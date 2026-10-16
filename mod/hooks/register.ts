// desktop-accounts：Claude 桌面 app 的帳號工具。
// 目前一個指令：/desktop-migrate 開獨立視窗跑遷移工具（tool/）。指令本身不碰任何帳號資料，
// 讀寫全在工具裡做，工具也能不透過 Claude 直接雙擊執行。之後的帳號管理、同步選項加在這個 mod。
import type { EngineInterface, Register } from 'claude-code'
import { manualPath, parseDryRun, planLaunch, type Platform } from './launch'

async function detectPlatform($: EngineInterface): Promise<Platform> {
  if (await $.env.get('WSL_DISTRO_NAME')) return 'wsl'
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  try {
    const { exitCode, stdout } = await $.process.run(['uname', '-s'])
    if (exitCode === 0 && stdout.trim() === 'Darwin') return 'mac'
  } catch {
    // 沒有 uname 就當不支援的平台
  }
  return 'other'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'desktop-migrate',
      description: '把桌面 app 舊帳號的側欄對話與已儲存的環境搬到目前帳號（開獨立視窗執行）',
      argumentHint: '[試跑]',
    })
    return started
  })

  on('command.run', { command: 'desktop-migrate' }, async ($, e) => {
    const platform = await detectPlatform($)
    const dryRun = parseDryRun(e.args)
    const tmpDir = platform === 'mac' ? await $.env.get('TMPDIR') : undefined
    const plan = planLaunch(platform, $.plugin.root, dryRun, tmpDir)
    if ('unsupported' in plan) {
      return { text: 'Claude 桌面 app 只有 Windows 與 macOS 版，這台電腦上沒有桌面 app 的資料可以遷移。' }
    }
    for (const action of plan.actions) {
      if ('write' in action) {
        await $.fs.write(action.write.path, action.write.text)
        continue
      }
      const result = await $.process.run(action.run, { timeoutMs: 60_000 })
      if (result.exitCode !== 0) {
        const why = (result.stderr || result.stdout).trim().split('\n').slice(-3).join('\n')
        return { text: `開不了遷移視窗（${why || `結束碼 ${result.exitCode}`}）。\n也可以直接雙擊：${manualPath(platform, $.plugin.root)}` }
      }
    }
    const quit = platform === 'mac' ? '選單列 Claude →「結束 Claude」（⌘Q）' : '右下角系統匣的 Claude 圖示按右鍵 →「結束」'
    return {
      text: [
        dryRun ? '已在另一個視窗開啟遷移工具（試跑：只列出計畫，不會寫入）。' : '已在另一個視窗開啟遷移工具。',
        `接下來照那個視窗的指示：先${quit}，只關掉視窗不夠。這個對話會跟著中斷，沒關係。`,
        '工具會先備份再搬，最後問你要不要重新開啟 Claude；重開後在側欄找回這個對話即可。',
      ].join('\n'),
    }
  })
}
