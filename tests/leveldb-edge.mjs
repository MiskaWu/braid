// LevelDB 追加寫入的邊界情況：日誌卡在區塊尾、單筆跨多個區塊。用真正的 LevelDB 讀回驗證。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { openDb, copyDir, check, eq, finish } from './lib.mjs'
const CDM = createRequire(import.meta.url)('../mod/tool/macos/core.js')
const impls = process.argv.slice(2).length ? process.argv.slice(2) : ['ps', 'js']
const fsIo = {
  join: (...p) => path.join(...p), readText: (p) => fs.readFileSync(p, 'utf8'), readBytes: (p) => new Uint8Array(fs.readFileSync(p)),
  appendBytes: (p, b) => fs.appendFileSync(p, b), fileSize: (p) => fs.statSync(p).size, exists: (p) => fs.existsSync(p), listDir: (p) => fs.readdirSync(p),
}

// Windows 路徑只在測 PowerShell 版時才找：CI（Ubuntu）沒有 wslpath 與 cmd.exe
const toWin = (p) => execFileSync('wslpath', ['-w', p]).toString().trim()
const winTemp = !impls.includes('ps') ? null : execFileSync('wslpath', ['-u', execFileSync('cmd.exe', ['/c', 'echo %TEMP%'], { cwd: '/mnt/c' }).toString().trim()]).toString().trim()
const ps1 = !impls.includes('ps') ? null : toWin(path.resolve('append.ps1'))
const BLOCK = 32768

async function scenario(impl, label, fillTo, valueLen) {
  label = `[${impl}] ${label}`
  const local = `/tmp/cdm-edge-${process.pid}`
  const win = impl === 'ps' ? path.join(winTemp, `cdm-edge-${process.pid}`) : null
  fs.rmSync(local, { recursive: true, force: true })
  let db = openDb(local, true)
  await db.open()
  await db.put(Buffer.from('old'), Buffer.from('keep-me'))
  if (fillTo !== null) {
    // 先量目前日誌長度，再用一筆剛好的寫入把它推到指定位置
    const log = () => fs.readdirSync(local).filter((f) => f.endsWith('.log')).map((f) => path.join(local, f))[0]
    const now = fs.statSync(log()).size
    const want = fillTo - (now % BLOCK) + (fillTo < now % BLOCK ? BLOCK : 0)
    const vlen = want - 7 - 12 - 1 - 1 - 1 - 3          // 標頭 7、批次頭 12、tag 1、鍵長 1、鍵 1、值長 3
    await db.put(Buffer.from('f'), Buffer.alloc(vlen, 0x61))
    check(fs.statSync(log()).size % BLOCK === fillTo, `${label}：日誌停在區塊內位置 ${fillTo}（剩 ${BLOCK - fillTo} 位元組）`)
  }
  await db.close()
  const value = Buffer.alloc(valueLen)
  for (let i = 0; i < valueLen; i++) value[i] = (i * 31) & 0xff
  if (impl === 'ps') {
    copyDir(local, win)
    fs.writeFileSync(path.join(win, 'k.bin'), 'probe-key')
    fs.writeFileSync(path.join(win, 'v.bin'), value)
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, toWin(win), toWin(path.join(win, 'k.bin')), toWin(path.join(win, 'v.bin'))]).toString().trim()
    check(/found=1/.test(out), `${label}：自己的讀取器讀得到剛寫的那筆（${out}）`)
    fs.rmSync(path.join(win, 'k.bin')); fs.rmSync(path.join(win, 'v.bin'))
    copyDir(win, local)
    fs.rmSync(win, { recursive: true, force: true })
  } else {
    const seq = CDM.leveldb.append(fsIo, local, new Uint8Array(Buffer.from('probe-key')), new Uint8Array(value))
    const st = CDM.leveldb.read(fsIo, local, 'probe')
    check(Object.keys(st.entries).length === 1 && st.maxSeq === seq, `${label}：自己的讀取器讀得到剛寫的那筆（seq=${seq}）`)
  }
  db = openDb(local)
  await db.open()
  const got = await db.get(Buffer.from('probe-key'))
  check(got !== undefined && Buffer.compare(got, value) === 0, `${label}：LevelDB 重播日誌後值完全相同（${valueLen} 位元組）`)
  eq((await db.get(Buffer.from('old'))).toString(), 'keep-me', `${label}：原有資料還在`)
  await db.put(Buffer.from('after'), Buffer.from('ok'))   // 之後 LevelDB 還能正常寫
  await db.close()
  fs.rmSync(local, { recursive: true, force: true })
}

