// 測試共用：用真正的 LevelDB 實作（classic-level）造資料與驗證，確認我們手寫的讀寫跟它相容。
import { ClassicLevel } from 'classic-level'
import fs from 'node:fs'
import path from 'node:path'

export const PREFIX = 'persisted.ccd-session-presets.'
export const ORIGIN = 'https://claude.ai'

export function lsKey(name, origin = ORIGIN) {
  return Buffer.concat([Buffer.from('_' + origin, 'latin1'), Buffer.from([0, 1]), Buffer.from(name, 'latin1')])
}

export function encodeValue(s) {
  return /^[\x00-\xff]*$/.test(s)
    ? Buffer.concat([Buffer.from([1]), Buffer.from(s, 'latin1')])
    : Buffer.concat([Buffer.from([0]), Buffer.from(s, 'utf16le')])
}

export function decodeValue(v) {
  if (v[0] === 1) return v.subarray(1).toString('latin1')
  if (v[0] === 0) return v.subarray(1).toString('utf16le')
  throw new Error('unknown value encoding ' + v[0])
}

export function openDb(dir, create = false) {
  return new ClassicLevel(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer', createIfMissing: create })
}

// 整個資料庫倒成 { keyHex: valueHex }，用來比對「除了目標鍵以外什麼都沒變」。
export async function dump(dir) {
  const db = openDb(dir)
  const out = {}
  for await (const [k, v] of db.iterator()) out[k.toString('hex')] = v.toString('hex')
  await db.close()
  return out
}

export async function readPresets(dir, name) {
  const db = openDb(dir)
  const v = await db.get(lsKey(name))
  await db.close()
  return v === undefined ? undefined : JSON.parse(decodeValue(v))
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj))
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true, filter: (p) => path.basename(p) !== 'LOCK' })
}

let failures = 0
export function check(cond, msg) {
  if (cond) console.log('  ok  ' + msg)
  else { console.log('  NG  ' + msg); failures++ }
}
export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  check(a === e, a === e ? msg : `${msg}\n        實際：${a}\n        預期：${e}`)
}
export function finish() {
  if (failures) { console.log(`\n${failures} 項失敗`); process.exit(1) }
  console.log('\n全部通過')
  process.exit(0)
}
