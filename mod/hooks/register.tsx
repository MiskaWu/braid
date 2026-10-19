// braid：Claude 的多帳號工具。/braid 打開面板，四個分頁對應三種用法加帳號清單：
//   帳號：這台電腦認得的帳號與各自的用量；新增帳號（一年期憑證，存在系統鑰匙圈）
//   切換：用量快到門檻時，輸入框上方提示，一鍵用另一個帳號在新視窗接著同一段對話
//   同步：桌面 app 開著時，把現在登入的帳號的側欄對話自動複製到另一個帳號，換過去就看得到
//   遷移：桌面 app 換帳號後，把舊帳號的對話與環境搬過來（/braid migrate 也可以直接開）
// 自動同步只寫沒登入的那個帳號的側欄資料夾（app 開著也安全，見 mirror.ts）。其餘寫入桌面 app 資料的事
// （遷移、同步環境、還原）一律交給 tool/ 的工具在獨立視窗做：它會等 app 結束、先備份。
// mod 本身不碰登入憑證：新增帳號與接著做都是 tool/cli、tool/windows 的腳本在新視窗裡自己取用。
// 引擎不准把 $ 經由資料結構傳遞，所以動作的分派寫成 switch，畫面的函式直接收 $。
import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type {
  BraidAccount,
  BraidAdd,
  BraidCredential,
  BraidKeep,
  BraidMirror,
  BraidPlatform,
  BraidSwitch,
  BraidSync,
  BraidTab,
  BraidUsage,
  BraidUses,
} from '../types'
import { backupLabel, desktopPaths, listToolBackups, listTrash, scanDesktop, type DesktopEnv, type DesktopIo, type DesktopPaths } from './desktop'
import { manualPath, parseDryRun, planLaunch, toolArgs, type ToolRequest } from './launch'
import { mirrorSessions, orgDirOf, parseSpec, type MirrorIo } from './mirror'
import {
  bandFor,
  candidates,
  classifyOrg,
  DEFAULT_KEEP,
  DEFAULT_SWITCH,
  DEFAULT_SYNC,
  defaultLabel,
  effectivePct,
  expiredFiles,
  extraToolBackups,
  FIVE_HOUR_CHOICES,
  fmtBytes,
  fmtReset,
  meter,
  mirrorTarget,
  nameOf,
  normalizeAccount,
  normalizeFolder,
  normalizeKeep,
  normalizeMirror,
  normalizeSwitch,
  normalizeSync,
  normalizeUses,
  orderedIds,
  isOrgId,
  KEEP_COPIES_CHOICES,
  KEEP_DAYS_CHOICES,
  lookOf,
  PALETTE,
  COLOR_NAMES,
  parseTz,
  partnerOf,
  seenFromClaudeJson,
  SEVEN_DAY_CHOICES,
  syncRequest,
  syncRows,
  upsertSeen,
  usageFrom,
  WINDOW_NAMES,
  type RateLimit,
  type Seen,
  type Why,
} from './model'
import { newCredentialId, planTerminal, removeFile, removeToolBackup, secretDelete, type TerminalPlan } from './terminal'

type $ = EngineInterface
type UI = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Button' | 'Input' | 'Select'>

const PANE = 'braid'

const platformAtom = atom({ plugin: 'braid', key: 'platform' } as const, null)
const usesAtom = atom({ plugin: 'braid', key: 'uses' } as const, null)
const draftUsesAtom = atom({ plugin: 'braid', key: 'draftUses' } as const, { migrate: false, switch: false, sync: false })
const tabAtom = atom({ plugin: 'braid', key: 'tab' } as const, 'accounts')
const accountsAtom = atom({ plugin: 'braid', key: 'accounts' } as const, {})
const currentAtom = atom({ plugin: 'braid', key: 'current' } as const, null)
const liveAtom = atom({ plugin: 'braid', key: 'live' } as const, null)
const switchAtom = atom({ plugin: 'braid', key: 'switch' } as const, DEFAULT_SWITCH)
const syncAtom = atom({ plugin: 'braid', key: 'sync' } as const, DEFAULT_SYNC)
const desktopAtom = atom({ plugin: 'braid', key: 'desktop' } as const, null)
const addAtom = atom({ plugin: 'braid', key: 'add' } as const, null)
const addFormAtom = atom({ plugin: 'braid', key: 'addForm' } as const, { label: '', email: '', org: '' })
const editingAtom = atom({ plugin: 'braid', key: 'editing' } as const, null)
const noticeAtom = atom({ plugin: 'braid', key: 'notice' } as const, null)
const handoffAtom = atom({ plugin: 'braid', key: 'handoff' } as const, null)
const snoozeAtom = atom({ plugin: 'braid', key: 'snooze' } as const, null)
const mirrorAtom = atom({ plugin: 'braid', key: 'mirror' } as const, null)
const keepAtom = atom({ plugin: 'braid', key: 'keep' } as const, DEFAULT_KEEP)
const tzAtom = atom({ plugin: 'braid', key: 'tz' } as const, 0)

// ── 指令 ────────────────────────────────────────────────────

type ActionName = 'migrate' | 'accounts' | 'switch' | 'sync'
type Action = { name: ActionName; aliases: readonly string[]; usage: string; summary: string }

const ACTIONS: readonly Action[] = [
  { name: 'accounts', aliases: ['帳號'], usage: 'accounts', summary: '打開面板的帳號頁：這台電腦的帳號與用量、新增帳號' },
  { name: 'switch', aliases: ['切換'], usage: 'switch', summary: '打開面板的切換頁：用量快用完時換哪個帳號接著做' },
  { name: 'sync', aliases: ['同步'], usage: 'sync', summary: '打開面板的同步頁：桌面 app 的兩個帳號自動同步對話，額度用完換過去就能接著做' },
  {
    name: 'migrate',
    aliases: ['遷移'],
    usage: 'migrate [試跑]',
    summary: '把桌面 app 舊帳號的側欄對話與已儲存的環境搬到目前帳號（開獨立視窗執行；試跑只列計畫）',
  },
]

/** 拆出動作與其餘參數：`migrate 試跑` → migrate、`試跑`。 */
export function parseCommand(args: string): { action: Action | undefined; word: string; rest: string } {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const action = ACTIONS.find(a => a.name === word.toLowerCase() || a.aliases.includes(word))
  return { action, word, rest: rest.join(' ') }
}

function help(prefix?: string): string {
  const lines = ACTIONS.map(a => `  /braid ${a.usage}\n      ${a.summary}`)
  return [...(prefix ? [prefix, ''] : []), '用法：', '  /braid\n      打開 braid 面板', ...lines].join('\n')
}

// ── 環境 ────────────────────────────────────────────────────

async function detectPlatform($: $): Promise<BraidPlatform> {
  if (await $.env.get('WSL_DISTRO_NAME')) return 'wsl'
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  try {
    const { exitCode, stdout } = await $.process.run(['uname', '-s'])
    if (exitCode === 0 && stdout.trim() === 'Darwin') return 'mac'
  } catch {
    // 沒有 uname 就當其他平台
  }
  return 'other'
}

async function tmpDir($: $, platform: BraidPlatform): Promise<string> {
  if (platform === 'windows') return (await $.env.get('TEMP')) ?? (await $.env.get('TMP')) ?? 'C:\\Windows\\Temp'
  if (platform === 'mac') return (await $.env.get('TMPDIR')) ?? '/tmp'
  return '/tmp'
}

async function claudePath($: $): Promise<string> {
  return (await $.env.get('CLAUDE_CODE_EXECPATH')) ?? 'claude'
}

/** 當地與 UTC 差幾分鐘：用 date 問系統（外掛的執行環境不一定知道時區），Windows 用 JS 的。 */
async function localTz($: $, platform: BraidPlatform): Promise<number> {
  if (platform !== 'windows') {
    try {
      const r = await $.process.run(['date', '+%z'], { timeoutMs: 5_000 })
      if (r.exitCode === 0 && r.stdout.trim()) return parseTz(r.stdout)
    } catch {
      // 用下面的
    }
  }
  return -new Date().getTimezoneOffset()
}

