import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseDryRun, planLaunch } from '../hooks/launch'

// 假的主機：環境變數、uname 的答案、每次 process.run／fs.write 收到什麼。
function world(on: On, env: Record<string, string>, opts: { uname?: string; fail?: string } = {}) {
  const runs: string[][] = []
  const writes: { path: string; text: string }[] = []
  mock.env(on, env)
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'uname') return ok(`${opts.uname ?? 'Linux'}\n`)
    if (opts.fail) return { value: { exitCode: 1, stdout: '', stderr: opts.fail, isStdoutTruncated: false, isStderrTruncated: false } }
    return ok('')
  })
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  return { runs, writes }
}

const RUN = (args = 'migrate') => ({ command: 'braid', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })

describe('/braid migrate 依平台開獨立視窗', () => {
  test('WSL：交給 launch-from-wsl.sh（它會複製到 Windows 暫存再開視窗）', async ($, on) => {
    const { runs } = world(on, { WSL_DISTRO_NAME: 'dev' })
    const { text } = await $.command.run(RUN())
    expect(runs.length).toBe(1)
    expect(runs[0]?.[0]).toBe('bash')
    expect(runs[0]?.[1]).toMatch(/^\/.+\/tool\/launch-from-wsl\.sh$/)
    expect(runs[0]?.length).toBe(2)
    expect(text).toContain('已在另一個視窗開啟遷移工具。')
    expect(text).toContain('系統匣')
  })

  test('WSL 試跑：帶 -DryRun', async ($, on) => {
    const { runs } = world(on, { WSL_DISTRO_NAME: 'dev' })
    const { text } = await $.command.run(RUN('migrate 試跑'))
    expect(runs[0]?.[1]).toMatch(/\/tool\/launch-from-wsl\.sh$/)
    expect(runs[0]?.[2]).toBe('-DryRun')
    expect(text).toContain('試跑')
  })

  test('Windows 原生：用 Start-Process 開 migrate.cmd，不經過 uname', async ($, on) => {
    const { runs } = world(on, { OS: 'Windows_NT' })
    await $.command.run(RUN())
    expect(runs.length).toBe(1)
    expect(runs[0]?.slice(0, 3)).toEqual(['powershell.exe', '-NoProfile', '-Command'])
    expect(runs[0]?.[3]).toMatch(/^Start-Process -FilePath '.*\\tool\\windows\\migrate\.cmd'$/)
  })

  test('macOS：用 Terminal 開 migrate.command', async ($, on) => {
    const { runs, writes } = world(on, {}, { uname: 'Darwin' })
    const { text } = await $.command.run(RUN())
    expect(runs.length).toBe(2)
    expect(runs[0]).toEqual(['uname', '-s'])
    expect(runs[1]?.slice(0, 3)).toEqual(['open', '-a', 'Terminal'])
    expect(runs[1]?.[3]).toMatch(/^\/.+\/tool\/macos\/migrate\.command$/)
    expect(writes).toEqual([])
    expect(text).toContain('⌘Q')
  })

  test('macOS 試跑：寫一個帶 --dry-run 的包裝再開', async ($, on) => {
    const { runs, writes } = world(on, { TMPDIR: '/var/folders/x/T/' }, { uname: 'Darwin' })
    await $.command.run(RUN('遷移 dry-run'))
    const wrapper = '/var/folders/x/T/braid-migrate-dry-run.command'
    expect(writes.length).toBe(1)
    expect(writes[0]?.path).toBe(wrapper)
    expect(writes[0]?.text).toMatch(/^#!\/bin\/bash\nexec "\/.+\/tool\/macos\/migrate\.command" --dry-run\n$/)
    expect(runs.slice(1)).toEqual([['chmod', '+x', wrapper], ['open', '-a', 'Terminal', wrapper]])
  })

  test('Linux（非 WSL）：說明不支援，什麼都不執行', async ($, on) => {
    const { runs } = world(on, {})
    const { text } = await $.command.run(RUN())
    expect(runs).toEqual([['uname', '-s']])
    expect(text).toContain('只有 Windows 與 macOS 版')
  })

  test('開不了視窗：說原因，並給可以直接雙擊的檔案', async ($, on) => {
    world(on, { WSL_DISTRO_NAME: 'dev' }, { fail: '讀不到 Windows 的暫存資料夾位置' })
    const { text } = await $.command.run(RUN())
    expect(text).toContain('開不了遷移視窗（讀不到 Windows 的暫存資料夾位置）')
    expect(text).toContain('migrate.cmd')
  })
})

describe('/braid 的動作', () => {
  test('不帶動作：列出用法，什麼都不執行', async ($, on) => {
    const { runs } = world(on, { WSL_DISTRO_NAME: 'dev' })
    const { text } = await $.command.run(RUN(''))
    expect(runs).toEqual([])
    expect(text).toContain('用法：')
    expect(text).toContain('/braid migrate [試跑]')
  })

  test('不認得的動作：說明並列出用法，什麼都不執行', async ($, on) => {
    const { runs } = world(on, { WSL_DISTRO_NAME: 'dev' })
    const { text } = await $.command.run(RUN('switch 公司'))
    expect(runs).toEqual([])
    expect(text).toContain('沒有「switch」這個動作。')
  })

  test('試跑不是動作：/braid 試跑 不會開視窗', async ($, on) => {
    const { runs } = world(on, { WSL_DISTRO_NAME: 'dev' })
    await $.command.run(RUN('試跑'))
    expect(runs).toEqual([])
  })
})

describe('純函式', () => {
  test('試跑的寫法', async () => {
    for (const a of ['試跑', 'dry-run', 'dryrun', '--dry-run', '-DryRun', '  試跑  ']) expect(parseDryRun(a)).toBe(true)
    for (const a of ['', '跑', 'run', 'not-dry-run-really']) expect(parseDryRun(a)).toBe(false)
  })

  test('路徑裡的引號不會弄壞指令', async () => {
    const win = planLaunch('windows', "C:/Users/O'Neil/.claude/plugins/x", false)
    expect('actions' in win && win.actions[0]).toEqual({ run: ['powershell.exe', '-NoProfile', '-Command', "Start-Process -FilePath 'C:\\Users\\O''Neil\\.claude\\plugins\\x\\tool\\windows\\migrate.cmd'"] })
    const mac = planLaunch('mac', '/Users/a "b"/$x', true, '/tmp')
    expect('actions' in mac && mac.actions[0]).toEqual({ write: { path: '/tmp/braid-migrate-dry-run.command', text: '#!/bin/bash\nexec "/Users/a \\"b\\"/\\$x/tool/macos/migrate.command" --dry-run\n' } })
  })
})
