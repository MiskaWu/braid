import { describe, expect, test } from 'claude-code/testing'

import type { BraidAccount, BraidSwitch } from '../types'
import { backupLabel } from '../hooks/desktop'
import { parseDryRun, planLaunch, toolArgs } from '../hooks/launch'
import {
  bandFor,
  candidates,
  classifyOrg,
  DEFAULT_SWITCH,
  defaultLabel,
  effectivePct,
  fmtReset,
  isRestricted,
  meter,
  nameOf,
  normalizeAccount,
  normalizeFolder,
  normalizeSwitch,
  normalizeSync,
  normalizeUses,
  orderedIds,
  isOrgId,
  parseTz,
  partnerOf,
  syncRequest,
  syncRows,
  syncScopeText,
  upsertSeen,
  usageFrom,
} from '../hooks/model'
import { newCredentialId, planTerminal, removeFile, secretDelete, wrapperText } from '../hooks/terminal'

// 2026-10-16 14:00（UTC+8）
const NOW = Date.parse('2026-10-16T06:00:00Z')
const TZ = 480
const iso = (ms: number) => new Date(ms).toISOString()
const H = 3600_000

function account(id: string, over: Partial<BraidAccount> = {}): BraidAccount {
  return {
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
    lastSeen: 0,
    ...over,
  }
}

const work = account('work', { orgId: 'org-w', label: '公司', lastSeen: 3 })
const work2 = account('work2', { orgId: 'org-w', label: '公司 2', credential: 'file', credentialId: 'tok-00000002', lastSeen: 2 })
const home = account('home', { orgId: 'org-h', label: '個人', credential: 'keychain', credentialId: 'tok-00000001', lastSeen: 1 })
const ACCOUNTS = { work, work2, home }

describe('讀回儲存的資料', () => {
  test('壞掉或舊版的值換成預設，不讓畫面掛掉', async () => {
    expect(normalizeUses('x')).toBe(null)
    expect(normalizeUses({ migrate: true, switch: 'yes' })).toEqual({ migrate: true, switch: false, sync: false })
    expect(normalizeSwitch(null)).toEqual(DEFAULT_SWITCH)
    expect(normalizeSwitch({ on: false, fiveHour: 'x', sevenDay: null, order: ['a', 3], restrict: 'yes', restricted: ['/a', '', 3] })).toEqual({
      on: false,
      fiveHour: 90,
      sevenDay: null,
      order: ['a'],
      restrict: false,
      restricted: ['/a'],
    })
    // 舊版的 folders／otherFolders 不再讀：回到預設的「全部資料夾都能換到任何帳號」
    expect(normalizeSwitch({ folders: { '/a': 'same-org' }, otherFolders: 'same-org' })).toEqual(DEFAULT_SWITCH)
    expect(normalizeSync({ on: true, pair: ['a', 'b', 'c'], folders: ['/x', ''], when: 'manual' })).toEqual({ on: true, pair: ['a', 'b'], all: false, folders: ['/x'], when: 'manual' })
    // 同步預設全部；沒有 all 欄位的舊設定，挑過資料夾的維持只同步挑的
    expect([normalizeSync(null).all, normalizeSync({}).all, normalizeSync({ all: false }).all, normalizeSync({ all: true, folders: ['/x'] }).all]).toEqual([true, true, false, true])
    expect(normalizeAccount({ label: 'x' })).toBe(null)
    expect(normalizeAccount({ id: 'tok-1', credential: 'file', source: 'token' })?.credentialId).toBe('tok-1')
    expect(normalizeAccount({ id: 'a', credential: 'stolen' })?.credential).toBe(null)
  })
})

describe('輸入的資料夾路徑', () => {
  test('去掉前後空白、引號與結尾斜線；根目錄與磁碟機根目錄保留；空的不收', async () => {
    expect(['  /a/b/ ', '"/a b"', "'C:\\proj\\'", '/', 'C:\\', '  ', '""'].map(normalizeFolder)).toEqual(['/a/b', '/a b', 'C:\\proj', '/', 'C:\\', null, null])
  })
})

