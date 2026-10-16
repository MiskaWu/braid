// macos/migrate.js 在 Node 上能驗的部分：語法、base64 編解碼。ObjC 橋接那層只能在 Mac 上試跑。
import fs from 'node:fs'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { check, finish } from './lib.mjs'
const src = fs.readFileSync(new URL('../mod/tool/macos/migrate.js', import.meta.url), 'utf8')
check(/^[\x00-\x7f]*$/.test(src), 'migrate.js 只用 ASCII（osascript 不一定用 UTF-8 讀）')
const ctx = { ObjC: { import() {} }, Uint8Array }
vm.createContext(ctx)
vm.runInContext(src, ctx)
check(typeof ctx.run === 'function', '語法正確，run() 存在')
let ok = true
for (const n of [0, 1, 2, 3, 4, 5, 255, 256, 257, 4096, 70001]) {
  const b = new Uint8Array(crypto.randomBytes(n))
  const enc = ctx.b64encode(b)
  if (enc !== Buffer.from(b).toString('base64')) { ok = false; console.log('    encode 不符', n) }
  const dec = ctx.b64decode(enc)
  if (Buffer.compare(Buffer.from(dec), Buffer.from(b)) !== 0) { ok = false; console.log('    decode 不符', n) }
}
check(ok, 'base64 編解碼與 Node 內建結果一致（0～70001 位元組）')
finish()
