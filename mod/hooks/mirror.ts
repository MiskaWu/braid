// 自動同步：把桌面 app 現在登入的帳號的側欄對話，複製到同步夥伴（沒登入的那個帳號）的資料夾。
// 為什麼 app 開著也能寫：app 只把目前帳號的清單放在記憶裡，換帳號時先清掉、再從磁碟重讀新帳號的資料夾
// （2.42304 的 LocalSessionManager.doInitialize），所以沒登入的那個帳號的資料夾 app 不會碰，換過去就讀到。
// 反過來，目前帳號的資料夾一律不寫：app 開著時記憶裡的清單會蓋回去，要等結束 app 才能寫（那是遷移工具的事）。
// 哪些欄位綁帳號要拿掉，和遷移工具共用 tool/spec.json。
// 刪除也跟著走：app 刪對話時會在那個帳號的資料夾留 deleted_<id>（內容是刪除時間），看到就把另一邊那筆側欄紀錄刪掉。
// 只刪側欄紀錄：停程序、刪 worktree 與分支、刪對話檔，app 在使用者刪的當下已經做了（那些是兩個帳號共用的檔案）。
// 引擎不准把 $ 傳過 import，所以讀寫檔的函式由 register.tsx 組好傳進來。
import type { FsEntry } from 'claude-code'

export type MirrorIo = {
  list: (path: string) => Promise<readonly FsEntry[]>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  /** 刪一個檔；刪不掉要丟錯 */
  remove: (path: string) => Promise<void>
  /**
   * 目標帳號仍然不是 app 登入中的帳號。每寫一筆、刪一筆之前問一次，不是就停：
   * 使用者可能在同步跑到一半時在 app 換成目標帳號，app 這時正從磁碟讀它的資料夾，再寫就會被蓋掉或讀到一半。
   * 只在開始時看一次不夠（2026-10-20 實測：換帳號後剩下的 5 筆有 4 筆照樣寫進作用中的帳號）。
   */
  stillInactive: () => Promise<boolean>
}

/** tool/spec.json 的 sessions 段：側欄紀錄的檔名規則與綁帳號的欄位。 */
export type SessionSpec = {
  filePrefix: string
  tombstonePrefix: string
  archivedIndex: string
  requiredKeys: string[]
  dropKeys: string[]
  nullKeys: string[]
  replaceFromTarget: string[]
}

type Rec = Record<string, unknown>

const isObj = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x)
const strings = (x: unknown): string[] | null => (Array.isArray(x) && x.every(v => typeof v === 'string') ? (x as string[]) : null)

/** 讀 spec.json；格式不對回 null（寧可不同步，也不要用猜的規則寫進去）。 */
export function parseSpec(text: string): SessionSpec | null {
  let s: unknown
  try {
    s = (JSON.parse(text.replace(/^﻿/, '')) as Rec).sessions
  } catch {
    return null
  }
  if (!isObj(s)) return null
  const { filePrefix, tombstonePrefix, archivedIndex } = s
  const requiredKeys = strings(s.requiredKeys)
  const dropKeys = strings(s.dropKeys)
  const nullKeys = strings(s.nullKeys)
  const replaceFromTarget = strings(s.replaceFromTarget)
  if (typeof filePrefix !== 'string' || !filePrefix || typeof tombstonePrefix !== 'string' || !tombstonePrefix || typeof archivedIndex !== 'string') return null
  if (!requiredKeys || !dropKeys || !nullKeys || !replaceFromTarget) return null
  return { filePrefix, tombstonePrefix, archivedIndex, requiredKeys, dropKeys, nullKeys, replaceFromTarget }
}

/** 對話屬於哪個資料夾：originCwd，沒有就 cwd（和遷移工具、面板的資料夾清單一樣）。 */
export function folderOf(r: Rec): string {
  if (typeof r.originCwd === 'string' && r.originCwd) return r.originCwd
  return typeof r.cwd === 'string' ? r.cwd : ''
}

