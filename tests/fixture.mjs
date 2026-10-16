// 造一份假的桌面 app 資料，涵蓋遷移會遇到的各種情況。
// 用法：node fixture.mjs <輸出根目錄> <WSL 端對話紀錄目錄>
//   <輸出根目錄>/app          假的 %APPDATA%\Claude
//   <輸出根目錄>/claude-home  假的 %USERPROFILE%\.claude
import fs from 'node:fs'
import path from 'node:path'
import { openDb, lsKey, encodeValue, writeJson, PREFIX } from './lib.mjs'

const [root, wslDir] = process.argv.slice(2)
if (!root || !wslDir) { console.error('用法：node fixture.mjs <輸出根目錄> <WSL 端對話紀錄目錄>'); process.exit(2) }

export const S = '11111111-1111-4111-8111-111111111111', SO = '11111111-1111-4111-8111-1111111111aa'
export const T = '22222222-2222-4222-8222-222222222222', TO = '22222222-2222-4222-8222-2222222222aa'
export const U = '33333333-3333-4333-8333-333333333333', UO = '33333333-3333-4333-8333-3333333333aa'
const uuid = (c) => `aaaaaaaa-0000-4000-8000-00000000000${c}`
const cli = (c) => `cccccccc-0000-4000-8000-00000000000${c}`

const DISTRO = process.env.WSL_DISTRO_NAME || 'dev'   // 跑測試這台的 WSL 發行版，對話紀錄要從這裡找得到
const app = path.join(root, 'app')
const home = path.join(root, 'claude-home')
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(wslDir, { recursive: true, force: true })

let clock = 1792000000000
function session(c, o = {}) {
  const e = {
    sessionId: `local_${uuid(c)}`,
    cliSessionId: cli(c),
    cwd: o.cwd ?? `/p/${c}`,
    originCwd: o.cwd ?? `/p/${c}`,
    createdAt: clock,
    lastActivityAt: (clock += 1000),
    model: 'claude-opus-5-5',
    isArchived: false,
    title: o.title ?? `session ${c}`,
    permissionMode: 'auto',
    wslConfig: o.wsl ? { distro: o.wsl } : null,
    sshRemoteProcessId: 'proc-' + c,
    remoteMcpServersConfig: [{ uuid: 'old-connector', name: 'Slack', tools: [{ name: 't', inputSchema: { type: 'object' } }] }],
    enabledMcpTools: {},
    promptAppendSnapshot: { append: 'x', toolSets: [1, 2], nested: { deep: { deeper: [{ a: 1.5 }] } } },
    alwaysAllowedReasons: [],
    completedTurns: 3,
    bridgeSessionIds: ['bridge-1'],
    sshReattach: { pid: 1 },
    scheduledTaskId: 'sched-1',
    priorRemoteCliSessionIds: ['prior-1'],
    startedFromEnvironmentId: 'env-1',
  }
  if (o.transcript) e.sshRemoteTranscriptPath = o.transcript
  if (o.drop) for (const k of o.drop) delete e[k]
  return e
}
const put = (acct, org, e) => writeJson(path.join(app, 'claude-code-sessions', acct, org, `${e.sessionId}.json`), e)
const transcript = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{"type":"user"}\n') }

// ---- 來源帳號 S ----
transcript(path.join(home, 'projects', 'C--p', cli('a') + '.jsonl'))
put(S, SO, session('a', { title: `測試 'quote' <tag> & amp "雙引號"` }))           // 複製；欄位要清掉
put(S, SO, session('b'))                                                          // 對話紀錄不見 → 略過
transcript(path.join(home, 'projects', 'C--p', cli('c') + '.jsonl'))
put(S, SO, session('c'))                                                          // 複製＋封存
put(S, SO, session('d'))                                                          // 目標已有 → 略過
put(S, SO, session('e'))                                                          // 目標刪除過 → 略過
transcript(path.join(wslDir, 'projects', 'p', cli('f') + '.jsonl'))
put(S, SO, session('f', { wsl: DISTRO, transcript: path.join(wslDir, 'projects', 'p', cli('f') + '.jsonl') })) // WSL，在 → 複製
put(S, SO, session('g', { wsl: DISTRO, transcript: path.join(wslDir, 'projects', 'p', cli('g') + '.jsonl') })) // WSL，不在 → 略過
put(S, SO, session('h', { drop: ['cwd'] }))                                       // 格式不符 → 略過
put(S, SO, session('i', { transcript: '/home/remote/.claude/projects/x/' + cli('i') + '.jsonl' })) // SSH 遠端 → 問、預設複製
fs.writeFileSync(path.join(app, 'claude-code-sessions', S, SO, 'local_broken.json'), '{not json')
writeJson(path.join(app, 'claude-code-sessions', S, SO, 'archived-sessions.idx'), { v: 1, archived: [`local_${uuid('c')}`, 'local_zzz'] })

