// 桌面版面板的圖：帳號卡、用量條、同步狀態卡、頁首。畫成 SVG（桌面 app 與手機有 Svg 元件，終端機沒有，
// 終端機照舊用文字）。純函式：給資料、回 SVG 字串，不碰 $。
//
// 配色照 Claude 的設計系統（dataviz 參考配色；桌面 app 面板的底色正是 #1a1a19）：
//   文字一律用文字色（主／次／淡），帳號身分靠旁邊的色點與頭像，不把文字塗成帳號色。
//   用量條是量表：平常是帳號色，到提醒門檻換警告色、用完換危險色，都附圖示與文字，不只靠顏色。
//   深淺兩套顏色寫在 SVG 自己的 <style>，用 prefers-color-scheme 切換。
// SVG 不會自己換行：文字用估計寬度截斷（中日韓字約一個字級寬，其他約 0.56 個）。
import { SLOTS } from './model'

const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' } as const

const FONT = `'Segoe UI Variable Text','Segoe UI',-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei UI','Microsoft JhengHei','Noto Sans TC','Noto Sans CJK TC',sans-serif`

/** 共用的樣式：文字色、細線、帳號色（深淺兩套）。 */
function style(): string {
  const slots = SLOTS.map((s, i) => `.c${i}{fill:${s.light}}.s${i}{stroke:${s.light}}.k${i}{fill:${s.light};fill-opacity:.16}`).join('')
  const slotsDark = SLOTS.map((s, i) => `.c${i}{fill:${s.dark}}.s${i}{stroke:${s.dark}}.k${i}{fill:${s.dark};fill-opacity:.2}`).join('')
  return (
    `<style>` +
    `text{font-family:${FONT};}` +
    `.t1{fill:#0b0b0b}.t2{fill:#52514e}.t3{fill:#7d7c76}.on{fill:#ffffff}` +
    `.hair{stroke:#e4e3de}.panel{fill:#f4f3ef}.tick{stroke:#52514e}` +
    `.num{font-variant-numeric:tabular-nums}` +
    slots +
    `@media (prefers-color-scheme: dark){` +
    `.t1{fill:#f0efec}.t2{fill:#c3c2b7}.t3{fill:#8f8e86}` +
    `.hair{stroke:#313130}.panel{fill:#222221}.tick{stroke:#c3c2b7}` +
    slotsDark +
    `}` +
    `</style>`
  )
}

/** 帳號顏色是第幾個（深淺主題各有一個值）；不是配色裡的回 null，直接用那個色碼。 */
export function slotOf(color: string): number | null {
  const c = color.toLowerCase()
  const i = SLOTS.findIndex(x => x.light === c || x.dark === c)
  return i >= 0 ? i : null
}

/** 填色：帳號色用 class（跟著主題換），其他色碼直接寫。 */
function fillOf(color: string, kind: 'c' | 's' | 'k' = 'c'): string {
  const i = slotOf(color)
  if (i !== null) return `class="${kind}${i}"`
  if (kind === 's') return `stroke="${esc(color)}"`
  if (kind === 'k') return `fill="${esc(color)}" fill-opacity=".2"`
  return `fill="${esc(color)}"`
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 中日韓全形字：圖裡一個字級寬、終端機佔兩欄（band.ts 估列數也用它）。 */
export const wide = (ch: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch)

/** 估計的字寬（px）。 */
export function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of s) w += wide(ch) ? size : /[A-Z0-9@%]/.test(ch) ? size * 0.62 : size * 0.54
  return w
}

/** 超過寬度就截斷加「…」。 */
export function fit(s: string, size: number, max: number): string {
  if (textWidth(s, size) <= max) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size) > max) break
    out += ch
  }
  return `${out}…`
}

/** 頭像上的字：名稱的第一個字（英文大寫）。 */
export function initial(label: string): string {
  const first = [...label.trim()][0] ?? '?'
  return first.toUpperCase()
}

