import { describe, expect, mock, test } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

// 情境：WSL 裡、桌面 app 開的對話，登入公司帳號 W（公司組織 OW）。
// 這台電腦的桌面 app 另有個人帳號 P 的對話；braid 另外新增過一個公司第二帳號 W2（有憑證、同組織）。
const NOW = Date.parse('2026-10-16T06:00:00Z') // 14:00（UTC+8）
const H = 3600_000
const W = 'aaaaaaaa-0000-4000-8000-000000000001'
const P = 'bbbbbbbb-0000-4000-8000-000000000002'
const OW = 'org-work'
const OP = 'org-home'
const APP = '/mnt/c/Users/u/AppData/Roaming/Claude'
const SESS = `${APP}/claude-code-sessions`
const BACKUPS = '/mnt/c/Users/u/braid-backups'

const DESKTOP_ENV = {
  WSL_DISTRO_NAME: 'dev',
  HOME: '/home/u',
  CLAUDE_CODE_EXECPATH: '/opt/claude',
  CLAUDE_CODE_ACCOUNT_UUID: W,
  CLAUDE_CODE_USER_EMAIL: 'me@corp.example',
  CLAUDE_CODE_ORGANIZATION_UUID: OW,
}

const acct = (id: string, over: Record<string, unknown>) => ({
  id,
  email: null,
  orgId: null,
  orgName: null,
  label: id,
  color: '#3B6FE0',
  source: 'desktop',
  credential: null,
  credentialId: null,
  usage: null,
  lastSeen: 1,
  ...over,
})

const PERSONAL = acct(P, { email: 'me@gmail.example', orgId: OP, label: '個人', color: '#14A38E', usage: { fiveHour: { pct: 12, resetsAt: null }, sevenDay: null, at: NOW - 2 * H } })
const WORK2 = acct('tok-00000002', { orgId: OW, label: '公司 2', color: '#D9822B', source: 'token', credential: 'file', credentialId: 'tok-00000002' })

type Opts = {
  env?: Record<string, string>
  store?: Record<string, unknown>
  policy?: Record<string, unknown>
  cwd?: string
  files?: Record<string, string>
  /** 檔案的修改時間（沒給是 NOW）；寫進去的檔依寫入順序排在 NOW 之後 */
  mtimes?: Record<string, number>
  uname?: string
  /** 開視窗的 bash 失敗時回的訊息 */
  failBash?: string
  /** rm 失敗（檔案被占用） */
  failRm?: boolean
  /** git -C <資料夾> remote get-url origin 的回答（沒列到的＝不是 git repo） */
  remotes?: Record<string, string>
  /** GitHub 上的 braid 版本；null＝連不上 */
  latest?: string | null
  /** claude plugin … 失敗時回的訊息 */
  failClaude?: string
}

const entry = (name: string, kind: FsEntry['kind'], mtimeMs = NOW, size = 1): FsEntry => ({ name, kind, size, mtimeMs, isLink: false })

// tool/spec.json 的 sessions 段（測試讀不到外掛的真檔，照抄一份）
const SPEC = JSON.stringify({
  sessions: {
    dir: 'claude-code-sessions',
    filePrefix: 'local_',
    tombstonePrefix: 'deleted_',
    archivedIndex: 'archived-sessions.idx',
    requiredKeys: ['sessionId', 'cliSessionId', 'cwd'],
    dropKeys: ['bridgeSessionIds', 'sshReattach', 'sshRemoteProcessId', 'priorRemoteCliSessionIds', 'scheduledTaskId'],
    nullKeys: ['startedFromEnvironmentId'],
    replaceFromTarget: ['remoteMcpServersConfig'],
  },
})

function world(on: On, opts: Opts = {}) {
  const runs: { argv: string[]; env?: Record<string, string> }[] = []
  const files: Record<string, string> = {
    // 桌面 app 的側欄：公司帳號在 /w/server 有 1 筆；個人帳號在 /w/server、/side/blog 各有對話
    [`${SESS}/${W}/${OW}/local_1.json`]: JSON.stringify({ cwd: '/w/server', lastActivityAt: NOW - H }),
    [`${SESS}/${P}/${OP}/local_2.json`]: JSON.stringify({ originCwd: '/w/server', cwd: '/w/server/.claude/worktrees/x', lastActivityAt: NOW - 3 * H }),
    [`${SESS}/${P}/${OP}/local_3.json`]: JSON.stringify({ cwd: '/side/blog', lastActivityAt: NOW - 5 * H }),
    [`${SESS}/${P}/${OP}/local_4.json`]: JSON.stringify({ cwd: '/side/blog', lastActivityAt: NOW - 6 * H }),
    [`${SESS}/${P}/${OP}/local_5.json`]: '壞掉的檔案',
    [`${BACKUPS}/20261016-140211/manifest.json`]: '{}',
    // 桌面 app 現在登入的帳號
    [`${APP}/config.json`]: JSON.stringify({ lastKnownAccountUuid: W }),
    // 跑這個對話的 claude（CLAUDE_CODE_EXECPATH）
    '/opt/claude': '',
    ...opts.files,
  }
  const mtimes: Record<string, number> = { ...opts.mtimes }
  let writes = 0
  const dirs: Record<string, FsEntry[]> = {
    [SESS]: [entry(W, 'dir'), entry(P, 'dir')],
    [`${SESS}/${W}`]: [entry(OW, 'dir')],
    [`${SESS}/${P}`]: [entry(OP, 'dir')],
    [`${SESS}/${W}/${OW}`]: [entry('local_1.json', 'file'), entry('archived-sessions.idx', 'file')],
    [`${SESS}/${P}/${OP}`]: ['local_2.json', 'local_3.json', 'local_4.json', 'local_5.json'].map(n => entry(n, 'file')),
    [BACKUPS]: [entry('20261016-140211', 'dir'), entry('not-a-backup', 'dir')],
  }
  const opened: string[] = []
  const toasts: string[] = []
  const copies: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { ...DESKTOP_ENV, ...opts.env })
  // braid 的跨對話儲存：自己記，測試才讀得到寫了什麼
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => ({ text: e.text, wait: false }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>? 看快捷鍵</Text>
  })
  on('session.cwd', () => ({ value: opts.cwd ?? '/w/server' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('settings.read', ($, e) => ({ value: e.source === 'policy' ? (opts.policy ?? {}) : {} }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push({ argv, ...(e.init?.env ? { env: e.init.env } : {}) })
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'uname') return out(`${opts.uname ?? 'Linux'}\n`)
    if (argv[0] === 'bash' && opts.failBash) return { value: { exitCode: 1, stdout: '', stderr: opts.failBash, isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'date') return out('+0800\n')
    if (argv[0] === 'git' && argv[3] === 'remote') {
      const r = opts.remotes?.[argv[2] ?? '']
      return r ? out(`${r}\n`) : { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === '/opt/claude' && argv[1] === 'plugin' && opts.failClaude) return { value: { exitCode: 1, stdout: '', stderr: opts.failClaude, isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'rm' && argv[1] === '-rf' && argv[2] === '--') {
      for (const f of Object.keys(files)) if (f.startsWith(`${argv[3]}/`)) delete files[f]
      return out('')
    }
    if (argv[0] === 'rm' && argv[2] === '--') {
      if (opts.failRm) return { value: { exitCode: 1, stdout: '', stderr: 'busy', isStdoutTruncated: false, isStderrTruncated: false } }
      delete files[argv[3] ?? '']
      return out('')
    }
    if (argv[0] === 'cmd.exe' && argv[2] === 'echo %APPDATA%') return out('C:\\Users\\u\\AppData\\Roaming\r\n')
    if (argv[0] === 'cmd.exe' && argv[2] === 'echo %USERPROFILE%') return out('C:\\Users\\u\r\n')
    if (argv[0] === 'wslpath') return out(`/mnt/c/${(argv[2] ?? '').slice(3).replace(/\\/g, '/')}\n`)
    return out('')
  })
  on('fs.read', ($, e) => {
    const text = e.path.endsWith('/tool/spec.json') ? SPEC : e.path.endsWith('/.claude-plugin/plugin.json') ? JSON.stringify({ name: 'braid', version: '0.3.4' }) : files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    mtimes[e.path] = NOW + ++writes
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files || e.path in dirs }))
  // 目錄：上面列的，加上檔案表裡在它底下的檔（含寫進去的）與子資料夾
  on('fs.list', ($, e) => {
    const listed = new Map((dirs[e.path] ?? []).map(d => [d.name, d]))
    for (const f of Object.keys(files)) {
      if (!f.startsWith(`${e.path}/`)) continue
      const rest = f.slice(e.path.length + 1)
      const cut = rest.indexOf('/')
      if (cut < 0) listed.set(rest, entry(rest, 'file', mtimes[f] ?? NOW, files[f]?.length ?? 1))
      else if (!listed.has(rest.slice(0, cut))) listed.set(rest.slice(0, cut), entry(rest.slice(0, cut), 'dir'))
    }
    return { value: [...listed.values()] }
  })
  const fetched: string[] = []
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    if (opts.latest === null) throw new Error('offline')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ version: opts.latest ?? '0.3.4' }) } }
  })
  // 發布頁面的工具：記下每一次真的送到工具的呼叫（擋下的不會到這裡），新頁回一個網址
  const artifacts: Record<string, unknown>[] = []
  on('tool.call', { tool: 'Artifact' }, ($, e) => {
    artifacts.push({ ...e })
    const url = typeof (e as { url?: unknown }).url === 'string' ? (e as { url: string }).url : `https://claude.ai/code/artifact/page-${artifacts.length}`
    return { result: { url }, text: `Published ${url}` } as never
  })
  const reloads: string[] = []
  on('command.run', { command: 'reload-plugins' }, () => {
    reloads.push('reload-plugins')
    return { text: '' }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  return { runs, files, mtimes, opened, toasts, copies, statuses, clock, store, fetched, reloads, artifacts }
}

const SURFACES = ['terminal', 'desktop'] as const
const PANE = {
  plugin: 'braid',
  component: 'Pane' as const,
  requestId: 'braid',
  props: { title: 'braid', isFocused: true, bodyColumns: 64, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}
const BAND = {
  plugin: 'braid',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
}
const START = { cwd: '/w/server', surface: 'desktop' as const, isInteractive: true }
const RUN = (args = '') => ({ command: 'braid', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } })
const USES_ALL = { migrate: true, switch: true, sync: true }
const SYNC_ON = { on: true, pair: [W, P], all: true, folders: [] }
/** 一筆桌面 app 的側欄紀錄（local_<id>.json）：必要欄位加上要改的 */
const rec = (id: string, over: Record<string, unknown>) =>
  JSON.stringify({ sessionId: `local_${id}`, cliSessionId: `cli-${id}`, cwd: '/w/server', lastActivityAt: NOW - H, ...over })
const usage = (five: number, seven = 20) => [
  { kind: 'five_hour', percentUsed: five, resetsAt: new Date(NOW + 2 * H).toISOString() },
  { kind: 'seven_day', percentUsed: seven, resetsAt: new Date(NOW + 96 * H).toISOString() },
]
const measure = (five: number) => ({ context: { window: 200_000 }, rateLimits: usage(five), changed: ['rateLimits' as const] })

type Drawing = {
  find: (q: { type?: string; key?: string; text?: string | RegExp }) => Promise<unknown>
  findAll: (q: { type?: string }) => Promise<{ props: Record<string, unknown> }[]>
}
const shows = async (ui: Drawing, text: RegExp) => (await ui.find({ text })) !== undefined
/** 文字裡、或圖（Svg）的說明裡看得到：桌面版把帳號卡與同步卡畫成圖，內容寫在 alt */
const seen = async (ui: Drawing, text: RegExp) => (await shows(ui, text)) || (await ui.findAll({ type: 'Svg' })).some(el => text.test(String(el.props.alt ?? '')))

describe('第一次打開：選用法', () => {
  test('/braid 開面板；還沒選過用法就先問，選完存起來、出現對應的分頁', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const { text } = await $.command.run(RUN())
    expect(text).toBe('已打開 braid 面板。')
    expect(w.opened).toEqual(['braid'])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await shows(ui, /你想用 braid 做什麼/)).toBe(true)
      expect(await ui.find({ key: 'tab-accounts' })).toBeUndefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'use-switch' })
    await ui.press({ key: 'use-migrate' })
    await ui.press({ key: 'use-save' })
    expect(await w.store.get('uses')).toEqual({ migrate: true, switch: true, sync: false, policy: false })
    expect(await ui.find({ key: 'tab-switch' })).toBeDefined()
    expect(await ui.find({ key: 'tab-migrate' })).toBeDefined()
    expect(await ui.find({ key: 'tab-sync' })).toBeUndefined()
    expect(await shows(ui, /接手順序/)).toBe(true) // 選了用量切換，直接到切換頁
    await ui.unmount()
  })
})

