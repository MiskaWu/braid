// 驗證遷移結果。用法：
//   node verify.mjs dryrun   <跑過的根目錄> <執行前的快照>
//   node verify.mjs apply    <跑過的根目錄> <執行前的快照>
//   node verify.mjs restored <跑過的根目錄> <執行前的快照>
//   node verify.mjs touch    <跑過的根目錄> <執行前的快照>   遷移後在新帳號用過 a、新開一段 n（給下一步的還原）
//   node verify.mjs undone   <跑過的根目錄> <執行前的快照>   還原只拿掉那次搬進來的（--projects /p/a,/p/c 搬的 a、c）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { dump, readPresets, readJson, writeJson, copyDir, check, eq, finish, PREFIX } from './lib.mjs'

const [mode, root, before] = process.argv.slice(2)
const S = '11111111-1111-4111-8111-111111111111', SO = '11111111-1111-4111-8111-1111111111aa'
const T = '22222222-2222-4222-8222-222222222222', TO = '22222222-2222-4222-8222-2222222222aa'
const uuid = (c) => `aaaaaaaa-0000-4000-8000-00000000000${c}`
const app = path.join(root, 'app'), app0 = path.join(before, 'app')
const tgt = (r) => path.join(r, 'claude-code-sessions', T, TO)
const src = (r) => path.join(r, 'claude-code-sessions', S, SO)

function treeHash(dir) {
  const out = {}
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n)
      if (fs.statSync(p).isDirectory()) walk(p)
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

// LevelDB 在 /mnt/c 上開鎖檔不穩，複製到本機暫存再開
// 結束時（不論通過與否）刪掉：finish() 用 process.exit，所以掛在 exit 上
const copies = []
process.on('exit', () => { for (const d of copies) fs.rmSync(d, { recursive: true, force: true }) })
function lsCopy(appDir, tag) {
  const d = path.join(os.tmpdir(), `cdm-verify-${tag}-${process.pid}`)
  copyDir(path.join(appDir, 'Local Storage', 'leveldb'), d)
  copies.push(d)
  return d
}

const lsBefore = await dump(lsCopy(app0, 'before'))

if (mode === 'dryrun') {
  console.log('== 試跑：什麼都不能改 ==')
  eq(treeHash(app), treeHash(app0), '整個 app 資料夾與執行前一致')
  finish()
}

if (mode === 'restored') {
  console.log('== 還原：回到遷移前 ==')
  eq(treeHash(tgt(app)), treeHash(tgt(app0)), '目標帳號 session 資料夾與遷移前一致')
  eq(readJson(path.join(app, 'ccd-session-presets.json')), readJson(path.join(app0, 'ccd-session-presets.json')), '環境清單檔與遷移前一致')
  eq(await dump(lsCopy(app, 'restored')), lsBefore, 'Local Storage 每個鍵都與遷移前一致')
  finish()
}

const rec = (c) => path.join(tgt(app), `local_${uuid(c)}.json`)
if (mode === 'touch') {
  const a = readJson(rec('a'))
  writeJson(rec('a'), { ...a, lastActivityAt: a.lastActivityAt + 1000, title: 'a 遷移後用過' })
  writeJson(rec('n'), { ...a, sessionId: `local_${uuid('n')}`, cliSessionId: 'new', title: '遷移後新開的' })
  process.exit(0)
}
if (mode === 'undone') {
  console.log('== 還原：只拿掉那次搬進來的 ==')
  eq(fs.readdirSync(tgt(app)).sort(), [`deleted_${uuid('e')}`, ...['a', 'd', 'n', 't'].map((c) => `local_${uuid(c)}.json`)].sort(),
    '拿掉沒用過的 c；遷移後用過的 a、之後新開的 n、原本的 d、t 與刪除紀錄留著')
  eq(readJson(rec('a')).title, 'a 遷移後用過', '用過的那筆是用過之後的內容')
  check(!fs.existsSync(path.join(tgt(app), 'archived-sessions.idx')), '封存清單回到備份時（備份時沒有，就拿掉）')
  eq(treeHash(src(app)), treeHash(src(app0)), '來源帳號一個檔都沒動')
  finish()
}

