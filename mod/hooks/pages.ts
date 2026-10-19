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