function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${style()}${body}</svg>`
}

function txt(x: number, y: number, cls: string, size: number, s: string, extra = ''): string {
  return `<text x="${x}" y="${y}" class="${cls}" font-size="${size}" ${extra}>${esc(s)}</text>`
}

function avatar(cx: number, cy: number, r: number, color: string, label: string): string {
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" ${fillOf(color)}/>` +
    `<text x="${cx}" y="${cy + r * 0.36}" class="on" font-size="${Math.round(r * 0.95)}" font-weight="600" text-anchor="middle">${esc(initial(label))}</text>`
  )
}

/** 小標籤（膠囊）：帳號色淡底＋次要文字。回寬度，讓下一個接著排。 */
function pill(x: number, cy: number, color: string | null, s: string): { svg: string; w: number } {
  const w = Math.ceil(textWidth(s, 11)) + 14
  const bg = color ? `<rect x="${x}" y="${cy - 9}" width="${w}" height="18" rx="9" ${fillOf(color, 'k')}/>` : `<rect x="${x}" y="${cy - 9}" width="${w}" height="18" rx="9" class="panel"/>`
  return { svg: bg + txt(x + 7, cy + 4, 't2', 11, s), w }
}

export type Window = { label: string; pct: number | null; reset: string | null }

/** 狀態圖示：警告是三角形、用完是圓形叉、正常不畫。 */
function statusIcon(x: number, cy: number, kind: 'warning' | 'critical'): string {
  if (kind === 'warning') {
    return `<path d="M${x} ${cy + 5}L${x + 5.5} ${cy - 5}L${x + 11} ${cy + 5}Z" fill="${STATUS.warning}"/><rect x="${x + 4.9}" y="${cy - 2}" width="1.2" height="4" fill="#1a1a19"/><rect x="${x + 4.9}" y="${cy + 2.6}" width="1.2" height="1.2" fill="#1a1a19"/>`
  }
  return `<circle cx="${x + 5.5}" cy="${cy}" r="5.5" fill="${STATUS.critical}"/><path d="M${x + 3.3} ${cy - 2.2}l4.4 4.4M${x + 7.7} ${cy - 2.2}l-4.4 4.4" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>`
}

/**
 * 一條用量量表，兩行：上行左邊名稱、右邊重置時間與百分比（到門檻或用完時前面加圖示）；
 * 下行是全寬的長條（帳號色，到門檻換警告色、滿了換危險色；底軌是同色的淡色；門檻畫一道細刻度）。
 * y 是上緣，回高度。
 */
function meter(y: number, w: number, color: string, win: Window, threshold: number | null, compact: boolean): { svg: string; h: number } {
  const pct = win.pct
  const level = pct === null ? 'none' : pct >= 100 ? 'critical' : threshold !== null && pct >= threshold ? 'warning' : 'normal'
  const base = y + 13
  let out = txt(0, base, 't2', 12, win.label)
  const pctText = pct === null ? '—' : `${pct}%`
  const pctW = textWidth(pctText, 13)
  out += txt(w, base + 0.5, 't1 num', 13, pctText, 'font-weight="600" text-anchor="end"')
  let rx = w - pctW - 8
  if (level === 'warning' || level === 'critical') {
    out += statusIcon(rx - 11, base - 4, level)
    rx -= 17
  }
  if (win.reset) out += txt(rx, base, 't3', 11, fit(win.reset, 11, rx - textWidth(win.label, 12) - 16), 'text-anchor="end"')
  const barH = compact ? 5 : 6
  const barY = base + 8
  out += `<rect x="0" y="${barY}" width="${w}" height="${barH}" rx="${barH / 2}" ${fillOf(color, 'k')}/>`
  if (pct !== null && pct > 0) {
    const fw = Math.max(barH, (w * Math.min(pct, 100)) / 100)
    const fill = level === 'critical' ? `fill="${STATUS.critical}"` : level === 'warning' ? `fill="${STATUS.warning}"` : fillOf(color)
    out += `<rect x="0" y="${barY}" width="${fw}" height="${barH}" rx="${barH / 2}" ${fill}/>`
  }
  if (threshold !== null && threshold > 0 && threshold < 100) {
    const tx = (w * threshold) / 100
    out += `<line x1="${tx}" y1="${barY - 3}" x2="${tx}" y2="${barY + barH + 3}" class="tick" stroke-width="1.2" stroke-opacity=".6"><title>${esc(`${threshold}% 時提醒`)}</title></line>`
  }
  return { svg: out, h: (compact ? 30 : 32) }
}

