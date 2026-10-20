// 頁面（artifact）的清單：braid 擋下來待發布的、braid 看過發布成功的。純邏輯，讀寫檔由 register.tsx 做。
//
// 放在 ~/.claude/artifact-sources/：
//   index.json                     清單（這個格式）
//   <專案名稱>/<id>.html           擋下來時存的原始檔（發布時拿它當 file_path）
// 用檔案不用 braid 的儲存：發布用終端機（另一個 CLAUDE_CONFIG_DIR）裡的 braid 讀不到這邊的儲存，但讀得到這個檔。
import { ANY } from './policy'

export type PageStatus = 'pending' | 'published' | 'dropped'

export type PageEntry = {
  id: string
  title: string
  /** 專案資料夾（歸屬看它） */
  project: string
  /** 原始檔（braid 存的副本）；發布成功才記錄的頁是 null */
  source: string | null
  /** 當初 Artifact 收到的其他參數（files、title、icon、description…），發布時照帶 */
  input: Record<string, unknown>
  /** 該由哪個帳號發布（歸屬表的帳號 id）；還沒設定歸屬的是 null */
  owner: string | null
  /** 發布者（成功時）或想發布的帳號（擋下時） */
  by: string | null
  status: PageStatus
  url: string | null
  at: number
}

export type PageIndex = { v: 1; pages: PageEntry[] }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)

export function parseIndex(text: string | null): PageIndex {
  const out: PageIndex = { v: 1, pages: [] }
  if (!text) return out
  let x: unknown
  try {
    x = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return out
  }
  if (!isObj(x) || !Array.isArray(x.pages)) return out
  for (const p of x.pages) {
    if (!isObj(p) || !str(p.id) || !str(p.project)) continue
    const status = p.status === 'published' || p.status === 'dropped' ? p.status : 'pending'
    out.pages.push({
      id: p.id as string,
      title: str(p.title) ?? '（沒有標題）',
      project: p.project as string,
      source: str(p.source),
      input: isObj(p.input) ? p.input : {},
      owner: str(p.owner),
      by: str(p.by),
      status,
      url: str(p.url),
      at: typeof p.at === 'number' ? p.at : 0,
    })
  }
  return out
}