describe('帳號與用量', () => {
  test('認出桌面 app 的帳號（公司信箱叫「公司」），用量進來後顯示用量條與重置時間，狀態列跟著更新', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: PERSONAL } })
    await $.session.start(START)
    const saved = (await w.store.get(`account:${W}`)) as { label: string; email: string; orgId: string; source: string }
    expect([saved.label, saved.email, saved.orgId, saved.source]).toEqual(['公司', 'me@corp.example', OW, 'desktop'])
    await $.session.measure(measure(62) as never)
    expect(((await w.store.get(`account:${W}`)) as { usage: { fiveHour: { pct: number } } }).usage.fiveHour.pct).toBe(62)
    expect(w.statuses.at(-1)).toBe('braid · 公司 5 小時 62% · 7 天 20%')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await seen(ui, /62%/)).toBe(true)
      expect(await seen(ui, /16:00 重置/)).toBe(true)
      expect(await seen(ui, /這個對話/)).toBe(true)
      expect(await seen(ui, /5 小時 12%.*2 小時前的數字/)).toBe(true)
      expect(await seen(ui, /braid 沒有它的登入憑證/)).toBe(true)
      // 桌面版畫成圖（頁首＋兩張帳號卡）、終端機是文字
      expect((await ui.findAll({ type: 'Svg' })).length).toBe(surface === 'desktop' ? 3 : 0)
      await ui.unmount()
    }
  })

  test('隨時都能換：有憑證的帳號卡片上可以直接用它接著這段對話；沒憑證的沒有這顆按鈕', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: PERSONAL, 'account:tok-00000002': WORK2 } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: `go-${P}` })).toBeUndefined()
    await ui.press({ key: 'go-tok-00000002' })
    expect(w.runs.at(-1)?.argv.slice(1)).toEqual([expect.stringMatching(/\/tool\/cli\/open-wsl\.sh$/), '/tmp/braid-resume-tok-00000002.sh'])
    expect(w.files['/tmp/braid-resume-tok-00000002.sh']).toContain("'sess-1' '/w/server' '/opt/claude' '公司 2'")
    await ui.unmount()
  })

  test('哪裡都找不到 claude：不開視窗，提示並複製安裝指令', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, 'account:tok-00000002': WORK2 }, env: { CLAUDE_CODE_EXECPATH: '', PATH: '/usr/bin' } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'go-tok-00000002' })
    expect(w.runs.some(r => /open-wsl\.sh$/.test(r.argv[1] ?? ''))).toBe(false)
    expect(w.toasts.at(-1)).toBe('braid：這台電腦找不到 Claude Code 的命令列程式（claude），沒辦法開新視窗接著做。請在終端機執行下面這行安裝：curl -fsSL https://claude.ai/install.sh | bash（已複製）')
    expect(w.copies.at(-1)).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    await ui.unmount()
  })

  test('先用 braid 新增過憑證的帳號，之後在桌面 app 換成它：併成一筆，名稱、顏色、憑證、切換順序都接過去', async ($, on) => {
    const tok = acct('tok-00000007', { email: 'me@gmail.example', orgId: OP, label: 'MiskaWu', color: '#8E6BD8', source: 'token', credential: 'file', credentialId: 'tok-00000007' })
    const w = world(on, {
      env: { CLAUDE_CODE_ACCOUNT_UUID: P, CLAUDE_CODE_USER_EMAIL: 'me@gmail.example', CLAUDE_CODE_ORGANIZATION_UUID: OP },
      store: { uses: USES_ALL, [`account:${W}`]: acct(W, { email: 'me@corp.example', orgId: OW, label: '公司' }), 'account:tok-00000007': tok, switch: { on: true, fiveHour: 90, sevenDay: 95, order: ['tok-00000007', W], restrict: false, restricted: [] } },
    })
    await $.session.start(START)
    expect(w.store.get('account:tok-00000007')).toBeUndefined()
    // 顏色：舊版的紫色換成新配色的桃紅
    expect(w.store.get(`account:${P}`)).toMatchObject({ label: 'MiskaWu', color: '#e87ba4', credential: 'file', credentialId: 'tok-00000007', source: 'desktop' })
    expect((w.store.get('switch') as { order: string[] }).order).toEqual([P, W])
    expect(w.runs.some(r => r.argv.join(' ').includes('secret.sh delete'))).toBe(false) // 憑證還要用，不刪
    await $.command.run(RUN('帳號'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.findAll({ key: 'go-tok-00000007' })).length).toBe(0) // 不會對自己「用它接著做」
    expect(await seen(ui, /MiskaWu/)).toBe(true)
    await ui.unmount()
  })

  test('沒有憑證、但和這個帳號一起自動同步的帳號：說在桌面 app 換過去就能接著做', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, sync: SYNC_ON, [`account:${P}`]: PERSONAL } })
    await $.session.start(START)
    await $.command.run(RUN('帳號'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await seen(ui, /在桌面 app 換成它就能接著做，對話會自動同步/)).toBe(true)
    await ui.unmount()
    void w
  })

  test('改名稱：存回去；移除要按兩次，braid 新增的帳號連憑證一起刪', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: PERSONAL, 'account:tok-00000002': WORK2 } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: `edit-${P}` })
    await ui.input({ key: `label-${P}`, text: '我的' })
    expect(((await w.store.get(`account:${P}`)) as { label: string }).label).toBe('我的')
    await ui.press({ key: 'forget-tok-00000002' })
    expect(await w.store.get('account:tok-00000002')).toBeDefined()
    expect(await shows(ui, /移除後登入憑證也會刪掉/)).toBe(true)
    await ui.press({ key: 'forget-yes-tok-00000002' })
    expect(await w.store.get('account:tok-00000002')).toBeUndefined()
    expect(w.runs.some(r => r.argv.join(' ').endsWith('/tool/cli/secret.sh delete tok-00000002'))).toBe(true)
    await ui.unmount()
  })
})