export type CardData = {
  label: string
  color: string
  /** 名稱後面的小標籤，例如「這個對話」「自動同步」 */
  tags: string[]
  /** 名稱下面那行淡字：信箱、組織 */
  sub: string | null
  windows: Window[]
  /** 用量是多久前量的（不是這個對話的帳號才有）；null 不顯示 */
  staleness: string | null
  /** 門檻（5 小時、7 天各一）；不提醒是 null */
  thresholds: (number | null)[]
  /** 最下面一行：怎麼換過去（在桌面 app 換、對話會不會跟過去） */
  note: { tone: 'good' | 'sync' | 'none'; text: string } | null
  /** 沒有用量時寫什麼 */
  empty: string
}

/** 帳號卡：頭像、名稱與標籤、信箱、兩條用量、怎麼換過去。外框與按鈕由面板的 Box 畫。 */
export function accountCard(d: CardData, w = 420): { source: string; alt: string; height: number } {
  let y = 0
  let body = avatar(20, 20, 20, d.color, d.label)
  const nameSize = 15
  const name = fit(d.label, nameSize, w - 56 - 120)
  body += txt(52, 17, 't1', nameSize, name, 'font-weight="600"')
  let px = 52 + textWidth(name, nameSize) + 8
  for (const tag of d.tags) {
    const p = pill(px, 12, d.color, tag)
    if (px + p.w > w) break
    body += p.svg
    px += p.w + 6
  }
  if (d.sub) body += txt(52, 35, 't3', 12, fit(d.sub, 12, w - 52))
  y = 50
  if (d.staleness) {
    body += txt(0, y + 12, 't3', 11, d.staleness)
    y += 18
  }
  const compact = d.staleness !== null
  d.windows.forEach((win, i) => {
    const m = meter(y, w, d.color, win, d.thresholds[i] ?? null, compact)
    body += `<g>${m.svg}</g>`
    y += m.h
  })
  if (d.windows.length === 0) {
    body += txt(0, y + 14, 't3', 12, fit(d.empty, 12, w))
    y += 22
  }
  if (d.note) {
    y += 8
    body += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" class="hair" stroke-width="1"/>`
    y += 18
    const icon =
      d.note.tone === 'good'
        ? `<circle cx="5" cy="${y - 4}" r="4" fill="${STATUS.good}"/>`
        : d.note.tone === 'sync'
          ? `<path d="M1 ${y - 7}h7l-2-2.4M9 ${y - 1}H2l2 2.4" fill="none" class="tick" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`
          : `<circle cx="5" cy="${y - 4}" r="3.6" fill="none" class="tick" stroke-width="1.2"/>`
    body += icon + txt(16, y, 't2', 12, fit(d.note.text, 12, w - 16))
    y += 6
  }
  const height = Math.ceil(y + 2)
  const alt = [
    `${d.label}${d.tags.length ? `（${d.tags.join('、')}）` : ''}`,
    d.sub,
    ...(d.windows.length ? d.windows.map(win => `${win.label} ${win.pct === null ? '沒有數字' : `${win.pct}%`}${win.reset ? `，${win.reset}` : ''}`) : [d.empty]),
    d.staleness,
    d.note?.text,
  ]
    .filter(Boolean)
    .join('；')
  return { source: svg(w, height, body), alt, height }
}

export type FlowData = {
  tone: 'on' | 'warn' | 'off'
  title: string
  /** 給看不到圖的人：整張卡一句話說完 */
  summary: string
  from: { label: string; color: string; caption: string } | null
  to: { label: string; color: string; caption: string } | null
  /** 上次同步的數字，例如 ['2 分鐘前', '新增 1', '刪除 3'] */
  chips: string[]
  lines: string[]
}

