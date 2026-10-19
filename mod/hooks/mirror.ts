// 自動同步：把桌面 app 現在登入的帳號的側欄對話，複製到同步夥伴（沒登入的那個帳號）的資料夾。
// 為什麼 app 開著也能寫：app 只把目前帳號的清單放在記憶裡，換帳號時先清掉、再從磁碟重讀新帳號的資料夾
// （2.42304 的 LocalSessionManager.doInitialize），所以沒登入的那個帳號的資料夾 app 不會碰，換過去就讀到。
// 反過來，目前帳號的資料夾一律不寫：app 開著時記憶裡的清單會蓋回去，要等結束 app 才能寫（那是遷移工具的事）。
// 哪些欄位綁帳號要拿掉，和遷移工具共用 tool/spec.json。只新增與更新，不刪除。
// 引擎不准把 $ 傳過 import，所以讀寫檔的函式由 register.tsx 組好傳進來。
import type { FsEntry } from 'claude-code'

export type MirrorIo = {
  list: (path: string) => Promise<readonly FsEntry[]>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
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

export type MirrorResult = { created: number; updated: number }

/**
 * 把 src 資料夾的側欄紀錄複製到 dst（同一個 app、另一個帳號的資料夾）。scope 是 'all' 或要同步的資料夾。
 *
 * 每一筆：
 * - dst 有刪除墓碑（在那邊刪過）→ 不帶回去
 * - dst 沒有 → 新增：拿掉綁帳號的欄位（dropKeys）、清空 nullKeys、replaceFromTarget 換成 dst 最近一筆的值
 * - dst 有、而且檔案比 src 新 → 不動（那邊之後改過，或上次已經同步）
 * - dst 有、src 比較新 → 更新：內容用 src 的，綁帳號的欄位留 dst 自己的；dst 的最後活動時間比較晚就不動
 * 寫過的紀錄依封存狀態更新 dst 的封存清單（app 載入時用它先載未封存的）。src 一律不寫，任何檔案都不刪。
 */
export async function mirrorSessions(io: MirrorIo, spec: SessionSpec, src: string, dst: string, sep: string, scope: 'all' | readonly string[]): Promise<MirrorResult> {
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
  for (const f of srcFiles) {
    if (!isRecord(f.name)) continue
    const id = f.name.slice(0, -'.json'.length)
    if (tombs.has(id.slice(spec.filePrefix.length))) continue
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
    await io.write(`${dst}${sep}${f.name}`, JSON.stringify(next))
    if (have) updated++
    else created++
    archived.set(id, next.isArchived === true)
  }

  if (archived.size > 0) await updateArchivedIndex(io, spec, dst, sep, dstByName.has(spec.archivedIndex), archived)
  return { created, updated }
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