/** 這個對話用的是哪個帳號：braid 開的視窗、桌面 app 給的環境變數、CLI 自己的登入，依序看。 */
async function seenNow($: $): Promise<Seen | null> {
  const braid = await $.env.get('BRAID_ACCOUNT')
  if (braid) return { id: braid, email: null, orgId: null, orgName: null, source: 'token' }
  const uuid = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  if (uuid) {
    return {
      id: uuid,
      email: (await $.env.get('CLAUDE_CODE_USER_EMAIL')) ?? null,
      orgId: (await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')) ?? null,
      orgName: null,
      source: 'desktop',
    }
  }
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const file = dir ? `${dir}/.claude.json` : home ? `${home}/.claude.json` : null
  if (!file) return null
  try {
    return seenFromClaudeJson(await $.fs.read(file))
  } catch {
    return null
  }
}

// ── 存取：設定與帳號存在 $.store（跨對話），同時寫進 $.state 讓畫面重畫 ──

async function loadStore($: $): Promise<void> {
  const uses = normalizeUses(await $.store.get('uses'))
  const sw = normalizeSwitch(await $.store.get('switch'))
  const sy = normalizeSync(await $.store.get('sync'))
  const accounts: Record<string, BraidAccount> = {}
  for (const k of await $.store.keys()) {
    if (!k.startsWith('account:')) continue
    const a = normalizeAccount(await $.store.get(k))
    if (a) accounts[a.id] = a
  }
  const snooze = await $.store.get('snooze')
  const mirror = normalizeMirror(await $.store.get('mirror'))
  const keep = normalizeKeep(await $.store.get('keep'))
  await update($, usesAtom, () => uses)
  await update($, switchAtom, () => sw)
  await update($, syncAtom, () => sy)
  await update($, accountsAtom, () => accounts)
  await update($, snoozeAtom, () => (typeof snooze === 'string' ? snooze : null))
  await update($, mirrorAtom, () => mirror)
  await update($, keepAtom, () => keep)
}

async function putAccount($: $, a: BraidAccount): Promise<void> {
  await $.store.set(`account:${a.id}`, a)
  await update($, accountsAtom, m => ({ ...m, [a.id]: a }))
}

async function dropAccount($: $, id: string): Promise<void> {
  await $.store.delete(`account:${id}`)
  await update($, accountsAtom, m => {
    const rest = { ...m }
    delete rest[id]
    return rest
  })
}

async function putUses($: $, uses: BraidUses): Promise<void> {
  await $.store.set('uses', uses)
  await update($, usesAtom, () => uses)
}

async function putSwitch($: $, change: (sw: BraidSwitch) => BraidSwitch): Promise<void> {
  const sw = change(await read($, switchAtom))
  await $.store.set('switch', sw)
  await update($, switchAtom, () => sw)
}

async function putSync($: $, change: (sy: BraidSync) => BraidSync): Promise<void> {
  const sy = change(await read($, syncAtom))
  await $.store.set('sync', sy)
  await update($, syncAtom, () => sy)
}

async function putKeep($: $, change: (k: BraidKeep) => BraidKeep): Promise<void> {
  const keep = change(await read($, keepAtom))
  await $.store.set('keep', keep)
  await update($, keepAtom, () => keep)
  await runPrune($, true) // 改短了就馬上清，畫面上的筆數跟著更新
  await ensureDesktop($, true)
}

const say = ($: $, text: string | null) => update($, noticeAtom, () => text)

// ── 用量 ────────────────────────────────────────────────────

async function onUsage($: $, rateLimits: readonly RateLimit[]): Promise<void> {
  const usage = usageFrom(rateLimits, await $.clock.now())
  if (!usage) return
  await update($, liveAtom, () => usage)
  const id = await read($, currentAtom)
  const account = id ? (await read($, accountsAtom))[id] : undefined
  if (account) await putAccount($, { ...account, usage })
  await refreshStatus($)
  // 快用完了：馬上再同步一次，換過去時連剛剛的對話都在（不在這個事件裡等，讀寫桌面 app 的資料夾要一點時間）
  const now = await $.clock.now()
  if (bandFor(await read($, accountsAtom), id, usage, await read($, switchAtom), await $.session.cwd(), now, null)) $.clock.after(1, () => runMirror($, 'urgent'))
}

/** 狀態列：開了用量切換才顯示目前帳號與 5 小時用量。 */
async function refreshStatus($: $): Promise<void> {
  const uses = await read($, usesAtom)
  const id = await read($, currentAtom)
  const live = await read($, liveAtom)
  const account = id ? (await read($, accountsAtom))[id] : undefined
  const pct = effectivePct(live?.fiveHour ?? null, await $.clock.now())
  $.ui.status(uses?.switch && account && pct !== null ? `braid · ${account.label} ${pct}%` : undefined)
}

// ── 開視窗 ──────────────────────────────────────────────────

/** 依序執行計畫；開不了視窗、需要使用者自己執行時回 manual，失敗回原因。 */
async function runPlan($: $, plan: TerminalPlan): Promise<'ok' | 'manual' | { error: string }> {
  if ('unsupported' in plan) return { error: '這個平台不支援' }
  for (const step of plan.steps) {
    if ('write' in step) {
      await $.fs.write(step.write.path, step.write.text)
      continue
    }
    const r = await $.process.run(step.run, { timeoutMs: 60_000, ...(step.env ? { env: step.env } : {}) })
    if (r.exitCode === 3 && plan.manual) return 'manual'
    if (r.exitCode !== 0) return { error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || `結束碼 ${r.exitCode}` }
  }
  return 'ok'
}

/** 開遷移工具的視窗（遷移、同步、還原共用）。回給使用者看的一句話。 */
async function launchTool($: $, req: ToolRequest): Promise<string> {
  const platform = (await read($, platformAtom)) ?? (await detectPlatform($))
  if (platform === 'other') return 'Claude 桌面 app 只有 Windows 與 macOS 版，這台電腦上沒有桌面 app 的資料。'
  const args = toolArgs(platform, req)
  if ('unsafe' in args) return `資料夾「${args.unsafe}」的名稱裡有逗號、" 或 %，沒辦法用參數指定。請改用 /braid migrate，在工具的勾選清單裡選。`
  const tmp = platform === 'mac' ? await $.env.get('TMPDIR') : undefined
  const plan = planLaunch(platform, $.plugin.root, args, tmp)
  if ('unsupported' in plan) return '這個平台不支援。'
  for (const step of plan.actions) {
    if ('write' in step) {
      await $.fs.write(step.write.path, step.write.text)
      continue
    }
    const result = await $.process.run(step.run, { timeoutMs: 60_000 })
    if (result.exitCode !== 0) {
      const why = (result.stderr || result.stdout).trim().split('\n').slice(-3).join('\n')
      return `開不了工具的視窗（${why || `結束碼 ${result.exitCode}`}）。\n也可以直接雙擊：${manualPath(platform, $.plugin.root)}`
    }
  }
  if (req.dryRun) {
    return '已在另一個視窗開啟遷移工具（試跑：只列計畫、不寫入，Claude 不用結束）。\n看完計畫按任意鍵關閉那個視窗；要正式搬就打 /braid migrate。'
  }
  const quit = platform === 'mac' ? '選單列 Claude →「結束 Claude」（⌘Q）' : '右下角系統匣的 Claude 圖示按右鍵 →「結束」'
  const what = req.restore ? '還原工具' : req.from && req.projects ? '同步工具' : '遷移工具'
  return [
    `已在另一個視窗開啟${what}。`,
    `接下來照那個視窗的指示：先${quit}，只關掉視窗不夠。這個對話會跟著中斷，沒關係。`,
    '工具會先備份再寫入，最後問你要不要重新開啟 Claude；重開後在側欄找回這個對話即可。',
  ].join('\n')
}

async function migrate($: $, rest: string): Promise<string> {
  return launchTool($, { dryRun: parseDryRun(rest) })
}

// ── 面板 ────────────────────────────────────────────────────

async function openPane($: $, tab?: BraidTab): Promise<void> {
  if (tab) await update($, tabAtom, () => tab)
  await $.ui.open({ id: PANE, title: 'braid', columns: 64 })
  const shown = tab ?? (await read($, tabAtom))
  if (shown !== 'accounts') await ensureDesktop($)
}

async function setTab($: $, tab: BraidTab): Promise<void> {
  await update($, tabAtom, () => tab)
  await say($, null)
  if (tab !== 'accounts') await ensureDesktop($)
}

function desktopIo($: $): DesktopIo {
  return {
    list: path => $.fs.list(path),
    read: path => $.fs.read(path),
    exists: path => $.fs.exists(path),
    run: (argv, cwd) => $.process.run(argv, { timeoutMs: 15_000, ...(cwd ? { cwd } : {}) }),
  }
}

async function desktopEnv($: $): Promise<DesktopEnv> {
  return { home: await $.env.get('HOME'), appData: await $.env.get('APPDATA'), userProfile: await $.env.get('USERPROFILE') }
}

async function ensureDesktop($: $, force = false): Promise<void> {
  if (!force && (await read($, desktopAtom)) !== null) return
  const platform = (await read($, platformAtom)) ?? 'other'
  const scanned = await scanDesktop(desktopIo($), await desktopEnv($), platform)
  await update($, desktopAtom, () => scanned)
}

// ── 自動同步 ────────────────────────────────────────────────

// 每個對話各有一個計時器；跨對話用 $.store 的 mirrorAt 節流，同時開好幾個對話也大約一分鐘一次
let mirrorTimer: { cancel: () => void } | null = null
let mirroring = false
// 桌面 app 的資料夾：WSL 裡要問 cmd.exe，不必每分鐘問一次
let pathsCache: DesktopPaths | null = null
const MIRROR_EVERY_MS = 60_000

/** 多久內同步過就不再做：計時器一分鐘一次；用量快用完時至少隔 10 秒；按「現在同步」不等。 */
const MIRROR_GAP: Record<'tick' | 'urgent' | 'now', number> = { tick: MIRROR_EVERY_MS - 5_000, urgent: 10_000, now: 0 }

/** 自動同步一次，結果記在 $.store（面板與提示看它）。沒開同步、這台沒有桌面 app 就什麼都不做。 */
async function runMirror($: $, mode: 'tick' | 'urgent' | 'now'): Promise<void> {
  if (mirroring) return
  const uses = await read($, usesAtom)
  const sy = await read($, syncAtom)
  const platform = await read($, platformAtom)
  if (!uses?.sync || !sy.on || sy.pair.length !== 2 || !platform || platform === 'other') return
  const now = await $.clock.now()
  const last = await $.store.get('mirrorAt')
  if (typeof last === 'number' && now - last < MIRROR_GAP[mode]) return
  mirroring = true
  try {
    await $.store.set('mirrorAt', now)
    const status = await mirrorOnce($, platform, now)
    await $.store.set('mirror', status)
    await update($, mirrorAtom, () => status)
  } finally {
    mirroring = false
  }
}

async function mirrorOnce($: $, platform: BraidPlatform, now: number): Promise<BraidMirror> {
  const base: BraidMirror = { at: now, active: null, to: null, toOrg: null, created: 0, updated: 0, deleted: 0, problem: null, detail: null }
  pathsCache ??= await desktopPaths(desktopIo($), await desktopEnv($), platform)
  if (!pathsCache) return { ...base, problem: 'no-desktop' }
  const sep = platform === 'windows' ? '\\' : '/'
  // 桌面 app 現在登入誰：app 換帳號當下就改 config.json 的這一欄
  let active: string | null = null
  try {
    const cfg: unknown = JSON.parse(await $.fs.read(`${pathsCache.appData}${sep}config.json`))
    const v = typeof cfg === 'object' && cfg !== null ? (cfg as Record<string, unknown>).lastKnownAccountUuid : null
    active = typeof v === 'string' && v ? v : null
  } catch {
    active = null
  }
  if (!active) return { ...base, problem: 'no-active' }
  const target = mirrorTarget(await read($, syncAtom), active)
  if (!target) return { ...base, active }
  let spec = null
  try {
    spec = parseSpec(await $.fs.read(`${$.plugin.root}/tool/spec.json`))
  } catch {
    spec = null
  }
  if (!spec) return { ...base, active, to: target.to, problem: 'no-spec' }
  const io: MirrorIo = {
    list: path => $.fs.list(path),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    // $.fs 沒有刪檔：用指令刪，刪完確認真的不見了（Windows 的 Remove-Item 失敗時結束碼也可能是 0）
    remove: async path => {
      await $.process.run(removeFile(platform, path), { timeoutMs: 15_000 })
      if (await $.fs.exists(path)) throw new Error(`刪不掉 ${path}`)
    },
  }
  const root = `${pathsCache.appData}${sep}claude-code-sessions`
  const mine = (await read($, accountsAtom))[active]
  const fromOrg = await orgDirOf(io, root, sep, active, mine?.orgId ?? null, spec)
  const toOrg = await orgDirOf(io, root, sep, target.to, null, spec)
  if (!toOrg) return { ...base, active, to: target.to, problem: 'no-target' }
  if (!fromOrg) return { ...base, active, to: target.to, toOrg }
  try {
    // 同步刪掉的側欄紀錄先原樣放這裡：braid-backups/sync-deleted/<帳號>/<組織>/local_<id>.json
    const bk = pathsCache.backups
    const trash = { dir: [bk.local, 'sync-deleted', target.to, toOrg].join(bk.sep), sep: bk.sep }
    const r = await mirrorSessions(io, spec, `${root}${sep}${active}${sep}${fromOrg}`, `${root}${sep}${target.to}${sep}${toOrg}`, sep, target.scope, trash)
    return { ...base, active, to: target.to, toOrg, ...r }
  } catch (err) {
    return { ...base, active, to: target.to, toOrg, problem: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

// ── 清舊備份：同步刪掉的對話備份超過幾天、遷移工具的整份備份超過幾份就刪（使用者在面板選） ──

let pruning = false
const PRUNE_EVERY_MS = 6 * 3600_000

async function runPrune($: $, force = false): Promise<void> {
  if (pruning) return
  const platform = await read($, platformAtom)
  if (!platform || platform === 'other') return
  const now = await $.clock.now()
  const last = await $.store.get('pruneAt')
  if (!force && typeof last === 'number' && now - last < PRUNE_EVERY_MS) return
  pruning = true
  try {
    await $.store.set('pruneAt', now)
    pathsCache ??= await desktopPaths(desktopIo($), await desktopEnv($), platform)
    if (!pathsCache) return
    const keep = await read($, keepAtom)
    const io = desktopIo($)
    const bk = pathsCache.backups
    for (const path of expiredFiles(await listTrash(io, bk), keep.deletedDays, now)) await $.process.run(removeFile(platform, path), { timeoutMs: 15_000 })
    for (const name of extraToolBackups(await listToolBackups(io, bk), keep.toolCopies)) await $.process.run(removeToolBackup(platform, bk.local, name), { timeoutMs: 60_000 })
  } catch {
    // 清不掉下次再清；備份多留不會壞事
  } finally {
    pruning = false
  }
}

/** 同步對象的顯示名稱：沒當過目前帳號的桌面帳號，用它的組織去借 braid 新增帳號的名稱（nameOf）。 */
function mirrorName(accounts: Record<string, BraidAccount>, id: string, org: string | null): string {
  return mirrorLook(accounts, id, org).label
}

function mirrorLook(accounts: Record<string, BraidAccount>, id: string, org: string | null): { label: string; color: string } {
  return lookOf(accounts, id, org ? [{ account: id, org, sessions: 0, lastActivity: 0, folders: [] }] : [])
}

// ── 新增帳號 ────────────────────────────────────────────────

// 等結果檔的計時器；模組重新載入會丟掉，畫面看到還在等就重新開始等
let addTimer: { cancel: () => void } | null = null
const ADD_TIMEOUT_MS = 15 * 60_000

async function startAdd($: $): Promise<void> {
  const policy = (await $.settings.read({ source: 'policy' })) as Record<string, unknown>
  if (policy.forceLoginOrgUUID) {
    await update($, addAtom, () => ({
      step: 'blocked' as const,
      reason:
        '公司設定 Claude Code 只能用公司組織登入。新增帳號要先用瀏覽器登入另一個帳號，braid 不會走這條路繞過這個限制。要用其他帳號，請先跟 IT 確認。',
    }))
    return
  }
  const platform = (await read($, platformAtom)) ?? 'other'
  const id = newCredentialId(Math.random)
  const tmp = await tmpDir($, platform)
  const sep = platform === 'windows' ? '\\' : '/'
  const resultPath = `${tmp.replace(/[\\/]+$/, '')}${sep}braid-add-${id}.json`
  const plan = planTerminal(platform, $.plugin.root, { kind: 'add', credentialId: id, result: resultPath, claude: await claudePath($) }, tmp)
  const ran = await runPlan($, plan)
  if (ran === 'manual' && 'steps' in plan) {
    await $.ui.copy({ text: plan.manual ?? '' })
    await say($, `這台電腦開不了新視窗。請在另一個終端機執行（已複製）：${plan.manual}`)
  } else if (ran !== 'ok' && ran !== 'manual') {
    await update($, addAtom, () => ({ step: 'failed' as const, reason: `開不了登入視窗（${ran.error}）` }))
    return
  }
  const startedAt = await $.clock.now()
  await update($, addAtom, () => ({ step: 'waiting' as const, id, resultPath, startedAt }))
  pollAdd($, id, resultPath, startedAt)
}

function pollAdd($: $, id: string, resultPath: string, startedAt: number): void {
  addTimer?.cancel()
  const timer = $.clock.every(1500, async () => {
    const add = await read($, addAtom)
    if (add?.step !== 'waiting' || add.id !== id) {
      timer.cancel()
      return
    }
    if (!(await $.fs.exists(resultPath))) {
      if ((await $.clock.now()) - startedAt > ADD_TIMEOUT_MS) {
        timer.cancel()
        await update($, addAtom, () => ({ step: 'failed' as const, reason: '等太久了，登入視窗沒有回報。可以再試一次。' }))
      }
      return
    }
    timer.cancel()
    addTimer = null
    let result: { ok?: unknown; backend?: unknown; reason?: unknown; orgId?: unknown } = {}
    try {
      result = JSON.parse((await $.fs.read(resultPath)).replace(/^\uFEFF/, '')) as typeof result
    } catch {
      result = { ok: false, reason: 'unreadable' }
    }
    try {
      await $.process.run(removeFile((await read($, platformAtom)) ?? 'other', resultPath), { timeoutMs: 15_000 })
    } catch {
      // 刪不掉也不擋：結果檔裡只有成功與否和組織，沒有憑證
    }
    const backends: readonly BraidCredential[] = ['keychain', 'secret-service', 'file', 'credman']
    const backend = backends.find(b => b === result.backend)
    if (result.ok === true && backend) {
      // 名稱欄留空、只當提示：沒填就用預設（併進既有帳號時沿用它原本的名稱），不會蓋掉使用者取過的名字
      await update($, addFormAtom, () => ({ label: '', email: '', org: '' }))
      await update($, addAtom, () => ({ step: 'confirm' as const, id, credential: backend, orgId: isOrgId(result.orgId) ? result.orgId : null }))
    } else {
      const why = result.reason === 'canceled' ? '在登入視窗取消了。' : result.reason === 'store-failed' ? '憑證存不進鑰匙圈。' : '登入視窗沒有完成。'
      await update($, addAtom, () => ({ step: 'failed' as const, reason: `${why}可以再試一次。` }))
    }
  })
  addTimer = timer
}

async function finishAdd($: $): Promise<void> {
  const add = await read($, addAtom)
  if (add?.step !== 'confirm') return
  const form = await read($, addFormAtom)
  const accounts = await read($, accountsAtom)
  const current = await read($, currentAtom)
  // 組織：查得到就照查到的，查不到才用使用者選的
  const verdict = add.orgId ? classifyOrg(accounts, current, add.orgId) : null
  const email = form.email.trim() || null
  const orgId = add.orgId ?? (form.org || null)
  const orgName = orgId ? (Object.values(accounts).find(a => a.orgId === orgId)?.orgName ?? null) : null
  // 認得的帳號就把憑證掛上去；和目前帳號同組織時，使用者已經按了「確定是同組織的另一個帳號」，當成新的
  let same: BraidAccount | undefined
  if (verdict) same = verdict.kind === 'known' ? verdict.account : undefined
  else same = email ? Object.values(accounts).find(a => a.email?.toLowerCase() === email.toLowerCase()) : undefined
  const label = form.label.trim()
  let saved: BraidAccount
  if (same) {
    if (same.credentialId && same.credentialId !== add.id) await removeSecret($, same.credentialId)
    saved = {
      ...same,
      label: label || same.label,
      email: same.email ?? email,
      orgId: same.orgId ?? orgId,
      orgName: same.orgName ?? orgName,
      credential: add.credential,
      credentialId: add.id,
    }
  } else {
    const used = Object.values(accounts).map(a => a.color)
    saved = {
      id: add.id,
      email,
      orgId,
      orgName,
      label: label || defaultLabel({ email, orgName }, Object.values(accounts).map(a => a.label)),
      color: PALETTE.find(c => !used.includes(c)) ?? PALETTE[0],
      source: 'token',
      credential: add.credential,
      credentialId: add.id,
      usage: null,
      lastSeen: 0,
    }
  }
  await putAccount($, saved)
  await update($, addAtom, () => null)
  await say($, same ? `已更新「${saved.label}」的登入憑證。` : `已新增「${saved.label}」。到「切換」設定什麼時候換過去。`)
}

async function removeSecret($: $, credentialId: string): Promise<void> {
  const platform = (await read($, platformAtom)) ?? 'other'
  try {
    await $.process.run(secretDelete(platform, $.plugin.root, credentialId), { timeoutMs: 30_000 })
  } catch {
    // 刪不掉也不擋：帳號已經從清單拿掉，憑證留著不會被用到
  }
}

async function discardAdd($: $): Promise<void> {
  const add = await read($, addAtom)
  addTimer?.cancel()
  addTimer = null
  if (add?.step === 'confirm') await removeSecret($, add.id)
  await update($, addAtom, () => null)
}

async function forget($: $, id: string): Promise<void> {
  const account = (await read($, accountsAtom))[id]
  if (!account) return
  if (account.credentialId) await removeSecret($, account.credentialId)
  await dropAccount($, id)
  await putSwitch($, sw => ({ ...sw, order: sw.order.filter(x => x !== id) }))
  await update($, editingAtom, () => null)
  await say($, `已移除「${account.label}」${account.credentialId ? '，登入憑證也刪掉了' : ''}。`)
}

// ── 接著做：用另一個帳號在新視窗接著同一段對話 ──────────────────────

async function handoff($: $, id: string): Promise<void> {
  const account = (await read($, accountsAtom))[id]
  if (!account?.credentialId) return
  const platform = (await read($, platformAtom)) ?? 'other'
  const plan = planTerminal(
    platform,
    $.plugin.root,
    {
      kind: 'resume',
      account: account.id,
      credentialId: account.credentialId,
      session: await $.session.id(),
      cwd: await $.session.cwd(),
      claude: await claudePath($),
      label: account.label,
    },
    await tmpDir($, platform),
  )
  const ran = await runPlan($, plan)
  if (ran !== 'ok' && ran !== 'manual') {
    $.ui.toast(`braid：開不了新視窗（${ran.error}）`)
    return
  }
  if (ran === 'manual' && 'steps' in plan && plan.manual) {
    await $.ui.copy({ text: plan.manual })
    $.ui.toast(`braid：這台電腦開不了新視窗。請在另一個終端機執行（已複製）：${plan.manual}`)
  }
  await update($, handoffAtom, () => ({ account: id, label: account.label, confirmed: false, noticed: false }))
}

async function snooze($: $, key: string): Promise<void> {
  await $.store.set('snooze', key)
  await update($, snoozeAtom, () => key)
}

// ── 畫面：共用的小元件 ───────────────────────────────────────
// 每頁同一套層次：頁首（標題＋一句話）→ 區塊標題 → 內容；說明一律是小字淡色，帳號一律是色點＋名稱。

function pageHead(ui: UI, key: string, title: string, sub: string) {
  const { Box, Text } = ui
  return (
    <Box key={key} flexDirection="column">
      <Text size="title" weight="bold">
        {title}
      </Text>
      <Text size="footnote" dimColor>
        {sub}
      </Text>
    </Box>
  )
}

function sectionHead(ui: UI, key: string, title: string, sub?: string) {
  const { Box, Text } = ui
  return (
    <Box key={key} flexDirection="column">
      <Text size="heading" weight="semibold">
        {title}
      </Text>
      {sub ? (
        <Text size="footnote" dimColor>
          {sub}
        </Text>
      ) : null}
    </Box>
  )
}

function fine(ui: UI, text: string, key?: string) {
  const { Text } = ui
  return (
    <Text key={key} size="footnote" dimColor>
      {text}
    </Text>
  )
}

function chip(ui: UI, look: { label: string; color: string }) {
  const { Text } = ui
  return (
    <Text>
      <Text color={look.color}>●</Text> <Text weight="semibold">{look.label}</Text>
    </Text>
  )
}

const WHY_TEXT: Record<Why, string> = {
  ok: '可以接手',
  'other-org': '這個資料夾只換同組織的帳號',
  'no-credential': 'braid 沒有它的登入憑證，只能在桌面 app 手動換',
  busy: '也快用完了',
}

const CREDENTIAL_TEXT: Record<BraidCredential, string> = {
  keychain: '鑰匙圈',
  'secret-service': '系統鑰匙圈',
  file: '只有你讀得到的檔案',
  credman: 'Windows 認證管理員',
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return '剛剛'
  if (min < 60) return `${min} 分鐘前`
  const hours = Math.round(min / 60)
  if (hours < 48) return `${hours} 小時前`
  return `${Math.round(hours / 24)} 天前`
}

function dateOf(ms: number, tz: number): string {
  if (!ms) return ''
  const d = new Date(ms + tz * 60_000)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

function meterLine(ui: UI, key: string, name: string, w: BraidUsage['fiveHour'], color: string, width: number, now: number, tz: number) {
  const { Text } = ui
  const pct = effectivePct(w, now)
  if (pct === null || !w) return null
  const bar = meter(pct, width)
  const reset = fmtReset(w.resetsAt, now, tz)
  const hot = pct >= 90
  return (
    <Text key={key} wrap="truncate">
      {name.padEnd(5, ' ')} <Text color={hot ? 'warning' : color}>{bar.used}</Text>
      <Text dimColor>{bar.left}</Text> <Text bold>{`${pct}%`.padStart(4, ' ')}</Text>
      <Text dimColor>{reset ? `  ${reset} 重置` : ''}</Text>
    </Text>
  )
}

// ── 畫面：各分頁 ─────────────────────────────────────────────

async function drawOnboarding($: $, ui: UI) {
  const { Box, Text, Button } = ui
  const draft = await read($, draftUsesAtom)
  const uses = await read($, usesAtom)
  const options: { id: keyof BraidUses; title: string; desc: string }[] = [
    { id: 'migrate', title: '換帳號了，把舊對話搬過來', desc: '桌面 app 舊帳號在 Code 分頁的對話與環境，複製到現在的帳號。搬一次就好。' },
    { id: 'switch', title: '用量用完，換另一個帳號接著做', desc: '快到上限時提醒，一鍵用另一個帳號在新視窗接著同一段對話。要兩個以上的帳號。' },
    { id: 'sync', title: '幾個帳號長期一起用', desc: '桌面 app 的兩個帳號自動同步對話，用量用完換過去就能接著做（預設全部資料夾，也可以只挑幾個）。' },
  ]
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>你想用 braid 做什麼？（可以複選）</Text>
      {options.map(o => (
        <Box key={`ob-${o.id}`} flexDirection="column">
          <Button key={`use-${o.id}`} plain onPress={() => update($, draftUsesAtom, d => ({ ...d, [o.id]: !d[o.id] }))}>
            {draft[o.id] ? '[x] ' : '[ ] '}
            {o.title}
          </Button>
          <Text dimColor>{`    ${o.desc}`}</Text>
        </Box>
      ))}
      <Text dimColor>沒選的功能不會出現，之後按「用法」可以再改。帳號頁一定會有。</Text>
      <Box flexDirection="row" gap={1}>
        <Button
          key="use-save"
          label="開始"
          variant="primary"
          onPress={async () => {
            await putUses($, draft)
            await update($, editingAtom, () => null)
            await setTab($, draft.switch ? 'switch' : draft.sync ? 'sync' : draft.migrate ? 'migrate' : 'accounts')
            await refreshStatus($)
          }}
        />
        {uses !== null && <Button key="use-cancel" label="取消" onPress={() => update($, editingAtom, () => null)} />}
      </Box>
    </Box>
  )
}

async function drawAccounts($: $, ui: UI, width: number) {
  const { Box, Text, Button, Input, Select } = ui
  const accounts = await read($, accountsAtom)
  const current = await read($, currentAtom)
  const live = await read($, liveAtom)
  const editing = await read($, editingAtom)
  const tz = await read($, tzAtom)
  const now = await $.clock.now()
  const barWidth = Math.max(8, Math.min(24, width - 34))

  const block = (a: BraidAccount, isCurrent: boolean) => {
    const usage = isCurrent ? (live ?? a.usage) : a.usage
    const editRow =
      editing === `edit:${a.id}` ? (
        <Box key={`edit-${a.id}`} flexDirection="column">
          <Input key={`label-${a.id}`} label="名稱" value={a.label} onSubmit={v => putAccount($, { ...a, label: v.trim() || a.label })} />
          <Select
            key={`color-${a.id}`}
            label="顏色"
            options={PALETTE.map(c => ({ value: c, label: COLOR_NAMES[c] ?? c }))}
            value={a.color}
            onSelect={v => putAccount($, { ...a, color: v })}
          />
          <Button key={`edit-done-${a.id}`} label="完成" onPress={() => update($, editingAtom, () => null)} />
        </Box>
      ) : editing === `forget:${a.id}` ? (
        <Box key={`forget-ask-${a.id}`} flexDirection="row" gap={1}>
          <Text color="warning">{a.credentialId ? '移除後登入憑證也會刪掉。' : '只是從清單拿掉。'}</Text>
          <Button key={`forget-yes-${a.id}`} label="確定移除" onPress={() => forget($, a.id)} />
          <Button key={`forget-no-${a.id}`} label="取消" onPress={() => update($, editingAtom, () => null)} />
        </Box>
      ) : (
        <Box key={`acts-${a.id}`} flexDirection="row" gap={1} flexWrap="wrap">
          {!isCurrent && a.credential && <Button key={`go-${a.id}`} label="用它接著這段對話" variant="primary" onPress={() => handoff($, a.id)} />}
          <Button key={`edit-${a.id}`} label="改名稱與顏色" dimColor onPress={() => update($, editingAtom, () => `edit:${a.id}`)} />
          {!isCurrent && <Button key={`forget-${a.id}`} label="移除" dimColor onPress={() => update($, editingAtom, () => `forget:${a.id}`)} />}
        </Box>
      )
    const five = effectivePct(usage?.fiveHour ?? null, now)
    const seven = effectivePct(usage?.sevenDay ?? null, now)
    return (
      <Box key={`acc-${a.id}`} flexDirection="column" borderStyle="round" borderColor={isCurrent ? a.color : undefined} paddingX={1}>
        <Text wrap="truncate">
          <Text color={a.color}>●</Text> <Text bold>{a.label}</Text>
          <Text dimColor>{a.orgName ? `  ${a.orgName}` : ''}</Text>
          {isCurrent ? <Text color="success">  這個對話在用</Text> : null}
        </Text>
        {a.email ? (
          <Text size="footnote" dimColor>
            {a.email}
          </Text>
        ) : null}
        {isCurrent ? (
          <Box flexDirection="column">
            {meterLine(ui, `m5-${a.id}`, '5 小時', usage?.fiveHour ?? null, a.color, barWidth, now, tz)}
            {meterLine(ui, `m7-${a.id}`, '7 天', usage?.sevenDay ?? null, a.color, barWidth, now, tz)}
            {!usage && <Text dimColor>Claude 回覆一次之後就會有用量。</Text>}
          </Box>
        ) : (
          <Text size="footnote" dimColor tabular>
            {usage ? `5 小時 ${five ?? '—'}% · 7 天 ${seven ?? '—'}%（${ago(now - usage.at)}的數字）` : '還沒有用量紀錄'}
          </Text>
        )}
        {!isCurrent && (
          <Text size="footnote" dimColor>
            {a.credential ? `可以一鍵接手（憑證存在${CREDENTIAL_TEXT[a.credential]}）` : 'braid 沒有它的登入憑證，只能在桌面 app 手動換'}
          </Text>
        )}
        {editRow}
      </Box>
    )
  }

  const cur = current ? accounts[current] : undefined
  const others = orderedIds(accounts, []).filter(id => id !== current).map(id => accounts[id] as BraidAccount)
  return (
    <Box flexDirection="column" gap={1}>
      {pageHead(ui, 'acc-head', '帳號', '這台電腦認得的帳號與各自的用量；有憑證的帳號可以一鍵接著這段對話。')}
      {sectionHead(ui, 'acc-cur-head', '目前使用')}
      {cur ? block(cur, true) : <Text dimColor>認不出這個對話用的是哪個帳號。</Text>}
      {sectionHead(ui, 'acc-other-head', '其他帳號')}
      {others.length === 0 && <Text dimColor>還沒有其他帳號。在桌面 app 用別的帳號開過對話、或按下面的按鈕新增，就會出現在這裡。</Text>}
      {others.map(a => block(a, false))}
      {await drawAdd($, ui)}
    </Box>
  )
}

async function drawAdd($: $, ui: UI) {
  const { Box, Text, Button, Input, Select } = ui
  const add: BraidAdd | null = await read($, addAtom)
  if (add === null) return <Button key="add" label="＋ 新增帳號" onPress={() => startAdd($)} />
  if (add.step === 'blocked' || add.step === 'failed') {
    return (
      <Box key="add-msg" flexDirection="column">
        <Text color="warning">{add.reason}</Text>
        <Box flexDirection="row" gap={1}>
          {add.step === 'failed' && <Button key="add-retry" label="再試一次" onPress={() => startAdd($)} />}
          <Button key="add-close" label="知道了" onPress={() => update($, addAtom, () => null)} />
        </Box>
      </Box>
    )
  }
  if (add.step === 'waiting') {
    if (addTimer === null) pollAdd($, add.id, add.resultPath, add.startedAt)
    return (
      <Box key="add-wait" flexDirection="column">
        <Text>已開登入視窗：在那個視窗用瀏覽器登入要加的帳號，再把憑證貼進去。</Text>
        <Text dimColor>完成後這裡會自動往下一步。</Text>
        <Button key="add-cancel" label="取消" onPress={() => discardAdd($)} />
      </Box>
    )
  }
  const form = await read($, addFormAtom)
  const accounts = await read($, accountsAtom)
  const current = await read($, currentAtom)
  const verdict = add.orgId ? classifyOrg(accounts, current, add.orgId) : null
  const known = verdict?.kind === 'known' ? verdict.account : undefined
  const orgName = add.orgId ? (Object.values(accounts).find(a => a.orgId === add.orgId)?.orgName ?? null) : null
  const suggested = known ? known.label : defaultLabel({ email: form.email.trim() || null, orgName }, Object.values(accounts).map(a => a.label))
  const labelInput = (
    <Input
      key="add-label"
      label="名稱"
      value={form.label}
      placeholder={`沒填就叫「${suggested}」`}
      onInput={v => update($, addFormAtom, f => ({ ...f, label: v }))}
      onSubmit={v => update($, addFormAtom, f => ({ ...f, label: v }))}
    />
  )
  if (verdict?.kind === 'current-org') {
    // 多半就是目前這個帳號：預設是刪掉；真的是同組織的另一個帳號才另外確認
    const cur = current ? accounts[current] : undefined
    return (
      <Box key="add-form" flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="warning">{`這組憑證屬於目前帳號「${cur?.label ?? ''}」的組織${orgName ? `（${orgName}）` : ''}。`}</Text>
        <Text>你在這個組織只有一個帳號的話，它就是目前這個帳號，用它接著做不會多出用量。多半是瀏覽器剛好登著目前的帳號：到瀏覽器登出（或開無痕視窗）再新增一次。</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="add-discard" label="不要了，刪掉這組憑證" variant="primary" onPress={() => discardAdd($)} />
          <Button key="add-save" label="確定是同組織的另一個帳號，加入" dimColor onPress={() => finishAdd($)} />
        </Box>
      </Box>
    )
  }
  const orgs = new Map<string, string>()
  for (const a of Object.values(accounts)) if (a.orgId) orgs.set(a.orgId, a.orgName ?? `${a.label} 的組織`)
  return (
    <Box key="add-form" flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="success">{`憑證已存好（${CREDENTIAL_TEXT[add.credential]}）。最後填一下：`}</Text>
      {known ? (
        <Text>{`看起來是已經認得的「${known.label}」（同一個組織）：按加入會更新它的登入憑證，不會多一筆。`}</Text>
      ) : add.orgId ? (
        <Text>這組憑證屬於另一個組織，不是目前帳號的。</Text>
      ) : (
        <Text color="warning">查不出這組憑證屬於哪個組織（連不上 Claude）。請自己確認登入的不是目前這個帳號。</Text>
      )}
      {labelInput}
      {!known && (
        <Input
          key="add-email"
          label="信箱（只用來顯示，可以空著）"
          value={form.email}
          onInput={v => update($, addFormAtom, f => ({ ...f, email: v }))}
          onSubmit={v => update($, addFormAtom, f => ({ ...f, email: v }))}
        />
      )}
      {!add.orgId && (
        <Box key="add-manual" flexDirection="column">
          <Select
            key="add-org"
            label="這個帳號屬於"
            options={[...[...orgs].map(([value, label]) => ({ value, label })), { value: '', label: '個人或其他組織' }]}
            value={form.org}
            onSelect={v => update($, addFormAtom, f => ({ ...f, org: v }))}
          />
          <Text dimColor>這裡由你說。信箱和桌面 app 登入過的帳號相同時，會直接併在一起。</Text>
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        <Button key="add-save" label="加入" variant="primary" onPress={() => finishAdd($)} />
        <Button key="add-discard" label="不要了" onPress={() => discardAdd($)} />
      </Box>
    </Box>
  )
}

// ── 一個一個加資料夾：同步頁（要同步的）與切換頁（只換同組織的）共用 ──

type PickerTarget = 'sync' | 'switch'
type PickerRow = { path: string; note: string }

async function changePicked($: $, target: PickerTarget, change: (list: string[]) => string[]): Promise<void> {
  if (target === 'sync') await putSync($, s => ({ ...s, folders: change(s.folders) }))
  else await putSwitch($, s => ({ ...s, restricted: change(s.restricted) }))
}

async function addPicked($: $, target: PickerTarget, text: string): Promise<void> {
  const path = normalizeFolder(text)
  if (path !== null) await changePicked($, target, list => (list.includes(path) ? list : [...list, path]))
}

/** 已加入的一列一列、各自可以移除；下面三種加法：這個對話的資料夾、從清單挑、輸入路徑。 */
function drawFolderPicker($: $, ui: UI, target: PickerTarget, view: { title: string; picked: PickerRow[]; choices: PickerRow[]; cwd: string; hint: string }) {
  const { Box, Text, Button, Input, Select } = ui
  const p = target === 'sync' ? 'sy' : 'sw'
  const has = (path: string) => view.picked.some(r => r.path === path)
  return (
    <Box key={`${p}-picker`} flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{`${view.title}（${view.picked.length}）`}</Text>
        {view.picked.length === 0 && <Text dimColor>還沒加入任何資料夾，用下面的方式加。</Text>}
        {view.picked.map(r => (
          <Box key={`${p}-row-${r.path}`} flexDirection="row" gap={1}>
            <Text wrap="truncate-start">
              {r.path} <Text dimColor>{r.note}</Text>
            </Text>
            <Button key={`${p}-del-${r.path}`} label="移除" dimColor onPress={() => changePicked($, target, list => list.filter(f => f !== r.path))} />
          </Box>
        ))}
      </Box>
      {!has(view.cwd) && <Button key={`${p}-add-here`} label={`＋ 加入這個對話的資料夾（${view.cwd}）`} onPress={() => addPicked($, target, view.cwd)} />}
      {view.choices.length > 0 && (
        <Select
          key={`${p}-add`}
          label="從清單加入"
          options={[{ value: '', label: `（還有 ${view.choices.length} 個資料夾可以加）` }, ...view.choices.map(r => ({ value: r.path, label: `${r.path}　${r.note}` }))]}
          value=""
          onSelect={v => addPicked($, target, v)}
        />
      )}
      <Input key={`${p}-add-path`} label="或輸入資料夾路徑" value="" placeholder="例如 /home/me/work/api，按 Enter 加入" onSubmit={v => addPicked($, target, v)} />
      <Text dimColor>{view.hint}</Text>
    </Box>
  )
}

async function drawSwitch($: $, ui: UI) {
  const { Box, Text, Button, Select } = ui
  const sw = await read($, switchAtom)
  const accounts = await read($, accountsAtom)
  const current = await read($, currentAtom)
  const platform = await read($, platformAtom)
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  const order = orderedIds(accounts, sw.order)
  const why = new Map(current ? candidates(accounts, current, sw, cwd, now).map(c => [c.account.id, c.why]) : [])
  // 從清單加入的候選：桌面 app 各帳號對話的資料夾（含對話數），還沒限制的
  const desktop = await read($, desktopAtom)
  const totals = new Map<string, number>()
  for (const prof of desktop?.profiles ?? []) for (const f of prof.folders) totals.set(f.path, (totals.get(f.path) ?? 0) + f.sessions)
  const noteOf = (path: string) => (totals.get(path) ? `${totals.get(path)} 個對話` : '')
  const choices = [...totals.keys()].filter(path => !sw.restricted.includes(path)).sort((x, y) => (totals.get(y) ?? 0) - (totals.get(x) ?? 0))
  return (
    <Box flexDirection="column" gap={1}>
      {pageHead(ui, 'sw-head', '切換', '用量快用完時，輸入框上方提醒你，一鍵換另一個帳號接著做。')}
      {sectionHead(ui, 'sw-alert-head', '提醒')}
      <Select
        key="sw-on"
        label="用量切換"
        options={[
          { value: 'on', label: '開' },
          { value: 'off', label: '關' },
        ]}
        value={sw.on ? 'on' : 'off'}
        onSelect={v => putSwitch($, s => ({ ...s, on: v === 'on' }))}
      />
      <Select
        key="sw-five"
        label="5 小時用量達到"
        options={FIVE_HOUR_CHOICES.map(n => ({ value: String(n), label: `${n}% 時提醒` }))}
        value={String(sw.fiveHour)}
        onSelect={v => putSwitch($, s => ({ ...s, fiveHour: Number(v) }))}
      />
      <Select
        key="sw-seven"
        label="7 天用量達到"
        options={[...SEVEN_DAY_CHOICES.map(n => ({ value: String(n), label: `${n}% 時提醒` })), { value: 'off', label: '不看 7 天' }]}
        value={sw.sevenDay === null ? 'off' : String(sw.sevenDay)}
        onSelect={v => putSwitch($, s => ({ ...s, sevenDay: v === 'off' ? null : Number(v) }))}
      />
      {fine(ui, '到門檻時，輸入框上方會出現提示，按了才換。')}

      {sectionHead(ui, 'sw-order-head', '換到哪個帳號', '由上往下找第一個能接手的。')}
      {order.length < 2 && <Text dimColor>要兩個以上的帳號才換得過去，到「帳號」頁新增。</Text>}
      {order.map((id, i) => {
        const a = accounts[id] as BraidAccount
        const note = id === current ? '這個對話在用' : WHY_TEXT[why.get(id) ?? 'ok']
        return (
          <Box key={`ord-${id}`} flexDirection="row" gap={1}>
            <Text wrap="truncate">
              {`${i + 1}. `}
              <Text color={a.color}>●</Text> <Text weight="semibold">{a.label}</Text> <Text dimColor>{note}</Text>
            </Text>
            {i > 0 && (
              <Button
                key={`up-${id}`}
                label="上移"
                dimColor
                onPress={() =>
                  putSwitch($, s => {
                    const next = orderedIds(accounts, s.order)
                    const at = next.indexOf(id)
                    if (at > 0) [next[at - 1], next[at]] = [next[at] as string, next[at - 1] as string]
                    return { ...s, order: next }
                  })
                }
              />
            )}
          </Box>
        )
      })}

      {sectionHead(ui, 'sw-scope-head', '資料夾')}
      <Select
        key="sw-scope"
        label="範圍"
        options={[
          { value: 'all', label: '全部資料夾都能換到任何帳號（建議）' },
          { value: 'restrict', label: '有些資料夾只換同組織的帳號' },
        ]}
        value={sw.restrict ? 'restrict' : 'all'}
        onSelect={v => putSwitch($, s => ({ ...s, restrict: v === 'restrict' }))}
      />
      {sw.restrict &&
        drawFolderPicker($, ui, 'switch', {
          title: '只換同組織帳號的資料夾',
          picked: sw.restricted.map(path => ({ path, note: noteOf(path) })),
          choices: choices.map(path => ({ path, note: noteOf(path) })),
          cwd,
          hint: '例如公司專案：在這些資料夾（含子資料夾）不會換到個人帳號。',
        })}
      {platform !== 'other' && fine(ui, '在桌面 app 按「接著做」，會開一個終端機視窗用另一個帳號接著。')}
    </Box>
  )
}

async function drawSync($: $, ui: UI) {
  const { Box, Text, Button, Select } = ui
  const platform = await read($, platformAtom)
  if (platform === 'other') {
    return <Text>CLI 的對話不分帳號：換帳號後用 claude --resume 就看得到全部，不需要同步。同步是給桌面 app 的側欄用的。</Text>
  }
  const desktop = await read($, desktopAtom)
  if (desktop === null) return <Text dimColor>讀取桌面 app 的資料中…</Text>
  const sy = await read($, syncAtom)
  const accounts = await read($, accountsAtom)
  const current = await read($, currentAtom)
  const partner = partnerOf(sy, current)
  const known = [...new Set([...desktop.profiles.map(p => p.account), ...Object.values(accounts).filter(a => a.source === 'desktop').map(a => a.id)])].filter(id => id !== current)
  const rows = current && partner ? syncRows(desktop.profiles, current, partner, sy.folders) : []
  const cwd = await $.session.cwd()
  const partnerName = partner ? nameOf(accounts, partner, desktop.profiles) : ''
  const hint = sy.pair.length === 2 && !partner ? `目前的同步設定是「${nameOf(accounts, sy.pair[0] as string, desktop.profiles)}」和「${nameOf(accounts, sy.pair[1] as string, desktop.profiles)}」，這個對話的帳號不在裡面。` : null
  const request = syncRequest(sy, partner)
  // 兩邊的組織不確定相同（braid 不認得對方、或組織不同）：全部同步會把個人專案也帶過去，要講清楚
  const mineOrg = current ? accounts[current]?.orgId : undefined
  const theirOrg = partner ? accounts[partner]?.orgId : undefined
  const crossOrg = !mineOrg || !theirOrg || mineOrg !== theirOrg
  const byPath = new Map(rows.map(r => [r.path, r]))
  const counts = (path: string) => {
    const r = byPath.get(path)
    return r && r.mine + r.theirs > 0 ? `目前 ${r.mine} · ${partnerName} ${r.theirs}` : '兩邊都還沒有對話'
  }
  const drawSyncAll = () => (
    <Box key="sy-all-box" flexDirection="column">
      {fine(ui, `目前兩個帳號共 ${rows.length} 個資料夾，之後新出現的也算。`)}
      {crossOrg && <Text color="warning">這兩個帳號可能不在同一個組織：全部同步會連個人專案的對話也一起帶過去，反過來也一樣。要分開，改成「只同步我挑的資料夾」。</Text>}
    </Box>
  )
  const drawSyncPicked = () =>
    drawFolderPicker($, ui, 'sync', {
      title: '要同步的資料夾',
      picked: sy.folders.map(path => ({ path, note: counts(path) })),
      choices: rows.filter(r => !sy.folders.includes(r.path)).map(r => ({ path: r.path, note: counts(r.path) })),
      cwd,
      hint: '路徑要和桌面 app 對話的資料夾完全一樣（子資料夾要另外加）。',
    })
  return (
    <Box flexDirection="column" gap={1}>
      {pageHead(ui, 'sy-head', '同步', '桌面 app 的兩個帳號自動同步側欄對話；額度用完，在 app 換過去就能接著做。')}
      {drawMirrorStatus($, ui, sy, accounts, await read($, mirrorAtom), await $.clock.now())}

      {sectionHead(ui, 'sy-set-head', '設定')}
      <Select
        key="sy-on"
        label="同步"
        options={[
          { value: 'on', label: '開' },
          { value: 'off', label: '關' },
        ]}
        value={sy.on ? 'on' : 'off'}
        onSelect={v => putSync($, s => ({ ...s, on: v === 'on' }))}
      />
      {!current && fine(ui, '認不出這個對話用的是哪個帳號，請在桌面 app 的對話裡打開 braid。')}
      {current && (
        <Select
          key="sy-partner"
          label="和哪個帳號同步"
          options={[{ value: '', label: '（選一個）' }, ...known.map(id => ({ value: id, label: nameOf(accounts, id, desktop.profiles) }))]}
          value={partner ?? ''}
          onSelect={v => putSync($, s => ({ ...s, pair: v ? [current, v] : [] }))}
        />
      )}
      {hint && fine(ui, hint)}
      {partner && (
        <Box key="sy-scope-box" flexDirection="column" gap={1}>
          <Select
            key="sy-scope"
            label="同步範圍"
            options={[
              { value: 'all', label: '全部資料夾（建議，之後新出現的也算）' },
              { value: 'picked', label: '只同步我挑的資料夾' },
            ]}
            value={sy.all ? 'all' : 'picked'}
            onSelect={v => putSync($, s => ({ ...s, all: v === 'all' }))}
          />
          {sy.all ? drawSyncAll() : drawSyncPicked()}
        </Box>
      )}

      {partner && (
        <Box key="sy-env-box" flexDirection="column" gap={1}>
          {sectionHead(ui, 'sy-env-head', '已儲存的環境', '存在 app 的內部資料庫，app 開著時寫不進去，所以不自動同步。要帶過來時按這裡：開獨立視窗，先結束 Claude，寫入前備份。')}
          {request && <Button key="sy-env" label={`從「${partnerName}」帶環境過來…`} onPress={async () => say($, await launchTool($, request))} />}
        </Box>
      )}

      {await drawBackups($, ui)}

      <Box key="sy-how" flexDirection="column">
        {sectionHead(ui, 'sy-how-head', '怎麼運作')}
        {fine(ui, '・桌面 app 開著時，大約每分鐘把現在登入的帳號的對話複製到另一個帳號；用量快用完時再馬上同步一次。', 'how-1')}
        {fine(ui, '・只寫沒登入的那個帳號：app 換帳號時才會重讀，所以不用結束 Claude。', 'how-2')}
        {fine(ui, '・刪除也跟著走；刪掉之後又在另一邊用過的不刪。被刪的那筆先存到備份。', 'how-3')}
        {fine(ui, '・對話內容本來就是電腦上同一個檔，兩邊看到的是同一份。', 'how-4')}
      </Box>
    </Box>
  )
}

/** 同步頁最上面的狀態卡：開著沒、從哪個帳號複製到哪個（帳號顏色）、上次結果；沒做成就說為什麼。 */
function drawMirrorStatus($: $, ui: UI, sy: BraidSync, accounts: Record<string, BraidAccount>, m: BraidMirror | null, now: number) {
  const { Box, Text, Button } = ui
  const name = (id: string, org: string | null = null) => mirrorName(accounts, id, org)
  const card = (tone: 'success' | 'warning' | undefined, title: string, lines: (string | null)[], flow: boolean) => (
    <Box key="sy-status" flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Text color={tone} weight="semibold">
          {title}
        </Text>
        {sy.on && sy.pair.length === 2 && <Button key="sy-now" label="現在同步" onPress={() => runMirror($, 'now')} />}
      </Box>
      {flow && m?.active && m.to ? (
        <Box key="sy-flow" flexDirection="row">
          <Text>
            {chip(ui, mirrorLook(accounts, m.active, null))}
            <Text dimColor>{'  →  '}</Text>
            {chip(ui, mirrorLook(accounts, m.to, m.toOrg))}
          </Text>
        </Box>
      ) : null}
      {lines.filter((l): l is string => l !== null).map((l, i) => fine(ui, l, `sy-line-${i}`))}
    </Box>
  )
  if (!sy.on || sy.pair.length !== 2) return card(undefined, '○ 沒開', ['打開下面的「同步」、選一個帳號，對話就會自動跟過去。'], false)
  if (!m) return card('success', '● 自動同步中', ['還沒同步過，馬上開始。'], false)
  const problem: Record<NonNullable<BraidMirror['problem']>, string> = {
    'no-desktop': '找不到桌面 app 的資料夾。',
    'no-active': '讀不到桌面 app 現在登入哪個帳號。',
    'no-spec': '讀不到同步規則（tool/spec.json），請重新安裝 braid。',
    'no-target': `「${m.to ? name(m.to) : ''}」還沒在桌面 app 用過 Code 分頁：先在 app 登入它、開一個對話，之後才同步得過去。`,
    failed: `上次同步失敗：${m.detail ?? '原因不明'}`,
  }
  if (m.problem) return card('warning', '⚠ 沒同步成', [problem[m.problem]], false)
  if (m.active && !sy.pair.includes(m.active)) return card(undefined, '○ 暫停', [`桌面 app 現在登入的是「${name(m.active)}」，不在這一對裡，先不同步。`], false)
  if (!m.to) return card(undefined, '○ 暫停', [sy.all || sy.folders.length > 0 ? '等下一次同步。' : '還沒挑要同步的資料夾。'], false)
  const counts = [m.created && `新增 ${m.created}`, m.updated && `更新 ${m.updated}`, m.deleted && `刪除 ${m.deleted}`].filter(Boolean)
  return card(
    'success',
    '● 自動同步中',
    [`對話會自動複製到「${name(m.to, m.toOrg)}」：換過去就看得到，不用結束 Claude。`, `上次同步 ${ago(now - m.at)}：${counts.length > 0 ? counts.join('、') : '已經一樣了'}`],
    true,
  )
}

/** 備份：保留多久（使用者選）、現在有多少、整份備份可以還原。同步頁與遷移頁共用。 */
async function drawBackups($: $, ui: UI) {
  const { Box, Text, Button, Select } = ui
  const desktop = await read($, desktopAtom)
  if (!desktop || desktop.error) return null
  const keep = await read($, keepAtom)
  return (
    <Box key="bk-box" flexDirection="column" gap={1}>
      {sectionHead(ui, 'bk-head', '備份', desktop.backupRoot ? `都放在 ${desktop.backupRoot}` : undefined)}
      <Box key="bk-days-box" flexDirection="column">
        <Select
          key="keep-days"
          label="同步刪掉的對話"
          options={[
            ...KEEP_DAYS_CHOICES.map(n => ({ value: String(n), label: n === DEFAULT_KEEP.deletedDays ? `留 ${n} 天（建議）` : `留 ${n} 天` })),
            { value: 'forever', label: '一直留著' },
          ]}
          value={keep.deletedDays === null ? 'forever' : String(keep.deletedDays)}
          onSelect={v => putKeep($, k => ({ ...k, deletedDays: v === 'forever' ? null : Number(v) }))}
        />
        {fine(ui, `目前 ${desktop.trash.count} 筆、${fmtBytes(desktop.trash.bytes)}。同步刪掉一段對話前，先把它的側欄紀錄存一份。`)}
      </Box>
      <Box key="bk-copies-box" flexDirection="column">
        <Select
          key="keep-copies"
          label="遷移與帶環境的整份備份"
          options={[
            ...KEEP_COPIES_CHOICES.map(n => ({ value: String(n), label: n === DEFAULT_KEEP.toolCopies ? `留最新 ${n} 份（建議）` : `留最新 ${n} 份` })),
            { value: 'all', label: '全部留著' },
          ]}
          value={keep.toolCopies === null ? 'all' : String(keep.toolCopies)}
          onSelect={v => putKeep($, k => ({ ...k, toolCopies: v === 'all' ? null : Number(v) }))}
        />
        {fine(ui, `目前 ${desktop.backups.length} 份。工具寫入前會整份備份一次，可以還原。`)}
      </Box>
      {desktop.backups.slice(0, 5).map(b => (
        <Box key={`bk-${b.name}`} flexDirection="row" gap={1} alignItems="center">
          <Text tabular>{backupLabel(b.name)}</Text>
          <Button key={`restore-${b.name}`} label="還原…" dimColor onPress={async () => say($, await launchTool($, { restore: b.dir }))} />
        </Box>
      ))}
    </Box>
  )
}

async function drawMigrate($: $, ui: UI) {
  const { Box, Text, Button } = ui
  const platform = await read($, platformAtom)
  if (platform === 'other') return <Text>Claude 桌面 app 只有 Windows 與 macOS 版，這台電腦上沒有桌面 app 的資料可以遷移。</Text>
  const desktop = await read($, desktopAtom)
  if (desktop === null) return <Text dimColor>讀取桌面 app 的資料中…</Text>
  const accounts = await read($, accountsAtom)
  const current = await read($, currentAtom)
  const tz = await read($, tzAtom)
  const cur = current ? accounts[current] : undefined
  const sources = desktop.profiles.filter(p => p.account !== current)
  return (
    <Box flexDirection="column" gap={1}>
      {pageHead(ui, 'mig-head', '遷移', '換帳號後，舊帳號在 Code 分頁的對話和已儲存的環境會不見。這裡把它們複製到現在登入的帳號。')}
      {sectionHead(ui, 'mig-to-head', '搬到這裡')}
      <Text>
        {cur?.source === 'desktop' ? `${cur.label}${cur.email ? `（${cur.email}）` : ''}` : '桌面 app 現在登入的帳號'}
        <Text dimColor>　工具寫入前會顯示信箱讓你確認</Text>
      </Text>
      {sectionHead(ui, 'mig-from-head', '這台電腦上其他帳號的資料')}
      {desktop.error && <Text color="warning">讀不到桌面 app 的資料。</Text>}
      {!desktop.error && sources.length === 0 && <Text dimColor>沒有其他帳號的對話。</Text>}
      {sources.map(p => (
        <Box key={`src-${p.account}-${p.org}`} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text>
            <Text bold>{nameOf(accounts, p.account, desktop.profiles)}</Text>
            <Text dimColor>{p.lastActivity ? `  最近 ${dateOf(p.lastActivity, tz)}` : ''}</Text>
          </Text>
          <Text>{`${p.sessions} 個對話 · ${p.folders.length} 個資料夾`}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key={`mig-dry-${p.account}-${p.org}`} label="試跑" onPress={async () => say($, await launchTool($, { dryRun: true, from: p.account }))} />
            <Button key={`mig-run-${p.account}-${p.org}`} label="開始遷移…" variant="primary" onPress={async () => say($, await launchTool($, { from: p.account }))} />
          </Box>
        </Box>
      ))}
      {fine(ui, '開始之後：勾選要搬的資料夾與環境 → 結束 Claude（系統匣或選單列）→ 確認信箱、輸入 Y → 搬完問你要不要重開。')}
      {await drawBackups($, ui)}
      <Button key="rescan" label="重新讀取" dimColor onPress={() => ensureDesktop($, true)} />
    </Box>
  )
}

// ── 註冊 ────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'braid',
      description: 'Claude 帳號工具：打開面板管理帳號、用量切換、同步；migrate＝桌面 app 換帳號後把舊對話搬過來',
      argumentHint: '[帳號|切換|同步|migrate [試跑]]',
    })
    const platform = await detectPlatform($)
    await update($, platformAtom, () => platform)
    const tz = await localTz($, platform)
    await update($, tzAtom, () => tz)
    await loadStore($)
    const seen = await seenNow($)
    if (seen) {
      const account = upsertSeen(await read($, accountsAtom), seen, await $.clock.now())
      await putAccount($, account)
      await update($, currentAtom, () => account.id)
    }
    // 自動同步：開始後先做一次，之後每分鐘一次（沒開同步時 runMirror 直接回來）
    mirrorTimer?.cancel()
    mirrorTimer = $.clock.every(MIRROR_EVERY_MS, async () => {
      await runMirror($, 'tick')
      await runPrune($)
    })
    $.clock.after(3_000, async () => {
      await runMirror($, 'tick')
      await runPrune($)
    })
    try {
      await onUsage($, (await $.session.usage()).rateLimits)
    } catch {
      // 還沒有用量
    }
    await refreshStatus($)
    return started
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await onUsage($, e.rateLimits)
    return next(e)
  })

  on('command.run', { command: 'braid' }, async ($, e) => {
    const { action, word, rest } = parseCommand(e.args)
    if (!word) {
      await openPane($)
      return { text: '已打開 braid 面板。' }
    }
    if (!action) return { text: help(`沒有「${word}」這個動作。`) }
    switch (action.name) {
      case 'migrate':
        return { text: await migrate($, rest) }
      case 'accounts':
      case 'switch':
      case 'sync':
        await openPane($, action.name)
        return { text: '已打開 braid 面板。' }
    }
  })

  // 交給另一個帳號接著做之後，在這裡再送訊息要先確認一次：兩邊各做各的，最後會分岔
  on('prompt.submit', async ($, e, next) => {
    const handed = await read($, handoffAtom)
    if (!handed || handed.confirmed || e.text.trimStart().startsWith('/')) return next(e)
    await update($, handoffAtom, v => (v ? { ...v, confirmed: true } : v))
    return { drop: `這段對話已經交給「${handed.label}」在新視窗接著做（那邊是複製出來的新對話）。確定要在這裡繼續，就再送一次。` }
  })

  // ── 輸入框上方：交給另一個帳號之後的提醒、用量快到門檻時提示換帳號 ──
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const uses = await read($, usesAtom)
    const accounts = await read($, accountsAtom)
    const current = await read($, currentAtom)

    // 變數不能叫 h：JSX 編譯成全域的 h(...)，同名的區域變數會把它蓋掉
    const handed = await read($, handoffAtom)
    if (handed && !handed.noticed) {
      return (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color="success" bold>
            braid
          </Text>
          <Text wrap="truncate">{`已在新視窗用「${handed.label}」接著做（複製出來的新對話）。在這裡再送訊息會先問你。`}</Text>
          <Button key="handoff-ok" label="知道了" role="dismiss" onPress={() => update($, handoffAtom, v => (v ? { ...v, noticed: true } : v))} />
        </Box>
      )
    }

    if (!uses?.switch) return next(e)
    const now = await $.clock.now()
    const band = bandFor(accounts, current, await read($, liveAtom), await read($, switchAtom), await $.session.cwd(), now, await read($, snoozeAtom))
    if (!band || !current) return next(e)
    const cur = accounts[current] as BraidAccount
    const reset = fmtReset(band.resetsAt, now, await read($, tzAtom))
    const head = band.kind === 'out' ? `${cur.label} ${WINDOW_NAMES[band.window]}用量用完了` : `${cur.label} ${WINDOW_NAMES[band.window]}用量 ${band.pct}%`
    const best = band.best
    // 桌面 app 的這個帳號有在自動同步：對話已經複製到另一個帳號，在 app 換過去就能接著做
    const sy = await read($, syncAtom)
    const m = await read($, mirrorAtom)
    const synced = uses.sync && sy.on && m && m.active === current && m.to && !m.problem ? mirrorName(accounts, m.to, m.toOrg) : null
    const detail = best
      ? synced
        ? `「${best.label}」可以在新視窗接著這段對話；或在桌面 app 換成「${synced}」，對話都已同步過去。`
        : `「${best.label}」可以接手：在新視窗接著這段對話。`
      : synced
        ? `在桌面 app 換成「${synced}」就能接著做，對話都已同步過去。`
        : band.manual
          ? `可以在桌面 app 換成「${band.manual.label}」；在 braid 開啟同步，對話就會自動跟過去。`
          : '沒有其他帳號可以接手；在 braid 面板可以新增。'
    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color="warning" bold>
            braid
          </Text>{' '}
          {head}
          {reset ? `，${reset} 重置` : ''}。<Text dimColor>{detail}</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          {best ? (
            <Button key="band-handoff" label={`用「${best.label}」接著做`} variant="primary" onPress={() => handoff($, best.id)} />
          ) : (
            <Button key="band-open" label="打開 braid" onPress={() => openPane($, 'switch')} />
          )}
          <Button key="band-snooze" label={reset ? `${reset} 前別再提醒` : '先別提醒'} role="dismiss" onPress={() => snooze($, band.snoozeKey)} />
        </Box>
      </Box>
    )
  })

  // ── 面板 ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)
      const accounts = await read($, accountsAtom)
      const current = await read($, currentAtom)
      return (
        <Box flexDirection="column">
          <Text>{current ? `目前：${nameOf(accounts, current)}` : '認不出目前的帳號'}</Text>
          <Text dimColor>braid 的設定請在電腦上改。</Text>
        </Box>
      )
    }
    const ui = $.ui.resolve(e) as unknown as UI
    const { Box, Text, Button } = ui
    const uses = await read($, usesAtom)
    const editing = await read($, editingAtom)
    if (uses === null || editing === 'uses') return drawOnboarding($, ui)

    const tabs: { id: BraidTab; label: string }[] = [
      { id: 'accounts', label: '帳號' },
      ...(uses.switch ? [{ id: 'switch' as const, label: '切換' }] : []),
      ...(uses.sync ? [{ id: 'sync' as const, label: '同步' }] : []),
      ...(uses.migrate ? [{ id: 'migrate' as const, label: '遷移' }] : []),
    ]
    const saved = await read($, tabAtom)
    const tab = tabs.some(t => t.id === saved) ? saved : 'accounts'
    const notice = await read($, noticeAtom)
    const body =
      tab === 'switch'
        ? await drawSwitch($, ui)
        : tab === 'sync'
          ? await drawSync($, ui)
          : tab === 'migrate'
            ? await drawMigrate($, ui)
            : await drawAccounts($, ui, e.props.bodyColumns)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {tabs.map(t => (
            <Button key={`tab-${t.id}`} label={t.label} variant={t.id === tab ? 'primary' : undefined} dimColor={t.id !== tab} onPress={() => setTab($, t.id)} />
          ))}
          <Button
            key="tab-uses"
            label="用法"
            dimColor
            onPress={async () => {
              await update($, draftUsesAtom, () => uses)
              await update($, editingAtom, () => 'uses')
            }}
          />
        </Box>
        {notice && <Text color="warning">{notice}</Text>}
        {body}
      </Box>
    )
  })
}
