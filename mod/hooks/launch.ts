// 依平台決定怎麼開遷移工具的視窗。純函式：給平台、plugin 根目錄與要做什麼，回要執行的動作。
// 遷移、同步、還原都一定要在桌面 app 結束後寫入，所以一律開「獨立的」終端機視窗跑工具：
// 那個視窗不屬於 Claude，結束 app 後還在，它會等 app 結束、問該問的、寫入、再問要不要重開 app。

export type Platform = 'wsl' | 'windows' | 'mac' | 'other'

export type Action = { run: string[] } | { write: { path: string; text: string } }

export type LaunchPlan = { actions: Action[] } | { unsupported: true }

/** 要工具做什麼。同步＝從另一個帳號把選定資料夾的對話帶過來，環境跟著資料夾走。 */
export type ToolRequest = {
  dryRun?: boolean
  from?: string
  projects?: readonly string[]
  presets?: 'all' | 'none' | 'folders'
  restore?: string
}

/** `/braid migrate 試跑`（或 dry-run）只列出計畫，不寫入。 */
export function parseDryRun(args: string): boolean {
  return args
    .trim()
    .split(/\s+/)
    .some(word => /^(試跑|-{0,2}dry-?run)$/i.test(word))
}

/**
 * 工具的參數：Windows 版（PowerShell）是 -From，macOS 版是 --from。
 * 資料夾用逗號分隔，所以資料夾名稱本身有逗號就沒辦法用參數指定；Windows 的值還要經過 cmd，
 * 裡面有 " 或 % 會被解讀。這兩種情況回 unsafe，由呼叫的人請使用者改用工具裡的勾選清單。
 */
export function toolArgs(platform: Platform, req: ToolRequest): string[] | { unsafe: string } {
  const mac = platform === 'mac'
  const flag = (ps: string, js: string) => (mac ? js : ps)
  const out: string[] = []
  if (req.restore) {
    out.push(flag('-Restore', '--restore'), req.restore)
  } else {
    if (req.dryRun) out.push(flag('-DryRun', '--dry-run'))
    if (req.from) out.push(flag('-From', '--from'), req.from)
    if (req.projects) {
      const comma = req.projects.find(p => p.includes(','))
      if (comma !== undefined) return { unsafe: comma }
      out.push(flag('-Projects', '--projects'), req.projects.length ? req.projects.join(',') : 'none')
    }
    if (req.presets) out.push(flag('-Presets', '--presets'), req.presets)
  }
  if (!mac) {
    const bad = out.find(a => /["%\r\n]/.test(a))
    if (bad !== undefined) return { unsafe: bad }
  }
  return out
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`
const dq = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`

export function planLaunch(platform: Platform, root: string, args: readonly string[], tmpDir?: string): LaunchPlan {
  switch (platform) {
    case 'wsl':
      // 腳本在 WSL 裡；它把工具複製到 Windows 暫存資料夾再開視窗（見 launch-from-wsl.sh）
      return { actions: [{ run: ['bash', `${root}/tool/launch-from-wsl.sh`, ...args] }] }
    case 'windows': {
      const cmd = `${root.replace(/\//g, '\\')}\\tool\\windows\\migrate.cmd`
      // 參數名稱原樣、值加雙引號：Start-Process 把清單用空白接起來，cmd 的 %* 再原樣交給 PowerShell
      const list = args.map(a => psq(a.startsWith('-') ? a : `"${a}"`)).join(',')
      const ps = `Start-Process -FilePath ${psq(cmd)}` + (list ? ` -ArgumentList ${list}` : '')
      return { actions: [{ run: ['powershell.exe', '-NoProfile', '-Command', ps] }] }
    }
    case 'mac': {
      const script = `${root}/tool/macos/migrate.command`
      if (args.length === 0) return { actions: [{ run: ['open', '-a', 'Terminal', script] }] }
      // open 沒辦法把參數交給 .command，有參數時寫一個帶參數的小包裝
      const wrapper = `${(tmpDir ?? '/tmp').replace(/\/+$/, '')}/braid-migrate.command`
      return {
        actions: [
          { write: { path: wrapper, text: `#!/bin/bash\nexec ${[script, ...args].map(dq).join(' ')}\n` } },
          { run: ['chmod', '+x', wrapper] },
          { run: ['open', '-a', 'Terminal', wrapper] },
        ],
      }
    }
    default:
      return { unsupported: true }
  }
}

/** 給使用者自己開的備案：雙擊哪個檔。 */
export function manualPath(platform: Platform, root: string): string {
  if (platform === 'mac') return `${root}/tool/macos/migrate.command`
  if (platform === 'windows') return `${root.replace(/\//g, '\\')}\\tool\\windows\\migrate.cmd`
  return `${root}/tool/windows/migrate.cmd`
}