describe('認帳號', () => {
  test('預設名稱：組織名稱優先，沒有就看信箱網域；重複加編號', async () => {
    expect(defaultLabel({ email: 'me@corp.com', orgName: 'Acme' }, [])).toBe('Acme')
    expect(defaultLabel({ email: 'me@corp.com', orgName: "me@corp.com's Organization" }, [])).toBe('公司')
    expect(defaultLabel({ email: 'me@gmail.com', orgName: null }, [])).toBe('個人')
    expect(defaultLabel({ email: null, orgName: null }, ['個人', '個人 2'])).toBe('個人 3')
  })

  test('再次看到同一個帳號：更新信箱與時間，保留使用者改過的名稱與顏色；braid 新增的帳號維持 token', async () => {
    const seen = { id: 'home', email: 'me@gmail.com', orgId: 'org-h', orgName: null, source: 'cli' as const }
    const renamed = { ...home, label: '我的', color: '#8E6BD8', source: 'token' as const }
    const got = upsertSeen({ home: renamed }, seen, NOW)
    expect([got.label, got.color, got.email, got.lastSeen, got.source]).toEqual(['我的', '#8E6BD8', 'me@gmail.com', NOW, 'token'])
  })

  test('新帳號拿一個還沒用過的顏色', async () => {
    const got = upsertSeen({ work }, { id: 'n', email: 'n@gmail.com', orgId: null, orgName: null, source: 'desktop' }, NOW)
    expect(got.color).not.toBe(work.color)
    expect([got.label, got.credential, got.credentialId]).toEqual(['個人', null, null])
  })
})

describe('新增的憑證屬於哪個組織', () => {
  test('組織 id 的格式', async () => {
    expect([isOrgId('12345678-90ab-4cde-8f01-23456789abcd'), isOrgId('x'), isOrgId(null), isOrgId('"; rm -rf /')]).toEqual([true, false, false, false])
  })

  test('和目前帳號同組織、正好一個認得的帳號在這個組織、或新的', async () => {
    const list = { work, home }
    expect(classifyOrg(list, 'work', 'org-w').kind).toBe('current-org')
    expect(classifyOrg(list, 'work', 'org-h')).toEqual({ kind: 'known', account: home })
    expect(classifyOrg(list, 'work', 'org-x').kind).toBe('new')
    expect(classifyOrg({ ...list, work2 }, 'home', 'org-w').kind).toBe('new') // 同組織有兩個認得的帳號：分不出是哪個，當新的
    expect(classifyOrg(list, null, 'org-w')).toEqual({ kind: 'known', account: work }) // 認不出目前帳號時不擋
  })
})

describe('用量', () => {
  test('從 rate limit 取出 5 小時與 7 天；兩個都沒有就是 null', async () => {
    expect(usageFrom([{ kind: 'five_hour', percentUsed: 62, resetsAt: 'r' }, { kind: 'spend_limit', percentUsed: 1 }], NOW)).toEqual({
      fiveHour: { pct: 62, resetsAt: 'r' },
      sevenDay: null,
      at: NOW,
    })
    expect(usageFrom([{ kind: 'spend_limit', percentUsed: 1 }], NOW)).toBe(null)
  })

  test('過了重置時間的窗算 0', async () => {
    expect(effectivePct({ pct: 80, resetsAt: iso(NOW - 1) }, NOW)).toBe(0)
    expect(effectivePct({ pct: 80, resetsAt: iso(NOW + 1) }, NOW)).toBe(80)
    expect(effectivePct(null, NOW)).toBe(null)
  })

  test('用量條', async () => {
    expect(meter(62, 10)).toEqual({ used: '██████', left: '░░░░' })
    expect(meter(130, 4)).toEqual({ used: '████', left: '' })
    expect(meter(0, 3)).toEqual({ used: '', left: '░░░' })
  })

  test('重置時間：今天寫時間、24 小時內的隔天加「明天」、更遠寫日期與星期', async () => {
    expect(fmtReset(iso(NOW + 2 * H), NOW, TZ)).toBe('16:00')
    expect(fmtReset(iso(NOW + 11 * H), NOW, TZ)).toBe('明天 01:00')
    expect(fmtReset(iso(NOW + 4 * 24 * H), NOW, TZ)).toBe('10/20（二）') // 2026-10-16 是星期五
    expect(fmtReset(null, NOW, TZ)).toBe('')
    expect([parseTz('+0800\n'), parseTz('-05:30'), parseTz('??')]).toEqual([480, -330, 0])
  })
})

