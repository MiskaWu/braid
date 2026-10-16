// LevelDB 追加寫入的邊界情況：日誌卡在區塊尾、單筆跨多個區塊。用真正的 LevelDB 讀回驗證。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { openDb, copyDir, check, eq, finish } from './lib.mjs'
const CDM = createRequire(import.meta.url)('../macos/core.js')
const impls = process.argv.slice(2).length ? process.argv.slice(2) : ['ps', 'js']
const fsIo = {
  join: (...p) => path.join(...p), readText: (p) => fs.readFileSync(p, 'utf8'), readBytes: (p) => new Uint8Array(fs.readFileSync(p)),
  appendBytes: (p, b) => fs.appendFileSync(p, b), fileSize: (p) => fs.statSync(p).size, exists: (p) => fs.existsSync(p), listDir: (p) => fs.readdirSync(p),
}

const winTemp = !impls.includes('ps') ? null : execFileSync('wslpath', ['-u', execFileSync('cmd.exe', ['/c', 'echo %TEMP%'], { cwd: '/mnt/c' }).toString().trim()]).toString().trim()
const toWin = (p) => execFileSync('wslpath', ['-w', p]).toString().trim()
const ps1 = toWin(path.resolve('append.ps1'))
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

for (const impl of impls) {
  await scenario(impl, '一般', null, 3000)
  await scenario(impl, '剩 3 位元組要補零', BLOCK - 3, 3000)
  await scenario(impl, '剩剛好 7 位元組', BLOCK - 7, 3000)
  await scenario(impl, '剩 8 位元組', BLOCK - 8, 3000)
  await scenario(impl, '單筆 70KB 跨三個區塊', null, 70000)
  await scenario(impl, '卡區塊尾又跨區塊', BLOCK - 5, 40000)
}
finish()