// ---- 目標帳號 T（目前登入）----
put(T, TO, session('d'))
fs.writeFileSync(path.join(app, 'claude-code-sessions', T, TO, `deleted_${uuid('e')}`), '1791875818446')
const t = session('t')
t.remoteMcpServersConfig = [{ uuid: 'new-connector', name: 'Claude Docs' }]
put(T, TO, t)

// ---- 第三個帳號 U：讓「多個舊帳號」的選擇路徑也跑到 ----
put(U, UO, session('u'))

writeJson(path.join(app, 'config.json'), { locale: 'zh-TW', lastKnownAccountUuid: T })

// ---- 已儲存的環境 ----
const preset = (id, name, cwd, settings) => ({ id, name, target: { kind: 'local', cwd, wslDistro: 'dev' }, ...(settings && { settings }), createdAt: 1, lastUsedAt: 2 })
const sState = {
  state: {
    presets: [
      preset('p-garden', 'garden', '/p/garden', { worktree: true }),
      preset('p-notebook', 'notebook', '/p/notebook'),
      preset('p-zh', '中文環境', '/p/中文'),
      preset('p-atlas-old', 'atlas', '/p/atlas'),
    ],
    builtIns: {}, seededFromDraft: true,
    // /p/a 是兩個選擇情境都會選的專案、/p/i 永遠不選：用來驗「資料夾設定只跟著選到的走」
    placeDefaults: { 'local:dev:/p/garden': { modelId: 'm', effort: 'xhigh' }, 'local:dev:/p/atlas': { modelId: 'OLD' }, 'local:dev:/p/a': { modelId: 'A' }, 'local:dev:/p/i': { modelId: 'I' } },
    fileMirrored: true, seededFromHistory: 2,
    startedFrom: ['p-garden', 'x1'],
    startedPlaces: [{ id: 'sp1', target: { kind: 'local', cwd: '/p/garden', wslDistro: 'dev' }, at: 5 }, { id: 'sp2', target: { kind: 'local', cwd: '/p/atlas', wslDistro: 'dev' }, at: 6 }],
  },
  version: 4,
}
const tStateOld = { state: { presets: [preset('p-stale', 'stale', '/p/stale')], builtIns: {} }, version: 4 }
const tState = {
  state: {
    presets: [preset('p-atlas-new', 'atlas', '/p/atlas', { worktree: true })],
    builtIns: {}, seededFromDraft: true,
    placeDefaults: { 'local:dev:/p/atlas': { modelId: 'NEW' } },
    fileMirrored: true, seededFromHistory: 2,
    startedFrom: ['p-atlas-new', 'x1'],
    startedPlaces: [{ id: 'sp9', target: { kind: 'local', cwd: '/p/atlas', wslDistro: 'dev' }, at: 9 }],
  },
  version: 4,
}
const empty = { state: { presets: [], builtIns: {}, placeDefaults: {}, roamingUnsentAt: null }, version: 4 }

writeJson(path.join(app, 'ccd-session-presets.json'), {
  byAccount: {
    [S]: { presets: sState.state.presets, builtIns: {}, seededFromDraft: true },
    [T]: { presets: tState.state.presets, builtIns: {}, seededFromDraft: true },
  },
})

const lsDir = path.join(app, 'Local Storage', 'leveldb')
fs.mkdirSync(lsDir, { recursive: true })
const db = openDb(lsDir, true)
await db.open()
const filler = (i) => [lsKey('filler-' + String(i).padStart(4, '0')), encodeValue('v'.repeat(150 + (i % 50)))]
for (let i = 0; i < 400; i++) await db.put(...filler(i))
await db.put(lsKey(PREFIX + S), encodeValue(JSON.stringify(sState)))
await db.put(lsKey(PREFIX + T), encodeValue(JSON.stringify(tStateOld)))     // 舊值進資料表
await db.put(lsKey(`${PREFIX}${S}.${SO}`), encodeValue(JSON.stringify(empty)))
await db.put(lsKey(`${PREFIX}${T}.${TO}`), encodeValue(JSON.stringify(empty)))
await db.put(lsKey(PREFIX + U), encodeValue(JSON.stringify({ state: { presets: [preset('p-u', 'u', '/p/u')] }, version: 5 })))
// app 記的目前登入：信箱給人看、帳號 ID 跟 config.json 交叉比對
await db.put(lsKey('lastLoginEmail'), encodeValue('tester@example.com'))
await db.put(lsKey('rq-cache-confirmed-account'), encodeValue(T))
await db.compactRange(Buffer.from([0]), Buffer.from([0xff, 0xff, 0xff]))  // 壓進 snappy 資料表
await db.put(lsKey(PREFIX + T), encodeValue(JSON.stringify(tState)))        // 新值只在日誌：讀的時候要取序號大的
for (let i = 400; i < 450; i++) await db.put(...filler(i))
await db.del(lsKey('filler-0001'))
await db.close()

console.log('fixture ready:', root)