describe('換帳號的規則', () => {
  const sw: BraidSwitch = { ...DEFAULT_SWITCH, restrict: true, restricted: ['/work', 'C:\\proj'] }

  test('預設不限制；設了才看清單，子資料夾跟著，名稱只是開頭相同的不算', async () => {
    expect(isRestricted(DEFAULT_SWITCH, '/work/server')).toBe(false)
    expect(isRestricted({ ...sw, restrict: false }, '/work/server')).toBe(false) // 切回全部時清單留著但不生效
    expect([isRestricted(sw, '/work'), isRestricted(sw, '/work/server/api'), isRestricted(sw, '/workshop'), isRestricted(sw, '/side/blog')]).toEqual([true, true, false, false])
    expect(isRestricted(sw, 'C:\\proj\\a')).toBe(true)
  })

  test('順序：設定的在前，其餘照最近出現排', async () => {
    expect(orderedIds(ACCOUNTS, ['home'])).toEqual(['home', 'work', 'work2'])
    expect(orderedIds(ACCOUNTS, ['gone'])).toEqual(['work', 'work2', 'home'])
  })

  test('限制的資料夾不換到其他組織的帳號；組織不明也不算同組織', async () => {
    const list = candidates({ ...ACCOUNTS, tok: account('tok', { credential: 'file', credentialId: 'tok' }) }, 'work', sw, '/work/server', NOW)
    expect(list.map(c => [c.account.id, c.why])).toEqual([
      ['work2', 'ok'],
      ['home', 'other-org'],
      ['tok', 'other-org'],
    ])
  })

  test('沒限制的資料夾：哪個組織都可以；沒有憑證的、也快用完的都說明原因', async () => {
    const busy = { ...work2, usage: { fiveHour: { pct: 95, resetsAt: iso(NOW + H) }, sevenDay: null, at: NOW } }
    const list = candidates({ work, work2: busy, home, desk: account('desk', { lastSeen: -1 }) }, 'work', sw, '/side/blog', NOW)
    expect(list.map(c => [c.account.id, c.why])).toEqual([
      ['work2', 'busy'],
      ['home', 'ok'],
      ['desk', 'no-credential'],
    ])
  })
})

describe('輸入框上方的提示', () => {
  const live = (five: number, seven = 10) => ({ fiveHour: { pct: five, resetsAt: iso(NOW + 2 * H) }, sevenDay: { pct: seven, resetsAt: iso(NOW + 96 * H) }, at: NOW })
  const at = (pct: number, seven?: number, snooze: string | null = null, sw: BraidSwitch = DEFAULT_SWITCH) => bandFor(ACCOUNTS, 'work', live(pct, seven), sw, '/work', NOW, snooze)

  test('沒到門檻不出現；關掉也不出現', async () => {
    expect(at(89)).toBe(null)
    expect(at(95, 10, null, { ...DEFAULT_SWITCH, on: false })).toBe(null)
  })

  test('到門檻：快用完；同組織有憑證的帳號可以一鍵接手', async () => {
    const band = at(92)
    expect([band?.kind, band?.window, band?.pct, band?.best?.id]).toEqual(['warn', 'five_hour', 92, 'work2'])
  })

  test('7 天也看；用完優先於快用完', async () => {
    expect(at(10, 96)?.window).toBe('seven_day')
    expect(at(100, 96)?.kind).toBe('out')
    expect(at(10, 96, null, { ...DEFAULT_SWITCH, sevenDay: null })).toBe(null)
  })

  test('按掉「先別提醒」：同一個窗、同一個重置時間不再出現，但用完時還會出現', async () => {
    const warn = at(92)
    expect(at(93, 10, warn?.snoozeKey ?? null)).toBe(null)
    expect(at(100, 10, warn?.snoozeKey ?? null)?.kind).toBe('out')
  })

  test('沒有可以一鍵接手的：給可以在桌面 app 手動換的帳號', async () => {
    const band = bandFor({ work, desk: account('desk', { orgId: 'org-w' }) }, 'work', live(92), DEFAULT_SWITCH, '/work', NOW, null)
    expect([band?.best, band?.manual?.id]).toEqual([null, 'desk'])
  })
})