// 有選擇的兩個情境：只搬選到的，資料夾設定也只跟著選到的專案與環境走
async function checkSelection(label, exp) {
  console.log(`== ${label} ==`)
  const plan = readJson(path.join(root, 'plan.json'))
  const f = (c) => `local_${uuid(c)}.json`
  eq(plan.sessions.copy, exp.copy.map(f), '只複製選到的對話')
  eq(plan.sessions.skip.filter((s) => s.reason === 'not-selected').map((s) => s.file), exp.notSelected.map(f), '沒選到的列為「沒有勾選」')
  eq(plan.archived, exp.archived.map((c) => `local_${uuid(c)}`), '封存清單只補選到的')
  eq(plan.presets.map((p) => [p.scope, p.status, p.add, p.skip]), exp.presets, '環境只加選到的')
  eq(fs.readdirSync(tgt(app)).filter((n) => n.startsWith('local_')).sort(), [...exp.copy, 'd', 't'].map(f).sort(), '目標帳號的 session 檔')
  eq(treeHash(src(app)), treeHash(src(app0)), '來源帳號一個檔都沒動')
  const lsDir = lsCopy(app, label)
  const st = await readPresets(lsDir, PREFIX + T)
  eq(st.state.presets.map((p) => p.name), exp.presetNames, '目標環境')
  eq(st.state.placeDefaults, exp.placeDefaults, '資料夾預設值只補選到的資料夾')
  eq(st.state.startedPlaces.map((p) => p.id), exp.startedPlaces, '最近使用位置只補選到的資料夾')
  eq(st.state.startedFrom, exp.startedFrom, 'startedFrom 只帶跟著搬的')
  const after = await dump(lsDir)
  const changed = Object.keys({ ...after, ...lsBefore }).filter((k) => after[k] !== lsBefore[k])
  eq(changed.length, 1, 'Local Storage 只有目標帳號那一個鍵變了')
  eq(readJson(path.join(app, 'ccd-session-presets.json')).byAccount[T].presets.map((p) => p.name), exp.presetNames, '環境清單檔與正本一致')
  finish()
}
const ATLAS = { 'local:dev:/p/atlas': { modelId: 'NEW' } }
if (mode === 'selected') {   // --projects "/p/a,/p/c" --presets garden
  await checkSelection('依參數選擇', {
    copy: ['a', 'c'], notSelected: ['f', 'i'], archived: ['c'],
    presets: [['account', 'merge', ['garden'], ['atlas']], ['org', 'none', [], []]],
    presetNames: ['atlas', 'garden'],
    placeDefaults: { ...ATLAS, 'local:dev:/p/garden': { modelId: 'm', effort: 'xhigh' }, 'local:dev:/p/a': { modelId: 'A' } },
    startedPlaces: ['sp9', 'sp1'], startedFrom: ['p-atlas-new', 'x1', 'p-garden'],
  })
}
if (mode === 'folders') {    // --projects "/p/a,/p/garden" --presets folders：環境跟著資料夾走（同步用）
  await checkSelection('環境跟著資料夾走', {
    copy: ['a'], notSelected: ['c', 'f', 'i'], archived: [],
    presets: [['account', 'merge', ['garden'], ['atlas']], ['org', 'none', [], []]],
    presetNames: ['atlas', 'garden'],
    placeDefaults: { ...ATLAS, 'local:dev:/p/garden': { modelId: 'm', effort: 'xhigh' }, 'local:dev:/p/a': { modelId: 'A' } },
    startedPlaces: ['sp9', 'sp1'], startedFrom: ['p-atlas-new', 'x1', 'p-garden'],
  })
}
if (mode === 'picked') {     // BRAID_TEST_PICKS="2,4,6;1"：專案 f、a＋環境 notebook，展開後只留 f
  await checkSelection('勾選視窗（測試替身）', {
    copy: ['f'], notSelected: ['a', 'c', 'i'], archived: [],
    presets: [['account', 'merge', ['notebook'], ['atlas']], ['org', 'none', [], []]],
    presetNames: ['atlas', 'notebook'],
    placeDefaults: { ...ATLAS, 'local:dev:/p/a': { modelId: 'A' } },
    startedPlaces: ['sp9'], startedFrom: ['p-atlas-new', 'x1'],
  })
}

console.log('== 計畫 ==')
const plan = readJson(path.join(root, 'plan.json'))
eq(plan.source, { account: S, org: SO }, '來源帳號＝-From 指定的那個')
eq(plan.target, { account: T, org: TO, email: 'tester@example.com' }, '目標帳號＝config.json 記的目前帳號，附上 app 記的登入信箱')
eq(plan.sessions.copy, ['a', 'c', 'f', 'i'].map((c) => `local_${uuid(c)}.json`), '要複製的 session')
eq(plan.sessions.skip.map((s) => [s.file.slice(-6, -5), s.reason]),
  [['b', 'missing-transcript'], ['d', 'exists'], ['e', 'tombstone'], ['g', 'missing-transcript'], ['h', 'invalid']], '略過的 session 與原因')
eq(plan.archived, [`local_${uuid('c')}`], '封存清單只補目標會有的那筆')
eq(plan.presets.map((p) => [p.scope, p.status, p.add, p.skip]),
  [['account', 'merge', ['garden', 'notebook', '中文環境'], ['atlas']], ['org', 'none', [], []]], '環境：帳號層級合併、組織層級沒資料')