// 日誌尾端寫到一半（app 開著時讀到的樣子）：試跑讀到那裡為止；要寫入時拒絕
async function tailScenario(impl) {
  const label = `[${impl}] 日誌尾端寫到一半`
  const local = `/tmp/cdm-tail-${process.pid}`
  fs.rmSync(local, { recursive: true, force: true })
  const db = openDb(local, true)
  await db.open()
  await db.put(Buffer.from('old'), Buffer.from('keep-me'))
  await db.close()
  const log = fs.readdirSync(local).filter((f) => f.endsWith('.log')).map((f) => path.join(local, f))[0]
  fs.appendFileSync(log, Buffer.from([1, 2, 3, 4, 100, 0, 1, 9, 9, 9]))   // 標頭說長 100，只寫了 3 個位元組
  if (impl === 'ps') {
    const win = path.join(winTemp, `cdm-tail-${process.pid}`)
    copyDir(local, win)
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, toWin(win), 'x', 'x', '-Mode', 'tail']).toString()
    eq(out.trim().split(/\r?\n/), ['tolerant-ok found=1', 'strict-refused', 'append-refused'], `${label}：試跑照讀、嚴格讀與寫入都拒絕`)
    fs.rmSync(win, { recursive: true, force: true })
  } else {
    let tolerant = 'tolerant-failed'
    try { tolerant = `tolerant-ok found=${Object.keys(CDM.leveldb.read(fsIo, local, 'old', true).entries).length}` } catch {}
    let strict = 'strict-ok'
    try { CDM.leveldb.read(fsIo, local, 'old', false) } catch { strict = 'strict-refused' }
    let append = 'append-ok'
    try { CDM.leveldb.append(fsIo, local, new Uint8Array([1, 2]), new Uint8Array([3])) } catch { append = 'append-refused' }
    eq([tolerant, strict, append], ['tolerant-ok found=1', 'strict-refused', 'append-refused'], `${label}：試跑照讀、嚴格讀與寫入都拒絕`)
  }
  fs.rmSync(local, { recursive: true, force: true })
}

// app 開著時檔案被以「允許別人讀寫」開著（Windows 才有這種鎖）：要讀得到，寫入要被拒絕
async function heldScenario() {
  const local = `/tmp/cdm-held-${process.pid}`, win = path.join(winTemp, `cdm-held-${process.pid}`)
  fs.rmSync(local, { recursive: true, force: true })
  const db = openDb(local, true)
  await db.open()
  await db.put(Buffer.from('old'), Buffer.from('keep-me'))
  await db.close()
  copyDir(local, win)
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, toWin(win), 'x', 'x', '-Mode', 'held']).toString()
  eq(out.trim().split(/\r?\n/), ['read-ok found=1', 'append-refused'], '[ps] 另一個程式開著檔案在寫：讀得到、寫入被拒絕')
  fs.rmSync(win, { recursive: true, force: true }); fs.rmSync(local, { recursive: true, force: true })
}

for (const impl of impls) {
  await tailScenario(impl)
  if (impl === 'ps') await heldScenario()
  await scenario(impl, '一般', null, 3000)
  await scenario(impl, '剩 3 位元組要補零', BLOCK - 3, 3000)
  await scenario(impl, '剩剛好 7 位元組', BLOCK - 7, 3000)
  await scenario(impl, '剩 8 位元組', BLOCK - 8, 3000)
  await scenario(impl, '單筆 70KB 跨三個區塊', null, 70000)
  await scenario(impl, '卡區塊尾又跨區塊', BLOCK - 5, 40000)
}
finish()
