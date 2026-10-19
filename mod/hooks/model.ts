// braid 的資料模型與純邏輯：帳號、用量、換帳號的規則、同步範圍。不碰 $，全部可以單獨測。
// 三種用法共用同一份帳號清單：遷移與同步看桌面 app 的側欄資料，用量切換看每個帳號的用量與憑證。
import type {
  BraidAccount,
  BraidProfile,
  BraidSwitch,
  BraidSync,
  BraidUsage,
  BraidUses,
  BraidWindow,
} from '../types'

// 帳號的顏色：亮度彼此拉開，色弱也分得出來；畫面上一律另外寫帳號名稱，不只靠顏色
export const PALETTE = ['#3B6FE0', '#14A38E', '#D9822B', '#8E6BD8', '#C2417A'] as const
export const COLOR_NAMES: Record<string, string> = {
  '#3B6FE0': '藍',
  '#14A38E': '青綠',
  '#D9822B': '橘',
  '#8E6BD8': '紫',
  '#C2417A': '桃紅',
}

export const DEFAULT_USES: BraidUses = { migrate: false, switch: false, sync: false }
export const DEFAULT_SWITCH: BraidSwitch = { on: true, fiveHour: 90, sevenDay: 95, order: [], restrict: false, restricted: [] }
export const DEFAULT_SYNC: BraidSync = { on: false, pair: [], all: true, folders: [], when: 'on-switch' }
export const FIVE_HOUR_CHOICES = [80, 90, 95] as const
export const SEVEN_DAY_CHOICES = [90, 95] as const

// ── 從儲存讀回來的資料：舊版或壞掉的值一律換成預設，不讓畫面因為一筆壞資料整個掛掉 ──

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)
const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback)

export function normalizeUses(x: unknown): BraidUses | null {
  if (!isObj(x)) return null
  return { migrate: x.migrate === true, switch: x.switch === true, sync: x.sync === true }
}

export function normalizeSwitch(x: unknown): BraidSwitch {
  if (!isObj(x)) return { ...DEFAULT_SWITCH }
  return {
    on: x.on !== false,
    fiveHour: num(x.fiveHour, DEFAULT_SWITCH.fiveHour),
    sevenDay: x.sevenDay === null ? null : num(x.sevenDay, DEFAULT_SWITCH.sevenDay ?? 95),
    order: Array.isArray(x.order) ? x.order.filter((v): v is string => typeof v === 'string') : [],
    restrict: x.restrict === true,
    restricted: Array.isArray(x.restricted) ? x.restricted.filter((v): v is string => typeof v === 'string' && v !== '') : [],
  }
}

export function normalizeSync(x: unknown): BraidSync {
  if (!isObj(x)) return { ...DEFAULT_SYNC }
  const folders = Array.isArray(x.folders) ? x.folders.filter((v): v is string => typeof v === 'string' && v !== '') : []
  return {
    on: x.on === true,
    pair: Array.isArray(x.pair) ? x.pair.filter((v): v is string => typeof v === 'string' && v !== '').slice(0, 2) : [],
    // 預設全部；沒有 all 欄位的舊設定，挑過資料夾的維持只同步挑的
    all: x.all === true || (x.all === undefined && folders.length === 0),
    folders,
    when: x.when === 'manual' ? 'manual' : 'on-switch',
  }
}

