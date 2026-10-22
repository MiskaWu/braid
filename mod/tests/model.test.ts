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
  meter,
  expiredFiles,
  extraToolBackups,
  isNewer,
  fmtBytes,
  normalizeKeep,
  mirrorTarget,
  nameOf,
  normalizeAccount,
  normalizeFolder,
  normalizeMirror,
  normalizeSwitch,
  normalizeSync,
  migrateSources,
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
import { accountCard, backupTiles, fit, header, initial, ownerHero, rankRow, slotOf, switchHero, syncFlow, useIcon } from '../hooks/visual'
import { ANY, cleanFolder, draftGroups, normalizePolicy, projectOf, remoteKey, ruleFor, setRule, verdictFor } from '../hooks/policy'
import { isNewPage, pageQuestion, parseIndex, pendingTwin, projectSlug, titleOf, urlIn } from '../hooks/pages'
import { claudeInstall, claudeLookup, newCredentialId, newestFirst, planTerminal, removeFile, removeToolBackup, secretDelete, wrapperText } from '../hooks/terminal'

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
    expect(normalizeUses({ migrate: true, switch: 'yes' })).toEqual({ switch: false, sync: false, policy: false }) // 舊版的 migrate 不再是用法
    expect(normalizeSwitch(null)).toEqual(DEFAULT_SWITCH)
    // 舊版的資料夾限制（restrict／restricted）不再讀：資料夾歸屬改由歸屬表決定
    expect(normalizeSwitch({ on: false, fiveHour: 'x', sevenDay: null, order: ['a', 3], restrict: true, restricted: ['/a'] })).toEqual({
      on: false,
      fiveHour: 90,
      sevenDay: null,
      order: ['a'],
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
  test('順序：設定的在前，其餘照最近出現排', async () => {
    expect(orderedIds(ACCOUNTS, ['home'])).toEqual(['home', 'work', 'work2'])
    expect(orderedIds(ACCOUNTS, ['gone'])).toEqual(['work', 'work2', 'home'])
  })

  test('能換過去＝在桌面 app 登入過（不看憑證、不看歸屬）；還沒在 app 登入過的、也快用完的說明原因', async () => {
    const busy = { ...work2, usage: { fiveHour: { pct: 95, resetsAt: iso(NOW + H) }, sevenDay: null, at: NOW } }
    const list = candidates(
      { work, work2: busy, home, tok: account('tok', { source: 'token', credential: 'file', credentialId: 'tok', lastSeen: -1 }), login: account('login', { source: 'cli', lastSeen: -2 }) },
      'work',
      DEFAULT_SWITCH,
      NOW,
    )
    expect(list.map(c => [c.account.id, c.why])).toEqual([
      ['work2', 'busy'],
      ['home', 'ok'],
      ['tok', 'elsewhere'], // braid 新增的：有憑證也要先在桌面 app 登入
      ['login', 'elsewhere'], // 只在終端機 /login 的
    ])
  })
})

