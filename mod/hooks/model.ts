// braid 的資料模型與純邏輯：帳號、用量、換帳號的規則、同步範圍。不碰 $，全部可以單獨測。
// 三種用法共用同一份帳號清單：遷移與同步看桌面 app 的側欄資料，用量切換看每個帳號的用量與憑證。
import type {
  BraidAccount,
  BraidKeep,
  BraidMirror,
  BraidMirrorProblem,
  BraidPlatform,
  BraidProfile,
  BraidSignIn,
  BraidSwitch,
  BraidSync,
  BraidUsage,
  BraidUses,
  BraidWindow,
} from '../types'

// 帳號的顏色：Claude 設計系統的類別色前五個，順序照驗證過的那組（dataviz 驗證器：深淺兩種底色、色弱模擬都分得開）。
// 存的是淺色主題的值；面板的 SVG 在深色主題換成 dark。畫面上一律另外寫帳號名稱，不只靠顏色。
export const SLOTS = [
  { light: '#2a78d6', dark: '#3987e5', name: '藍' },
  { light: '#eb6834', dark: '#d95926', name: '橘' },
  { light: '#1baf7a', dark: '#199e70', name: '青綠' },
  { light: '#eda100', dark: '#c98500', name: '黃' },
  { light: '#e87ba4', dark: '#d55181', name: '桃紅' },
] as const
export const PALETTE: readonly string[] = SLOTS.map(s => s.light)
export const COLOR_NAMES: Record<string, string> = Object.fromEntries(SLOTS.map(s => [s.light, s.name]))
// 0.3.4 以前的顏色換成新配色裡最接近的那個（紫色沒有對應，併到桃紅）
const LEGACY_COLORS: Record<string, string> = { '#3b6fe0': '#2a78d6', '#14a38e': '#1baf7a', '#d9822b': '#eb6834', '#8e6bd8': '#e87ba4', '#c2417a': '#e87ba4' }

export const DEFAULT_USES: BraidUses = { switch: false, sync: false, policy: false }
export const DEFAULT_SWITCH: BraidSwitch = { on: true, fiveHour: 90, sevenDay: 95, order: [] }
export const DEFAULT_SYNC: BraidSync = { on: false, pair: [], all: true, folders: [] }
export const DEFAULT_KEEP: BraidKeep = { deletedDays: 30, toolCopies: 5 }
export const KEEP_DAYS_CHOICES = [7, 30, 90] as const
export const KEEP_COPIES_CHOICES = [3, 5, 10] as const
export const FIVE_HOUR_CHOICES = [80, 90, 95] as const
export const SEVEN_DAY_CHOICES = [90, 95] as const

// ── 從儲存讀回來的資料：舊版或壞掉的值一律換成預設，不讓畫面因為一筆壞資料整個掛掉 ──

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)
const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback)

export function normalizeUses(x: unknown): BraidUses | null {
  if (!isObj(x)) return null
  // 舊版的 migrate 不再讀：遷移改成一次性的動作，在帳號頁做
  return { switch: x.switch === true, sync: x.sync === true, policy: x.policy === true }
}

export function normalizeSwitch(x: unknown): BraidSwitch {
  if (!isObj(x)) return { ...DEFAULT_SWITCH }
  return {
    on: x.on !== false,
    fiveHour: num(x.fiveHour, DEFAULT_SWITCH.fiveHour),
    sevenDay: x.sevenDay === null ? null : num(x.sevenDay, DEFAULT_SWITCH.sevenDay ?? 95),
    order: Array.isArray(x.order) ? x.order.filter((v): v is string => typeof v === 'string') : [],
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
  }
}

const positive = (x: unknown, fallback: number | null): number | null =>
  x === null ? null : typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : fallback

export function normalizeKeep(x: unknown): BraidKeep {
  if (!isObj(x)) return { ...DEFAULT_KEEP }
  return { deletedDays: positive(x.deletedDays, DEFAULT_KEEP.deletedDays), toolCopies: positive(x.toolCopies, DEFAULT_KEEP.toolCopies) }
}

/** 遷移工具的整份備份資料夾名稱：20261016-140211，同一秒的第二份 20261016-140211-2。 */
export const TOOL_BACKUP_NAME = /^\d{8}-\d{6}(-\d+)?$/