describe('同步', () => {
  test('要工具做什麼：全部資料夾連環境全部；勾選的只帶那些資料夾，環境跟著資料夾；沒有範圍或沒有夥伴就不做', async () => {
    const sync = { on: true, pair: ['a', 'b'], all: false, folders: ['/x', '/y'], when: 'on-switch' as const }
    expect(syncRequest(sync, 'b')).toEqual({ from: 'b', projects: ['/x', '/y'], presets: 'folders' })
    expect(syncRequest({ ...sync, all: true }, 'b')).toEqual({ from: 'b', projects: 'all', presets: 'all' })
    expect(syncRequest({ ...sync, folders: [] }, 'b')).toBe(null)
    expect(syncRequest({ ...sync, all: true, folders: [] }, 'b')?.projects).toBe('all')
    expect(syncRequest(sync, null)).toBe(null)
    expect([syncScopeText(sync), syncScopeText({ ...sync, all: true })]).toEqual(['同步的 2 個資料夾', '所有資料夾'])
  })

  test('同步夥伴是一對帳號裡的另一個；目前帳號不在這一對裡就沒有', async () => {
    const sync = { on: true, pair: ['a', 'b'], all: false, folders: [], when: 'on-switch' as const }
    expect([partnerOf(sync, 'a'), partnerOf(sync, 'b'), partnerOf(sync, 'c'), partnerOf({ ...sync, pair: [] }, 'a')]).toEqual(['b', 'a', null, null])
  })

  test('資料夾清單：兩邊的聯集，勾過的在前，同一個帳號不同組織的併在一起', async () => {
    const profiles = [
      { account: 'a', org: 'o1', sessions: 3, lastActivity: 1, folders: [{ path: '/x', sessions: 2, lastActivity: 1 }, { path: '/y', sessions: 1, lastActivity: 1 }] },
      { account: 'a', org: 'o2', sessions: 1, lastActivity: 1, folders: [{ path: '/x', sessions: 1, lastActivity: 1 }] },
      { account: 'b', org: 'o3', sessions: 5, lastActivity: 1, folders: [{ path: '/z', sessions: 5, lastActivity: 1 }] },
    ]
    expect(syncRows(profiles, 'a', 'b', ['/y']).map(r => [r.path, r.mine, r.theirs, r.checked])).toEqual([
      ['/y', 1, 0, true],
      ['/z', 0, 5, false],
      ['/x', 3, 0, false],
    ])
  })

  test('不認得的桌面帳號：組織正好對到一個 braid 新增的帳號就借它的名稱；認得 id 的同組織帳號不借、對到兩個也不借', async () => {
    const profiles = [{ account: 'desk-p', org: 'org-h', sessions: 1, lastActivity: 1, folders: [] }, { account: 'desk-w', org: 'org-w', sessions: 1, lastActivity: 1, folders: [] }]
    const tok = account('tok-1', { orgId: 'org-h', label: 'MiskaWu' })
    expect(nameOf({ work, 'tok-1': tok }, 'desk-p', profiles)).toBe('MiskaWu')
    expect(nameOf({ work, 'tok-1': tok }, 'desk-w', profiles)).toBe('帳號 desk-w…') // work 有真正的 id：是另一個帳號
    expect(nameOf({ 'tok-1': tok, 'tok-2': { ...tok, id: 'tok-2' } }, 'desk-p', profiles)).toBe('帳號 desk-p…')
    expect(nameOf({ work }, 'work', profiles)).toBe('公司')
    expect(nameOf({}, 'desk-p')).toBe('帳號 desk-p…')
  })

  test('備份資料夾名稱轉成時間', async () => {
    expect([backupLabel('20261016-140211'), backupLabel('20261016-140211-2'), backupLabel('x')]).toEqual(['10/16 14:02', '10/16 14:02', 'x'])
  })
})

