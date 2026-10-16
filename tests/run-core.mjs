// 測試用：在 Node 上跑 macOS 版的核心（macos/core.js），檔案介面換成 fs。
// 參數與 macOS 版相同：--dry-run --yes --from X --restore DIR --app-data-root --claude-home --backup-root --plan-json --projects --presets
// 環境變數 BRAID_TEST_PICKS 代替勾選視窗（例如「2,4,6;1」）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const CDM = require('../mod/tool/macos/core.js')
const spec = JSON.parse(fs.readFileSync(new URL('../mod/tool/spec.json', import.meta.url), 'utf8'))

const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const opts = {
  spec, dryRun: args.includes('--dry-run'), yes: args.includes('--yes'), from: opt('--from'),
  appDataRoot: opt('--app-data-root'), claudeHome: opt('--claude-home'), backupRoot: opt('--backup-root'),
  planJson: opt('--plan-json'), skipAppCheck: true, noRelaunch: true,
  projects: opt('--projects'), presets: opt('--presets'),
  testPicks: process.env.BRAID_TEST_PICKS ? process.env.BRAID_TEST_PICKS.split(';') : null,
}
const io = {
  interactive: false,
  say: (m) => console.log(m),
  readLine: () => '',
  join: (...p) => path.join(...p),
  readText: (p) => fs.readFileSync(p, 'utf8'),
  writeText: (p, s) => { fs.writeFileSync(p + '.migrating', s); fs.renameSync(p + '.migrating', p) },
  readBytes: (p) => new Uint8Array(fs.readFileSync(p)),
  appendBytes: (p, b) => fs.appendFileSync(p, b),
  fileSize: (p) => fs.statSync(p).size,
  exists: (p) => fs.existsSync(p),
  isDir: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
  listDir: (p) => fs.readdirSync(p),
  mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  copyTree: (s, d) => fs.cpSync(s, d, { recursive: true }),
  removeTree: (p) => fs.rmSync(p, { recursive: true, force: true }),
  timestamp: () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15),
  isAppRunning: () => false, quitApp: () => {}, launchApp: () => {}, sleep: () => {},
  wslRoot: () => '',          // 測試在 WSL 裡跑，假的 WSL 對話紀錄就在本機路徑
  restoreCommand: (d) => `node run-core.mjs --restore "${d}"`,
}
process.exit(opt('--restore') ? CDM.restore(io, opts, opt('--restore')) : CDM.migrate(io, opts))
