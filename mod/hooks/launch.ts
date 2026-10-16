// 依平台決定怎麼開遷移視窗。純函式：給平台、plugin 根目錄與要不要試跑，回要做的動作。
// 遷移一定要在桌面 app 結束後寫入，所以一律開「獨立的」終端機視窗跑工具：
// 那個視窗不屬於 Claude，結束 app 後還在，它會等 app 結束、問該問的、寫入、再問要不要重開 app。

export type Platform = 'wsl' | 'windows' | 'mac' | 'other'

export type Action = { run: string[] } | { write: { path: string; text: string } }

export type LaunchPlan = { actions: Action[] } | { unsupported: true }

/** `/desktop-migrate 試跑`（或 dry-run）只列出計畫，不寫入。 */
export function parseDryRun(args: string): boolean {
  return args
    .trim()
    .split(/\s+/)
    .some(word => /^(試跑|-{0,2}dry-?run)$/i.test(word))
}

export function planLaunch(platform: Platform, root: string, dryRun: boolean, tmpDir?: string): LaunchPlan {
  switch (platform) {
    case 'wsl':
      // 腳本在 WSL 裡；它把工具複製到 Windows 暫存資料夾再開視窗（見 launch-from-wsl.sh）
      return { actions: [{ run: ['bash', `${root}/tool/launch-from-wsl.sh`, ...(dryRun ? ['-DryRun'] : [])] }] }
    case 'windows': {
      const cmd = `${root.replace(/\//g, '\\')}\\tool\\windows\\migrate.cmd`.replace(/'/g, "''")
      const ps = `Start-Process -FilePath '${cmd}'` + (dryRun ? " -ArgumentList '-DryRun'" : '')
      return { actions: [{ run: ['powershell.exe', '-NoProfile', '-Command', ps] }] }
    }
    case 'mac': {
      const script = `${root}/tool/macos/migrate.command`
      if (!dryRun) return { actions: [{ run: ['open', '-a', 'Terminal', script] }] }
      // open 沒辦法把參數交給 .command，試跑時寫一個帶參數的小包裝
      const wrapper = `${(tmpDir ?? '/tmp').replace(/\/+$/, '')}/claude-desktop-migrate-dry-run.command`
      const quoted = script.replace(/(["\\$`])/g, '\\$1')
      return {
        actions: [
          { write: { path: wrapper, text: `#!/bin/bash\nexec "${quoted}" --dry-run\n` } },
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