/** 使用者輸入的資料夾路徑：去掉前後空白、貼上時常帶的引號、結尾的斜線（根目錄除外）；空的回 null。 */
export function normalizeFolder(text: string): string | null {
  const t = text.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  if (!t) return null
  const stripped = t.replace(/[\\/]+$/, '')
  if (stripped === '') return t.startsWith('/') ? '/' : null
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`
  return stripped
}

function normalizeWindow(x: unknown): BraidWindow | null {
  if (!isObj(x) || typeof x.pct !== 'number') return null
  return { pct: x.pct, resetsAt: str(x.resetsAt) }
}

export function normalizeAccount(x: unknown): BraidAccount | null {
  if (!isObj(x) || !str(x.id)) return null
  const usage = isObj(x.usage) ? { fiveHour: normalizeWindow(x.usage.fiveHour), sevenDay: normalizeWindow(x.usage.sevenDay), at: num(x.usage.at, 0) } : null
  const credential = x.credential === 'keychain' || x.credential === 'secret-service' || x.credential === 'file' || x.credential === 'credman' ? x.credential : null
  return {
    id: x.id as string,
    email: str(x.email),
    orgId: str(x.orgId),
    orgName: str(x.orgName),
    label: str(x.label) ?? '帳號',
    color: str(x.color) ?? PALETTE[0],
    source: x.source === 'cli' || x.source === 'token' ? x.source : 'desktop',
    credential,
    credentialId: credential ? (str(x.credentialId) ?? (x.id as string)) : null,
    usage,
    lastSeen: num(x.lastSeen, 0),
  }
}

// ── 認出目前的帳號 ──

/** 一個對話看到的自己：桌面 app 給的環境變數、CLI 自己登入的資料、或 braid 開的視窗帶的帳號 id。 */
export type Seen = { id: string; email: string | null; orgId: string | null; orgName: string | null; source: BraidAccount['source'] }

/** CLI 自己登入的帳號，存在 ~/.claude.json 的 oauthAccount。 */
export function seenFromClaudeJson(text: string): Seen | null {
  try {
    const oa = (JSON.parse(text) as { oauthAccount?: unknown }).oauthAccount
    if (!isObj(oa) || !str(oa.accountUuid)) return null
    return { id: oa.accountUuid as string, email: str(oa.emailAddress), orgId: str(oa.organizationUuid), orgName: str(oa.organizationName), source: 'cli' }
  } catch {
    return null
  }
}

// 常見的個人信箱網域；桌面 app 只給信箱、不給組織名稱，靠這個猜是公司還是個人帳號（之後可以改名）
const PERSONAL_MAIL = /@(gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|mac|proton|protonmail|pm|qq|163|126|yeah|naver|kakao)\./i

/** 第一次看到的帳號叫什麼：有組織名稱用組織名稱，否則看信箱網域猜「公司」或「個人」。 */
export function defaultLabel(seen: Pick<Seen, 'email' | 'orgName'>, taken: readonly string[]): string {
  const org = seen.orgName
  const base = org && !org.includes('@') && !/personal|個人/i.test(org) ? org : seen.email && !PERSONAL_MAIL.test(seen.email) ? '公司' : '個人'
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`
}

/** 把看到的帳號併進清單：已知的更新信箱、組織與最後出現時間，名稱與顏色保留使用者改過的。 */
export function upsertSeen(accounts: Record<string, BraidAccount>, seen: Seen, now: number): BraidAccount {
  const old = accounts[seen.id]
  if (old) {
    return {
      ...old,
      email: seen.email ?? old.email,
      orgId: seen.orgId ?? old.orgId,
      orgName: seen.orgName ?? old.orgName,
      source: old.source === 'token' ? 'token' : seen.source,
      lastSeen: now,
    }
  }
  const all = Object.values(accounts)
  const used = all.map(a => a.color)
  return {
    id: seen.id,
    email: seen.email,
    orgId: seen.orgId,
    orgName: seen.orgName,
    label: defaultLabel(seen, all.map(a => a.label)),
    color: PALETTE.find(c => !used.includes(c)) ?? PALETTE[all.length % PALETTE.length] ?? PALETTE[0],
    source: seen.source,
    credential: null,
    credentialId: null,
    usage: null,
    lastSeen: now,
  }
}

// ── 新增帳號：這組憑證屬於哪個組織 ──

/** 組織 id 長這樣才收（新增帳號的腳本從 API 回應標頭讀來的）。 */
export const isOrgId = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-fA-F-]{36}$/.test(x)

export type OrgVerdict = { kind: 'current-org' } | { kind: 'known'; account: BraidAccount } | { kind: 'new' }

/**
 * 一年期憑證（setup-token）查不了帳號資料，只查得到組織，所以用組織判斷新增的憑證是誰：
 * - 和目前帳號同一個組織：一個人在一個組織通常只有一個帳號，多半就是目前這個帳號（瀏覽器剛好登著它）
 * - 正好有一個認得的帳號（不是目前這個）在這個組織：當成那個帳號，更新它的憑證
 * - 其他：新的帳號
 */
export function classifyOrg(accounts: Record<string, BraidAccount>, current: string | null, orgId: string): OrgVerdict {
  const cur = current ? accounts[current] : undefined
  if (cur?.orgId === orgId) return { kind: 'current-org' }
  const same = Object.values(accounts).filter(a => a.id !== current && a.orgId === orgId)
  return same.length === 1 && same[0] ? { kind: 'known', account: same[0] } : { kind: 'new' }
}

// ── 用量 ──

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export function usageFrom(rateLimits: readonly RateLimit[], at: number): BraidUsage | null {
  const pick = (kind: string): BraidWindow | null => {
    const w = rateLimits.find(r => r.kind === kind)
    return w ? { pct: w.percentUsed, resetsAt: w.resetsAt ?? null } : null
  }
  const fiveHour = pick('five_hour')
  const sevenDay = pick('seven_day')
  return fiveHour || sevenDay ? { fiveHour, sevenDay, at } : null
}