console.log('== 側欄 session ==')
const names = fs.readdirSync(tgt(app)).sort()
eq(names.filter((n) => n.startsWith('local_')),
  ['a', 'c', 'd', 'f', 'i', 't'].map((c) => `local_${uuid(c)}.json`).sort(), '目標帳號的 session 檔')
check(names.includes(`deleted_${uuid('e')}`), '刪除紀錄原封不動')
eq(treeHash(src(app)), treeHash(src(app0)), '來源帳號一個檔都沒動')
eq(fs.readFileSync(path.join(tgt(app), `local_${uuid('d')}.json`), 'utf8'),
  fs.readFileSync(path.join(tgt(app0), `local_${uuid('d')}.json`), 'utf8'), '目標已有的那筆沒被覆蓋')
const newMcp = readJson(path.join(tgt(app0), `local_${uuid('t')}.json`)).remoteMcpServersConfig
for (const c of ['a', 'c', 'f', 'i']) {
  const got = readJson(path.join(tgt(app), `local_${uuid(c)}.json`))
  const orig = readJson(path.join(src(app0), `local_${uuid(c)}.json`))
  const expect = { ...orig, startedFromEnvironmentId: null, remoteMcpServersConfig: newMcp }
  for (const k of ['bridgeSessionIds', 'sshReattach', 'sshRemoteProcessId', 'scheduledTaskId', 'priorRemoteCliSessionIds']) delete expect[k]
  eq(got, expect, `session ${c}：只動了規則裡的欄位，其餘逐欄相同`)
}
eq(readJson(path.join(tgt(app), 'archived-sessions.idx')), { v: 1, archived: [`local_${uuid('c')}`] }, '目標封存清單')

console.log('== 已儲存的環境（Local Storage）==')
const lsAfterDir = lsCopy(app, 'after')
const st = (await readPresets(lsAfterDir, PREFIX + T))
eq(st.version, 4, '版本號保留')
eq(st.state.presets.map((p) => p.name), ['atlas', 'garden', 'notebook', '中文環境'], '目標環境＝原有＋舊帳號補進來的')
eq(st.state.presets[0].settings, { worktree: true }, '同資料夾的 atlas 保留目標帳號那筆')
eq(st.state.placeDefaults, { 'local:dev:/p/atlas': { modelId: 'NEW' }, 'local:dev:/p/garden': { modelId: 'm', effort: 'xhigh' }, 'local:dev:/p/a': { modelId: 'A' }, 'local:dev:/p/i': { modelId: 'I' } }, '資料夾預設值：目標的優先、補上缺的')
eq(st.state.startedPlaces.map((p) => p.id), ['sp9', 'sp1'], '最近使用位置：補上目標沒有的資料夾')
eq(st.state.startedFrom, ['p-atlas-new', 'x1', 'p-garden'], 'startedFrom 取聯集')
const after = await dump(lsAfterDir)
const tKey = Buffer.concat([Buffer.from('_https://claude.ai', 'latin1'), Buffer.from([0, 1]), Buffer.from(PREFIX + T, 'latin1')]).toString('hex')
const changed = Object.keys({ ...after, ...lsBefore }).filter((k) => after[k] !== lsBefore[k])
eq(changed, [tKey], 'Local Storage 只有目標帳號那一個鍵變了')
check(after[tKey].startsWith('00'), '含中文的值用 UTF-16 編碼寫入')

console.log('== 環境清單檔（副本）==')
const mirror = readJson(path.join(app, 'ccd-session-presets.json'))
eq(mirror.byAccount[T].presets.map((p) => p.name), ['atlas', 'garden', 'notebook', '中文環境'], '副本與正本一致')
eq(mirror.byAccount[S], readJson(path.join(app0, 'ccd-session-presets.json')).byAccount[S], '舊帳號那份沒動')

console.log('== 備份 ==')
const backups = fs.readdirSync(path.join(root, 'backups'))
eq(backups.length, 1, '產生一份備份')
const b = path.join(root, 'backups', backups[0])
check(['manifest.json', 'sessions', 'leveldb', 'mirror.json'].every((n) => fs.existsSync(path.join(b, n))), '備份含 session、Local Storage、環境清單檔')
const manifest = readJson(path.join(b, 'manifest.json'))
eq(manifest.addedSessions, ['a', 'c', 'f', 'i'].map((c) => ({ file: `local_${uuid(c)}.json`, lastActivityAt: readJson(path.join(src(app0), `local_${uuid(c)}.json`)).lastActivityAt })),
  '備份記下這次寫進去的檔與當時的最後活動時間（還原只拿掉這些）')
eq(manifest.addedArchived, [`local_${uuid('c')}`], '備份記下這次補進封存清單的')
eq(treeHash(path.join(b, 'sessions')), treeHash(tgt(app0)), '備份的 session 是遷移前的樣子')
finish()