async function readRec(io: MirrorIo, path: string): Promise<Rec | null> {
  try {
    const r: unknown = JSON.parse(await io.read(path))
    return isObj(r) ? r : null
  } catch {
    return null
  }
}

const at = (r: Rec) => (typeof r.lastActivityAt === 'number' ? r.lastActivityAt : 0)

/**
 * 帳號底下用哪個組織的資料夾：指定的組織有資料夾就用它，否則挑最近有寫入紀錄的那個。帳號沒有資料夾回 null。
 * 一般一個帳號只有一個組織；指定的是這個對話的環境變數給的組織（桌面 app 開的對話才有）。
 */
export async function orgDirOf(io: MirrorIo, root: string, sep: string, account: string, prefer: string | null, spec: SessionSpec): Promise<string | null> {
  let orgs: readonly FsEntry[]
  try {
    orgs = (await io.list(`${root}${sep}${account}`)).filter(o => o.kind === 'dir')
  } catch {
    return null
  }
  if (prefer && orgs.some(o => o.name === prefer)) return prefer
  let best: { name: string; mtime: number } | null = null
  for (const o of orgs) {
    let mtime = 0
    try {
      for (const f of await io.list(`${root}${sep}${account}${sep}${o.name}`)) if (f.name.startsWith(spec.filePrefix)) mtime = Math.max(mtime, f.mtimeMs)
    } catch {
      continue
    }
    if (!best || mtime > best.mtime) best = { name: o.name, mtime }
  }
  return best?.name ?? null
}

/**
 * 同步自己寫出去的檔：資料夾 → 檔名 → 寫完時的樣子（修改時間:大小）。
 * 換帳號後方向反過來，來源資料夾裡樣子還是這樣的檔就是同步自己的複本、app 沒動過，不寫回去。
 * 沒有它的話，「修改時間比較新」會把剛複製過去的複本當成新的變更，每次換帳號都把全部紀錄原樣寫回去（2026-10-20 實測）；
 * 寫得越久，越容易撞上 app 存檔與下一次換帳號。也讓遷移工具的「還原」不會被同步抵銷：另一邊的複本沒動過，就不帶回來。
 */
export type MirrorMemory = Record<string, Record<string, string>>

const look = (f: FsEntry) => `${f.mtimeMs}:${f.size}`

/** stopped：目標帳號中途被 app 登入，後面的沒寫（下一次同步方向會反過來）。 */
export type MirrorResult = { created: number; updated: number; deleted: number; stopped?: true }

/**
 * 把 src 資料夾的側欄紀錄複製到 dst（同一個 app、另一個帳號的資料夾）。scope 是 'all' 或要同步的資料夾。
 *
 * 每一筆：
 * - dst 有刪除墓碑（在那邊刪過）→ 不帶回去
 * - dst 沒有 → 新增：拿掉綁帳號的欄位（dropKeys）、清空 nullKeys、replaceFromTarget 換成 dst 最近一筆的值
 * - dst 有、而且檔案比 src 新 → 不動（那邊之後改過，或上次已經同步）
 * - dst 有、src 比較新 → 更新：內容用 src 的，綁帳號的欄位留 dst 自己的；dst 的最後活動時間比較晚就不動
 * 刪除：src 有 deleted_<id>、dst 還有那筆 → 刪掉 dst 的紀錄，再留一份同樣時間的 deleted_<id>（之後不會再被帶回來）。
 * 不刪的情況：dst 那筆的最後活動晚於刪除時間（刪掉之後又在那邊用過）、不在同步範圍、src 其實還有那筆。
 * 只依 src 明確的刪除紀錄刪，src 讀到空的也不會因此刪東西。刪之前先把那筆原樣存到 trash（備份寫不進去就不刪）。
 * 寫過、刪過的紀錄依封存狀態更新 dst 的封存清單（app 載入時用它先載未封存的）。src 一律不寫。
 * 每一筆（一次新增或更新、一整組刪除步驟、封存清單）動手前問 io.stillInactive()，dst 被 app 登入了就停在那裡。
 * memory 記同步自己寫出去的檔（見 MirrorMemory）：src 裡同步自己寫過、app 沒動過的檔不帶回 dst；寫完把 dst 新寫的記進去。
 */