/** 同步狀態卡：狀態、兩個帳號（左：app 登入中、右：寫入對象）之間編在一起的兩股線，下面是上次同步的數字。 */
export function syncFlow(d: FlowData, w = 420): { source: string; alt: string; height: number } {
  const tone = d.tone === 'on' ? STATUS.good : d.tone === 'warn' ? STATUS.warning : null
  let body = ''
  let y = 14
  body += tone ? `<circle cx="5" cy="${y - 4}" r="4.5" fill="${tone}"/>` : `<circle cx="5" cy="${y - 4}" r="4" fill="none" class="tick" stroke-width="1.2"/>`
  body += txt(16, y, 't1', 13, d.title, 'font-weight="600"')
  y += 14
  if (d.from && d.to) {
    const cy = y + 30
    const ax = 52
    body += avatar(ax, cy, 22, d.from.color, d.from.label)
    body += avatar(w - ax, cy, 22, d.to.color, d.to.label)
    // 兩股線：各用兩個帳號的顏色，平滑地交纏成辮子；同步中時上面有光點往右流
    const x0 = 92
    const x1 = w - 92
    const amp = 8
    const period = (x1 - x0) / 2.5
    const strand = (phase: number) => {
      let d2 = ''
      for (let x = x0; x <= x1 + 0.1; x += 3) {
        const yy = cy + amp * Math.sin(((x - x0) / period) * Math.PI * 2 + phase)
        d2 += `${d2 ? 'L' : 'M'}${x.toFixed(1)} ${yy.toFixed(1)}`
      }
      return d2
    }
    const moving = d.tone === 'on'
    const lineA = strand(0)
    const lineB = strand(Math.PI)
    body += `<path d="${lineA}" fill="none" ${fillOf(d.from.color, 's')} stroke-width="2" stroke-linecap="round" stroke-opacity="${moving ? '.85' : '.35'}"/>`
    body += `<path d="${lineB}" fill="none" ${fillOf(d.to.color, 's')} stroke-width="2" stroke-linecap="round" stroke-opacity="${moving ? '.85' : '.35'}"/>`
    if (moving) {
      for (const [line, color] of [[lineA, d.from.color], [lineB, d.to.color]] as const) {
        for (let k = 0; k < 3; k++) {
          body += `<circle r="2.6" ${fillOf(color)}><animateMotion dur="2.4s" begin="-${(k * 0.8).toFixed(1)}s" repeatCount="indefinite" path="${line}"/></circle>`
        }
      }
    }
    body += `<path d="M${x1 + 6} ${cy - 5}L${x1 + 12} ${cy}L${x1 + 6} ${cy + 5}" fill="none" class="tick" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
    const nameY = cy + 40
    body += txt(ax, nameY, 't1', 12, fit(d.from.label, 12, ax * 2), 'font-weight="600" text-anchor="middle"')
    body += txt(w - ax, nameY, 't1', 12, fit(d.to.label, 12, ax * 2), 'font-weight="600" text-anchor="middle"')
    body += txt(ax, nameY + 15, 't3', 11, fit(d.from.caption, 11, ax * 2), 'text-anchor="middle"')
    body += txt(w - ax, nameY + 15, 't3', 11, fit(d.to.caption, 11, ax * 2), 'text-anchor="middle"')
    y = nameY + 24
  }
  for (const line of d.lines) {
    y += 18
    body += txt(0, y, 't2', 12, fit(line, 12, w))
  }
  if (d.chips.length > 0) {
    y += 12
    let x = 0
    for (const c of d.chips) {
      const p = pill(x, y + 9, null, c)
      if (x + p.w > w) break
      body += p.svg
      x += p.w + 6
    }
    y += 20
  }
  const height = Math.ceil(y + 4)
  const alt = d.summary
  return { source: svg(w, height, body), alt, height }
}

/**
 * 輸入框下方那行的迷你量表：帳號色點與名稱、5 小時與 7 天各一條細長條與百分比。
 * 規則同帳號卡：平常帳號色、到門檻警告色、用完危險色（另附圖示）。
 */
export function usageStrip(d: { label: string; color: string; windows: Window[]; thresholds: (number | null)[] }): { source: string; alt: string; height: number } {
  const h = 18
  const mid = h / 2
  let x = 0
  let body = `<circle cx="4" cy="${mid}" r="4" ${fillOf(d.color)}/>`
  const name = fit(d.label, 11, 80)
  body += txt(12, mid + 4, 't2', 11, name, 'font-weight="600"')
  x = 12 + textWidth(name, 11) + 12
  d.windows.forEach((win, i) => {
    const th = d.thresholds[i] ?? null
    const pct = win.pct
    const level = pct === null ? 'none' : pct >= 100 ? 'critical' : th !== null && pct >= th ? 'warning' : 'normal'
    const short = win.label.replace(' 小時', 'h').replace(' 天', 'd')
    body += txt(x, mid + 4, 't3', 11, short)
    x += textWidth(short, 11) + 5
    const bw = 44
    body += `<rect x="${x}" y="${mid - 2.5}" width="${bw}" height="5" rx="2.5" ${fillOf(d.color, 'k')}/>`
    if (pct !== null && pct > 0) {
      const fill = level === 'critical' ? `fill="${STATUS.critical}"` : level === 'warning' ? `fill="${STATUS.warning}"` : fillOf(d.color)
      body += `<rect x="${x}" y="${mid - 2.5}" width="${Math.max(5, (bw * Math.min(pct, 100)) / 100)}" height="5" rx="2.5" ${fill}/>`
    }
    x += bw + 5
    if (level === 'warning' || level === 'critical') {
      body += statusIcon(x, mid, level)
      x += 14
    }
    const p = pct === null ? '—' : `${pct}%`
    body += txt(x, mid + 4, 't1 num', 11, p, 'font-weight="600"')
    x += textWidth(p, 11) + 12
  })
  const w = Math.ceil(x)
  const alt = `${d.label} ${d.windows.map(win => `${win.label} ${win.pct === null ? '沒有數字' : `${win.pct}%`}`).join('，')}`
  return { source: svg(w, h, body), alt, height: h }
}

// ── 第二批：頁首、切換頁的總覽、名次列、用法插圖、歸屬總覽 ──

/** braid 的標誌：三股交纏的線（三個帳號色），r 是外框大小的一半。 */
function logo(x: number, y: number, s: number): string {
  const w = s * 2
  const strand = (phase: number, cls: string) => {
    let d = ''
    for (let i = 0; i <= 24; i++) {
      const t = i / 24
      const px = x + t * w
      const py = y + s + Math.sin(t * Math.PI * 2 + phase) * s * 0.55
      d += `${d ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`
    }
    return `<path d="${d}" fill="none" class="${cls}" stroke-width="${(s * 0.22).toFixed(1)}" stroke-linecap="round"/>`
  }
  return strand(0, 's0') + strand((Math.PI * 2) / 3, 's1') + strand((Math.PI * 4) / 3, 's2')
}

/** 面板頁首：標誌、braid、目前帳號（頭像＋名稱）、5 小時與 7 天迷你量表。 */
export function header(d: { account: { label: string; color: string } | null; windows: Window[]; thresholds: (number | null)[] }, w = 420): { source: string; alt: string; height: number } {
  const h = 40
  let body = logo(2, 9, 11)
  body += txt(32, 26, 't1', 16, 'braid', 'font-weight="700" letter-spacing="-0.3"')
  if (d.account) {
    let x = w - 1
    const bars: string[] = []
    ;[...d.windows].reverse().forEach((win, ri) => {
      const i = d.windows.length - 1 - ri
      const th = d.thresholds[i] ?? null
      const pct = win.pct ?? 0
      const level = win.pct === null ? 'none' : pct >= 100 ? 'critical' : th !== null && pct >= th ? 'warning' : 'normal'
      const p = win.pct === null ? '—' : `${pct}%`
      const pw = textWidth(p, 11)
      bars.push(txt(x, 25, 't1 num', 11, p, 'font-weight="600" text-anchor="end"'))
      x -= pw + 5 + 36
      const fill = level === 'critical' ? `fill="${STATUS.critical}"` : level === 'warning' ? `fill="${STATUS.warning}"` : fillOf(d.account!.color)
      bars.push(`<rect x="${x}" y="19" width="36" height="5" rx="2.5" ${fillOf(d.account!.color, 'k')}/>`)
      if (pct > 0) bars.push(`<rect x="${x}" y="19" width="${Math.max(5, (36 * Math.min(pct, 100)) / 100)}" height="5" rx="2.5" ${fill}/>`)
      const short = win.label.replace(' 小時', 'h').replace(' 天', 'd')
      x -= textWidth(short, 11) + 5
      bars.push(txt(x, 25, 't3', 11, short))
      x -= 12
    })
    body += bars.join('')
    const name = fit(d.account.label, 12, 90)
    x -= textWidth(name, 12) + 4
    body += txt(x, 25, 't1', 12, name, 'font-weight="600"')
    x -= 18
    body += avatar(x + 8, 20, 8, d.account.color, d.account.label)
  }
  body += `<line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" class="hair" stroke-width="1"/>`
  const alt = d.account ? `braid；目前：${d.account.label}；${d.windows.map(win => `${win.label} ${win.pct ?? '—'}%`).join('，')}` : 'braid'
  return { source: svg(w, h, body), alt, height: h }
}

/**
 * 切換頁的總覽：目前帳號兩條用量與提醒門檻（標出幾 % 提醒），右邊是「下一個可以換的」。
 */
export function switchHero(d: {
  account: { label: string; color: string }
  windows: Window[]
  thresholds: (number | null)[]
  next: { label: string; color: string; note: string } | null
}, w = 420): { source: string; alt: string; height: number } {
  let body = ''
  const colW = w - 140
  let y = 0
  body += txt(0, 14, 't3', 11, '目前的用量')
  y = 26
  d.windows.forEach((win, i) => {
    const th = d.thresholds[i] ?? null
    const pct = win.pct ?? 0
    const level = win.pct === null ? 'none' : pct >= 100 ? 'critical' : th !== null && pct >= th ? 'warning' : 'normal'
    body += txt(0, y + 10, 't2', 12, win.label)
    body += txt(colW, y + 10, 't1 num', 13, win.pct === null ? '—' : `${pct}%`, 'font-weight="600" text-anchor="end"')
    const by = y + 18
    body += `<rect x="0" y="${by}" width="${colW}" height="8" rx="4" ${fillOf(d.account.color, 'k')}/>`
    const fill = level === 'critical' ? `fill="${STATUS.critical}"` : level === 'warning' ? `fill="${STATUS.warning}"` : fillOf(d.account.color)
    if (pct > 0) body += `<rect x="0" y="${by}" width="${Math.max(8, (colW * Math.min(pct, 100)) / 100)}" height="8" rx="4" ${fill}/>`
    if (th !== null) {
      const tx = (colW * th) / 100
      body += `<line x1="${tx}" y1="${by - 4}" x2="${tx}" y2="${by + 12}" class="tick" stroke-width="1.4"/>`
      body += txt(tx, by + 24, 't3', 10, `${th}% 提醒`, tx > colW - 30 ? 'text-anchor="end"' : 'text-anchor="middle"')
    }
    y = by + 32
  })
  // 右邊：下一個可以換的
  const rx = colW + 28
  body += `<line x1="${rx - 14}" y1="4" x2="${rx - 14}" y2="${y - 6}" class="hair" stroke-width="1"/>`
  body += txt(rx, 14, 't3', 11, '下一個可以換的')
  if (d.next) {
    body += avatar(rx + 16, 44, 16, d.next.color, d.next.label)
    body += txt(rx + 40, 42, 't1', 13, fit(d.next.label, 13, w - rx - 40), 'font-weight="600"')
    body += txt(rx + 40, 58, 't3', 11, fit(d.next.note, 11, w - rx - 40))
  } else {
    body += txt(rx, 46, 't3', 12, '還沒有可以換的帳號')
  }
  const height = Math.ceil(y)
  const alt = `${d.account.label}：${d.windows.map((win, i) => `${win.label} ${win.pct ?? '—'}%（${d.thresholds[i] ?? '不'}% 提醒）`).join('，')}；下一個可以換的：${d.next ? d.next.label : '沒有'}`
  return { source: svg(w, height, body), alt, height }
}

/** 名次列：圓圈裡的名次、頭像、名稱、狀態標籤（可以換過去／還沒在桌面 app 登入過／也快用完）。 */
export function rankRow(d: { rank: number; label: string; color: string; status: { tone: 'good' | 'warn' | 'muted' | 'current'; text: string } }, w = 330): { source: string; alt: string; height: number } {
  const h = 28
  let body = `<circle cx="10" cy="14" r="9" class="panel"/>` + txt(10, 18, 't2 num', 11, String(d.rank), 'text-anchor="middle" font-weight="600"')
  body += avatar(36, 14, 10, d.color, d.label)
  const name = fit(d.label, 13, 110)
  body += txt(52, 18.5, 't1', 13, name, 'font-weight="600"')
  const x = 52 + textWidth(name, 13) + 10
  const tone = d.status.tone
  const dot = tone === 'good' ? STATUS.good : tone === 'warn' ? STATUS.warning : null
  const text = fit(d.status.text, 11, w - x - 22)
  const pw = textWidth(text, 11) + (dot ? 22 : 14)
  body += `<rect x="${x}" y="5" width="${pw}" height="18" rx="9" class="panel"/>`
  if (dot) body += `<circle cx="${x + 9}" cy="14" r="3.5" fill="${dot}"/>`
  body += txt(x + (dot ? 17 : 7), 18, tone === 'current' ? 't2' : 't2', 11, text)
  return { source: svg(w, h, body), alt: `${d.rank}. ${d.label}：${d.status.text}`, height: h }
}

/** 用法卡的插圖（48×48）。 */
export function useIcon(kind: 'switch' | 'sync' | 'policy'): { source: string; alt: string } {
  const s = 48
  let b = `<rect x="0" y="0" width="${s}" height="${s}" rx="12" class="panel"/>`
  if (kind === 'switch') {
    b += `<rect x="9" y="17" width="30" height="5" rx="2.5" class="k1"/><rect x="9" y="17" width="26" height="5" rx="2.5" fill="${STATUS.warning}"/>`
    b += `<rect x="9" y="27" width="30" height="5" rx="2.5" class="k0"/><rect x="9" y="27" width="8" height="5" rx="2.5" class="c0"/>`
    b += `<path d="M33 37l4 3-4 3M17 40h20" fill="none" class="tick" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  } else if (kind === 'sync') {
    b += `<circle cx="13" cy="24" r="6" class="c0"/><circle cx="35" cy="24" r="6" class="c1"/>`
    b += `<path d="M19 24q2.5-5 5 0t5 0" fill="none" class="s0" stroke-width="1.8" stroke-linecap="round"/><path d="M19 24q2.5 5 5 0t5 0" fill="none" class="s1" stroke-width="1.8" stroke-linecap="round"/>`
  } else {
    b += `<path d="M9 16a3 3 0 0 1 3-3h7l3 3h14a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3z" class="k2"/><path d="M9 16a3 3 0 0 1 3-3h7l3 3h14a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3z" fill="none" class="s2" stroke-width="1.4"/>`
    b += `<circle cx="20" cy="27" r="5" class="c0"/><circle cx="31" cy="27" r="5" class="c1"/>`
  }
  const alt = { switch: '用量切換的圖示', sync: '同步的圖示', policy: '歸屬的圖示' }[kind]
  return { source: svg(s, s, b), alt }
}

/** 歸屬頁的總覽：資料夾 → 歸屬帳號，下面是這個對話做的新頁會怎樣（直接發布／先排著）。 */
export function ownerHero(d: {
  project: string
  owner: { label: string; color: string } | null
  me: { label: string; color: string }
  state: 'ok' | 'mismatch' | 'unset' | 'any'
}, w = 420): { source: string; alt: string; height: number } {
  const h = 74
  // 資料夾
  let b = `<path d="M1 20a4 4 0 0 1 4-4h10l4 4h18a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4z" class="k2"/>`
  b += `<path d="M1 20a4 4 0 0 1 4-4h10l4 4h18a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4z" fill="none" class="s2" stroke-width="1.4"/>`
  const name = fit(d.project, 14, 130)
  b += txt(52, 30, 't1', 14, name, 'font-weight="600"')
  b += txt(52, 46, 't3', 11, '這個資料夾')
  // 箭頭
  const ax = 52 + Math.max(textWidth(name, 14), 60) + 16
  b += `<path d="M${ax} 31h28m-6-5 6 5-6 5" fill="none" class="tick" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  const ox = ax + 44
  if (d.owner) {
    b += avatar(ox + 14, 30, 14, d.owner.color, d.owner.label)
    b += txt(ox + 34, 30, 't1', 14, fit(d.owner.label, 14, w - ox - 34), 'font-weight="600"')
    b += txt(ox + 34, 46, 't3', 11, '歸屬帳號')
  } else {
    b += `<circle cx="${ox + 14}" cy="30" r="13" fill="none" class="tick" stroke-width="1.2" stroke-dasharray="3 3"/>`
    b += txt(ox + 14, 34.5, 't3', 13, d.state === 'any' ? '*' : '?', 'text-anchor="middle" font-weight="600"')
    b += txt(ox + 34, 30, 't1', 14, d.state === 'any' ? '不分' : '還沒設定', 'font-weight="600"')
    b += txt(ox + 34, 46, 't3', 11, d.state === 'any' ? '哪個帳號都可以' : '新頁會先排著')
  }
  // 狀態列
  const color = d.state === 'ok' ? STATUS.good : d.state === 'mismatch' ? STATUS.warning : null
  const label = d.state === 'mismatch' ? `新頁先排著，等歸屬帳號發布（這個對話是「${d.me.label}」）` : d.state === 'unset' ? `這個對話是「${d.me.label}」` : `新頁直接發布（這個對話是「${d.me.label}」）`
  b += color ? `<circle cx="5" cy="${h - 7}" r="4" fill="${color}"/>` : `<circle cx="5" cy="${h - 7}" r="3.6" fill="none" class="tick" stroke-width="1.2"/>`
  b += txt(15, h - 3, 't2', 12, fit(label, 12, w - 15))
  const alt = `${d.project} → ${d.owner ? d.owner.label : d.state === 'any' ? '不分' : '還沒設定'}；${label}`
  return { source: svg(w, h, b), alt, height: h }
}

/** 備份的兩格統計：同步刪掉的對話（筆數、大小、留多久）、整份備份（份數、留幾份）。 */
export function backupTiles(d: { trash: { count: number; size: string; keep: string }; tool: { count: number; keep: string } }, w = 420): { source: string; alt: string; height: number } {
  const h = 70
  const gap = 10
  const tw = (w - gap) / 2
  const tile = (x: number, title: string, big: string, unit: string, sub: string) => {
    let b = `<rect x="${x}" y="0" width="${tw}" height="${h}" rx="10" class="panel"/>`
    b += txt(x + 12, 20, 't3', 11, title)
    b += txt(x + 12, 46, 't1', 22, big, 'font-weight="700"')
    b += txt(x + 12 + textWidth(big, 22) + 4, 46, 't2', 12, unit)
    b += txt(x + 12, 62, 't3', 11, fit(sub, 11, tw - 20))
    return b
  }
  let body = tile(0, '同步刪掉的對話', String(d.trash.count), `筆 · ${d.trash.size}`, d.trash.keep)
  body += tile(tw + gap, '遷移與帶環境的整份備份', String(d.tool.count), '份', d.tool.keep)
  const alt = `同步刪掉的對話：${d.trash.count} 筆、${d.trash.size}，${d.trash.keep}；整份備份：${d.tool.count} 份，${d.tool.keep}`
  return { source: svg(w, h, body), alt, height: h }
}