/** 要清掉的整份備份：新到舊排，留最新 copies 份；名稱不像備份的一律不碰。copies 是 null 就全部留著。 */
export function extraToolBackups(names: readonly string[], copies: number | null): string[] {
  if (copies === null) return []
  const key = (n: string) => {
    const [d = '', t = '', k = '1'] = n.split('-')
    return `${d}${t}${k.padStart(6, '0')}`
  }
  return names
    .filter(n => TOOL_BACKUP_NAME.test(n))
    .sort((a, b) => key(b).localeCompare(key(a)))
    .slice(copies)
}

/** 要清掉的同步刪除備份：存進去超過 days 天的。days 是 null 就全部留著。 */
export function expiredFiles(files: readonly { path: string; mtimeMs: number }[], days: number | null, now: number): string[] {
  if (days === null) return []
  return files.filter(f => f.mtimeMs > 0 && now - f.mtimeMs > days * 86_400_000).map(f => f.path)
}

/** 版本號比大小（0.3.10 比 0.3.9 新）；讀不懂的當成不比較新。 */
export function isNewer(latest: string | null, installed: string | null): boolean {
  const parts = (v: string | null) => (v && /^\d+(\.\d+)*$/.test(v.trim()) ? v.trim().split('.').map(Number) : null)
  const a = parts(latest)
  const b = parts(installed)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/** 位元組寫成給人看的大小。 */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const PROBLEMS: readonly BraidMirrorProblem[] = ['no-desktop', 'no-active', 'no-spec', 'no-target', 'failed']

export function normalizeMirror(x: unknown): BraidMirror | null {
  if (!isObj(x) || typeof x.at !== 'number') return null
  return {
    at: x.at,
    active: str(x.active),
    to: str(x.to),
    toOrg: str(x.toOrg),
    created: num(x.created, 0),
    updated: num(x.updated, 0),
    deleted: num(x.deleted, 0),
    problem: PROBLEMS.find(p => p === x.problem) ?? null,
    detail: str(x.detail),
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
    color: ((c: string | null) => (c ? (LEGACY_COLORS[c.toLowerCase()] ?? c) : null))(str(x.color)) ?? (PALETTE[0] as string),
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

/**
 * Claude Code 自己的登入存在哪個 .claude.json：有 CLAUDE_CONFIG_DIR 就在那裡，否則家目錄。
 * Windows 的家目錄看 USERPROFILE（Claude Code 用的 os.homedir() 也是），不看 HOME：
 * 有些 Windows 會設 HOME（例如 Git 的設定），指到別處時 braid 會讀錯檔、認不出帳號（2026-10-22，同事在 VS Code 遇到）。
 */
export function claudeJsonAt(platform: BraidPlatform, env: { configDir?: string; home?: string; userProfile?: string }): string | null {
  const sep = platform === 'windows' ? '\\' : '/'
  const home = platform === 'windows' ? env.userProfile || env.home : env.home || env.userProfile
  const dir = env.configDir || home
  return dir ? `${dir.replace(/[\\/]+$/, '')}${sep}.claude.json` : null
}

/**
 * 這個對話的帳號是怎麼認出來的：token＝braid 用一年期憑證開的視窗（BRAID_ACCOUNT）；desktop＝桌面 app 開的對話
 * （app 把帳號放在 CLAUDE_CODE_ACCOUNT_UUID）；cli＝VS Code 插件或終端機，讀 Claude Code 自己的登入（file）；
 * none＝都沒有（why：找不到家目錄、讀不到檔、檔裡沒有登入資料）。
 */
export type SignIn = BraidSignIn

/** 換帳號的方法：桌面 app 的對話在 app 換；VS Code 插件與終端機用 /login（對話紀錄不分帳號，換過去這段對話不用搬）。 */
export type SwitchBy = 'desktop' | 'login'

export function switchByOf(signIn: SignIn | null): SwitchBy {
  return signIn?.by === 'desktop' ? 'desktop' : 'login'
}

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
    color: PALETTE.find(c => !used.includes(c)) ?? PALETTE[all.length % PALETTE.length] ?? (PALETTE[0] as string),
    source: seen.source,
    credential: null,
    credentialId: null,
    usage: null,
    lastSeen: now,
  }
}

/** 信箱相同的帳號（不分大小寫）。認帳號是不是同一個，新增憑證與認出帳號兩條路都用這一個。 */
export function sameEmail(accounts: Record<string, BraidAccount>, email: string | null): BraidAccount[] {
  const want = email?.trim().toLowerCase()
  return want ? Object.values(accounts).filter(a => a.email?.trim().toLowerCase() === want) : []
}

/** braid 自動取的名稱（個人、公司、個人 2…）；使用者改過的不算。 */
const isAutoLabel = (label: string) => /^(個人|公司)( \d+)?$/.test(label)

/**
 * 同一個帳號的兩筆紀錄併成一筆。braid 新增憑證時還不知道帳號 id（tok-…），之後在桌面 app 或 CLI 認出同一個帳號
 * （信箱相同，而且正好一筆 tok-）時，把憑證併過來、丟掉 tok- 那筆。名稱與顏色：認出來的那筆還是自動取的名稱，
 * 就用 tok- 那筆的（新增時使用者取的）；使用者改過的保留。用量取比較新的。
 */
export function absorbTokenTwin(accounts: Record<string, BraidAccount>, a: BraidAccount): { account: BraidAccount; absorbed: string | null } {
  if (a.id.startsWith('tok-')) return { account: a, absorbed: null }
  const twins = sameEmail(accounts, a.email).filter(t => t.id.startsWith('tok-'))
  const t = twins.length === 1 ? twins[0] : undefined
  if (!t) return { account: a, absorbed: null }
  const mine = !isAutoLabel(a.label)
  const usage = !a.usage ? t.usage : !t.usage ? a.usage : a.usage.at >= t.usage.at ? a.usage : t.usage
  return {
    account: {
      ...a,
      label: mine ? a.label : t.label,
      color: mine ? a.color : t.color,
      orgId: a.orgId ?? t.orgId,
      orgName: a.orgName ?? t.orgName,
      credential: a.credential ?? t.credential,
      credentialId: a.credential ? a.credentialId : t.credentialId,
      usage,
    },
    absorbed: t.id,
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

/** 依設定的順序排帳號；沒排到的照最近出現的時間排在後面。 */
export function orderedIds(accounts: Record<string, BraidAccount>, order: readonly string[]): string[] {
  const listed = order.filter(id => accounts[id])
  const rest = Object.values(accounts)
    .filter(a => !listed.includes(a.id))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(a => a.id)
  return [...listed, ...rest]
}

/**
 * 能不能換過去：ok＝在桌面 app 登入過（使用者自己在 app 換）；elsewhere＝還沒在桌面 app 登入過（braid 新增的、
 * 或只在終端機 /login 的），要先在 app 登入它；busy＝也快用完。
 * braid 不替使用者換帳號、不開視窗接著做（2026-10-22 拍板：各人本機的 claude 裝在哪不一定，VS Code 插件裡開出去的視窗出錯就關掉）。
 * 不看歸屬表：歸屬只管新頁歸誰，對話往哪個帳號走由使用者換帳號與同步決定。
 */
export type Why = 'ok' | 'elsewhere' | 'busy'

export type Candidate = { account: BraidAccount; why: Why }

/** 一個帳號是否也快用完：上次的數字超過門檻、而且還沒到重置時間。 */
export function isBusy(usage: BraidUsage | null, sw: BraidSwitch, now: number): boolean {
  if (!usage) return false
  const five = effectivePct(usage.fiveHour, now)
  const seven = effectivePct(usage.sevenDay, now)
  return (five !== null && five >= sw.fiveHour) || (sw.sevenDay !== null && seven !== null && seven >= sw.sevenDay)
}

/** 其他帳號依順序，各自能不能換過去、不能的話為什麼。by＝login（VS Code、終端機用 /login 換）時，任何帳號都能登入，不分在不在桌面 app 登入過。 */
export function candidates(accounts: Record<string, BraidAccount>, currentId: string, sw: BraidSwitch, now: number, by: SwitchBy = 'desktop'): Candidate[] {
  return orderedIds(accounts, sw.order)
    .filter(id => id !== currentId)
    .map(id => {
      const account = accounts[id] as BraidAccount
      let why: Why = 'ok'
      if (by === 'desktop' && account.source !== 'desktop') why = 'elsewhere'
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
  /** 建議在桌面 app 換成的帳號：順序裡第一個能換的 */
  next: BraidAccount | null
  /** 沒有能換的時候，還沒在桌面 app 登入過的帳號（先在 app 登入它就能換） */
  elsewhere: BraidAccount | null
}

/** 輸入框上方要不要出現提示、說什麼。 */
export function bandFor(
  accounts: Record<string, BraidAccount>,
  currentId: string | null,
  live: BraidUsage | null,
  sw: BraidSwitch,
  now: number,
  snooze: string | null,
  by: SwitchBy = 'desktop',
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
  const list = candidates(accounts, currentId, sw, now, by)
  return {
    ...hit,
    snoozeKey,
    next: list.find(c => c.why === 'ok')?.account ?? null,
    elsewhere: list.find(c => c.why === 'elsewhere')?.account ?? null,
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
 * 自動同步這次要做什麼：從桌面 app 現在登入的帳號，複製到同一對裡的另一個帳號。
 * 沒開、app 的帳號不在這一對裡、或只同步挑的資料夾卻還沒挑，就不做。
 * 只寫沒登入的那個帳號：目前帳號的資料夾 app 開著時會蓋回去（見 mirror.ts）。
 */
export function mirrorTarget(sync: BraidSync, active: string | null): { from: string; to: string; scope: 'all' | readonly string[] } | null {
  const to = partnerOf(sync, active)
  if (!sync.on || !active || !to || to === active) return null
  if (!sync.all && sync.folders.length === 0) return null
  return { from: active, to, scope: sync.all ? 'all' : sync.folders }
}

/**
 * 環境要工具做什麼：全部資料夾（環境也全部），或勾選的資料夾（環境跟著資料夾走）；沒有範圍就是 null。
 * 環境存在 app 的內部資料庫，app 開著不能寫，所以不自動同步，由同步頁的按鈕交給遷移工具。
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

/** 同步範圍的勾選清單：兩個帳號的資料夾聯集，勾過的排前面，其餘照對話數排。 */
export function syncRows(profiles: readonly BraidProfile[], mine: string, partner: string, picked: readonly string[]): SyncRow[] {
  const a = foldersOf(profiles, mine)
  const b = foldersOf(profiles, partner)
  const paths = new Set([...a.keys(), ...b.keys(), ...picked])
  return [...paths]
    .map(path => ({ path, mine: a.get(path) ?? 0, theirs: b.get(path) ?? 0, checked: picked.includes(path) }))
    .sort((x, y) => Number(y.checked) - Number(x.checked) || y.mine + y.theirs - (x.mine + x.theirs) || x.path.localeCompare(y.path))
}

// ── 遷移：一次性的動作 ──

/** 帳號頁與輸入框上方「要不要搬過來」的一列：其他帳號還沒在目標帳號的對話有幾個。 */
export type MigrateSource = { account: string; org: string; pending: number; lastActivity: number }

const recordId = (name: string) => name.replace(/^local_/, '').replace(/\.json$/, '')

/**
 * 其他帳號在這台電腦、還沒搬到 target（桌面 app 現在登入的帳號）的對話：target 沒有同名的紀錄、也沒刪過（和遷移工具略過的一樣）。
 * 不列 exclude（同步夥伴：同步會把對話帶過來）。搬完了就是 0、自然不再列——不用另外記「搬過了」。
 */
export function migrateSources(profiles: readonly BraidProfile[], target: string | null, exclude: string | null): MigrateSource[] {
  if (!target) return []
  const have = new Set<string>()
  const gone = new Set<string>()
  for (const p of profiles) {
    if (p.account !== target) continue
    for (const n of p.names ?? []) have.add(n)
    for (const d of p.deleted ?? []) gone.add(d)
  }
  return profiles
    .filter(p => p.account !== target && p.account !== exclude)
    .map(p => ({ account: p.account, org: p.org, lastActivity: p.lastActivity, pending: (p.names ?? []).filter(n => !have.has(n) && !gone.has(recordId(n))).length }))
    .filter(s => s.pending > 0)
    .sort((a, b) => b.lastActivity - a.lastActivity)
}

// ── /braid 診斷：出問題時貼給幫忙的人看 ──

/** 信箱只留第一個字與網域（貼出去給人看也不洩漏全名）。 */
export function maskEmail(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  return at > 0 ? `${email[0]}***${email.slice(at)}` : '***'
}

export type Diagnosis = {
  version: string | null
  platform: BraidPlatform
  entrypoint: string | null
  signIn: SignIn | null
  account: { label: string; id: string; email: string | null } | null
  env: { home: string | null; userProfile: string | null; configDir: string | null }
  desktop: { dir: string; active: string | null } | null
  accounts: string[]
  uses: string[]
  sync: string | null
  claude: string | null
}

const PLATFORM_TEXT: Record<BraidPlatform, string> = { wsl: 'WSL', windows: 'Windows 本機', mac: 'macOS', other: 'Linux 或其他（沒有桌面 app）' }

/** 診斷的每一行：給人讀，不含任何憑證；帳號只列 id 開頭、信箱遮掉。 */
export function diagnosisLines(d: Diagnosis): string[] {
  const none = '（沒有）'
  const how = !d.signIn
    ? '還沒判斷（對話剛開始）'
    : d.signIn.by === 'desktop'
      ? '桌面 app 開的對話：app 給的環境變數 CLAUDE_CODE_ACCOUNT_UUID'
      : d.signIn.by === 'token'
        ? 'braid 用一年期憑證開的視窗（BRAID_ACCOUNT）'
        : d.signIn.by === 'cli'
          ? `Claude Code 自己的登入：${d.signIn.file}`
          : d.signIn.why === 'no-file'
            ? '找不到家目錄，不知道去哪裡讀 .claude.json'
            : d.signIn.why === 'unreadable'
              ? `讀不到 ${d.signIn.file}（沒有這個檔，或沒有權限）`
              : `${d.signIn.file} 裡沒有登入資料（oauthAccount）：在這裡用 /login 登入過才有；用 API key 的認不出帳號`
  const who = d.account ? `「${d.account.label}」（${short(d.account.id)}${d.account.email ? `，${maskEmail(d.account.email)}` : ''}）` : '認不出來'
  const by = switchByOf(d.signIn) === 'desktop' ? '在桌面 app 換' : '用 /login 換（VS Code 插件、終端機；這段對話不用搬）'
  return [
    `braid 診斷${d.version ? `（${d.version}）` : ''}`,
    `平台：${PLATFORM_TEXT[d.platform]}${d.entrypoint ? `；Claude Code 從 ${d.entrypoint} 啟動` : ''}`,
    `這個對話的帳號：${who}`,
    `  怎麼認的：${how}`,
    `  換帳號：${by}`,
    `家目錄：USERPROFILE=${d.env.userProfile ?? none}；HOME=${d.env.home ?? none}；CLAUDE_CONFIG_DIR=${d.env.configDir ?? none}`,
    `桌面 app：${d.desktop ? `${d.desktop.dir}，現在登入 ${d.desktop.active ? short(d.desktop.active) : '讀不到'}` : '這台電腦找不到'}`,
    `braid 認得的帳號：${d.accounts.length > 0 ? `${d.accounts.length} 個（${d.accounts.join('、')}）` : '沒有'}`,
    `用法：${d.uses.length > 0 ? d.uses.join('、') : '還沒選'}`,
    ...(d.sync ? [`同步：${d.sync}`] : []),
    `claude 執行檔（新增帳號、更新用）：${d.claude ?? '找不到'}`,
  ]
}

/** 帳號 id 的短寫，給沒有信箱可顯示的帳號用。 */
export const short = (id: string) => `${id.slice(0, 8)}…`

/**
 * 顯示用的帳號名稱：braid 認得的用名稱。不認得的桌面 app 帳號（從沒當過目前帳號），組織若正好對到一個
 * 用 braid 新增的帳號（tok-…，不知道它真正的帳號 id），就借那個名稱：多半是同一個人的同一個帳號。
 * 認得真正 id 的其他帳號不借（同組織的另一個帳號），對到不只一個也不借；都沒有就寫「帳號 1111aaaa…」。
 */
export function nameOf(accounts: Record<string, BraidAccount>, id: string, profiles: readonly BraidProfile[] = []): string {
  return lookOf(accounts, id, profiles).label
}

/** 顯示用的名稱與顏色（規則同 nameOf）；認不得的帳號用主題的淡色。 */
export function lookOf(accounts: Record<string, BraidAccount>, id: string, profiles: readonly BraidProfile[] = []): { label: string; color: string } {
  const known = accounts[id]
  if (known) return { label: known.label, color: known.color }
  const org = profiles.find(p => p.account === id)?.org
  const same = org ? Object.values(accounts).filter(a => a.id.startsWith('tok-') && a.orgId === org) : []
  return same.length === 1 && same[0] ? { label: same[0].label, color: same[0].color } : { label: `帳號 ${short(id)}`, color: 'inactive' }
}