describe('用量快用完：輸入框上方的提示', () => {
  test('公司資料夾：同組織、有憑證的帳號可以一鍵接手；按了開新視窗用它接著同一段對話', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: PERSONAL, 'account:tok-00000002': WORK2 } })
    await $.session.start(START)
    await $.session.measure(measure(92) as never)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await shows(ui, /公司 5 小時用量 92%，16:00 重置/)).toBe(true)
      expect((await ui.find({ key: 'band-handoff' }))?.props.label).toBe('用「公司 2」接著做')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'band-handoff' })
    const wrapper = '/tmp/braid-resume-tok-00000002.sh'
    const root = (w.runs.at(-1)?.argv[1] ?? '').replace('/tool/cli/open-wsl.sh', '')
    expect(root).toMatch(/^\//)
    // 憑證 id、對話、資料夾、claude、名稱、帳號 id 都寫死在一次性的小腳本裡；憑證本身不在
    expect(w.files[wrapper]).toBe(
      `#!/bin/bash\nrm -f -- "$0"\nexec bash '${root}/tool/cli/resume.sh' 'tok-00000002' 'sess-1' '/w/server' '/opt/claude' '公司 2' 'tok-00000002'\n`,
    )
    expect(w.runs.at(-1)?.argv.slice(2)).toEqual([wrapper])
    // 提示換成「已交給另一個帳號」；在這裡再送訊息要先確認一次
    expect(await shows(ui, /已在新視窗用「公司 2」接著做/)).toBe(true)
    await ui.unmount()
    const first = await $.prompt.submit({ text: '繼續', wait: false } as never)
    expect('drop' in first && first.drop).toMatch(/已經交給「公司 2」/)
    const slash = await $.prompt.submit({ text: '/braid', wait: false } as never)
    expect('drop' in slash).toBe(false)
  })

  test('沒設定歸屬：任何帳號都能一鍵接手；資料夾歸公司後，個人帳號要先確認風險（按兩次）才接手', async ($, on) => {
    const home = { ...PERSONAL, credential: 'keychain', credentialId: 'tok-00000001' }
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: home } })
    await $.session.start(START)
    await $.session.measure(measure(95) as never)
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ key: 'band-handoff' }))?.props.label).toBe('用「個人」接著做')
    await ui.unmount()
    w.store.set('uses', { ...USES_ALL, policy: true })
    w.store.set('policy', { rules: [{ folder: '/w', owner: W }] })
    await $.session.start(START)
    await $.session.measure(measure(95) as never)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: 'band-handoff' })).toBeUndefined() // /w/server 歸公司：個人帳號不算一鍵接手
    expect(await shows(ui, /公司程式碼會經由「個人」（個人帳號）送出/)).toBe(true)
    await ui.press({ key: 'band-risky' })
    await ui.press({ key: 'band-risky-yes' })
    expect(w.runs.at(-1)?.argv.join(' ')).toContain('open-wsl.sh')
    expect(w.files['/tmp/braid-resume-tok-00000001.sh']).toContain("'tok-00000001'")
    await ui.unmount()
  })

  test('「先別提醒」：同一個窗不再出現、記在跨對話的儲存；用完時再出現一次；沒到門檻不出現', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL } })
    await $.session.start(START)
    await $.session.measure(measure(50) as never)
    let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ key: 'band-snooze' })).toBeUndefined()
    await ui.unmount()
    await $.session.measure(measure(91) as never)
    ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await ui.find({ key: 'band-snooze' }))?.props.label).toBe('16:00 前別再提醒')
    await ui.press({ key: 'band-snooze' })
    expect(await ui.find({ key: 'band-snooze' })).toBeUndefined()
    expect(typeof (await w.store.get('snooze'))).toBe('string')
    await ui.unmount()
    await $.session.measure(measure(100) as never)
    ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await shows(ui, /用量用完了/)).toBe(true)
    await ui.unmount()
  })

  test('沒開用量切換就不提示，也不佔狀態列', async ($, on) => {
    const w = world(on, { store: { uses: { migrate: true, switch: false, sync: false } } })
    await $.session.start(START)
    await $.session.measure(measure(99) as never)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ key: 'band-snooze' })).toBeUndefined()
    await ui.unmount()
    expect(w.statuses.filter(s => s !== undefined)).toEqual([])
  })
})

describe('新增帳號', () => {
  test('公司政策限定登入組織：不讓新增，說明原因，不開任何視窗', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL }, policy: { forceLoginOrgUUID: OW } })
    await $.session.start(START)
    const before = w.runs.length
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'add' })
    expect(await shows(ui, /只能用公司組織登入/)).toBe(true)
    expect(w.runs.length).toBe(before)
    await ui.unmount()
  })

  test('開登入視窗 → 等結果檔 → 填名稱與組織 → 存成有憑證的帳號；憑證不經過 mod', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'add' })
    const open = w.runs.at(-1)?.argv ?? []
    expect(open[1]).toMatch(/\/tool\/cli\/open-wsl\.sh$/)
    const wrapper = open[2] ?? ''
    const id = /braid-add-(tok-[0-9a-f]{8})\.sh$/.exec(wrapper)?.[1] ?? ''
    expect(id).not.toBe('')
    const result = `/tmp/braid-add-${id}.json`
    expect(w.files[wrapper]).toMatch(new RegExp(`add-account\\.sh' '${id}' '${result}' '/opt/claude'\\n$`))
    expect(await shows(ui, /已開登入視窗/)).toBe(true)
    await w.clock.advance(1500)
    expect(await shows(ui, /已開登入視窗/)).toBe(true) // 還沒有結果檔：繼續等
    w.files[result] = '\uFEFF{"ok":true,"backend":"file"}'
    await w.clock.advance(1500)
    expect(await shows(ui, /憑證已存好（只有你讀得到的檔案）/)).toBe(true)
    expect(w.runs.some(r => r.argv.join(' ') === `rm -f -- ${result}`)).toBe(true) // 結果檔讀完就刪
    expect(await shows(ui, /查不出這組憑證屬於哪個組織/)).toBe(true) // 結果檔沒有組織：由使用者說明
    await ui.input({ key: 'add-label', text: '公司 2' })
    await ui.select({ key: 'add-org', value: OW })
    await ui.press({ key: 'add-save' })
    const saved = (await w.store.get(`account:${id}`)) as { label: string; orgId: string; orgName: string | null; credential: string; credentialId: string; source: string }
    expect([saved.label, saved.orgId, saved.credential, saved.credentialId, saved.source]).toEqual(['公司 2', OW, 'file', id, 'token'])
    expect(JSON.stringify(saved)).not.toMatch(/sk-ant/)
    expect(await shows(ui, /已新增「公司 2」/)).toBe(true)
    await ui.unmount()
  })

  // 只裝桌面 app 的電腦：PATH 上沒有 claude，CLAUDE_CODE_EXECPATH 也不一定有。2026-10-19 有人在 Windows 按了 Enter 才看到
  // 「無法辨識 'claude' 詞彙」——面板只看那個變數，沒有就交裸的 claude 給視窗。
  const NO_EXEC = { CLAUDE_CODE_EXECPATH: '', PATH: '/usr/bin:/mnt/c/Users/u/AppData/Roaming/npm' }
  const CCD = '/home/u/.claude/remote/ccd-cli'

  test('PATH 上沒有 claude：用桌面 app 自帶的最新那份，交完整路徑；Windows 那邊的 claude 不算', async ($, on) => {
    const w = world(on, {
      store: { uses: USES_ALL },
      env: NO_EXEC,
      files: { '/mnt/c/Users/u/AppData/Roaming/npm/claude': '', [`${CCD}/2.1.30`]: '', [`${CCD}/2.1.299-686c67ec1014`]: '', [`${CCD}/2.1.293`]: '' },
    })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'add' })
    const wrapper = w.runs.at(-1)?.argv[2] ?? ''
    expect(w.files[wrapper]).toMatch(new RegExp(`add-account\\.sh' 'tok-[0-9a-f]{8}' '[^']+' '${CCD}/2\\.1\\.299-686c67ec1014'\\n$`))
    expect(await shows(ui, /已開登入視窗/)).toBe(true)
    await ui.unmount()
  })

  test('macOS：桌面 app 自帶的在 Application Support/Claude/claude-code/<版本>/<雜湊>/claude', async ($, on) => {
    const bundled = '/Users/u/Library/Application Support/Claude/claude-code/2.1.299/f0584be0fbaf/claude'
    const w = world(on, { store: { uses: USES_ALL }, uname: 'Darwin', env: { ...NO_EXEC, WSL_DISTRO_NAME: '', HOME: '/Users/u', TMPDIR: '/var/T/' }, files: { [bundled]: '' } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'add' })
    const wrapper = Object.keys(w.files).find(f => /^\/var\/T\/braid-add-tok-[0-9a-f]{8}\.command$/.test(f)) ?? ''
    expect(w.files[wrapper]).toContain(`'${bundled}'`)
    await ui.unmount()
  })

  test('哪裡都找不到 claude：不開視窗，說要先裝，給安裝指令與複製鈕', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL }, env: NO_EXEC })
    await $.session.start(START)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'add' })
      expect(await shows(ui, /這台電腦找不到 Claude Code 的命令列程式（claude），新增帳號要用它開瀏覽器登入。請在終端機執行下面這行安裝/)).toBe(true)
      expect(await shows(ui, /^curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash$/)).toBe(true)
      await ui.press({ key: 'add-copy' })
      expect(w.copies.at(-1)).toBe('curl -fsSL https://claude.ai/install.sh | bash')
      expect(await ui.find({ key: 'add-retry' })).toBeDefined()
      await ui.press({ key: 'add-close' })
      await ui.unmount()
    }
    expect(w.runs.some(r => /open-wsl\.sh$/.test(r.argv[1] ?? ''))).toBe(false)
    expect(Object.keys(w.files).some(f => f.startsWith('/tmp/braid-add-'))).toBe(false)
  })

  test('登入視窗回報找不到 claude（面板找到之後才不見）：一樣給安裝指令', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'add' })
    const id = /braid-add-(tok-[0-9a-f]{8})\.sh$/.exec(w.runs.at(-1)?.argv[2] ?? '')?.[1] ?? ''
    w.files[`/tmp/braid-add-${id}.json`] = '{"ok":false,"reason":"no-claude"}'
    await w.clock.advance(1500)
    expect(await shows(ui, /找不到 Claude Code 的命令列程式/)).toBe(true)
    expect(await ui.find({ key: 'add-copy' })).toBeDefined()
    await ui.unmount()
  })

  // 新增帳號的腳本查到的組織（一年期憑證只查得到組織）
  const addWith = async (w: ReturnType<typeof world>, ui: { press: (t: { key: string }) => Promise<unknown> }, orgId: string | null) => {
    await ui.press({ key: 'add' })
    const id = /braid-add-(tok-[0-9a-f]{8})\.sh$/.exec(w.runs.at(-1)?.argv[2] ?? '')?.[1] ?? ''
    w.files[`/tmp/braid-add-${id}.json`] = JSON.stringify({ ok: true, backend: 'file', orgId })
    await w.clock.advance(1500)
    return id
  }
  const ORG_X = '0000aaaa-1111-2222-3333-444455556666'
  const ORG_W = 'cccccccc-0000-4000-8000-00000000000a'

  test('另一個組織：照查到的組織存成新帳號，不用選組織', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const id = await addWith(w, ui, ORG_X)
    expect(await shows(ui, /屬於另一個組織，不是目前帳號的/)).toBe(true)
    expect(await ui.find({ key: 'add-org' })).toBeUndefined()
    await ui.press({ key: 'add-save' })
    const saved = w.store.get(`account:${id}`) as { orgId: string; credentialId: string; label: string }
    expect([saved.orgId, saved.credentialId, saved.label]).toEqual([ORG_X, id, '個人'])
    await ui.unmount()
  })

  test('和目前帳號同一個組織：警告多半就是目前這個帳號，預設刪掉憑證', async ($, on) => {
    const work = acct(W, { email: 'me@corp.example', orgId: ORG_W, label: '公司' })
    const w = world(on, { store: { uses: USES_ALL, [`account:${W}`]: work }, env: { CLAUDE_CODE_ORGANIZATION_UUID: ORG_W } })
    await $.session.start(START)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const id = await addWith(w, ui, ORG_W)
      expect(await shows(ui, /這組憑證屬於目前帳號「公司」的組織/)).toBe(true)
      expect((await ui.find({ key: 'add-discard' }))?.props.variant).toBe('primary')
      await ui.press({ key: 'add-discard' })
      expect(w.runs.at(-1)?.argv.slice(-2)).toEqual(['delete', id])
      expect([...w.store.keys()].filter(k => k.startsWith('account:'))).toEqual([`account:${W}`])
      await ui.unmount()
    }
  })

  test('和目前帳號同一個組織，但確定是另一個帳號：明確按了才加入', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL }, env: { CLAUDE_CODE_ORGANIZATION_UUID: ORG_W } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const id = await addWith(w, ui, ORG_W)
    await ui.press({ key: 'add-save' })
    expect((w.store.get(`account:${id}`) as { orgId: string }).orgId).toBe(ORG_W)
    await ui.unmount()
  })

  test('組織和一個已經認得的帳號相同（例如在桌面 app 登入過的個人帳號）：更新它的憑證，不多一筆', async ($, on) => {
    const old = { ...PERSONAL, orgId: ORG_X, credential: 'file', credentialId: 'tok-0000000a' }
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: old } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const id = await addWith(w, ui, ORG_X)
    expect(await shows(ui, /看起來是已經認得的「個人」/)).toBe(true)
    await ui.press({ key: 'add-save' })
    expect(w.runs.some(r => r.argv.slice(-2).join(' ') === 'delete tok-0000000a')).toBe(true)
    const saved = w.store.get(`account:${P}`) as { credentialId: string; label: string }
    expect([saved.credentialId, saved.label]).toEqual([id, '個人'])
    expect(w.store.get(`account:${id}`)).toBeUndefined()
    expect(await shows(ui, /已更新「個人」的登入憑證/)).toBe(true)
    await ui.unmount()
  })

  test('信箱和桌面 app 登入過的帳號相同：憑證併進那個帳號，不另外多一筆', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: PERSONAL } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'add' })
    const id = /braid-add-(tok-[0-9a-f]{8})\.sh$/.exec(w.runs.at(-1)?.argv[2] ?? '')?.[1] ?? ''
    w.files[`/tmp/braid-add-${id}.json`] = '{"ok":true,"backend":"secret-service"}'
    await w.clock.advance(1500)
    await ui.input({ key: 'add-email', text: 'Me@Gmail.example' })
    await ui.press({ key: 'add-save' })
    expect(await w.store.get(`account:${id}`)).toBeUndefined()
    const merged = (await w.store.get(`account:${P}`)) as { credential: string; credentialId: string; orgId: string; label: string }
    expect([merged.credential, merged.credentialId, merged.orgId, merged.label]).toEqual(['secret-service', id, OP, '個人'])
    await ui.unmount()
  })

  test('登入視窗取消：說明並可以再試；確認階段按「不要了」會刪掉剛存的憑證', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'add' })
    let id = /braid-add-(tok-[0-9a-f]{8})\.sh$/.exec(w.runs.at(-1)?.argv[2] ?? '')?.[1] ?? ''
    w.files[`/tmp/braid-add-${id}.json`] = '{"ok":false,"reason":"canceled"}'
    await w.clock.advance(1500)
    expect(await shows(ui, /在登入視窗取消了/)).toBe(true)
    await ui.press({ key: 'add-retry' })
    id = /braid-add-(tok-[0-9a-f]{8})\.sh$/.exec(w.runs.at(-1)?.argv[2] ?? '')?.[1] ?? ''
    w.files[`/tmp/braid-add-${id}.json`] = '{"ok":true,"backend":"file"}'
    await w.clock.advance(1500)
    await ui.press({ key: 'add-discard' })
    expect(w.runs.at(-1)?.argv.slice(-2)).toEqual(['delete', id])
    expect(await ui.find({ key: 'add' })).toBeDefined()
    await ui.unmount()
  })
})

