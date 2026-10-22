// 輸入框上方的提示：一則提示的資料形狀、它在帶子裡佔幾列、列數很緊時怎麼收。純邏輯，不碰 $。
//
// 輸入框上方那一塊（AbovePrompt）所有 mod 共用一個位置：引擎只畫最外層 hook 回的那一棵樹。braid 裝在最前面、是最外層，
// 0.11.0 以前四種提示各自直接回樹、不叫 next，鏈上在它裡層的 mod（canopy、ue-agent、baton 的指令卡片）和引擎的問卷就整個不見。
// 所以照 baton 定下的約定（baton README「和其他 mod 共用輸入框上方」）只疊、不佔：
// 每種提示只說「要顯示什麼」（Notice），畫法、佔幾列、往下傳的 maxRows 扣多少、疊在下層上面，全都只在 register.tsx 的一處。
// 新的提示照這個形狀加，不會再有哪個分支忘了把下層疊回去。
import { wide } from './visual'

export type NoticeButton = {
  key: string
  label: string
  /** 主要動作 */
  primary?: boolean
  /** 次要的，畫淡色 */
  dim?: boolean
  /** 關掉這則提示的那顆：收成一列時和第一顆一起留著 */
  dismiss?: boolean
  onPress: () => unknown
}

export type Notice = {
  /** 「braid」那個字的顏色：用量快用完是 warning，其他是 suggestion */
  tone: 'warning' | 'suggestion'
  text: string
  /** 接在 text 後面的淡色補充（收成一列時不畫） */
  detail?: string
  buttons: NoticeButton[]
}

export type NoticeLayout = {
  /** 收成一列：字截斷、只留第一顆按鈕和關掉的那顆 */
  compact: boolean
  /** 佔幾列：往下傳的 maxRows 扣掉這些 */
  rows: number
  buttons: NoticeButton[]
}

/** 按鈕的框比字寬多幾欄：終端機畫成 `[ label ]`。估多不估少：多算只是下層少放一點，少算會讓整條超出、被引擎捲走。 */
const BUTTON_CHROME = 4

/** 字佔幾欄：中日韓全形算兩欄。 */
export function cells(s: string): number {
  let n = 0
  for (const ch of s) n += wide(ch) ? 2 : 1
  return n
}

/** 一段會折行的字在 columns 欄寬裡佔幾列。 */
export function textRows(s: string, columns: number): number {
  const width = Math.max(1, columns)
  return s.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(cells(line) / width)), 0)
}

/** 一列會折行的按鈕（gap 1）佔幾列：照順序排，放不下就換一列。 */
export function buttonRows(labels: string[], columns: number): number {
  if (labels.length === 0) return 0
  let rows = 1
  let used = 0
  for (const label of labels) {
    const w = cells(label) + BUTTON_CHROME
    if (used > 0 && used + 1 + w > columns) {
      rows++
      used = w
    } else used += used > 0 ? 1 + w : w
  }
  return rows
}

/** 整則攤開佔幾列：一段字（「braid 」＋內容＋補充）加一列（會折行的）按鈕。 */
export function noticeRows(n: Notice, columns: number): number {
  return textRows(`braid ${n.text}${n.detail ?? ''}`, columns) + buttonRows(n.buttons.map(b => b.label), columns)
}

/**
 * 照 maxRows 排：攤開放得下就攤開；放不下就收成一列；連一列都沒有就不畫（null，交給下層）。
 * maxRows 是外層扣過的列數，braid 在最外層時就是整個帶子的。
 */
export function noticeLayout(n: Notice, columns: number, maxRows: number): NoticeLayout | null {
  if (maxRows < 1) return null
  const rows = noticeRows(n, columns)
  if (rows <= maxRows) return { compact: false, rows, buttons: n.buttons }
  const first = n.buttons[0]
  const dismiss = n.buttons.find(b => b.dismiss)
  return { compact: true, rows: 1, buttons: [first, dismiss].filter((b, i, all): b is NoticeButton => !!b && all.indexOf(b) === i) }
}
