import { describe, expect, test } from 'claude-code/testing'

import type { BraidAccount, BraidSwitch } from '../types'
import { backupLabel } from '../hooks/desktop'
import { parseDryRun, planLaunch, toolArgs } from '../hooks/launch'
import {
  absorbTokenTwin,
  bandFor,
  candidates,
  classifyOrg,
  DEFAULT_SWITCH,
  defaultLabel,
  effectivePct,
  fmtReset,
  isRestricted,
  meter,
  expiredFiles,
  extraToolBackups,
  fmtBytes,
  normalizeKeep,
  mirrorTarget,
  nameOf,
  normalizeAccount,
  normalizeFolder,
  normalizeMirror,
  normalizeSwitch,
  normalizeSync,
  normalizeUses,
  orderedIds,
  isOrgId,
  parseTz,
  partnerOf,
  syncRequest,
  syncRows,
  upsertSeen,
  usageFrom,
} from '../hooks/model'
import { mirrorSessions, orgDirOf, parseSpec, type MirrorIo, type SessionSpec } from '../hooks/mirror'
import { newCredentialId, planTerminal, removeFile, removeToolBackup, secretDelete, wrapperText } from '../hooks/terminal'

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
    // 舊版的 when（換帳號後問／只在按的時候）不再讀：開著就自動同步
    expect(normalizeSync({ on: true, pair: ['a', 'b', 'c'], folders: ['/x', ''], when: 'manual' })).toEqual({ on: true, pair: ['a', 'b'], all: false, folders: ['/x'] })
    expect(normalizeMirror({ at: 5, active: 'a', to: 'b', toOrg: 'o', created: 2, updated: 'x', problem: 'weird', detail: '' })).toEqual({
      at: 5,
      active: 'a',
      to: 'b',
      toOrg: 'o',
      created: 2,
      updated: 0,
      deleted: 0,
      problem: null,
      detail: null,
    })
    expect([normalizeMirror(null), normalizeMirror({ active: 'a' })]).toEqual([null, null])
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
    const sync = { on: true, pair: ['a', 'b'], all: false, folders: ['/x', '/y'] }
    expect(syncRequest(sync, 'b')).toEqual({ from: 'b', projects: ['/x', '/y'], presets: 'folders' })
    expect(syncRequest({ ...sync, all: true }, 'b')).toEqual({ from: 'b', projects: 'all', presets: 'all' })
    expect(syncRequest({ ...sync, folders: [] }, 'b')).toBe(null)
    expect(syncRequest({ ...sync, all: true, folders: [] }, 'b')?.projects).toBe('all')
    expect(syncRequest(sync, null)).toBe(null)
  })

  test('自動同步的方向：從桌面 app 現在登入的帳號到同一對的另一個；沒開、不在這一對、挑資料夾卻沒挑就不做', async () => {
    const sync = { on: true, pair: ['a', 'b'], all: true, folders: [] }
    expect(mirrorTarget(sync, 'a')).toEqual({ from: 'a', to: 'b', scope: 'all' })
    expect(mirrorTarget(sync, 'b')).toEqual({ from: 'b', to: 'a', scope: 'all' })
    expect(mirrorTarget({ ...sync, all: false, folders: ['/x'] }, 'a')).toEqual({ from: 'a', to: 'b', scope: ['/x'] })
    expect([mirrorTarget({ ...sync, on: false }, 'a'), mirrorTarget(sync, 'c'), mirrorTarget(sync, null), mirrorTarget({ ...sync, all: false }, 'a'), mirrorTarget({ ...sync, pair: ['a', 'a'] }, 'a')]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ])
  })

  test('同步夥伴是一對帳號裡的另一個；目前帳號不在這一對裡就沒有', async () => {
    const sync = { on: true, pair: ['a', 'b'], all: false, folders: [] }
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

// ── 自動同步的核心：用記憶體裡的假檔案系統，修改時間自己給 ──

const SPEC: SessionSpec = {
  filePrefix: 'local_',
  tombstonePrefix: 'deleted_',
  archivedIndex: 'archived-sessions.idx',
  requiredKeys: ['sessionId', 'cliSessionId', 'cwd'],
  dropKeys: ['bridgeSessionIds', 'sshReattach', 'sshRemoteProcessId', 'priorRemoteCliSessionIds', 'scheduledTaskId'],
  nullKeys: ['startedFromEnvironmentId'],
  replaceFromTarget: ['remoteMcpServersConfig'],
}

const TRASH = { dir: '/bk/sync-deleted/t', sep: '/' }

function memFs(files: Record<string, { text: string; mtime: number }>, dirs: string[] = [], failRemove = false) {
  const writes: string[] = []
  const removes: string[] = []
  let clock = 1_000
  const io: MirrorIo = {
    list: async path => {
      const out = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
      for (const [f, v] of Object.entries(files)) {
        if (!f.startsWith(`${path}/`)) continue
        const rest = f.slice(path.length + 1)
        const name = rest.split('/')[0] as string
        if (rest.includes('/')) out.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
        else out.set(name, { name, kind: 'file', size: v.text.length, mtimeMs: v.mtime, isLink: false })
      }
      for (const d of dirs) if (d.startsWith(`${path}/`) && !d.slice(path.length + 1).includes('/')) out.set(d.slice(path.length + 1), { name: d.slice(path.length + 1), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
      if (out.size === 0 && !dirs.includes(path)) throw new Error(`ENOENT ${path}`)
      return [...out.values()]
    },
    read: async path => {
      const f = files[path]
      if (!f) throw new Error(`ENOENT ${path}`)
      return f.text
    },
    write: async (path, text) => {
      writes.push(path)
      files[path] = { text, mtime: ++clock }
    },
    remove: async path => {
      if (failRemove) throw new Error(`EBUSY ${path}`)
      removes.push(path)
      delete files[path]
    },
  }
  return { io, files, writes, removes }
}

const r = (id: string, over: Record<string, unknown> = {}) => JSON.stringify({ sessionId: `local_${id}`, cliSessionId: `cli-${id}`, cwd: '/w', lastActivityAt: 100, ...over })
const json = (text: string | undefined) => JSON.parse(text ?? 'null') as Record<string, unknown>

describe('自動同步：複製側欄紀錄', () => {
  test('新增：拿掉綁帳號的欄位、清空 nullKeys、連接器換成目標帳號最近一筆的；刪過的、缺欄位的、壞掉的、範圍外的不帶；來源一個檔都不寫', async () => {
    const m = memFs({
      '/s/local_a.json': { text: r('a', { bridgeSessionIds: ['b'], sshReattach: { pid: 1 }, sshRemoteProcessId: 7, scheduledTaskId: 't', startedFromEnvironmentId: 'e', remoteMcpServersConfig: { slack: 1 }, title: 'A' }), mtime: 10 },
      '/s/local_b.json': { text: r('b', { cwd: '/other' }), mtime: 10 },
      '/s/local_c.json': { text: r('c'), mtime: 10 },
      '/s/local_d.json': { text: JSON.stringify({ sessionId: 'local_d', cwd: '/w' }), mtime: 10 },
      '/s/local_e.json': { text: '{壞掉', mtime: 10 },
      '/s/notes.txt': { text: 'x', mtime: 10 },
      '/s/local_w.json': { text: r('w', { cwd: '/w/.claude/worktrees/x', originCwd: '/w' }), mtime: 10 },
      '/t/deleted_c': { text: '1', mtime: 1 },
      '/t/local_old.json': { text: r('old', { lastActivityAt: 1, remoteMcpServersConfig: { old: 1 } }), mtime: 1 },
      '/t/local_new.json': { text: r('new', { lastActivityAt: 50, remoteMcpServersConfig: { mine: 1 } }), mtime: 1 },
    })
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', ['/w'], TRASH)).toEqual({ created: 2, updated: 0, deleted: 0 })
    expect(json(m.files['/t/local_a.json']?.text)).toEqual({ sessionId: 'local_a', cliSessionId: 'cli-a', cwd: '/w', lastActivityAt: 100, startedFromEnvironmentId: null, remoteMcpServersConfig: { mine: 1 }, title: 'A' })
    expect(json(m.files['/t/local_w.json']?.text).originCwd).toBe('/w') // 資料夾看 originCwd
    expect(m.writes.sort()).toEqual(['/t/local_a.json', '/t/local_w.json'])
  })

  test('更新：來源比較新就覆寫，綁帳號的欄位留目標自己的；目標檔案比較新、或最後活動比較晚就不動；寫過一次就不再重寫', async () => {
    const m = memFs({
      '/s/local_a.json': { text: r('a', { title: '新', lastActivityAt: 200, bridgeSessionIds: ['s'], sshRemoteProcessId: 7, startedFromEnvironmentId: 'es', remoteMcpServersConfig: { s: 1 } }), mtime: 20 },
      '/t/local_a.json': { text: r('a', { title: '舊', lastActivityAt: 100, bridgeSessionIds: ['t'], sshRemoteProcessId: 9, startedFromEnvironmentId: 'et', remoteMcpServersConfig: { t: 1 } }), mtime: 10 },
      '/s/local_b.json': { text: r('b', { title: '這邊' }), mtime: 20 },
      '/t/local_b.json': { text: r('b', { title: '那邊後來改的' }), mtime: 30 },
      '/s/local_c.json': { text: r('c', { title: '這邊', lastActivityAt: 100 }), mtime: 20 },
      '/t/local_c.json': { text: r('c', { title: '那邊聊得比較晚', lastActivityAt: 300 }), mtime: 10 },
      '/s/local_d.json': { text: r('d', { title: '只有封存變了', isArchived: true }), mtime: 20 },
      '/t/local_d.json': { text: r('d', { title: '只有封存變了', isArchived: false, sshReattach: { pid: 3 } }), mtime: 10 },
    })
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH)).toEqual({ created: 0, updated: 2, deleted: 0 })
    expect(json(m.files['/t/local_a.json']?.text)).toEqual({
      sessionId: 'local_a',
      cliSessionId: 'cli-a',
      cwd: '/w',
      lastActivityAt: 200,
      title: '新',
      bridgeSessionIds: ['t'],
      sshRemoteProcessId: 9,
      startedFromEnvironmentId: 'et',
      remoteMcpServersConfig: { t: 1 },
    })
    expect(json(m.files['/t/local_b.json']?.text).title).toBe('那邊後來改的')
    expect(json(m.files['/t/local_c.json']?.text).title).toBe('那邊聊得比較晚')
    expect(json(m.files['/t/local_d.json']?.text)).toMatchObject({ isArchived: true, sshReattach: { pid: 3 } })
    expect(json(m.files['/t/archived-sessions.idx']?.text)).toEqual({ v: 1, archived: ['local_d'] })
    m.writes.length = 0
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH)).toEqual({ created: 0, updated: 0, deleted: 0 })
    expect(m.writes).toEqual([])
  })

  test('封存清單：加進封存的、拿掉取消封存的，其他的留著、照字母排；沒有清單又沒有封存的不建；看不懂的格式不動', async () => {
    const m = memFs({
      '/s/local_a.json': { text: r('a', { isArchived: true }), mtime: 20 },
      '/s/local_b.json': { text: r('b', { isArchived: false }), mtime: 20 },
      '/t/local_b.json': { text: r('b', { isArchived: true }), mtime: 10 },
      '/t/archived-sessions.idx': { text: JSON.stringify({ v: 1, archived: ['local_z', 'local_b'] }), mtime: 10 },
    })
    await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH)
    expect(json(m.files['/t/archived-sessions.idx']?.text)).toEqual({ v: 1, archived: ['local_a', 'local_z'] })

    const n = memFs({ '/s/local_a.json': { text: r('a'), mtime: 20 }, '/t/local_x.json': { text: r('x'), mtime: 1 } })
    await mirrorSessions(n.io, SPEC, '/s', '/t', '/', 'all', TRASH)
    expect(n.files['/t/archived-sessions.idx']).toBeUndefined()

    const odd = JSON.stringify({ v: 2, archived: ['local_q'] })
    const o = memFs({ '/s/local_a.json': { text: r('a', { isArchived: true }), mtime: 20 }, '/t/archived-sessions.idx': { text: odd, mtime: 1 } })
    await mirrorSessions(o.io, SPEC, '/s', '/t', '/', 'all', TRASH)
    expect(o.files['/t/archived-sessions.idx']?.text).toBe(odd)
  })

  test('刪除：這邊刪過、那邊還有 → 先備份、刪掉那邊的紀錄（連同 .tmp）、留同樣時間的刪除紀錄、拿出封存清單；再跑一次什麼都不做', async () => {
    const m = memFs({
      '/s/deleted_x': { text: '500', mtime: 9 },
      '/t/local_x.json': { text: r('x', { lastActivityAt: 400, isArchived: true }), mtime: 1 },
      '/t/local_x.json.tmp': { text: r('x'), mtime: 1 },
      '/t/archived-sessions.idx': { text: JSON.stringify({ v: 1, archived: ['local_x', 'local_y'] }), mtime: 1 },
      '/s/deleted_cli-only': { text: '500', mtime: 9 }, // 對話檔 id 的刪除紀錄：那邊沒有這個名字的紀錄，不動
    })
    const before = m.files['/t/local_x.json']?.text
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH)).toEqual({ created: 0, updated: 0, deleted: 1 })
    expect(m.files['/bk/sync-deleted/t/local_x.json']?.text).toBe(before)
    expect(m.removes).toEqual(['/t/local_x.json.tmp', '/t/local_x.json'])
    expect(m.files['/t/deleted_x']?.text).toBe('500')
    expect(json(m.files['/t/archived-sessions.idx']?.text)).toEqual({ v: 1, archived: ['local_y'] })
    expect(m.files['/t/deleted_cli-only']).toBeUndefined()
    m.writes.length = 0
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH)).toEqual({ created: 0, updated: 0, deleted: 0 })
    expect(m.writes).toEqual([])
  })

  test('不刪：刪掉之後又在那邊用過、不在同步範圍、這邊其實還有那筆、那邊已經刪過', async () => {
    const m = memFs({
      '/s/deleted_used': { text: '500', mtime: 9 },
      '/t/local_used.json': { text: r('used', { lastActivityAt: 600 }), mtime: 1 },
      '/s/deleted_out': { text: '500', mtime: 9 },
      '/t/local_out.json': { text: r('out', { cwd: '/other', lastActivityAt: 1 }), mtime: 1 },
      '/s/deleted_both': { text: '500', mtime: 9 },
      '/s/local_both.json': { text: r('both', { lastActivityAt: 1 }), mtime: 1 },
      '/t/local_both.json': { text: r('both', { lastActivityAt: 1 }), mtime: 5 },
      '/s/deleted_gone': { text: '500', mtime: 9 },
      '/t/deleted_gone': { text: '300', mtime: 1 },
    })
    expect((await mirrorSessions(m.io, SPEC, '/s', '/t', '/', ['/w'], TRASH)).deleted).toBe(0)
    expect(m.removes).toEqual([])
    expect([m.files['/t/local_used.json'], m.files['/t/local_out.json'], m.files['/t/local_both.json']].every(Boolean)).toBe(true)
    expect(m.files['/t/deleted_gone']?.text).toBe('300')
  })

  test('刪除紀錄的時間讀不懂就看檔案時間；刪不掉就整個停下來，不留刪除紀錄', async () => {
    const m = memFs({ '/s/deleted_x': { text: '??', mtime: 500 }, '/t/local_x.json': { text: r('x', { lastActivityAt: 400 }), mtime: 1 } })
    expect((await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH)).deleted).toBe(1)
    expect(m.files['/t/deleted_x']?.text).toBe('500')
    const f = memFs({ '/s/deleted_x': { text: '500', mtime: 9 }, '/t/local_x.json': { text: r('x', { lastActivityAt: 400 }), mtime: 1 } }, [], true)
    await expect(mirrorSessions(f.io, SPEC, '/s', '/t', '/', 'all', TRASH)).rejects.toThrow(/EBUSY/)
    expect(f.files['/t/local_x.json']).toBeDefined()
    expect(f.files['/t/deleted_x']).toBeUndefined()
  })

  test('備份寫不進去就不刪', async () => {
    const m = memFs({ '/s/deleted_x': { text: '500', mtime: 9 }, '/t/local_x.json': { text: r('x', { lastActivityAt: 400 }), mtime: 1 } })
    const write = m.io.write
    m.io.write = async (path, text) => {
      if (path.startsWith('/bk/')) throw new Error('EACCES')
      await write(path, text)
    }
    await expect(mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH)).rejects.toThrow(/EACCES/)
    expect(m.removes).toEqual([])
    expect(m.files['/t/local_x.json']).toBeDefined()
  })

  test('目標資料夾讀不到就整個失敗（不會寫到別的地方）', async () => {
    const m = memFs({ '/s/local_a.json': { text: r('a'), mtime: 20 } })
    await expect(mirrorSessions(m.io, SPEC, '/s', '/missing', '/', 'all', TRASH)).rejects.toThrow(/ENOENT/)
    expect(m.writes).toEqual([])
  })

  test('組織資料夾：指定的有就用；沒指定挑最近有寫入紀錄的；帳號沒有資料夾回 null', async () => {
    const m = memFs({
      '/root/acc/o1/local_a.json': { text: '{}', mtime: 50 },
      '/root/acc/o2/local_b.json': { text: '{}', mtime: 90 },
      '/root/acc/o2/archived-sessions.idx': { text: '{}', mtime: 10 },
    })
    expect(await orgDirOf(m.io, '/root', '/', 'acc', 'o1', SPEC)).toBe('o1')
    expect(await orgDirOf(m.io, '/root', '/', 'acc', 'nope', SPEC)).toBe('o2')
    expect(await orgDirOf(m.io, '/root', '/', 'acc', null, SPEC)).toBe('o2')
    expect(await orgDirOf(m.io, '/root', '/', 'ghost', null, SPEC)).toBe(null)
  })

  test('規則檔：讀 spec.json 的 sessions 段（含 BOM）；缺欄位或壞掉回 null', async () => {
    const text = `\uFEFF${JSON.stringify({ sessions: { ...SPEC, dir: 'claude-code-sessions' }, presets: {} })}`
    expect(parseSpec(text)).toEqual(SPEC)
    expect(parseSpec(JSON.stringify({ sessions: { ...SPEC, dropKeys: 'x' } }))).toBe(null)
    expect(parseSpec(JSON.stringify({ sessions: { ...SPEC, filePrefix: '' } }))).toBe(null)
    expect(parseSpec('{')).toBe(null)
  })
})