describe('切換設定', () => {
  test('門檻與順序存回去；資料夾的事交給歸屬頁，這裡沒有清單也沒有下拉', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: PERSONAL, 'account:tok-00000002': WORK2 } })
    await $.session.start(START)
    await $.command.run(RUN('切換'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ key: 'sw-scope' })).toBeUndefined()
      expect(await shows(ui, /全部資料夾都能換到任何帳號/)).toBe(true)
      expect(await seen(ui, /可以接手/)).toBe(true)
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.select({ key: 'sw-five', value: '80' })
    await ui.select({ key: 'sw-seven', value: 'off' })
    await ui.press({ key: `up-${P}` })
    const sw = w.store.get('switch') as { fiveHour: number; sevenDay: number | null; order: string[] }
    expect([sw.fiveHour, sw.sevenDay]).toEqual([80, null])
    expect(sw.order.indexOf(P)).toBeLessThan(sw.order.indexOf('tok-00000002'))
    await ui.unmount()
  })
})

describe('同步', () => {
  test('第一次設定：預設全部資料夾；組織不同要警告；環境交給工具 -Projects all -Presets all', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: PERSONAL } })
    await $.session.start(START)
    await $.command.run(RUN('同步'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.select({ key: 'sy-on', value: 'on' })
    await ui.select({ key: 'sy-partner', value: P })
    expect(await w.store.get('sync')).toEqual({ on: true, pair: [W, P], all: true, folders: [] })
    expect((await ui.find({ key: 'sy-scope' }))?.props.value).toBe('all')
    expect(await ui.find({ key: 'sy-when' })).toBeUndefined() // 開了就自動，不用選時機
    expect(await shows(ui, /共 2 個資料夾/)).toBe(true)
    expect(await shows(ui, /不同組織：全部同步會讓個人與公司的對話互相帶過去/)).toBe(true) // 公司與個人
    expect(await ui.find({ key: 'sy-add' })).toBeUndefined()
    await ui.press({ key: 'sy-env' })
    expect(w.runs.at(-1)?.argv.slice(2)).toEqual(['-From', P, '-Projects', 'all', '-Presets', 'all'])
    expect(await shows(ui, /已在另一個視窗開啟同步工具/)).toBe(true)
    await ui.unmount()
  })

  test('自己挑：一個一個加——這個對話的資料夾、從清單挑、輸入路徑；可以移除；環境只帶這些資料夾的', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: PERSONAL, sync: { on: true, pair: [W, P], all: true, folders: [] } } })
    await $.session.start(START)
    await $.command.run(RUN('同步'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.select({ key: 'sy-scope', value: 'picked' })
      expect(await shows(ui, /還沒加入任何資料夾/)).toBe(true)
      expect(await ui.find({ key: 'sy-env' })).toBeUndefined() // 沒有範圍就沒有「帶環境過來」
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // 1. 這個對話的資料夾
    expect((await ui.find({ key: 'sy-add-here' }))?.props.label).toBe('＋ 加入這個對話的資料夾（/w/server）')
    await ui.press({ key: 'sy-add-here' })
    expect(await ui.find({ key: 'sy-add-here' })).toBeUndefined()
    expect(await shows(ui, /\/w\/server.*目前 1 · 個人 1/)).toBe(true)
    // 2. 從清單挑：只列還沒加的，附兩邊的對話數
    const options = ((await ui.find({ key: 'sy-add' }))?.props.options ?? []) as { value: string; label: string }[]
    expect(options.map(o => o.value)).toEqual(['', '/side/blog'])
    expect(options[1]?.label).toBe('/side/blog　目前 0 · 個人 2')
    await ui.select({ key: 'sy-add', value: '/side/blog' })
    expect(await ui.find({ key: 'sy-add' })).toBeUndefined() // 清單都加完了
    // 3. 輸入路徑：去掉引號、空白與結尾斜線；重複的不再加
    await ui.input({ key: 'sy-add-path', text: '  "/new/proj/"  ' })
    await ui.input({ key: 'sy-add-path', text: '/new/proj' })
    expect(await shows(ui, /\/new\/proj.*兩邊都還沒有對話/)).toBe(true)
    expect((w.store.get('sync') as { folders: string[] }).folders).toEqual(['/w/server', '/side/blog', '/new/proj'])
    // 移除
    await ui.press({ key: 'sy-del-/side/blog' })
    expect((w.store.get('sync') as { folders: string[] }).folders).toEqual(['/w/server', '/new/proj'])
    await ui.press({ key: 'sy-env' })
    expect(w.runs.at(-1)?.argv.slice(2)).toEqual(['-From', P, '-Projects', '/w/server,/new/proj', '-Presets', 'folders'])
    // 切回全部：挑過的留著，再切回來還在
    await ui.select({ key: 'sy-scope', value: 'all' })
    expect(w.store.get('sync')).toMatchObject({ all: true, folders: ['/w/server', '/new/proj'] })
    await ui.select({ key: 'sy-scope', value: 'picked' })
    expect(await ui.find({ key: 'sy-del-/new/proj' })).toBeDefined()
    await ui.unmount()
  })

  test('全部資料夾：同組織的兩個帳號不警告', async ($, on) => {
    const work2 = acct(P, { email: 'me2@corp.example', orgId: OW, label: '公司 2' })
    const w = world(on, { store: { uses: USES_ALL, sync: SYNC_ON, [`account:${P}`]: work2 } })
    await $.session.start(START)
    await $.command.run(RUN('同步'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shows(ui, /共 \d+ 個資料夾/)).toBe(true)
    expect(await shows(ui, /不同組織/)).toBe(false)
    await ui.unmount()
    void w
  })

  test('自動同步：開始後就把桌面 app 現在登入的帳號的對話複製到另一個帳號；綁帳號的欄位拿掉；在那邊刪過的不帶；這邊的資料夾一個檔都不寫', async ($, on) => {
    const w = world(on, {
      store: { uses: USES_ALL, sync: SYNC_ON, [`account:${P}`]: PERSONAL },
      files: {
        [`${SESS}/${W}/${OW}/local_a.json`]: rec('a', { cwd: '/w/server', title: 'A', bridgeSessionIds: ['wb'], sshRemoteProcessId: 7, startedFromEnvironmentId: 'env-w', remoteMcpServersConfig: { slack: 1 } }),
        [`${SESS}/${W}/${OW}/local_b.json`]: rec('b', { cwd: '/side/blog', title: 'B', isArchived: true }),
        [`${SESS}/${W}/${OW}/local_c.json`]: rec('c', { cwd: '/w/server', title: 'C' }),
        [`${SESS}/${P}/${OP}/deleted_c`]: '1760000000000',
        [`${SESS}/${P}/${OP}/local_3.json`]: rec('3', { cwd: '/side/blog', remoteMcpServersConfig: {} }),
      },
    })
    const mine = Object.fromEntries(Object.entries(w.files).filter(([k]) => k.startsWith(`${SESS}/${W}/`)))
    await $.session.start(START)
    expect(w.files[`${SESS}/${P}/${OP}/local_a.json`]).toBeUndefined() // 開始後幾秒才做，不拖慢開對話
    await w.clock.advance(3_000)
    expect(JSON.parse(w.files[`${SESS}/${P}/${OP}/local_a.json`] ?? 'null')).toEqual({
      sessionId: 'local_a',
      cliSessionId: 'cli-a',
      cwd: '/w/server',
      lastActivityAt: NOW - H,
      title: 'A',
      startedFromEnvironmentId: null,
      remoteMcpServersConfig: {}, // 換成那個帳號自己的
    })
    expect(JSON.parse(w.files[`${SESS}/${P}/${OP}/archived-sessions.idx`] ?? 'null')).toEqual({ v: 1, archived: ['local_b'] })
    expect(w.files[`${SESS}/${P}/${OP}/local_c.json`]).toBeUndefined() // 在個人帳號刪過
    expect(Object.fromEntries(Object.entries(w.files).filter(([k]) => k.startsWith(`${SESS}/${W}/`)))).toEqual(mine)
    // 狀態：說清楚從哪到哪、不用結束 Claude
    await $.command.run(RUN('同步'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await seen(ui, /自動同步中：從「公司」複製到「個人」/)).toBe(true) // 桌面版是兩個帳號之間的圖
    expect(await seen(ui, /複製到「個人」，換過去就看得到，不用結束 Claude/)).toBe(true)
    expect(await seen(ui, /上次同步 剛剛：新增 2/)).toBe(true)
    await ui.unmount()
    const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await shows(term, /自動同步中/)).toBe(true)
    expect(await term.find({ key: 'sy-flow' })).toBeDefined() // 終端機：公司 → 個人，帶帳號顏色
    await term.unmount()
  })

  test('之後每分鐘一次：app 改過的紀錄跟著更新，那個帳號自己的欄位留著；那邊比較新的不動；新的對話也帶過去', async ($, on) => {
    const target = `${SESS}/${P}/${OP}`
    const w = world(on, {
      store: { uses: USES_ALL, sync: SYNC_ON },
      files: {
        [`${SESS}/${W}/${OW}/local_d.json`]: rec('d', { cwd: '/w/server', title: 'D 舊' }),
        [`${target}/local_d.json`]: rec('d', { cwd: '/w/server', title: 'D 舊', bridgeSessionIds: ['pb'], sshRemoteProcessId: 9 }),
        [`${SESS}/${W}/${OW}/local_e.json`]: rec('e', { cwd: '/w/server', title: 'E 這邊' }),
        [`${target}/local_e.json`]: rec('e', { cwd: '/w/server', title: 'E 那邊', lastActivityAt: NOW }),
      },
      mtimes: { [`${target}/local_d.json`]: NOW - 2 * H, [`${target}/local_e.json`]: NOW - 2 * H },
    })
    await $.session.start(START)
    await w.clock.advance(3_000)
    expect(JSON.parse(w.files[`${target}/local_d.json`] ?? '{}')).toMatchObject({ title: 'D 舊', bridgeSessionIds: ['pb'], sshRemoteProcessId: 9 })
    expect(JSON.parse(w.files[`${target}/local_e.json`] ?? '{}').title).toBe('E 那邊') // 那邊的最後活動比較晚
    // app 在這邊繼續聊 d、開了新的 f
    w.files[`${SESS}/${W}/${OW}/local_d.json`] = rec('d', { cwd: '/w/server', title: 'D 新', lastActivityAt: NOW + H, bridgeSessionIds: ['wb'] })
    w.mtimes[`${SESS}/${W}/${OW}/local_d.json`] = NOW + H
    w.files[`${SESS}/${W}/${OW}/local_f.json`] = rec('f', { cwd: '/w/server', title: 'F' })
    await w.clock.advance(30_000)
    expect(w.files[`${target}/local_f.json`]).toBeUndefined() // 還不到一分鐘
    await w.clock.advance(30_000)
    expect(JSON.parse(w.files[`${target}/local_d.json`] ?? '{}')).toMatchObject({ title: 'D 新', lastActivityAt: NOW + H, bridgeSessionIds: ['pb'], sshRemoteProcessId: 9 })
    expect(JSON.parse(w.files[`${target}/local_f.json`] ?? '{}').title).toBe('F')
  })

  test('刪除也跟著走：這邊刪過的，那邊的側欄紀錄刪掉、留刪除紀錄，原本那筆先備份到 braid-backups/sync-deleted', async ($, on) => {
    const target = `${SESS}/${P}/${OP}`
    const old = rec('x', { cwd: '/w/server', lastActivityAt: NOW - 3 * H })
    const w = world(on, {
      store: { uses: USES_ALL, sync: SYNC_ON },
      files: { [`${SESS}/${W}/${OW}/deleted_x`]: String(NOW - H), [`${target}/local_x.json`]: old },
    })
    await $.session.start(START)
    await w.clock.advance(3_000)
    expect(w.files[`${target}/local_x.json`]).toBeUndefined()
    expect(w.files[`${target}/deleted_x`]).toBe(String(NOW - H))
    expect(w.files[`${BACKUPS}/sync-deleted/${P}/${OP}/local_x.json`]).toBe(old)
    expect(w.runs.some(r => r.argv.join(' ') === `rm -f -- ${target}/local_x.json`)).toBe(true)
    await $.command.run(RUN('同步'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await seen(ui, /上次同步 剛剛：刪除 1/)).toBe(true)
    expect(await seen(ui, /同步刪掉的對話：1 筆/)).toBe(true) // 備份統計數得到剛存的那筆
    await ui.unmount()
  })

  test('刪不掉：狀態說同步失敗，刪除紀錄不留', async ($, on) => {
    const target = `${SESS}/${P}/${OP}`
    const w = world(on, {
      store: { uses: USES_ALL, sync: SYNC_ON },
      files: { [`${SESS}/${W}/${OW}/deleted_x`]: String(NOW - H), [`${target}/local_x.json`]: rec('x', { lastActivityAt: NOW - 3 * H }) },
      failRm: true,
    })
    await $.session.start(START)
    await w.clock.advance(3_000)
    expect(w.files[`${target}/local_x.json`]).toBeDefined()
    expect(w.files[`${target}/deleted_x`]).toBeUndefined()
    await $.command.run(RUN('同步'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shows(ui, /上次同步失敗：刪不掉/)).toBe(true)
    await ui.unmount()
  })

  test('以桌面 app 現在登入的帳號為準：app 已經換到個人帳號，就從個人複製到公司（這個對話還是公司的也一樣）', async ($, on) => {
    const w = world(on, {
      store: { uses: USES_ALL, sync: SYNC_ON },
      files: {
        [`${APP}/config.json`]: JSON.stringify({ lastKnownAccountUuid: P }),
        [`${SESS}/${P}/${OP}/local_p.json`]: rec('p', { cwd: '/side/blog' }),
        [`${SESS}/${W}/${OW}/local_w.json`]: rec('w', { cwd: '/w/server' }),
      },
    })
    await $.session.start(START)
    await w.clock.advance(3_000)
    expect(w.files[`${SESS}/${W}/${OW}/local_p.json`]).toBeDefined()
    expect(w.files[`${SESS}/${P}/${OP}/local_w.json`]).toBeUndefined() // app 正在用的個人帳號：一律不寫
  })

  test('app 登入的帳號不在這一對裡、或另一個帳號還沒在 app 用過：不寫，狀態說明原因', async ($, on) => {
    const other = 'cccccccc-0000-4000-8000-000000000003'
    const w = world(on, {
      store: { uses: USES_ALL, sync: SYNC_ON, [`account:${P}`]: PERSONAL },
      files: { [`${APP}/config.json`]: JSON.stringify({ lastKnownAccountUuid: other }), [`${SESS}/${W}/${OW}/local_a.json`]: rec('a', { cwd: '/w/server' }) },
    })
    await $.session.start(START)
    await w.clock.advance(3_000)
    expect(Object.keys(w.files).filter(k => k.startsWith(`${SESS}/${P}/`) && k.endsWith('local_a.json'))).toEqual([])
    await $.command.run(RUN('同步'))
    let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shows(ui, /桌面 app 現在登入的是「帳號 cccccccc…」，不在這一對裡，先不同步/)).toBe(true)
    // 另一個帳號沒有資料夾
    w.files[`${APP}/config.json`] = JSON.stringify({ lastKnownAccountUuid: W })
    await w.store.set('sync', { ...SYNC_ON, pair: [W, other] })
    await $.session.start(START)
    await w.clock.advance(1) // 重新載入後桌面資料在背景重讀
    await ui.press({ key: 'sy-now' })
    expect(await shows(ui, /「帳號 cccccccc…」還沒在桌面 app 用過 Code 分頁/)).toBe(true)
    await ui.unmount()
  })

  test('用量快用完：馬上再同步一次；提示說在桌面 app 換過去就能接著做', async ($, on) => {
    const w = world(on, {
      store: { uses: USES_ALL, sync: SYNC_ON, [`account:${P}`]: PERSONAL },
      files: { [`${SESS}/${W}/${OW}/local_a.json`]: rec('a', { cwd: '/w/server' }) },
    })
    await $.session.start(START)
    await w.clock.advance(3_000)
    w.files[`${SESS}/${W}/${OW}/local_n.json`] = rec('n', { cwd: '/w/server' })
    await w.clock.advance(15_000)
    await $.session.measure(measure(92) as never)
    await w.clock.advance(1)
    expect(w.files[`${SESS}/${P}/${OP}/local_n.json`]).toBeDefined() // 不等一分鐘
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await shows(band, /在桌面 app 換成「個人」就能接著做，對話都已同步過去/)).toBe(true)
    await band.unmount()
  })

  test('沒開同步：時間到了也什麼都不寫', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, sync: { ...SYNC_ON, on: false } }, files: { [`${SESS}/${W}/${OW}/local_a.json`]: rec('a', { cwd: '/w/server' }) } })
    await $.session.start(START)
    await w.clock.advance(120_000)
    expect(w.files[`${SESS}/${P}/${OP}/local_a.json`]).toBeUndefined()
    expect(w.store.get('mirror')).toBeUndefined()
  })

  test('桌面 app 的舊帳號沒當過目前帳號：用組織對到的、braid 新增的帳號名稱來叫它', async ($, on) => {
    const tok = acct('tok-00000009', { orgId: OP, label: 'MiskaWu', source: 'token', credential: 'file', credentialId: 'tok-00000009' })
    const w = world(on, { store: { uses: USES_ALL, sync: SYNC_ON, 'account:tok-00000009': tok } })
    await $.session.start(START)
    await w.clock.advance(3_000)
    await $.command.run(RUN('同步'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const options = ((await ui.find({ key: 'sy-partner' }))?.props.options ?? []) as { value: string; label: string }[]
    expect(options.find(o => o.value === P)?.label).toBe('MiskaWu')
    expect(options.some(o => o.value === 'tok-00000009')).toBe(false) // braid 新增的帳號不是桌面 app 帳號，不列
    expect(await seen(ui, /複製到「MiskaWu」/)).toBe(true)
    await ui.unmount()
  })

  test('沒開同步：狀態卡說怎麼打開，沒有「現在同步」', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL } })
    await $.session.start(START)
    await $.command.run(RUN('同步'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shows(ui, /○ 沒開/)).toBe(true)
    expect(await ui.find({ key: 'sy-now' })).toBeUndefined()
    await ui.unmount()
    void w
  })

  test('純 Linux：說明 CLI 的對話不分帳號、不需要同步', async ($, on) => {
    const w = world(on, { env: { WSL_DISTRO_NAME: '' }, store: { uses: USES_ALL } })
    await $.session.start(START)
    await $.command.run(RUN('sync'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await shows(ui, /CLI 的對話不分帳號/)).toBe(true)
    await ui.unmount()
  })
})

