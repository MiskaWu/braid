// switchboard：Claude 的帳號工具。對話裡用 /switchboard <動作>，動作名稱與命令列版共用。
// 目前一個動作：migrate 開獨立視窗跑桌面 app 的遷移工具（tool/）。指令本身不碰任何帳號資料，
// 讀寫全在工具裡做，工具也能不透過 Claude 直接雙擊。之後的同步、切換帳號：在 ACTIONS 加一列、
// 在 command.run 的 switch 加一個 case（引擎不准把 $ 經由資料結構傳遞，所以分派寫成 switch）。
import type { EngineInterface, Register } from 'claude-code'
import { manualPath, parseDryRun, planLaunch, type Platform } from './launch'

type Action = { name: 'migrate'; aliases: readonly string[]; usage: string; summary: string }

const ACTIONS: readonly Action[] = [
  {
    name: 'migrate',
    aliases: ['遷移'],
    usage: 'migrate [試跑]',
    summary: '把桌面 app 舊帳號的側欄對話與已儲存的環境搬到目前帳號（開獨立視窗執行；試跑只列計畫）',
  },
]

/** 拆出動作與其餘參數：`migrate 試跑` → migrate、`試跑`。 */
export function parseCommand(args: string): { action: Action | undefined; word: string; rest: string } {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const action = ACTIONS.find(a => a.name === word.toLowerCase() || a.aliases.includes(word))
  return { action, word, rest: rest.join(' ') }
}

function help(prefix?: string): string {
  const lines = ACTIONS.map(a => `  /switchboard ${a.usage}\n      ${a.summary}`)
  return [...(prefix ? [prefix, ''] : []), '用法：', ...lines].join('\n')
}

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

async function migrate($: EngineInterface, rest: string): Promise<string> {
  const platform = await detectPlatform($)
  const dryRun = parseDryRun(rest)
  const tmpDir = platform === 'mac' ? await $.env.get('TMPDIR') : undefined
  const plan = planLaunch(platform, $.plugin.root, dryRun, tmpDir)
  if ('unsupported' in plan) return 'Claude 桌面 app 只有 Windows 與 macOS 版，這台電腦上沒有桌面 app 的資料可以遷移。'
  for (const step of plan.actions) {
    if ('write' in step) {
      await $.fs.write(step.write.path, step.write.text)
      continue
    }
    const result = await $.process.run(step.run, { timeoutMs: 60_000 })
    if (result.exitCode !== 0) {
      const why = (result.stderr || result.stdout).trim().split('\n').slice(-3).join('\n')
      return `開不了遷移視窗（${why || `結束碼 ${result.exitCode}`}）。\n也可以直接雙擊：${manualPath(platform, $.plugin.root)}`
    }
  }
  const quit = platform === 'mac' ? '選單列 Claude →「結束 Claude」（⌘Q）' : '右下角系統匣的 Claude 圖示按右鍵 →「結束」'
  return [
    dryRun ? '已在另一個視窗開啟遷移工具（試跑：只列出計畫，不會寫入）。' : '已在另一個視窗開啟遷移工具。',
    `接下來照那個視窗的指示：先${quit}，只關掉視窗不夠。這個對話會跟著中斷，沒關係。`,
    '工具會先備份再搬，最後問你要不要重新開啟 Claude；重開後在側欄找回這個對話即可。',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'switchboard',
      description: 'Claude 帳號工具：migrate＝換帳號後把桌面 app 的舊對話與環境搬過來',
      argumentHint: 'migrate [試跑]',
    })
    return started
  })

  on('command.run', { command: 'switchboard' }, async ($, e) => {
    const { action, word, rest } = parseCommand(e.args)
    if (!action) return { text: help(word ? `沒有「${word}」這個動作。` : undefined) }
    switch (action.name) {
      case 'migrate':
        return { text: await migrate($, rest) }
    }
  })
}