describe('輸入框上方的提示', () => {
  const live = (five: number, seven = 10) => ({ fiveHour: { pct: five, resetsAt: iso(NOW + 2 * H) }, sevenDay: { pct: seven, resetsAt: iso(NOW + 96 * H) }, at: NOW })
  const at = (pct: number, seven?: number, snooze: string | null = null, sw: BraidSwitch = DEFAULT_SWITCH) => bandFor(ACCOUNTS, 'work', live(pct, seven), sw, NOW, snooze)

  test('沒到門檻不出現；關掉也不出現', async () => {
    expect(at(89)).toBe(null)
    expect(at(95, 10, null, { ...DEFAULT_SWITCH, on: false })).toBe(null)
  })

  test('到門檻：快用完；建議順序裡第一個在桌面 app 登入過的帳號', async () => {
    const band = at(92)
    expect([band?.kind, band?.window, band?.pct, band?.next?.id]).toEqual(['warn', 'five_hour', 92, 'work2'])
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

  test('沒有能換的：給還沒在桌面 app 登入過的帳號（先登入它就能換）', async () => {
    const band = bandFor({ work, tok: account('tok', { source: 'token', credential: 'file', credentialId: 'tok' }) }, 'work', live(92), DEFAULT_SWITCH, NOW, null)
    expect([band?.next, band?.elsewhere?.id]).toEqual([null, 'tok'])
  })

  test('只剩個人帳號能換：照樣建議它——歸屬只管新頁，不管對話往哪個帳號走', async () => {
    const band = bandFor({ work, home }, 'work', live(100), DEFAULT_SWITCH, NOW, null)
    expect(band?.next?.id).toBe('home')
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
      { account: 'a', org: 'o1', sessions: 3, lastActivity: 1, folders: [{ path: '/x', sessions: 2, lastActivity: 1 }, { path: '/y', sessions: 1, lastActivity: 1 }], names: [], deleted: [] },
      { account: 'a', org: 'o2', sessions: 1, lastActivity: 1, folders: [{ path: '/x', sessions: 1, lastActivity: 1 }], names: [], deleted: [] },
      { account: 'b', org: 'o3', sessions: 5, lastActivity: 1, folders: [{ path: '/z', sessions: 5, lastActivity: 1 }], names: [], deleted: [] },
    ]
    expect(syncRows(profiles, 'a', 'b', ['/y']).map(r => [r.path, r.mine, r.theirs, r.checked])).toEqual([
      ['/y', 1, 0, true],
      ['/z', 0, 5, false],
      ['/x', 3, 0, false],
    ])
  })

  test('還沒搬過來的：目標沒有同名紀錄、也沒刪過的才算；同步夥伴不列；搬完的帳號不列；不知道目標是誰就不列', async () => {
    const prof = (account: string, names: string[], deleted: string[] = [], lastActivity = 1) => ({ account, org: `o-${account}`, sessions: names.length, lastActivity, folders: [], names, deleted })
    const profiles = [
      prof('new', ['local_1.json', 'local_a.json'], ['b']),
      prof('old', ['local_a.json', 'local_b.json', 'local_c.json', 'local_d.json'], [], 5),
      prof('done', ['local_a.json'], [], 9),
      prof('partner', ['local_p.json'], [], 7),
    ]
    expect(migrateSources(profiles, 'new', 'partner')).toEqual([{ account: 'old', org: 'o-old', pending: 2, lastActivity: 5 }]) // a 已經有、b 刪過
    expect(migrateSources(profiles, 'new', null).map(x => x.account)).toEqual(['partner', 'old']) // 最近用過的在前
    expect(migrateSources(profiles, null, null)).toEqual([])
    expect(migrateSources([prof('old', ['local_x.json'])], 'brand-new', null)).toEqual([{ account: 'old', org: 'o-old', pending: 1, lastActivity: 1 }]) // 目標還沒有資料夾
  })

  test('不認得的桌面帳號：組織正好對到一個 braid 新增的帳號就借它的名稱；認得 id 的同組織帳號不借、對到兩個也不借', async () => {
    const profiles = [{ account: 'desk-p', org: 'org-h', sessions: 1, lastActivity: 1, folders: [], names: [], deleted: [] }, { account: 'desk-w', org: 'org-w', sessions: 1, lastActivity: 1, folders: [], names: [], deleted: [] }]
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

describe('開新視窗跑帳號腳本（新增帳號）', () => {
  const add = { kind: 'add' as const, credentialId: 'tok-1', result: "/tmp/it's here.json", claude: '/opt/claude' }

  test('一次性的小腳本：先刪自己，參數用單引號寫死（單引號本身也跳脫）', async () => {
    expect(wrapperText('/r', add)).toBe("#!/bin/bash\nrm -f -- \"$0\"\nexec bash '/r/tool/cli/add-account.sh' 'tok-1' '/tmp/it'\\''s here.json' '/opt/claude'\n")
  })

  test('WSL：寫小腳本，交給 open-wsl.sh 開 Windows 視窗', async () => {
    expect(planTerminal('wsl', '/r', add, '/tmp/')).toEqual({
      steps: [{ write: { path: '/tmp/braid-add-tok-1.sh', text: wrapperText('/r', add) } }, { run: ['bash', '/r/tool/cli/open-wsl.sh', '/tmp/braid-add-tok-1.sh'] }],
      manual: null,
    })
  })

  test('Linux：開不了視窗時給一行指令', async () => {
    const plan = planTerminal('other', '/r', { ...add, credentialId: 'tok-2' }, '/tmp')
    expect('steps' in plan && plan.manual).toBe("bash '/tmp/braid-add-tok-2.sh'")
  })

  test('macOS：.command 檔，加執行權限再用 Terminal 開', async () => {
    const plan = planTerminal('mac', '/r', add, '/var/T/')
    expect('steps' in plan && plan.steps.slice(1)).toEqual([{ run: ['chmod', '+x', '/var/T/braid-add-tok-1.command'] }, { run: ['open', '-a', 'Terminal', '/var/T/braid-add-tok-1.command'] }])
  })

  test('Windows：參數放環境變數（中文不經過命令列），開 PowerShell 視窗跑 add-account.ps1', async () => {
    const plan = planTerminal('windows', 'C:/plug', { ...add, result: 'C:\\T\\中文.json' }, 'C:\\T')
    expect('steps' in plan && plan.steps).toEqual([
      {
        run: [
          'powershell.exe',
          '-NoProfile',
          '-Command',
          "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"C:\\plug\\tool\\windows\\add-account.ps1\"'",
        ],
        env: { BRAID_ACCOUNT: 'tok-1', BRAID_RESULT: 'C:\\T\\中文.json', BRAID_CLAUDE: '/opt/claude' },
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

describe('找 claude 執行檔', () => {
  test('Windows：跑這個對話的那支 → PATH（exe 先於 npm 的 cmd）→ 原生安裝 → npm → 桌面 app 自帶的', async () => {
    const roaming = 'C:\\Users\\u\\AppData\\Roaming'
    expect(claudeLookup('windows', { execPath: 'C:\\A\\claude.exe', path: 'C:\\Windows;"C:\\npm dir\\";;', home: 'C:\\Users\\u', appData: roaming })).toEqual({
      files: [
        'C:\\A\\claude.exe',
        'C:\\Windows\\claude.exe',
        'C:\\Windows\\claude.cmd',
        'C:\\npm dir\\claude.exe',
        'C:\\npm dir\\claude.cmd',
        'C:\\Users\\u\\.local\\bin\\claude.exe',
        `${roaming}\\npm\\claude.cmd`,
      ],
      bundles: [{ dir: `${roaming}\\Claude\\claude-code`, exe: 'claude.exe' }],
    })
  })

  test('WSL：PATH 裡 /mnt/ 底下的是 Windows 的 claude，不算；桌面 app 開的對話用的在 ccd-cli', async () => {
    const where = claudeLookup('wsl', { path: '/usr/bin:/mnt/c/Users/u/AppData/Roaming/npm:/home/u/.local/bin', home: '/home/u' })
    expect(where.files).toEqual(['/usr/bin/claude', '/home/u/.local/bin/claude', '/home/u/.claude/local/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
    expect(where.bundles).toEqual([{ dir: '/home/u/.claude/remote/ccd-cli', exe: null }])
  })

  test('npm 安裝時 CLAUDE_CODE_EXECPATH 是 node：不拿來跑 claude 的指令', async () => {
    expect(claudeLookup('other', { execPath: '/usr/local/bin/node', home: '/h' }).files[0]).toBe('/h/.local/bin/claude')
    expect(claudeLookup('windows', { execPath: 'C:\\nodejs\\NODE.EXE' }).files).toEqual([])
  })

  test('macOS：桌面 app 自帶的在 Application Support', async () => {
    expect(claudeLookup('mac', { home: '/Users/u' }).bundles[0]).toEqual({ dir: '/Users/u/Library/Application Support/Claude/claude-code', exe: 'claude' })
  })

  test('版本資料夾由新到舊：看數字不看字串（2.1.299 比 2.1.30 新），不像版本的排最後', async () => {
    expect(newestFirst(['2.1.30', 'junk', '2.1.299-686c67ec1014', '2.1.293', '10.0.0'])).toEqual(['10.0.0', '2.1.299-686c67ec1014', '2.1.293', '2.1.30', 'junk'])
  })

  test('真的沒裝：給官方安裝程式的那一行', async () => {
    expect(claudeInstall('windows')).toEqual({ shell: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' })
    expect(claudeInstall('wsl').command).toBe('curl -fsSL https://claude.ai/install.sh | bash')
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
  // 目標帳號還沒被 app 登入；測試可以改成某次寫入之後就被登入
  const app = { activeAfterWrites: Infinity }
  const io: MirrorIo = {
    stillInactive: async () => writes.length < app.activeAfterWrites,
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
  return { io, files, writes, removes, app }
}

const r = (id: string, over: Record<string, unknown> = {}) => JSON.stringify({ sessionId: `local_${id}`, cliSessionId: `cli-${id}`, cwd: '/w', lastActivityAt: 100, ...over })
const json = (text: string | undefined) => JSON.parse(text ?? 'null') as Record<string, unknown>

describe('新頁被歸屬擋下時問的選項', () => {
  const me = { id: 'p', label: '個人' }
  const work = { id: 'w', label: '公司' }
  const base = { title: '週報', name: 'acme', me, others: [] as { id: string; label: string }[], canPublish: true }

  test('第一個選項一律是「先排著」：不發布、不改歸屬表（人不在時選擇框自己帶過也不會替使用者決定）', async () => {
    const cases = [
      pageQuestion({ ...base, owner: work }),
      pageQuestion({ ...base, owner: work, canPublish: false }),
      pageQuestion({ ...base, owner: null, others: [work] }),
      pageQuestion({ ...base, owner: null, others: [work], canPublish: false }),
      pageQuestion({ ...base, owner: null }),
    ]
    for (const q of cases) {
      expect(q.choices[0]?.action).toEqual({ kind: 'queue' })
      expect(q.choices.at(-1)?.action).toEqual({ kind: 'skip' })
      expect(q.choices.length).toBeGreaterThanOrEqual(2)
      expect(q.choices.length).toBeLessThanOrEqual(4)
      expect(q.question.endsWith('？')).toBe(true)
      expect(q.header.length).toBeLessThanOrEqual(12)
    }
  })

  test('歸別的帳號：排著、用這個帳號發布（寫清楚不能轉移）、不發；不能發布的視窗沒有發布', async () => {
    const q = pageQuestion({ ...base, owner: work })
    expect(q.choices.map(c => [c.label, c.action.kind])).toEqual([['排進待發布', 'queue'], ['用「個人」發布', 'publish'], ['這次不發', 'skip']])
    expect(q.question).toMatch(/頁面會歸「個人」，之後不能轉移/)
    expect(pageQuestion({ ...base, owner: work, canPublish: false }).choices.map(c => c.action.kind)).toEqual(['queue', 'skip'])
  })

  test('還沒設定：先排著、歸自己並發布、歸另一邊的第一個帳號先排著、不發；不能發布的視窗歸自己也只是排著', async () => {
    const q = pageQuestion({ ...base, owner: null, others: [work, { id: 'x', label: '第三' }] })
    expect(q.choices.map(c => [c.label, c.action])).toEqual([
      ['先排著，之後再決定', { kind: 'queue' }],
      ['歸「個人」並發布', { kind: 'own', owner: 'p', publish: true }],
      ['歸「公司」，先排著', { kind: 'own', owner: 'w', publish: false }],
      ['這次不發', { kind: 'skip' }],
    ])
    expect(pageQuestion({ ...base, owner: null, canPublish: false }).choices[1]).toEqual({ label: '歸「個人」，先排著', action: { kind: 'own', owner: 'p', publish: false } })
  })

  test('同一張頁的重送：同專案、同標題、還在排的那筆', async () => {
    const page = (id: string, project: string, title: string, status: 'pending' | 'published') => ({ id, title, project, source: null, input: {}, owner: null, by: null, status, url: null, at: 0 })
    const index = { v: 1 as const, pages: [page('a', '/p', '週報', 'published'), page('b', '/p', '週報', 'pending'), page('c', '/q', '週報', 'pending')] }
    expect(pendingTwin(index, '/p', '週報')?.id).toBe('b')
    expect(pendingTwin(index, '/p', '月報')).toBeUndefined()
  })
})

describe('自動同步：複製側欄紀錄', () => {
  test('換帳號後方向反過來：同步自己寫過去、app 沒動過的複本不寫回去；app 改過的照常帶回來', async () => {
    const m = memFs({
      '/a/local_x.json': { text: r('x', { title: 'X' }), mtime: 10 },
      '/a/local_y.json': { text: r('y'), mtime: 10 },
      '/b/local_z.json': { text: r('z'), mtime: 5 },
    })
    const memory = {}
    expect(await mirrorSessions(m.io, SPEC, '/a', '/b', '/', 'all', TRASH, memory)).toEqual({ created: 2, updated: 0, deleted: 0 })
    // 換成 b：x、y 是剛複製過去的，修改時間比 a 的新，沒有記憶的話會被當成新的變更整批寫回 a
    const before = m.writes.length
    expect(await mirrorSessions(m.io, SPEC, '/b', '/a', '/', 'all', TRASH, memory)).toEqual({ created: 1, updated: 0, deleted: 0 })
    expect(m.writes.slice(before)).toEqual(['/a/local_z.json']) // 只有 b 自己的那筆
    // 在 b 用過 x（app 改了它）：照常帶回 a
    m.files['/b/local_x.json'] = { text: r('x', { title: 'X 在 b 改過', lastActivityAt: 200 }), mtime: 5_000 }
    expect(await mirrorSessions(m.io, SPEC, '/b', '/a', '/', 'all', TRASH, memory)).toEqual({ created: 0, updated: 1, deleted: 0 })
    expect(json(m.files['/a/local_x.json']?.text).title).toBe('X 在 b 改過')
    // 換回 a：剛寫回 a 的 x 也是複本，不再寫去 b
    expect(await mirrorSessions(m.io, SPEC, '/a', '/b', '/', 'all', TRASH, memory)).toEqual({ created: 0, updated: 0, deleted: 0 })
  })

  test('遷移工具「還原」拿掉的紀錄：另一邊的複本沒動過就不帶回來，在那邊用過才帶回來', async () => {
    const m = memFs({ '/a/local_mig.json': { text: r('mig'), mtime: 10 }, '/b/local_z.json': { text: r('z'), mtime: 5 } }, ['/a', '/b'])
    const memory = {}
    await mirrorSessions(m.io, SPEC, '/a', '/b', '/', 'all', TRASH, memory)
    delete m.files['/a/local_mig.json'] // 還原：只拿掉那次搬進來的，不留刪除紀錄
    await mirrorSessions(m.io, SPEC, '/b', '/a', '/', 'all', TRASH, memory)
    expect(m.files['/a/local_mig.json']).toBeUndefined()
    m.files['/b/local_mig.json'] = { text: r('mig', { lastActivityAt: 300 }), mtime: 9_000 } // 在 b 接著用了
    await mirrorSessions(m.io, SPEC, '/b', '/a', '/', 'all', TRASH, memory)
    expect(m.files['/a/local_mig.json']).toBeDefined()
  })

  test('目標帳號中途被 app 登入：在那一筆之前停下，後面的新增、刪除、封存清單都不寫', async () => {
    const m = memFs({
      '/s/local_a.json': { text: r('a'), mtime: 10 },
      '/s/local_b.json': { text: r('b', { isArchived: true }), mtime: 10 },
      '/s/local_c.json': { text: r('c'), mtime: 10 },
      '/s/deleted_x': { text: '500', mtime: 10 },
      '/t/local_x.json': { text: r('x'), mtime: 1 },
    })
    m.app.activeAfterWrites = 0 // 一開始就被登入了：連刪除的備份都不寫
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})).toEqual({ created: 0, updated: 0, deleted: 0, stopped: true })
    expect([m.writes, m.removes]).toEqual([[], []])
    const n = memFs({ '/s/local_a.json': { text: r('a'), mtime: 10 }, '/s/local_b.json': { text: r('b', { isArchived: true }), mtime: 10 }, '/s/local_c.json': { text: r('c'), mtime: 10 }, '/t/local_z.json': { text: r('z'), mtime: 1 } })
    n.app.activeAfterWrites = 1 // 寫完第一筆就換過去了
    expect(await mirrorSessions(n.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})).toEqual({ created: 1, updated: 0, deleted: 0, stopped: true })
    expect(n.writes).toEqual(['/t/local_a.json']) // 封存清單也沒寫
  })

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
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', ['/w'], TRASH, {})).toEqual({ created: 2, updated: 0, deleted: 0 })
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
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})).toEqual({ created: 0, updated: 2, deleted: 0 })
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
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})).toEqual({ created: 0, updated: 0, deleted: 0 })
    expect(m.writes).toEqual([])
  })

  test('封存清單：加進封存的、拿掉取消封存的，其他的留著、照字母排；沒有清單又沒有封存的不建；看不懂的格式不動', async () => {
    const m = memFs({
      '/s/local_a.json': { text: r('a', { isArchived: true }), mtime: 20 },
      '/s/local_b.json': { text: r('b', { isArchived: false }), mtime: 20 },
      '/t/local_b.json': { text: r('b', { isArchived: true }), mtime: 10 },
      '/t/archived-sessions.idx': { text: JSON.stringify({ v: 1, archived: ['local_z', 'local_b'] }), mtime: 10 },
    })
    await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})
    expect(json(m.files['/t/archived-sessions.idx']?.text)).toEqual({ v: 1, archived: ['local_a', 'local_z'] })

    const n = memFs({ '/s/local_a.json': { text: r('a'), mtime: 20 }, '/t/local_x.json': { text: r('x'), mtime: 1 } })
    await mirrorSessions(n.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})
    expect(n.files['/t/archived-sessions.idx']).toBeUndefined()

    const odd = JSON.stringify({ v: 2, archived: ['local_q'] })
    const o = memFs({ '/s/local_a.json': { text: r('a', { isArchived: true }), mtime: 20 }, '/t/archived-sessions.idx': { text: odd, mtime: 1 } })
    await mirrorSessions(o.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})
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
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})).toEqual({ created: 0, updated: 0, deleted: 1 })
    expect(m.files['/bk/sync-deleted/t/local_x.json']?.text).toBe(before)
    expect(m.removes).toEqual(['/t/local_x.json.tmp', '/t/local_x.json'])
    expect(m.files['/t/deleted_x']?.text).toBe('500')
    expect(json(m.files['/t/archived-sessions.idx']?.text)).toEqual({ v: 1, archived: ['local_y'] })
    expect(m.files['/t/deleted_cli-only']).toBeUndefined()
    m.writes.length = 0
    expect(await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})).toEqual({ created: 0, updated: 0, deleted: 0 })
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
    expect((await mirrorSessions(m.io, SPEC, '/s', '/t', '/', ['/w'], TRASH, {})).deleted).toBe(0)
    expect(m.removes).toEqual([])
    expect([m.files['/t/local_used.json'], m.files['/t/local_out.json'], m.files['/t/local_both.json']].every(Boolean)).toBe(true)
    expect(m.files['/t/deleted_gone']?.text).toBe('300')
  })

  test('刪除紀錄的時間讀不懂就看檔案時間；刪不掉就整個停下來，不留刪除紀錄', async () => {
    const m = memFs({ '/s/deleted_x': { text: '??', mtime: 500 }, '/t/local_x.json': { text: r('x', { lastActivityAt: 400 }), mtime: 1 } })
    expect((await mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})).deleted).toBe(1)
    expect(m.files['/t/deleted_x']?.text).toBe('500')
    const f = memFs({ '/s/deleted_x': { text: '500', mtime: 9 }, '/t/local_x.json': { text: r('x', { lastActivityAt: 400 }), mtime: 1 } }, [], true)
    await expect(mirrorSessions(f.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})).rejects.toThrow(/EBUSY/)
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
    await expect(mirrorSessions(m.io, SPEC, '/s', '/t', '/', 'all', TRASH, {})).rejects.toThrow(/EACCES/)
    expect(m.removes).toEqual([])
    expect(m.files['/t/local_x.json']).toBeDefined()
  })

  test('目標資料夾讀不到就整個失敗（不會寫到別的地方）', async () => {
    const m = memFs({ '/s/local_a.json': { text: r('a'), mtime: 20 } })
    await expect(mirrorSessions(m.io, SPEC, '/s', '/missing', '/', 'all', TRASH, {})).rejects.toThrow(/ENOENT/)
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

describe('桌面版的圖', () => {
  const card = (over: Partial<Parameters<typeof accountCard>[0]> = {}) =>
    accountCard({
      label: 'A&B <x>',
      color: '#2a78d6',
      tags: ['這個對話'],
      sub: 'me@x.example',
      windows: [
        { label: '5 小時', pct: 92, reset: '16:00 重置' },
        { label: '7 天', pct: 100, reset: '明天 09:00 重置' },
      ],
      staleness: null,
      thresholds: [90, 95],
      note: { tone: 'good', text: '在桌面 app 換成它就能用' },
      empty: '還沒有用量紀錄',
      ...over,
    })

  test('使用者取的名稱照字面畫（跳脫 < & " 這類字元），不會變成 SVG 標記', async () => {
    const c = card()
    expect(c.source).toContain('A&amp;B &lt;x&gt;')
    expect(c.source).not.toContain('<x>')
    expect(c.alt).toMatch(/^A&B <x>（這個對話）/) // 說明文字給人讀，不跳脫
  })

  test('到門檻換警告色、用完換危險色，都附圖示；平常是帳號色（跟著主題換的 class）', async () => {
    const c = card().source
    expect(c).toContain('fill="#fab219"') // 92% ≥ 90：警告
    expect(c).toContain('fill="#d03b3b"') // 100%：用完
    expect(card({ windows: [{ label: '5 小時', pct: 30, reset: null }] }).source).toMatch(/class="c0"/)
    expect(c).toContain('prefers-color-scheme: dark')
  })

  test('大小在上限內；長名稱與長說明截斷；頭像取第一個字', async () => {
    const long = card({ label: '一個非常非常非常非常非常非常長的帳號名稱', sub: 'x'.repeat(200) })
    expect(long.source.length).toBeLessThan(131072)
    expect(long.source).toContain('…')
    expect(fit('abc', 12, 1000)).toBe('abc')
    expect([initial('miskawu'), initial('公司'), initial('  ')]).toEqual(['M', '公', '?'])
    expect([slotOf('#2A78D6'), slotOf('#3987e5'), slotOf('#123456')]).toEqual([0, 0, null])
  })

  test('同步卡：同步中光點一開始就在流動（不會停在左上角）；說明文字是給看不到圖的人的一句話', async () => {
    const f = syncFlow({
      tone: 'on',
      title: '自動同步中',
      summary: '自動同步中：從「公司」複製到「個人」',
      from: { label: '公司', color: '#2a78d6', caption: 'app 登入中' },
      to: { label: '個人', color: '#eb6834', caption: '換過去就看得到' },
      chips: ['剛剛', '新增 1'],
      lines: [],
    })
    expect(f.alt).toBe('自動同步中：從「公司」複製到「個人」')
    expect(f.source).toContain('animateMotion')
    expect(f.source).not.toMatch(/begin="[1-9]/) // 延後出發的光點會先停在原點
  })

  test('版本比大小：照數字，不照字母；讀不懂的不算新', async () => {
    expect([isNewer('0.3.10', '0.3.9'), isNewer('0.4.0', '0.3.4'), isNewer('0.3.4', '0.3.4'), isNewer('0.3.3', '0.3.4'), isNewer('1.0', '0.9.9')]).toEqual([true, true, false, false, true])
    expect([isNewer(null, '0.3.4'), isNewer('beta', '0.3.4'), isNewer('0.4.0', null)]).toEqual([false, false, false])
  })
})

describe('歸屬表', () => {
  // 分得出公司或個人的帳號：公司信箱、個人信箱
  const work = account('work', { orgId: 'org-w', label: '公司', email: 'me@corp.example' })
  const work2 = account('work2', { orgId: 'org-w', label: '公司 2', email: 'me2@corp.example' })
  const home = account('home', { orgId: 'org-h', label: '個人', email: 'me@gmail.com' })
  const policy = normalizePolicy({
    rules: [
      { folder: '/p/acme/', owner: 'work' },
      { folder: '/p/acme/sandbox', owner: 'home' },
      { folder: 'C:\\code', owner: ANY },
      { folder: '', owner: 'x' },
      { folder: '/p/bad' },
    ],
  })

  test('讀回：去掉結尾斜線、壞的略過；同一個資料夾只留最後一條', async () => {
    expect(policy.rules).toEqual([
      { folder: '/p/acme', owner: 'work' },
      { folder: '/p/acme/sandbox', owner: 'home' },
      { folder: 'C:\\code', owner: ANY },
    ])
    expect(setRule(policy, '/p/acme/', 'home').rules.filter(r => r.folder === '/p/acme')).toEqual([{ folder: '/p/acme', owner: 'home' }])
    expect([cleanFolder('/'), cleanFolder('C:\\'), cleanFolder(' /a/b// ')]).toEqual(['/', 'C:\\', '/a/b'])
  })

  test('含子資料夾、取最具體的；worktree 跟著它的專案；開頭相同但不是子資料夾的不算；Windows 路徑也行', async () => {
    expect(ruleFor(policy, '/p/acme/server/api')?.owner).toBe('work')
    expect(ruleFor(policy, '/p/acme/sandbox/x')?.owner).toBe('home')
    expect(ruleFor(policy, '/p/acme/.claude/worktrees/feat-x/src')?.owner).toBe('work')
    expect(projectOf('/p/braid/.claude/worktrees/fix-1')).toBe('/p/braid')
    expect(ruleFor(policy, '/p/acme-old')).toBe(null)
    expect(ruleFor(policy, 'C:\\code\\app')?.owner).toBe(ANY)
  })

  test('新頁歸誰：對得上、歸別的帳號（公司專案用個人帳號、反過來）；不分；還沒設定；歸屬帳號被移除', async () => {
    const accounts = { work, work2, home }
    const p = { rules: [{ folder: '/w', owner: 'work' }, { folder: '/me', owner: 'home' }, { folder: '/any', owner: ANY }, { folder: '/gone', owner: 'x' }] }
    expect(verdictFor(p, accounts, work, '/w/a').kind).toBe('ok')
    expect(verdictFor(p, accounts, work2, '/w/a').kind).toBe('ok') // 同組織的第二個帳號也算公司
    expect(verdictFor(p, accounts, home, '/w/a')).toMatchObject({ kind: 'mismatch', owner: { id: 'work' } })
    expect(verdictFor(p, accounts, work, '/me/blog')).toMatchObject({ kind: 'mismatch', owner: { id: 'home' } })
    expect(verdictFor(p, accounts, home, '/me/blog').kind).toBe('ok')
    expect(verdictFor(p, accounts, home, '/any/x').kind).toBe('any')
    expect(verdictFor(p, accounts, home, '/other')).toEqual({ kind: 'unset', project: '/other' })
    expect(verdictFor(p, accounts, home, '/gone/x').kind).toBe('lost')
  })

  test('git 遠端：取主機與擁有者；工作區看底下 repo 最多的；沒有遠端的另成一組放最後', async () => {
    expect([remoteKey('git@github.com:Me/braid.git'), remoteKey('https://gitlab.example.com/team/x.git'), remoteKey('ssh://git@host:2222/grp/x.git'), remoteKey('nope'), remoteKey(null)]).toEqual([
      'github.com/me',
      'gitlab.example.com/team',
      'host/grp',
      null,
      null,
    ])
    const groups = draftGroups([
      { folder: '/p/a', remote: 'git@github.com:me/a.git', inner: [] },
      { folder: '/p/b', remote: 'git@github.com:me/b.git', inner: [] },
      { folder: '/p/ws', remote: null, inner: ['git@corp.example:team/x.git', 'git@corp.example:team/y.git', 'git@gitlab.com:other/z.git'] },
      { folder: '/p/notes', remote: null, inner: [] },
    ])
    expect(groups).toEqual([
      { key: 'github.com/me', folders: ['/p/a', '/p/b'] },
      { key: 'corp.example/team', folders: ['/p/ws'] },
      { key: null, folders: ['/p/notes'] },
    ])
  })
})

describe('頁面清單', () => {
  test('什麼算新頁：沒帶網址的發布、從類型新建；更新、讀、列清單、上傳素材都不算', async () => {
    expect([isNewPage({ file_path: 'a.html' }), isNewPage({ action: 'publish', type_url: 't' }), isNewPage({ file_path: 'a.html', url: 'u' }), isNewPage({ action: 'read', url: 'u' }), isNewPage({ action: 'list' }), isNewPage({ url: 'u', asset: true, file_path: 'x.png' })]).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ])
  })

  test('讀回清單：壞掉的檔是空清單、缺欄位的略過；網址、標題、資料夾名稱', async () => {
    expect(parseIndex('{壞').pages).toEqual([])
    expect(parseIndex(JSON.stringify({ pages: [{ id: 'a', project: '/p', status: 'weird' }, { id: 'b' }] })).pages.map(p => [p.id, p.status, p.title])).toEqual([['a', 'pending', '（沒有標題）']])
    expect(urlIn('Published: https://claude.ai/code/artifact/abc-123 (private)')).toBe('https://claude.ai/code/artifact/abc-123')
    expect(urlIn('no url')).toBe(null)
    expect([titleOf({ title: 'T' }, null), titleOf({ file_path: '/x/report.html' }, '<title> 報告 </title>'), titleOf({ file_path: '/x/report.html' }, null)]).toEqual(['T', '報告', 'report'])
    expect([projectSlug('/home/me/projects/acme'), projectSlug('C:\\work\\my app'), projectSlug('/')]).toEqual(['acme', 'my-app', 'project'])
  })
})

describe('桌面版的圖（第二批）', () => {
  const bad = 'A&B <x>'
  test('頁首、切換總覽、名次列、歸屬總覽：名稱照字面畫（跳脫）、說明文字完整、大小在上限內', async () => {
    const parts = [
      header({ account: { label: bad, color: '#2a78d6' }, windows: [{ label: '5 小時', pct: 27, reset: null }, { label: '7 天', pct: 100, reset: null }], thresholds: [90, 95] }),
      switchHero({ account: { label: bad, color: '#2a78d6' }, windows: [{ label: '5 小時', pct: 92, reset: null }], thresholds: [90], next: { label: bad, color: '#eb6834', note: '可以換過去' } }),
      rankRow({ rank: 2, label: bad, color: '#eb6834', status: { tone: 'good', text: '可以換過去' } }),
      ownerHero({ project: bad, owner: { label: bad, color: '#2a78d6' }, me: { label: '個人', color: '#e87ba4' }, state: 'mismatch' }),
    ]
    for (const p of parts) {
      expect(p.source).toContain('A&amp;B &lt;x&gt;')
      expect(p.source).not.toContain('<x>')
      expect(p.source.length).toBeLessThan(131072)
      expect(p.alt).toContain(bad)
    }
    expect(parts[0]?.alt).toBe('braid；目前：A&B <x>；5 小時 27%，7 天 100%')
    expect(parts[0]?.source).toContain('fill="#d03b3b"') // 7 天用完：危險色
    expect(parts[1]?.alt).toMatch(/5 小時 92%（90% 提醒）；下一個可以換的：A&B <x>/)
    expect(parts[2]?.alt).toBe('2. A&B <x>：可以換過去')
    expect(parts[3]?.alt).toBe('A&B <x> → A&B <x>；新頁先排著，等歸屬帳號發布（這個對話是「個人」）')
    expect(ownerHero({ project: 'p', owner: null, me: { label: '個人', color: '#e87ba4' }, state: 'unset' }).alt).toBe('p → 還沒設定；這個對話是「個人」')
    expect(switchHero({ account: { label: 'a', color: '#2a78d6' }, windows: [], thresholds: [], next: null }).alt).toMatch(/下一個可以換的：沒有/)
  })

  test('備份的兩格統計：筆數、大小、留多久都在說明文字裡', async () => {
    const t = backupTiles({ trash: { count: 5, size: '262 KB', keep: '留 30 天' }, tool: { count: 1, keep: '留最新 5 份' } })
    expect(t.alt).toBe('同步刪掉的對話：5 筆、262 KB，留 30 天；整份備份：1 份，留最新 5 份')
    expect(t.source).toContain('>5<')
    expect(t.source.length).toBeLessThan(131072)
  })

  test('用法插圖：三種都有，說明文字給看不到圖的人', async () => {
    for (const k of ['switch', 'sync', 'policy'] as const) {
      const i = useIcon(k)
      expect(i.source.startsWith('<svg')).toBe(true)
      expect(i.alt).toMatch(/的圖示$/)
    }
  })
})