/** 已經過了重置時間的窗算 0：其他帳號顯示的是上次的數字，過了重置時間就不準了。 */
export function effectivePct(w: BraidWindow | null, now: number): number | null {
  if (!w) return null
  if (w.resetsAt && Date.parse(w.resetsAt) <= now) return 0
  return w.pct
}

/** 文字的用量條：█ 已用、░ 剩下。終端機與桌面都畫得出來。 */
export function meter(pct: number, width: number): { used: string; left: string } {
  const n = Math.max(0, Math.min(width, Math.round((Math.min(pct, 100) / 100) * width)))
  return { used: '█'.repeat(n), left: '░'.repeat(width - n) }
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const pad = (n: number) => String(n).padStart(2, '0')

/** 重置時間：24 小時內寫時間（隔天加「明天」），再遠寫日期與星期。tz＝當地與 UTC 差幾分鐘。 */
export function fmtReset(iso: string | null, now: number, tz: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const local = new Date(t + tz * 60_000)
  const today = new Date(now + tz * 60_000)
  const hm = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  const sameDay = local.getUTCFullYear() === today.getUTCFullYear() && local.getUTCMonth() === today.getUTCMonth() && local.getUTCDate() === today.getUTCDate()
  if (sameDay) return hm
  if (t - now < 24 * 3600_000) return `明天 ${hm}`
  return `${local.getUTCMonth() + 1}/${local.getUTCDate()}（${WEEKDAYS[local.getUTCDay()]}）`
}

/** 「+0800」或「+08:00」→ 480。看不懂就當 0。 */
export function parseTz(text: string): number {
  const m = /([+-])(\d{2}):?(\d{2})/.exec(text.trim())
  if (!m) return 0
  const v = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -v : v
}

// ── 換帳號 ──

/** 這個資料夾（含子資料夾）是不是設成只換同組織的帳號。預設不限制。 */
export function isRestricted(sw: BraidSwitch, cwd: string): boolean {
  if (!sw.restrict) return false
  return sw.restricted.some(f => cwd === f || cwd.startsWith(f.endsWith('/') || f.endsWith('\\') ? f : `${f}/`) || cwd.startsWith(`${f}\\`))
}

/** 依設定的順序排帳號；沒排到的照最近出現的時間排在後面。 */
export function orderedIds(accounts: Record<string, BraidAccount>, order: readonly string[]): string[] {
  const listed = order.filter(id => accounts[id])
  const rest = Object.values(accounts)
    .filter(a => !listed.includes(a.id))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(a => a.id)
  return [...listed, ...rest]
}

export type Why = 'ok' | 'other-org' | 'no-credential' | 'busy'

export type Candidate = { account: BraidAccount; why: Why }

/** 一個帳號是否也快用完：上次的數字超過門檻、而且還沒到重置時間。 */
export function isBusy(usage: BraidUsage | null, sw: BraidSwitch, now: number): boolean {
  if (!usage) return false
  const five = effectivePct(usage.fiveHour, now)
  const seven = effectivePct(usage.sevenDay, now)
  return (five !== null && five >= sw.fiveHour) || (sw.sevenDay !== null && seven !== null && seven >= sw.sevenDay)
}

/**
 * 其他帳號依順序，各自能不能接手、不能的話為什麼。
 * 只換同組織的資料夾：組織不明的帳號（braid 新增、使用者沒說是哪個組織）一律不算同組織。
 */
export function candidates(accounts: Record<string, BraidAccount>, currentId: string, sw: BraidSwitch, cwd: string, now: number): Candidate[] {
  const current = accounts[currentId]
  const sameOrgOnly = isRestricted(sw, cwd)
  return orderedIds(accounts, sw.order)
    .filter(id => id !== currentId)
    .map(id => {
      const account = accounts[id] as BraidAccount
      let why: Why = 'ok'
      if (sameOrgOnly && (!account.orgId || !current?.orgId || account.orgId !== current.orgId)) why = 'other-org'
      else if (!account.credential) why = 'no-credential'
      else if (isBusy(account.usage, sw, now)) why = 'busy'
      return { account, why }
    })
}

export type Band = {
  kind: 'warn' | 'out'
  window: 'five_hour' | 'seven_day'
  pct: number
  resetsAt: string | null
  /** 「先別提醒」記這個；快用完時按掉的，用完時還會再出現一次 */
  snoozeKey: string
  /** 可以一鍵接著做的帳號 */
  best: BraidAccount | null
  /** 沒有 braid 的憑證、但可以在桌面 app 手動換過去的帳號 */
  manual: BraidAccount | null
}

/** 輸入框上方要不要出現提示、說什麼。 */
export function bandFor(
  accounts: Record<string, BraidAccount>,
  currentId: string | null,
  live: BraidUsage | null,
  sw: BraidSwitch,
  cwd: string,
  now: number,
  snooze: string | null,
): Band | null {
  if (!sw.on || !currentId || !live || !accounts[currentId]) return null
  const five = effectivePct(live.fiveHour, now)
  const seven = effectivePct(live.sevenDay, now)
  let hit: Pick<Band, 'kind' | 'window' | 'pct' | 'resetsAt'> | null = null
  if (five !== null && five >= 100) hit = { kind: 'out', window: 'five_hour', pct: five, resetsAt: live.fiveHour?.resetsAt ?? null }
  else if (seven !== null && seven >= 100) hit = { kind: 'out', window: 'seven_day', pct: seven, resetsAt: live.sevenDay?.resetsAt ?? null }
  else if (five !== null && five >= sw.fiveHour) hit = { kind: 'warn', window: 'five_hour', pct: five, resetsAt: live.fiveHour?.resetsAt ?? null }
  else if (sw.sevenDay !== null && seven !== null && seven >= sw.sevenDay) hit = { kind: 'warn', window: 'seven_day', pct: seven, resetsAt: live.sevenDay?.resetsAt ?? null }
  if (!hit) return null
  const snoozeKey = `${currentId}|${hit.window}|${hit.resetsAt ?? ''}|${hit.kind}`
  if (snooze === snoozeKey) return null
  const list = candidates(accounts, currentId, sw, cwd, now)
  return {
    ...hit,
    snoozeKey,
    best: list.find(c => c.why === 'ok')?.account ?? null,
    manual: list.find(c => c.why === 'no-credential')?.account ?? null,
  }
}

export const WINDOW_NAMES = { five_hour: '5 小時', seven_day: '7 天' } as const

// ── 桌面 app 的側欄資料 ──

/** 同一個帳號在不同組織底下的資料夾併在一起。 */
export function foldersOf(profiles: readonly BraidProfile[], account: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of profiles) if (p.account === account) for (const f of p.folders) out.set(f.path, (out.get(f.path) ?? 0) + f.sessions)
  return out
}

