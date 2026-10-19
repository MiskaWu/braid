// 歸屬表：哪個資料夾歸哪個帳號。對話該用誰、頁面（artifact）該歸誰，都看這一張表（使用者 10-19 拍板的「方案四」）。
// 純邏輯，不碰 $。
//
// 規則：資料夾（含子資料夾）→ 帳號 id，或「不分」（*）。多條符合時取最具體（最長）的那條；
// worktree（…/.claude/worktrees/x）跟著它的專案。沒有規則的資料夾＝還沒設定：第一次問，答案寫回表。
// 「對得上」看的是同一邊：同一個帳號，或同一個組織（公司的第二個帳號也算公司）。
import type { BraidAccount, BraidPolicy, BraidRule } from '../types'

/** 「不分」：哪個帳號都可以。 */
export const ANY = '*'

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** 資料夾寫法統一：去掉結尾的斜線（根目錄除外）。 */
export function cleanFolder(p: string): string {
  const t = p.trim()
  const s = t.replace(/[\\/]+$/, '')
  return s === '' ? (t.startsWith('/') ? '/' : t) : /^[A-Za-z]:$/.test(s) ? `${s}\\` : s
}

export function normalizePolicy(x: unknown): BraidPolicy {
  const rules: BraidRule[] = []
  if (isObj(x) && Array.isArray(x.rules)) {
    for (const r of x.rules) {
      if (!isObj(r) || typeof r.folder !== 'string' || typeof r.owner !== 'string' || !r.folder.trim() || !r.owner) continue
      const folder = cleanFolder(r.folder)
      const i = rules.findIndex(o => o.folder === folder)
      if (i >= 0) rules.splice(i, 1)
      rules.push({ folder, owner: r.owner })
    }
  }
  return { rules }
}

/** 加一條或改一條（同一個資料夾只留一條）。 */
export function setRule(policy: BraidPolicy, folder: string, owner: string): BraidPolicy {
  const f = cleanFolder(folder)
  return { rules: [...policy.rules.filter(r => r.folder !== f), { folder: f, owner }] }
}

export function dropRule(policy: BraidPolicy, folder: string): BraidPolicy {
  return { rules: policy.rules.filter(r => r.folder !== folder) }
}

/** 對話開在 worktree 時算它所屬的專案：…/.claude/worktrees/x/… → …。 */
export function projectOf(cwd: string): string {
  const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/.exec(cwd)
  return cleanFolder(m?.[1] ?? cwd)
}

function inside(path: string, folder: string): boolean {
  if (path === folder) return true
  const withSep = /[\\/]$/.test(folder) ? folder : `${folder}/`
  return path.startsWith(withSep) || path.startsWith(`${folder}\\`)
}

/** 這個資料夾適用哪一條：含子資料夾，多條符合取最長的。 */
export function ruleFor(policy: BraidPolicy, cwd: string): BraidRule | null {
  const path = projectOf(cwd)
  let best: BraidRule | null = null
  for (const r of policy.rules) if (inside(path, r.folder) && (!best || r.folder.length > best.folder.length)) best = r
  return best
}

// 常見的個人信箱網域（和 model.ts 猜「公司／個人」名稱的那份一樣）
const PERSONAL_MAIL = /@(gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|mac|proton|protonmail|pm|qq|163|126|yeah|naver|kakao)\./i

/** 帳號是個人還是公司的：組織名稱或信箱網域判斷；都沒有就不知道。 */
export function sideOf(a: Pick<BraidAccount, 'email' | 'orgName'>): 'personal' | 'work' | 'unknown' {
  if (a.orgName && /personal|個人/i.test(a.orgName)) return 'personal'
  if (a.email) return PERSONAL_MAIL.test(a.email) ? 'personal' : 'work'
  return 'unknown'
}

/** 兩個帳號算同一邊：同一個帳號，或組織相同。 */
export function sameSide(a: BraidAccount, b: BraidAccount): boolean {
  return a.id === b.id || (!!a.orgId && !!b.orgId && a.orgId === b.orgId)
}