describe('輸入框下方的迷你量表', () => {
  const HINT = {
    plugin: 'braid',
    component: 'PromptHint' as const,
    props: { isDraft: false, isWorking: false, hint: '? 看快捷鍵' },
  }

  test('桌面版：app 自己的提示留著，旁邊接 5 小時與 7 天的量表；終端機不加（用狀態列的文字）', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL } })
    await $.session.start(START)
    await $.session.measure({ context: { window: 200_000 }, rateLimits: usage(92, 64), changed: ['rateLimits' as const] } as never)
    const desk = await $.ui.mount({ ...HINT, surface: 'desktop' } as never)
    expect(await shows(desk as never, /看快捷鍵/)).toBe(true)
    const svgs = await (desk as unknown as Drawing).findAll({ type: 'Svg' })
    expect(svgs.map(s => s.props.alt)).toEqual(['公司 5 小時 92%，7 天 64%'])
    expect(String(svgs[0]?.props.source)).toContain('fill="#fab219"') // 92% 過了 90% 的門檻
    await desk.unmount()
    const term = await $.ui.mount({ ...HINT, surface: 'terminal' } as never)
    expect((await (term as unknown as Drawing).findAll({ type: 'Svg' })).length).toBe(0)
    await term.unmount()
    expect(w.statuses.at(-1)).toBe('braid · 公司 5 小時 92% · 7 天 64%')
  })

  test('沒開用量切換、或還沒有用量：不加', async ($, on) => {
    const w = world(on, { store: { uses: { migrate: true, switch: false, sync: true } } })
    await $.session.start(START)
    await $.session.measure(measure(50) as never)
    const desk = await $.ui.mount({ ...HINT, surface: 'desktop' } as never)
    expect((await (desk as unknown as Drawing).findAll({ type: 'Svg' })).length).toBe(0)
    await desk.unmount()
    void w
  })
})