/** 寫回檔案的樣子：好讀的 JSON。 */
export function serializeIndex(index: PageIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`
}

/** 工具回應裡的頁面網址。 */
export function urlIn(text: string | undefined): string | null {
  const m = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/.exec(text ?? '')
  return m ? m[0] : null
}

/** 專案資料夾的名稱（存原始檔的子資料夾）：最後一段，只留安全的字。 */
export function projectSlug(project: string): string {
  const last = project.split(/[\\/]/).filter(Boolean).pop() ?? 'project'
  return last.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 60) || 'project'
}

/** 頁面的標題：參數的 title，否則檔名（去副檔名），否則 HTML 的 <title>。 */
export function titleOf(input: Record<string, unknown>, html: string | null): string {
  const t = str(input.title)
  if (t) return t
  const fromHtml = html ? /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1]?.trim() : null
  if (fromHtml) return fromHtml
  const fp = str(input.file_path)
  return fp ? (fp.split(/[\\/]/).pop() ?? fp).replace(/\.[^.]+$/, '') : '（沒有標題）'
}

/** 是不是發布一張新頁（沒帶 url 的 publish，或從類型新建）。更新已有的頁、讀、列清單都不算。 */
export function isNewPage(input: Record<string, unknown>): boolean {
  const action = str(input.action) ?? 'publish'
  if (action !== 'publish') return false
  if (input.asset === true) return false
  return !str(input.url)
}

/** 某個帳號（含同一邊的帳號）該發布、還在排隊的頁。sameSideOf 判斷 owner 與這個帳號是不是同一邊。 */
export function pendingFor(index: PageIndex, isMine: (owner: string | null) => boolean): PageEntry[] {
  return index.pages.filter(p => p.status === 'pending' && p.owner !== ANY && isMine(p.owner))
}

/** 同一張頁的重送：同專案、同標題、還在排隊的那筆（更新它，不另排一筆）。 */
export function pendingTwin(index: PageIndex, project: string, title: string): PageEntry | undefined {
  return index.pages.find(p => p.status === 'pending' && p.project === project && p.title === title)
}

// ── 新頁被歸屬擋下時，在對話裡問使用者 ──

type Who = { id: string; label: string }

/**
 * 選項做什麼：publish＝用這個對話的帳號發布（不改表）；own＝還沒設定的資料夾寫回表、歸 owner，publish 時順便現在發布、否則排著；
 * queue＝排進待發布（歸屬帳號發布，還沒設定的就等之後決定歸誰）；skip＝這次不發。
 */
export type PageAction = { kind: 'publish' } | { kind: 'own'; owner: string; publish: boolean } | { kind: 'queue' } | { kind: 'skip' }
export type PageChoice = { label: string; action: PageAction }

/**
 * 問題與選項（$.ui.ask：2–4 個選項，只有文字、沒有說明，所以選了會怎樣寫在問題裡）。
 * 決定只能來自使用者按的選項。選擇框在人不在時自己結束的話回什麼不保證，所以**第一個選項一律是「先排著」**：
 * 不發布、不改歸屬表，就算被自動帶過也不會替使用者做決定。
 * canPublish：這個對話能發布（braid 用一年期憑證開的視窗不能，官方只保證 /login 的對話）。
 * others：還沒設定時另外給的帳號（跟這個對話不同邊的，只列第一個，選項才不會超過四個）。
 */
export function pageQuestion(d: {
  title: string
  name: string
  me: Who
  owner: Who | null
  others: readonly Who[]
  canPublish: boolean
}): { question: string; header: string; choices: PageChoice[] } {
  const header = '新頁歸屬'
  const skip: PageChoice = { label: '這次不發', action: { kind: 'skip' } }
  const token = '這個視窗是 braid 用一年期憑證開的，官方只保證 /login 的對話能發布，所以只能先排著。'
  if (d.owner) {
    const o = d.owner.label
    const m = d.me.label
    const why = d.canPublish
      ? `排進待發布的話，之後在「${o}」登入的對話發布；用「${m}」發布的話，頁面會歸「${m}」，之後不能轉移，用「${o}」的對話改不到它。`
      : `排進待發布的話，之後在「${o}」登入的對話發布。${token}`
    return {
      question: `「${d.name}」歸「${o}」，這個對話是「${m}」。${why}新頁「${d.title}」要怎麼處理？`,
      header,
      choices: [{ label: '排進待發布', action: { kind: 'queue' } }, ...(d.canPublish ? [{ label: `用「${m}」發布`, action: { kind: 'publish' } } as PageChoice] : []), skip],
    }
  }
  const other = d.others[0]
  const why = d.canPublish
    ? '選了歸誰，這個資料夾之後的新頁都用那個帳號發布；頁面歸發布它的帳號，之後不能轉移。'
    : `選了歸誰，這個資料夾之後的新頁都用那個帳號發布。${token}`
  const mine: PageChoice = d.canPublish
    ? { label: `歸「${d.me.label}」並發布`, action: { kind: 'own', owner: d.me.id, publish: true } }
    : { label: `歸「${d.me.label}」，先排著`, action: { kind: 'own', owner: d.me.id, publish: false } }
  return {
    question: `「${d.name}」還沒設定歸哪個帳號。${why}新頁「${d.title}」要怎麼處理？`,
    header,
    choices: [
      { label: '先排著，之後再決定', action: { kind: 'queue' } },
      mine,
      ...(other ? [{ label: `歸「${other.label}」，先排著`, action: { kind: 'own', owner: other.id, publish: false } } as PageChoice] : []),
      skip,
    ],
  }
}