export type SyncRow = { path: string; mine: number; theirs: number; checked: boolean }

/** 同步夥伴：一對帳號裡不是目前這個的那個；目前帳號不在這一對裡就沒有。 */
export function partnerOf(sync: BraidSync, current: string | null): string | null {
  if (!current || sync.pair.length !== 2 || !sync.pair.includes(current)) return null
  return sync.pair.find(id => id !== current) ?? null
}

/**
 * 同步要工具做什麼：全部資料夾（環境也全部），或勾選的資料夾（環境跟著資料夾走）；沒有範圍就是 null。
 * 同步頁的按鈕與換帳號後的提示都只用這一個，範圍怎麼算不會兩邊各寫一套。
 */
export function syncRequest(
  sync: BraidSync,
  partner: string | null,
): { from: string; projects: readonly string[] | 'all'; presets: 'all' | 'folders' } | null {
  if (!partner) return null
  if (sync.all) return { from: partner, projects: 'all', presets: 'all' }
  if (sync.folders.length === 0) return null
  return { from: partner, projects: sync.folders, presets: 'folders' }
}

/** 提示裡怎麼說同步範圍。 */
export function syncScopeText(sync: BraidSync): string {
  return sync.all ? '所有資料夾' : `同步的 ${sync.folders.length} 個資料夾`
}

/** 同步範圍的勾選清單：兩個帳號的資料夾聯集，勾過的排前面，其餘照對話數排。 */
export function syncRows(profiles: readonly BraidProfile[], mine: string, partner: string, picked: readonly string[]): SyncRow[] {
  const a = foldersOf(profiles, mine)
  const b = foldersOf(profiles, partner)
  const paths = new Set([...a.keys(), ...b.keys(), ...picked])
  return [...paths]
    .map(path => ({ path, mine: a.get(path) ?? 0, theirs: b.get(path) ?? 0, checked: picked.includes(path) }))
    .sort((x, y) => Number(y.checked) - Number(x.checked) || y.mine + y.theirs - (x.mine + x.theirs) || x.path.localeCompare(y.path))
}

/** 帳號 id 的短寫，給沒有信箱可顯示的帳號用。 */
export const short = (id: string) => `${id.slice(0, 8)}…`

/** 顯示用的帳號名稱：braid 認得的用名稱，不認得的寫「帳號 1111aaaa…」。 */
export function nameOf(accounts: Record<string, BraidAccount>, id: string): string {
  return accounts[id]?.label ?? `帳號 ${short(id)}`
}