describe('同一個帳號的兩筆紀錄', () => {
  const tok = (over: Partial<BraidAccount> = {}) =>
    account('tok-1', { email: 'Me@Gmail.com', orgId: 'org-h', label: 'MiskaWu', color: '#8E6BD8', source: 'token', credential: 'file', credentialId: 'tok-1', ...over })

  test('認出來的帳號信箱和一個 braid 新增的帳號相同：併成一筆，憑證、名稱與顏色用新增時的，用量取新的', async () => {
    const desk = account('desk', { email: 'me@gmail.com', orgId: 'org-h', label: '個人', color: '#14A38E', usage: { fiveHour: { pct: 1, resetsAt: null }, sevenDay: null, at: 200 } })
    const t = tok({ usage: { fiveHour: { pct: 9, resetsAt: null }, sevenDay: null, at: 100 } })
    const got = absorbTokenTwin({ desk, 'tok-1': t }, desk)
    expect(got.absorbed).toBe('tok-1')
    expect(got.account).toMatchObject({ id: 'desk', label: 'MiskaWu', color: '#8E6BD8', credential: 'file', credentialId: 'tok-1', source: 'desktop' })
    expect(got.account.usage?.fiveHour?.pct).toBe(1)
  })

  test('使用者改過名的保留；信箱不同、兩筆都像、或自己就是 tok- 的都不併', async () => {
    const renamed = account('desk', { email: 'me@gmail.com', label: '我的', color: '#14A38E' })
    expect(absorbTokenTwin({ renamed, 'tok-1': tok() }, renamed).account).toMatchObject({ label: '我的', color: '#14A38E', credentialId: 'tok-1' })
    const other = account('desk', { email: 'you@gmail.com', label: '個人' })
    expect(absorbTokenTwin({ other, 'tok-1': tok() }, other).absorbed).toBe(null)
    const desk = account('desk', { email: 'me@gmail.com', label: '個人' })
    expect(absorbTokenTwin({ desk, 'tok-1': tok(), 'tok-2': tok({ id: 'tok-2' }) }, desk).absorbed).toBe(null)
    expect(absorbTokenTwin({ 'tok-1': tok(), 'tok-2': tok({ id: 'tok-2' }) }, tok({ id: 'tok-2' })).absorbed).toBe(null)
    expect(absorbTokenTwin({ 'tok-1': tok() }, account('desk', { email: null, label: '個人' })).absorbed).toBe(null)
  })
})