describe('歸屬（依資料夾決定帳號）', () => {
  const USES_P = { ...USES_ALL, policy: true }
  // 公司帳號（桌面 app 與 CLI 都 /login 這個）、braid 新增憑證的個人帳號
  const WORK = acct(W, { email: 'me@corp.example', orgId: OW, label: '公司' })
  const HOME = { ...PERSONAL, credential: 'keychain', credentialId: 'tok-00000001' }
  const AS_HOME = { CLAUDE_CODE_ACCOUNT_UUID: P, CLAUDE_CODE_USER_EMAIL: 'me@gmail.example', CLAUDE_CODE_ORGANIZATION_UUID: OP }
  const CLI_LOGIN = { '/home/u/.claude.json': JSON.stringify({ oauthAccount: { accountUuid: W, emailAddress: 'me@corp.example', organizationUuid: OW } }) }
  const PAGES = '/home/u/.claude/artifact-sources'
  const PAGE = { '/w/server/report.html': '<html><title>週報</title></html>' }
  const rules = (owner: string, folder = '/w') => ({ rules: [{ folder, owner }] })
  const pages = (w: { files: Record<string, string> }) => JSON.parse(w.files[`${PAGES}/index.json`] ?? '{"pages":[]}') as { pages: Record<string, unknown>[] }
  const publish = (over: Record<string, unknown> = {}) => ({ tool: 'Artifact', file_path: '/w/server/report.html', ...over }) as never

  test('第 1 格 公司專案 × 公司帳號：不提醒；新頁照常發布，記下網址與歸屬', async ($, on) => {
    const w = world(on, { store: { uses: USES_P, policy: rules(W), [`account:${W}`]: WORK, [`account:${P}`]: HOME }, files: PAGE })
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await band.find({ key: 'pol-go' })).toBeUndefined()
    expect(await band.find({ key: `ask-${W}` })).toBeUndefined()
    await band.unmount()
    const r = (await $.tool.call(publish())) as { text?: string; deny?: string }
    expect(r.deny).toBeUndefined()
    expect(w.artifacts.length).toBe(1)
    expect(pages(w).pages).toMatchObject([{ title: '週報', project: '/w/server', owner: W, by: W, status: 'published', url: 'https://claude.ai/code/artifact/page-1' }])
  })

  test('第 2 格 公司專案 × 個人帳號：提醒公司程式碼會經由個人帳號送出；一鍵用公司接著做（CLI 自己 /login 的帳號，不帶憑證）', async ($, on) => {
    const w = world(on, { env: AS_HOME, store: { uses: USES_P, policy: rules(W), [`account:${W}`]: WORK, [`account:${P}`]: HOME }, files: { ...PAGE, ...CLI_LOGIN } })
    await $.session.start(START)
    for (const surface of SURFACES) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await shows(band, /這個資料夾歸「公司」：公司程式碼會經由「個人」（個人帳號）送出，可能違反公司規範/)).toBe(true)
      expect((await band.find({ key: 'pol-go' }))?.props.label).toBe('用「公司」在新視窗接著做')
      await band.unmount()
    }
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await band.press({ key: 'pol-go' })
    expect(w.files['/tmp/braid-resume--.sh']).toContain("/tool/cli/resume.sh' '-' 'sess-1' '/w/server'") // 「-」：不帶憑證
    await band.unmount()
    expect((w.store.get(`account:${W}`) as { source: string }).source).toBe('desktop') // 也是 CLI 登入的帳號，來源仍是桌面
  })

  test('第 2 格（頁面）：公司專案用個人帳號發布新頁 → 擋下、存原始檔、排進「待公司發布」；更新已有的頁照常', async ($, on) => {
    const w = world(on, { env: AS_HOME, store: { uses: USES_P, policy: rules(W), [`account:${W}`]: WORK, [`account:${P}`]: HOME }, files: PAGE })
    await $.session.start(START)
    const r = (await $.tool.call(publish())) as { deny?: string }
    expect(r.deny).toMatch(/這個資料夾歸「公司」，這個對話是「個人」/)
    expect(r.deny).toMatch(/原始檔已存到 \/home\/u\/\.claude\/artifact-sources\/server\/p[0-9a-z]+\.html，排進「待發布」/)
    expect(w.artifacts.length).toBe(0)
    const [entry] = pages(w).pages
    expect(entry).toMatchObject({ title: '週報', project: '/w/server', owner: W, by: P, status: 'pending', url: null })
    expect(w.files[String(entry?.source)]).toBe(PAGE['/w/server/report.html'])
    const upd = (await $.tool.call(publish({ url: 'https://claude.ai/code/artifact/old' }))) as { deny?: string }
    expect(upd.deny).toBeUndefined()
    expect(w.artifacts.length).toBe(1)
  })

  test('第 3 格 個人專案 × 公司帳號：較強的提醒（公司能取得）；一鍵用個人帳號接著做（帶憑證）', async ($, on) => {
    const w = world(on, { store: { uses: USES_P, policy: rules(P), [`account:${W}`]: WORK, [`account:${P}`]: HOME } })
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await shows(band, /這個資料夾歸「個人」：個人內容會經由「公司」（公司帳號）送出，公司能取得/)).toBe(true)
    await band.press({ key: 'pol-go' })
    expect(w.files['/tmp/braid-resume-tok-00000001.sh']).toContain("'tok-00000001'")
    await band.unmount()
  })

  test('第 4 格 個人專案 × 個人帳號：不提醒，新頁照常發布', async ($, on) => {
    const w = world(on, { env: AS_HOME, store: { uses: USES_P, policy: rules(P), [`account:${W}`]: WORK, [`account:${P}`]: HOME }, files: PAGE })
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await band.find({ key: 'pol-go' })).toBeUndefined()
    await band.unmount()
    expect(((await $.tool.call(publish())) as { deny?: string }).deny).toBeUndefined()
    expect(w.artifacts.length).toBe(1)
  })

  test('第 5 格 還沒設定：問歸誰（不擋對話）、按了寫回表；回答前新頁擋下排隊；「之後再說」這個對話不再問', async ($, on) => {
    const w = world(on, { store: { uses: USES_P, [`account:${W}`]: WORK, [`account:${P}`]: HOME }, files: PAGE })
    await $.session.start(START)
    const r = (await $.tool.call(publish())) as { deny?: string }
    expect(r.deny).toMatch(/這個資料夾還沒設定歸哪個帳號/)
    expect(pages(w).pages).toMatchObject([{ owner: null, status: 'pending' }])
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await shows(band, /「server」歸哪個帳號？/)).toBe(true)
    await band.press({ key: 'ask-later' })
    expect(await band.find({ key: `ask-${W}` })).toBeUndefined()
    await band.unmount()
    await $.session.start(START)
    const again = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await again.press({ key: `ask-${W}` })
    expect(w.store.get('policy')).toEqual({ rules: [{ folder: '/w/server', owner: W }] })
    expect(await again.find({ key: `ask-${W}` })).toBeUndefined()
    await again.unmount()
  })

  test('第 6 格 臨時指定：「這次就用目前帳號」按兩次才算，只算這個對話，不改表', async ($, on) => {
    const w = world(on, { env: AS_HOME, store: { uses: USES_P, policy: rules(W), [`account:${W}`]: WORK, [`account:${P}`]: HOME } })
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await band.press({ key: 'pol-stay' })
    expect(await shows(band, /公司程式碼會經由/)).toBe(true) // 還沒確認：提醒還在
    await band.press({ key: 'pol-stay-yes' })
    expect(await band.find({ key: 'pol-stay' })).toBeUndefined()
    expect(await shows(band, /公司程式碼會經由/)).toBe(false)
    await band.unmount()
    expect(w.store.get('policy')).toEqual(rules(W))
    await $.session.start(START) // 新的對話（或重新載入）：又會提醒
    const next = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await next.find({ key: 'pol-stay' })).toBeDefined()
    await next.unmount()
  })

  test('待發布：歸屬帳號的對話按「發布」，braid 替你發布並記下網址；不同邊的要按兩次確認；可以丟掉', async ($, on) => {
    const index = {
      v: 1,
      pages: [
        { id: 'pa', title: '週報', project: '/w/server', source: `${PAGES}/server/pa.html`, input: { title: '週報' }, owner: W, by: P, status: 'pending', url: null, at: 1 },
        { id: 'pb', title: '筆記', project: '/me/blog', source: `${PAGES}/blog/pb.html`, input: {}, owner: P, by: W, status: 'pending', url: null, at: 2 },
        { id: 'pc', title: '草稿', project: '/w/server', source: `${PAGES}/server/pc.html`, input: {}, owner: W, by: P, status: 'pending', url: null, at: 3 },
      ],
    }
    const w = world(on, {
      store: { uses: USES_P, policy: rules(W), [`account:${W}`]: WORK, [`account:${P}`]: HOME },
      files: { [`${PAGES}/index.json`]: JSON.stringify(index), [`${PAGES}/server/pa.html`]: 'A', [`${PAGES}/blog/pb.html`]: 'B', [`${PAGES}/server/pc.html`]: 'C' },
    })
    await $.session.start(START)
    await $.command.run(RUN('歸屬'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shows(ui, /週報/)).toBe(true)
    await ui.press({ key: 'pg-pub-pa' })
    expect(w.artifacts.at(-1)).toMatchObject({ file_path: `${PAGES}/server/pa.html`, title: '週報' })
    expect(pages(w).pages.find(p => p.id === 'pa')).toMatchObject({ status: 'published', by: W, url: 'https://claude.ai/code/artifact/page-1' })
    expect(await ui.find({ key: 'pg-pub-pb' })).toBeUndefined() // 歸個人：公司的對話沒有「發布」
    await ui.press({ key: 'pg-mine-pb' })
    await ui.press({ key: 'pg-mine-yes-pb' })
    expect(pages(w).pages.find(p => p.id === 'pb')).toMatchObject({ status: 'published', by: W })
    await ui.press({ key: 'pg-drop-pc' })
    expect(pages(w).pages.find(p => p.id === 'pc')?.status).toBe('dropped')
    await ui.unmount()
  })

  test('第 10 格 braid 用一年期憑證開的視窗：待發布的頁不給「發布」，說明要在 /login 的對話發布', async ($, on) => {
    const index = { v: 1, pages: [{ id: 'pa', title: '週報', project: '/me', source: `${PAGES}/me/pa.html`, input: {}, owner: P, by: W, status: 'pending', url: null, at: 1 }] }
    const w = world(on, {
      env: { BRAID_ACCOUNT: P, CLAUDE_CODE_ACCOUNT_UUID: '' },
      store: { uses: USES_P, policy: rules(P), [`account:${W}`]: WORK, [`account:${P}`]: HOME },
      files: { [`${PAGES}/index.json`]: JSON.stringify(index) },
    })
    await $.session.start(START)
    await $.command.run(RUN('歸屬'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'pg-pub-pa' })).toBeUndefined()
    expect(await shows(ui, /官方只保證 \/login 的對話能發布/)).toBe(true)
    await ui.unmount()
    void w
  })

  test('依 git 遠端快速設定：掃描旁邊的資料夾、依遠端分組，一組選一次寫進表（已有規則的不改）', async ($, on) => {
    const w = world(on, {
      store: { uses: USES_P, policy: rules(P, '/w/blog'), [`account:${W}`]: WORK, [`account:${P}`]: HOME },
      files: { '/w/server/a': '', '/w/api/a': '', '/w/blog/a': '', '/w/ws/x/a': '', '/w/notes/a': '' },
      remotes: { '/w/server': 'git@corp.example:team/server.git', '/w/api': 'git@corp.example:team/api.git', '/w/blog': 'git@github.com:me/blog.git', '/w/ws/x': 'git@corp.example:team/x.git' },
    })
    await $.session.start(START)
    await $.command.run(RUN('歸屬'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'pol-scan' })
    expect(await shows(ui, /corp\.example\/team/)).toBe(true)
    await ui.select({ key: 'pol-group-0', value: W })
    const got = (w.store.get('policy') as { rules: { folder: string; owner: string }[] }).rules
    expect(got.filter(r => r.owner === W).map(r => r.folder).sort()).toEqual(['/w/api', '/w/server', '/w/ws'])
    expect(got.find(r => r.folder === '/w/blog')?.owner).toBe(P)
    await ui.unmount()
  })
})