describe('遷移工具的參數', () => {
  test('試跑的寫法', async () => {
    for (const a of ['試跑', 'dry-run', 'dryrun', '--dry-run', '-DryRun', '  試跑  ']) expect(parseDryRun(a)).toBe(true)
    for (const a of ['', '跑', 'run', 'not-dry-run-really']) expect(parseDryRun(a)).toBe(false)
  })

  test('Windows 與 macOS 的參數名稱；同步帶資料夾與環境跟著資料夾', async () => {
    const sync = { from: 'acct', projects: ['/p/a', '/p/中文 b'], presets: 'folders' as const }
    expect(toolArgs('wsl', sync)).toEqual(['-From', 'acct', '-Projects', '/p/a,/p/中文 b', '-Presets', 'folders'])
    expect(toolArgs('mac', sync)).toEqual(['--from', 'acct', '--projects', '/p/a,/p/中文 b', '--presets', 'folders'])
    expect(toolArgs('windows', { dryRun: true, from: 'x' })).toEqual(['-DryRun', '-From', 'x'])
    expect(toolArgs('windows', { restore: 'C:\\b\\1', dryRun: true })).toEqual(['-Restore', 'C:\\b\\1'])
    expect(toolArgs('mac', { projects: [] })).toEqual(['--projects', 'none'])
    expect(toolArgs('wsl', { from: 'acct', projects: 'all', presets: 'all' })).toEqual(['-From', 'acct', '-Projects', 'all', '-Presets', 'all'])
  })

  test('沒辦法用參數表達的資料夾：拒絕，請使用者改用勾選清單', async () => {
    expect(toolArgs('mac', { projects: ['/p/a,b'] })).toEqual({ unsafe: '/p/a,b' })
    expect(toolArgs('windows', { projects: ['/p/100%'] })).toEqual({ unsafe: '/p/100%' })
    expect(toolArgs('mac', { projects: ['/p/100%'] })).toEqual(['--projects', '/p/100%'])
  })

  test('各平台怎麼開視窗', async () => {
    expect(planLaunch('wsl', '/r', ['-DryRun'])).toEqual({ actions: [{ run: ['bash', '/r/tool/launch-from-wsl.sh', '-DryRun'] }] })
    const win = planLaunch('windows', "C:/Users/O'Neil/x", ['-From', 'a b'])
    expect('actions' in win && win.actions[0]).toEqual({
      run: ['powershell.exe', '-NoProfile', '-Command', "Start-Process -FilePath 'C:\\Users\\O''Neil\\x\\tool\\windows\\migrate.cmd' -ArgumentList '-From','\"a b\"'"],
    })
    expect(planLaunch('mac', '/r', [])).toEqual({ actions: [{ run: ['open', '-a', 'Terminal', '/r/tool/macos/migrate.command'] }] })
    const mac = planLaunch('mac', '/Users/a "b"/$x', ['--dry-run'], '/tmp/')
    expect('actions' in mac && mac.actions).toEqual([
      { write: { path: '/tmp/braid-migrate.command', text: '#!/bin/bash\nexec "/Users/a \\"b\\"/\\$x/tool/macos/migrate.command" "--dry-run"\n' } },
      { run: ['chmod', '+x', '/tmp/braid-migrate.command'] },
      { run: ['open', '-a', 'Terminal', '/tmp/braid-migrate.command'] },
    ])
    expect(planLaunch('other', '/r', [])).toEqual({ unsupported: true })
  })
})