describe('備份保留', () => {
  test('整份備份：新到舊留最新幾份（同一秒的第二份算比較新），不像備份的名稱不碰；null 全部留著', async () => {
    const names = ['20261003-090000', 'before-auto-sync', '20261001-090000', '20261003-090000-2', '20261003-090000-10', '20261002-090000']
    // 同一秒的第 10 份比第 2 份新（照數字，不照字母）
    expect(extraToolBackups(names, 2)).toEqual(['20261003-090000', '20261002-090000', '20261001-090000'])
    expect(extraToolBackups(names, 10)).toEqual([])
    expect(extraToolBackups(names, null)).toEqual([])
  })

  test('同步刪掉的備份：超過幾天的才清；null 全部留著；讀不到時間的不清', async () => {
    const day = 86_400_000
    const files = [
      { path: 'a', mtimeMs: NOW - 31 * day },
      { path: 'b', mtimeMs: NOW - 29 * day },
      { path: 'c', mtimeMs: 0 },
    ]
    expect(expiredFiles(files, 30, NOW)).toEqual(['a'])
    expect(expiredFiles(files, null, NOW)).toEqual([])
  })

  test('設定：預設 30 天、5 份；null＝一直留著；壞值回預設', async () => {
    expect(normalizeKeep(undefined)).toEqual({ deletedDays: 30, toolCopies: 5 })
    expect(normalizeKeep({ deletedDays: null, toolCopies: 3 })).toEqual({ deletedDays: null, toolCopies: 3 })
    expect(normalizeKeep({ deletedDays: -1, toolCopies: 2.5 })).toEqual({ deletedDays: 30, toolCopies: 5 })
    expect([fmtBytes(7), fmtBytes(2048), fmtBytes(5 * 1024 * 1024)]).toEqual(['7 B', '2 KB', '5.0 MB'])
  })

  test('刪整份備份：只收備份名稱、路徑自己組；名稱不對就丟錯', async () => {
    expect(removeToolBackup('wsl', '/mnt/c/Users/u/braid-backups/', '20261001-090000')).toEqual(['rm', '-rf', '--', '/mnt/c/Users/u/braid-backups/20261001-090000'])
    expect(removeToolBackup('windows', 'C:\\Users\\u\\braid-backups', '20261001-090000-2')).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-Command',
      "Remove-Item -LiteralPath 'C:\\Users\\u\\braid-backups\\20261001-090000-2' -Recurse -Force -ErrorAction SilentlyContinue",
    ])
    for (const bad of ['..', '../x', 'sync-deleted', '20261001-090000/../..', '']) expect(() => removeToolBackup('wsl', '/b', bad)).toThrow(/不是備份資料夾/)
  })
})