export async function mirrorSessions(
  io: MirrorIo,
  spec: SessionSpec,
  src: string,
  dst: string,
  sep: string,
  scope: 'all' | readonly string[],
  trash: { dir: string; sep: string },
  memory: MirrorMemory,
): Promise<MirrorResult> {
  const srcFiles = (await io.list(src)).filter(f => f.kind === 'file')
  const dstFiles = (await io.list(dst)).filter(f => f.kind === 'file')
  const isRecord = (name: string) => name.startsWith(spec.filePrefix) && name.endsWith('.json')
  const dstByName = new Map(dstFiles.map(f => [f.name, f]))
  const tombs = new Set(dstFiles.filter(f => f.name.startsWith(spec.tombstonePrefix)).map(f => f.name.slice(spec.tombstonePrefix.length)))
  const accountKeys = [...spec.dropKeys, ...spec.nullKeys, ...spec.replaceFromTarget]

  // dst 最近一筆紀錄的 replaceFromTarget 欄位（例如連接器設定）；新增時才要，第一次用到才讀
  let replace: Rec | null = null
  const replacement = async (): Promise<Rec> => {
    if (replace) return replace
    let latest: Rec | null = null
    for (const f of dstFiles) {
      if (!isRecord(f.name)) continue
      const r = await readRec(io, `${dst}${sep}${f.name}`)
      if (r && (!latest || at(r) > at(latest))) latest = r
    }
    const found: Rec = {}
    for (const k of spec.replaceFromTarget) if (latest && k in latest) found[k] = latest[k]
    replace = found
    return found
  }

  const archived = new Map<string, boolean>()
  let created = 0
  let updated = 0
  let deleted = 0
  const ours = memory[src] ?? {}
  const written: string[] = []
  // 寫完（或中途停下）把 dst 這次寫的檔記下來；已經不在的拿掉
  const remember = async (): Promise<void> => {
    if (written.length === 0 && deleted === 0) return
    const now = new Map((await io.list(dst)).filter(f => f.kind === 'file').map(f => [f.name, f]))
    const kept: Record<string, string> = {}
    for (const [name, sig] of Object.entries(memory[dst] ?? {})) if (now.has(name)) kept[name] = sig
    for (const name of written) {
      const f = now.get(name)
      if (f) kept[name] = look(f)
    }
    memory[dst] = kept
  }
  const stop = async (): Promise<MirrorResult> => {
    await remember()
    return { created, updated, deleted, stopped: true }
  }

  // 先處理刪除：在 src 刪過、dst 還有的
  const srcNames = new Set(srcFiles.map(f => f.name))
  for (const t of srcFiles) {
    if (!t.name.startsWith(spec.tombstonePrefix)) continue
    const uuid = t.name.slice(spec.tombstonePrefix.length)
    const name = `${spec.filePrefix}${uuid}.json`
    if (!dstByName.has(name) || tombs.has(uuid) || srcNames.has(name)) continue
    let raw: string
    try {
      raw = await io.read(`${dst}${sep}${name}`)
    } catch {
      continue
    }
    let old: Rec | null = null
    try {
      const parsed: unknown = JSON.parse(raw)
      old = isObj(parsed) ? parsed : null
    } catch {
      old = null
    }
    if (!old) continue
    if (scope !== 'all' && !scope.includes(folderOf(old))) continue
    let stamp = ''
    try {
      stamp = (await io.read(`${src}${sep}${t.name}`)).trim()
    } catch {
      stamp = ''
    }
    const deletedAt = /^\d+$/.test(stamp) ? Number(stamp) : t.mtimeMs
    if (at(old) > deletedAt) continue
    if (!(await io.stillInactive())) return await stop() // 整組刪除步驟之前問一次，不會刪到一半停下
    // 先刪紀錄再留刪除紀錄：刪不掉就整個停下來（丟錯），不會留下「有刪除紀錄、紀錄卻還在」的狀態
    await io.write(`${trash.dir}${trash.sep}${name}`, raw) // 備份；寫不進去會丟錯，下面就不刪
    if (dstByName.has(`${name}.tmp`)) await io.remove(`${dst}${sep}${name}.tmp`) // app 載入時會把孤兒 .tmp 救回成紀錄
    await io.remove(`${dst}${sep}${name}`)
    await io.write(`${dst}${sep}${t.name}`, /^\d+$/.test(stamp) ? stamp : String(Math.round(deletedAt)))
    tombs.add(uuid)
    archived.set(name.slice(0, -'.json'.length), false)
    deleted++
  }

  for (const f of srcFiles) {
    if (!isRecord(f.name)) continue
    const id = f.name.slice(0, -'.json'.length)
    if (tombs.has(id.slice(spec.filePrefix.length))) continue
    if (ours[f.name] === look(f)) continue // 同步自己寫過來、app 沒動過的複本：不寫回去
    const have = dstByName.get(f.name)
    if (have && f.mtimeMs <= have.mtimeMs) continue
    const rec = await readRec(io, `${src}${sep}${f.name}`)
    if (!rec || !spec.requiredKeys.every(k => k in rec)) continue
    if (scope !== 'all' && !scope.includes(folderOf(rec))) continue
    const old = have ? await readRec(io, `${dst}${sep}${f.name}`) : null
    if (old && at(old) > at(rec)) continue

    const next: Rec = { ...rec }
    for (const k of spec.dropKeys) delete next[k]
    for (const k of spec.nullKeys) if (k in next) next[k] = null
    const toReplace = spec.replaceFromTarget.filter(k => k in next && !(old && k in old))
    if (toReplace.length > 0) {
      const rep = await replacement()
      for (const k of toReplace) if (k in rep) next[k] = rep[k]
    }
    if (old) for (const k of accountKeys) if (k in old) next[k] = old[k]
    if (!(await io.stillInactive())) return await stop()
    await io.write(`${dst}${sep}${f.name}`, JSON.stringify(next))
    written.push(f.name)
    if (have) updated++
    else created++
    archived.set(id, next.isArchived === true)
  }

  if (archived.size > 0) {
    if (!(await io.stillInactive())) return await stop()
    await updateArchivedIndex(io, spec, dst, sep, dstByName.has(spec.archivedIndex), archived)
  }
  await remember()
  return { created, updated, deleted }
}

/** 封存清單：{"v":1,"archived":[依字母排的 id]}，和 app 自己寫的一樣。看不懂的格式不動，app 會不靠它載入。 */
async function updateArchivedIndex(io: MirrorIo, spec: SessionSpec, dst: string, sep: string, exists: boolean, archived: Map<string, boolean>): Promise<void> {
  const path = `${dst}${sep}${spec.archivedIndex}`
  let ids = new Set<string>()
  if (exists) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await io.read(path))
    } catch {
      return
    }
    const list = isObj(parsed) && parsed.v === 1 ? strings(parsed.archived) : null
    if (!list) return
    ids = new Set(list)
  }
  const before = [...ids].sort().join('\n')
  for (const [id, isArchived] of archived) {
    if (isArchived) ids.add(id)
    else ids.delete(id)
  }
  const after = [...ids].sort()
  if (after.join('\n') === before) return
  if (!exists && after.length === 0) return
  await io.write(path, JSON.stringify({ v: 1, archived: after }))
}