/** 對不上時的風險：公司的東西經由個人帳號送出、個人的東西經由公司帳號送出、其他。 */
export type Risk = 'work-via-personal' | 'personal-via-work' | 'other'

export type Verdict =
  /** 還沒設定：第一次問 */
  | { kind: 'unset'; project: string }
  /** 規則是「不分」 */
  | { kind: 'any'; rule: BraidRule }
  /** 歸屬帳號已經不在 braid 的清單裡（移除了）：當成還沒設定 */
  | { kind: 'lost'; rule: BraidRule; project: string }
  | { kind: 'ok'; rule: BraidRule; owner: BraidAccount }
  | { kind: 'mismatch'; rule: BraidRule; owner: BraidAccount; risk: Risk }

export function riskOf(owner: BraidAccount, current: BraidAccount): Risk {
  const o = sideOf(owner)
  const c = sideOf(current)
  if (o === 'work' && c === 'personal') return 'work-via-personal'
  if (o === 'personal' && c === 'work') return 'personal-via-work'
  return 'other'
}

/** 這個資料夾在這個帳號底下的判斷。current 是這個對話的帳號。 */
export function verdictFor(policy: BraidPolicy, accounts: Record<string, BraidAccount>, current: BraidAccount, cwd: string): Verdict {
  const rule = ruleFor(policy, cwd)
  if (!rule) return { kind: 'unset', project: projectOf(cwd) }
  if (rule.owner === ANY) return { kind: 'any', rule }
  const owner = accounts[rule.owner]
  if (!owner) return { kind: 'lost', rule, project: projectOf(cwd) }
  if (sameSide(owner, current)) return { kind: 'ok', rule, owner }
  return { kind: 'mismatch', rule, owner, risk: riskOf(owner, current) }
}

/** 對不上時，說清楚風險的那句話。 */
export function riskText(risk: Risk, owner: string, current: string): string {
  if (risk === 'work-via-personal') return `這個資料夾歸「${owner}」：公司程式碼會經由「${current}」（個人帳號）送出，可能違反公司規範。`
  if (risk === 'personal-via-work') return `這個資料夾歸「${owner}」：個人內容會經由「${current}」（公司帳號）送出，公司能取得。`
  return `這個資料夾歸「${owner}」：內容會經由「${current}」送出。`
}

// ── 草稿：依 git 遠端分組，讓使用者一組選一次 ──

/** git 遠端位址的「主機／擁有者」：git@github.com:me/x.git、https://gitlab.example.com/team/x → github.com/me、gitlab.example.com/team。 */
export function remoteKey(url: string | null): string | null {
  if (!url) return null
  const u = url.trim()
  const ssh = /^(?:[^@\s]+@)?([^:\s/]+):\/?([^/\s]+)\//.exec(u)
  const web = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\//.exec(u)
  const m = /^[a-z]+:\/\//.test(u) ? web : ssh
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

/** 一個專案資料夾：自己的遠端，或（不是 git repo 的工作區）底下各 repo 的遠端。 */
export type FolderRemotes = { folder: string; remote: string | null; inner: (string | null)[] }

export type DraftGroup = { key: string | null; folders: string[] }

/**
 * 依遠端分組：自己有遠端看自己的；工作區看底下 repo 最多的那個主機／擁有者；都沒有的歸到 key=null 那組（請使用者逐一選）。
 */
export function draftGroups(items: readonly FolderRemotes[]): DraftGroup[] {
  const groups = new Map<string | null, string[]>()
  for (const it of items) {
    let key = remoteKey(it.remote)
    if (!key) {
      const counts = new Map<string, number>()
      for (const r of it.inner) {
        const k = remoteKey(r)
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      key = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    }
    groups.set(key, [...(groups.get(key) ?? []), it.folder])
  }
  return [...groups.entries()]
    .map(([key, folders]) => ({ key, folders: folders.sort() }))
    .sort((a, b) => (a.key === null ? 1 : b.key === null ? -1 : b.folders.length - a.folders.length || a.key.localeCompare(b.key)))
}