describe('braid 的新版', () => {
  test('GitHub 上有新版：開始後幾秒查到，跳一次提醒；面板上方有「更新並重新載入」，按了照官方兩步更新再重新載入', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL }, latest: '0.4.0' })
    await $.session.start(START)
    await w.clock.advance(5_000)
    expect(w.fetched).toEqual(['https://raw.githubusercontent.com/MiskaWu/braid/main/mod/.claude-plugin/plugin.json'])
    expect(w.toasts.filter(t => /braid 有新版 0\.4\.0（你的是 0\.3\.4）/.test(t)).length).toBe(1)
    await $.command.run(RUN())
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shows(ui, /braid 有新版 0\.4\.0/)).toBe(true)
    await ui.press({ key: 'upd-go' })
    const claudeRuns = w.runs.filter(r => r.argv[0] === '/opt/claude').map(r => r.argv.slice(1).join(' '))
    expect(claudeRuns).toEqual(['plugin marketplace update braid', 'plugin update braid@braid'])
    expect(w.reloads).toEqual(['reload-plugins'])
    await ui.unmount()
    // 同一個新版不再跳提醒；12 小時內不再查
    await $.session.start(START)
    await w.clock.advance(5_000)
    expect(w.toasts.filter(t => /有新版/.test(t)).length).toBe(1)
    expect(w.fetched.length).toBe(1)
  })

  for (const [name, latest] of [['已經是最新', '0.3.4'], ['連不上 GitHub', null]] as const) {
    test(`${name}：不提示，什麼都不跑`, async ($, on) => {
      const w = world(on, { store: { uses: USES_ALL }, latest })
      await $.session.start(START)
      await w.clock.advance(5_000)
      await $.command.run(RUN())
      const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
      expect(await ui.find({ key: 'upd' })).toBeUndefined()
      await ui.unmount()
      expect(w.toasts.some(t => /新版/.test(t))).toBe(false)
      expect(w.runs.some(r => r.argv[0] === '/opt/claude')).toBe(false)
    })
  }

  test('更新失敗：說原因，給可以自己在終端機執行的指令，不重新載入', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL }, latest: '0.4.0', failClaude: 'network unreachable' })
    await $.session.start(START)
    await w.clock.advance(5_000)
    await $.command.run(RUN())
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'upd-go' })
    expect(await shows(ui, /更新失敗（network unreachable）。可以在終端機執行：claude plugin marketplace update braid && claude plugin update braid@braid/)).toBe(true)
    expect(w.reloads).toEqual([])
    await ui.unmount()
  })

  test('找不到 claude：說要先裝或改用 /plugin，不跑、不重新載入', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL }, latest: '0.4.0', env: { CLAUDE_CODE_EXECPATH: '', PATH: '/usr/bin' } })
    await $.session.start(START)
    await w.clock.advance(5_000)
    await $.command.run(RUN())
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'upd-go' })
    expect(await shows(ui, /找不到 Claude Code 的命令列程式（claude），沒辦法在這裡更新。.*；或在 \/plugin 裡更新 braid。/)).toBe(true)
    expect(w.runs.some(r => r.argv[1] === 'plugin')).toBe(false)
    expect(w.reloads).toEqual([])
    await ui.unmount()
  })
})