describe('開新視窗跑帳號腳本', () => {
  const resume = { kind: 'resume' as const, account: 'acct-1', credentialId: 'tok-1', session: 's-1', cwd: "/w/it's here", claude: '/opt/claude', label: '個人' }

  test('一次性的小腳本：先刪自己，參數用單引號寫死（單引號本身也跳脫）', async () => {
    expect(wrapperText('/r', resume)).toBe(
      "#!/bin/bash\nrm -f -- \"$0\"\nexec bash '/r/tool/cli/resume.sh' 'tok-1' 's-1' '/w/it'\\''s here' '/opt/claude' '個人' 'acct-1'\n",
    )
  })

  test('WSL：寫小腳本，交給 open-wsl.sh 開 Windows 視窗', async () => {
    expect(planTerminal('wsl', '/r', resume, '/tmp/')).toEqual({
      steps: [{ write: { path: '/tmp/braid-resume-tok-1.sh', text: wrapperText('/r', resume) } }, { run: ['bash', '/r/tool/cli/open-wsl.sh', '/tmp/braid-resume-tok-1.sh'] }],
      manual: null,
    })
  })

  test('Linux：開不了視窗時給一行指令', async () => {
    const plan = planTerminal('other', '/r', { kind: 'add', credentialId: 'tok-2', result: '/tmp/r.json', claude: 'claude' }, '/tmp')
    expect('steps' in plan && plan.manual).toBe("bash '/tmp/braid-add-tok-2.sh'")
  })

  test('macOS：.command 檔，加執行權限再用 Terminal 開', async () => {
    const plan = planTerminal('mac', '/r', resume, '/var/T/')
    expect('steps' in plan && plan.steps.slice(1)).toEqual([{ run: ['chmod', '+x', '/var/T/braid-resume-tok-1.command'] }, { run: ['open', '-a', 'Terminal', '/var/T/braid-resume-tok-1.command'] }])
  })

  test('Windows：參數放環境變數（中文不經過命令列），開 PowerShell 視窗跑 resume.ps1', async () => {
    const plan = planTerminal('windows', 'C:/plug', { ...resume, cwd: 'C:\\w\\中文' }, 'C:\\T')
    expect('steps' in plan && plan.steps).toEqual([
      {
        run: [
          'powershell.exe',
          '-NoProfile',
          '-Command',
          "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"C:\\plug\\tool\\windows\\resume.ps1\"'",
        ],
        env: { BRAID_ACCOUNT: 'acct-1', BRAID_CREDENTIAL: 'tok-1', BRAID_SESSION: 's-1', BRAID_CWD: 'C:\\w\\中文', BRAID_CLAUDE: '/opt/claude', BRAID_LABEL: '個人' },
      },
    ])
  })

  test('刪憑證不開視窗；新憑證 id 的格式', async () => {
    expect(secretDelete('wsl', '/r', 'tok-1')).toEqual(['bash', '/r/tool/cli/secret.sh', 'delete', 'tok-1'])
    expect(secretDelete('windows', 'C:/r', 'tok-1')).toEqual(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\r\\tool\\windows\\secret.ps1', 'delete', 'tok-1'])
    let i = 0
    expect(newCredentialId(() => (i++ % 16) / 16)).toBe('tok-01234567')
    expect(removeFile('wsl', '/tmp/braid-add-tok-1.json')).toEqual(['rm', '-f', '--', '/tmp/braid-add-tok-1.json'])
    expect(removeFile('windows', "C:\\T\\o'k.json")).toEqual(['powershell.exe', '-NoProfile', '-Command', "Remove-Item -LiteralPath 'C:\\T\\o''k.json' -Force -ErrorAction SilentlyContinue"])
  })
})