describe('更新之後', () => {
  // 0.3.1 寫進 $.state 的桌面資料沒有 trash、backupRoot；$.state 在重新載入後還留著。
  // 測試的 $ 碰不到 $.state，改成攔截讀取：braid 自己寫 desktop 之前，讀到的都是舊版的形狀
  const OLD_DESKTOP = { profiles: [], backups: [], error: null }
  function leftover(on: On) {
    const held = { on: true }
    on('state.get', ($, e, next) => (held.on && e.plugin === 'braid' && e.key === 'desktop' ? { value: { value: OLD_DESKTOP, version: 1 } } : next(e)))
    on('state.set', ($, e, next) => {
      if (e.plugin === 'braid' && e.key === 'desktop') held.on = false
      return next(e)
    })
    return held
  }

  test('上一版留下的暫存：重新載入時丟掉重讀，同步頁照常畫得出來', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, sync: SYNC_ON } })
    leftover(on)
    await $.session.start(START)
    await $.command.run(RUN('同步'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'bk-keep-toggle' })).toBeDefined()
    expect(await ui.find({ key: 'pane-error' })).toBeUndefined()
    await ui.unmount()
    void w
  })

  test('一頁畫壞了：說原因、給「重新讀取」，按了重讀就好，其他分頁照樣能切', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, sync: SYNC_ON } })
    const held = leftover(on)
    await $.session.start(START)
    await $.command.run(RUN('同步'))
    held.on = true // 載入之後才又冒出舊形狀（模擬沒被重讀蓋掉的情況）
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shows(ui, /這一頁畫不出來/)).toBe(true)
    expect(await ui.find({ key: 'tab-accounts' })).toBeDefined()
    await ui.press({ key: 'pane-retry' })
    // 攔下來的那次讀取不算在測試工具的追蹤裡，它不知道要重畫；實際的 app 讀取都經過它，會自己重畫
    await ui.redraw()
    expect(await ui.find({ key: 'pane-error' })).toBeUndefined()
    expect(await ui.find({ key: 'bk-keep-toggle' })).toBeDefined()
    await ui.unmount()
    void w
  })
})

describe('備份保留', () => {
  const TRASH_DIR = `${BACKUPS}/sync-deleted/${P}/${OP}`
  const DAY = 24 * H
  const manifest = (name: string) => ({ [`${BACKUPS}/${name}/manifest.json`]: '{}', [`${BACKUPS}/${name}/sessions/local_1.json`]: '{}' })

  test('預設：同步刪掉的備份留 30 天、整份備份留最新 5 份；開始後清掉超過的，其他的（含不像備份的資料夾）不碰', async ($, on) => {
    const names = ['20261001-090000', '20261002-090000', '20261003-090000', '20261004-090000', '20261005-090000', '20261005-090000-2']
    const w = world(on, {
      store: { uses: USES_ALL },
      files: {
        ...Object.assign({}, ...names.map(manifest)),
        [`${BACKUPS}/before-auto-sync/x.json`]: '{}',
        [`${TRASH_DIR}/local_old.json`]: '{}',
        [`${TRASH_DIR}/local_new.json`]: '{}',
      },
      mtimes: { [`${TRASH_DIR}/local_old.json`]: NOW - 40 * DAY, [`${TRASH_DIR}/local_new.json`]: NOW - 10 * DAY },
    })
    await $.session.start(START)
    await w.clock.advance(3_000)
    expect(w.files[`${TRASH_DIR}/local_old.json`]).toBeUndefined()
    expect(w.files[`${TRASH_DIR}/local_new.json`]).toBeDefined()
    // 加上原本就有的 20261016-140211 共 7 份：留最新 5 份，最舊的兩份清掉
    expect([w.files[`${BACKUPS}/20261001-090000/manifest.json`], w.files[`${BACKUPS}/20261002-090000/manifest.json`]]).toEqual([undefined, undefined])
    expect(['20261003-090000', '20261005-090000-2', '20261016-140211'].every(n => w.files[`${BACKUPS}/${n}/manifest.json`] !== undefined)).toBe(true)
    expect(w.files[`${BACKUPS}/before-auto-sync/x.json`]).toBeDefined()
    expect(w.runs.filter(r => r.argv[0] === 'rm' && r.argv[1] === '-rf').map(r => r.argv[3])).toEqual([`${BACKUPS}/20261002-090000`, `${BACKUPS}/20261001-090000`])
  })

  test('在面板改：存起來、馬上照新的清；選「一直留著」「全部留著」就不清', async ($, on) => {
    const w = world(on, {
      store: { uses: USES_ALL, sync: SYNC_ON },
      files: { [`${TRASH_DIR}/local_a.json`]: '{"x":1}', ...manifest('20261010-090000') },
      mtimes: { [`${TRASH_DIR}/local_a.json`]: NOW - 10 * DAY },
    })
    await $.session.start(START)
    await $.command.run(RUN('同步'))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'keep-days' })).toBeUndefined() // 桌面版：保留設定先收著
    await ui.press({ key: 'bk-keep-toggle' })
    expect((await ui.find({ key: 'keep-days' }))?.props.value).toBe('30')
    expect((await ui.find({ key: 'keep-copies' }))?.props.value).toBe('5')
    expect(await seen(ui, /同步刪掉的對話：1 筆、7 B，留 30 天/)).toBe(true)
    expect(await seen(ui, /整份備份：2 份，留最新 5 份/)).toBe(true)
    await ui.select({ key: 'keep-days', value: '7' })
    expect(w.store.get('keep')).toEqual({ deletedDays: 7, toolCopies: 5 })
    expect(w.files[`${TRASH_DIR}/local_a.json`]).toBeUndefined()
    expect(await seen(ui, /同步刪掉的對話：0 筆/)).toBe(true)
    await ui.select({ key: 'keep-copies', value: '3' })
    await ui.select({ key: 'keep-copies', value: 'all' })
    await ui.select({ key: 'keep-days', value: 'forever' })
    expect(w.store.get('keep')).toEqual({ deletedDays: null, toolCopies: null })
    await ui.unmount()
  })

})

describe('遷移頁', () => {
  test('列出其他帳號的對話（壞掉的檔略過），試跑、開始各帶 -From；備份可以還原', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL, [`account:${P}`]: PERSONAL } })
    await $.session.start(START)
    await $.command.run(RUN())
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab-migrate' })
    expect(await shows(ui, /3 個對話 · 2 個資料夾/)).toBe(true)
    expect(await ui.find({ key: `src-${W}-${OW}` })).toBeUndefined() // 目前的帳號不列
    await ui.press({ key: `mig-dry-${P}-${OP}` })
    expect(w.runs.at(-1)?.argv.slice(1)).toEqual([expect.stringMatching(/\/tool\/launch-from-wsl\.sh$/), '-DryRun', '-From', P])
    expect(await shows(ui, /試跑：只列計畫/)).toBe(true)
    await ui.press({ key: 'restore-20261016-140211' })
    expect(w.runs.at(-1)?.argv.slice(2)).toEqual(['-Restore', 'C:\\Users\\u\\braid-backups\\20261016-140211'])
    expect(await ui.find({ key: 'restore-not-a-backup' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('/braid migrate 依平台開獨立視窗', () => {
  test('WSL：交給 launch-from-wsl.sh；試跑帶 -DryRun', async ($, on) => {
    const w = world(on)
    let { text } = await $.command.run(RUN('migrate'))
    expect(w.runs.at(-1)?.argv[0]).toBe('bash')
    expect(w.runs.at(-1)?.argv.length).toBe(2)
    expect(text).toContain('系統匣')
    ;({ text } = await $.command.run(RUN('migrate 試跑')))
    expect(w.runs.at(-1)?.argv[2]).toBe('-DryRun')
    expect(text).toContain('Claude 不用結束')
  })

  test('Windows 原生：Start-Process 開 migrate.cmd，不經過 uname', async ($, on) => {
    const w = world(on, { env: { WSL_DISTRO_NAME: '', OS: 'Windows_NT' } })
    await $.command.run(RUN('migrate'))
    expect(w.runs.map(r => r.argv[0])).toEqual(['powershell.exe'])
    expect(w.runs[0]?.argv[3]).toMatch(/^Start-Process -FilePath '.*\\tool\\windows\\migrate\.cmd'$/)
  })

  test('macOS：沒參數直接開；試跑寫一個帶 --dry-run 的包裝', async ($, on) => {
    const w = world(on, { env: { WSL_DISTRO_NAME: '', TMPDIR: '/var/T/' }, uname: 'Darwin' })
    await $.command.run(RUN('migrate'))
    expect(w.runs.at(-1)?.argv.slice(0, 3)).toEqual(['open', '-a', 'Terminal'])
    await $.command.run(RUN('遷移 dry-run'))
    expect(w.files['/var/T/braid-migrate.command']).toMatch(/^#!\/bin\/bash\nexec ".+\/tool\/macos\/migrate\.command" "--dry-run"\n$/)
  })

  test('開不了視窗：說原因，並給可以直接雙擊的檔案', async ($, on) => {
    const w = world(on, { failBash: '讀不到 Windows 的暫存資料夾位置' })
    const { text } = await $.command.run(RUN('migrate'))
    expect(text).toContain('開不了工具的視窗（讀不到 Windows 的暫存資料夾位置）')
    expect(text).toContain('migrate.cmd')
    expect(w.opened).toEqual([])
  })

  test('不認得的動作：說明並列出用法，什麼都不執行', async ($, on) => {
    const w = world(on)
    const { text } = await $.command.run(RUN('試跑'))
    expect(text).toContain('沒有「試跑」這個動作。')
    expect(text).toContain('/braid migrate [試跑]')
    expect(w.runs.filter(r => r.argv[0] === 'bash')).toEqual([])
  })
})

describe('手機', () => {
  test('沒有輸入框與下拉選單：只顯示目前帳號，請到電腦上改', async ($, on) => {
    const w = world(on, { store: { uses: USES_ALL } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    expect(await shows(ui, /目前：公司/)).toBe(true)
    expect(await shows(ui, /請在電腦上改/)).toBe(true)
    await ui.unmount()
  })
})

