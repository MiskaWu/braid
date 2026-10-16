// 讀桌面 app 的側欄資料（只讀）：每個帳號、組織底下有哪些對話，依資料夾彙總；還有遷移工具留下的備份。
// 遷移頁與同步頁用它顯示「有什麼可以搬」。寫入一律交給 tool/ 裡的工具，它會等 app 結束、先備份。
// 引擎不准把 $ 傳過 import，所以這裡收一組讀檔、執行指令的函式（register.tsx 用 $ 組好），環境變數由它先讀好。
import type { FsEntry } from 'claude-code'

import type { BraidBackup, BraidDesktop, BraidFolder, BraidPlatform, BraidProfile } from '../types'

export type DesktopIo = {
  list: (path: string) => Promise<readonly FsEntry[]>
  read: (path: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
  run: (argv: string[], cwd?: string) => Promise<{ exitCode: number; stdout: string }>
}

/** 會用到的環境變數：macOS 的 HOME、Windows 的 APPDATA 與 USERPROFILE。 */
export type DesktopEnv = { home?: string; appData?: string; userProfile?: string }

/** Windows 的資料夾位置（%APPDATA% 這類）。在 WSL 裡問 cmd.exe，回兩種寫法：工具要的 Windows 路徑、這邊讀檔用的路徑。 */
async function windowsDir(io: DesktopIo, env: DesktopEnv, name: 'APPDATA' | 'USERPROFILE', platform: BraidPlatform): Promise<{ win: string; local: string } | null> {
  if (platform === 'windows') {
    const v = name === 'APPDATA' ? env.appData : env.userProfile
    return v ? { win: v, local: v } : null
  }
  if (platform !== 'wsl') return null
  try {
    const echo = await io.run(['cmd.exe', '/c', `echo %${name}%`], '/mnt/c')
    const win = echo.stdout.trim()
    if (echo.exitCode !== 0 || !win || win.includes('%')) return null
    const conv = await io.run(['wslpath', '-u', win])
    const local = conv.stdout.trim()
    return conv.exitCode === 0 && local ? { win, local } : null
  } catch {
    return null
  }
}

export type DesktopPaths = { appData: string; backups: { local: string; win: string; sep: string } }

/** 桌面 app 的資料夾與備份資料夾；這個平台沒有桌面 app 就是 null。 */
export async function desktopPaths(io: DesktopIo, env: DesktopEnv, platform: BraidPlatform): Promise<DesktopPaths | null> {
  if (platform === 'mac') {
    const home = env.home
    if (!home) return null
    return { appData: `${home}/Library/Application Support/Claude`, backups: { local: `${home}/braid-backups`, win: `${home}/braid-backups`, sep: '/' } }
  }
  const appData = await windowsDir(io, env, 'APPDATA', platform)
  const profile = await windowsDir(io, env, 'USERPROFILE', platform)
  if (!appData || !profile) return null
  const sep = platform === 'windows' ? '\\' : '/'
  return {
    appData: `${appData.local}${sep}Claude`,
    backups: { local: `${profile.local}${sep}braid-backups`, win: `${profile.win}\\braid-backups`, sep },
  }
}

async function list(io: DesktopIo, dir: string) {
  try {
    return await io.list(dir)
  } catch {
    return []
  }
}

/** 讀一個帳號、組織資料夾裡的側欄紀錄，依資料夾彙總（資料夾＝originCwd，沒有就 cwd，和遷移工具一樣）。 */
async function readProfile(io: DesktopIo, dir: string, sep: string, account: string, org: string): Promise<BraidProfile> {
  const byFolder = new Map<string, BraidFolder>()
  let sessions = 0
  let lastActivity = 0
  for (const f of await list(io, dir)) {
    if (f.kind !== 'file' || !/^local_.+\.json$/.test(f.name)) continue
    let data: { cwd?: unknown; originCwd?: unknown; lastActivityAt?: unknown }
    try {
      data = JSON.parse(await io.read(`${dir}${sep}${f.name}`)) as typeof data
    } catch {
      continue
    }
    const path = typeof data.originCwd === 'string' && data.originCwd ? data.originCwd : typeof data.cwd === 'string' ? data.cwd : ''
    if (!path) continue
    const at = typeof data.lastActivityAt === 'number' ? data.lastActivityAt : 0
    const folder = byFolder.get(path) ?? { path, sessions: 0, lastActivity: 0 }
    folder.sessions++
    folder.lastActivity = Math.max(folder.lastActivity, at)
    byFolder.set(path, folder)
    sessions++
    lastActivity = Math.max(lastActivity, at)
  }
  const folders = [...byFolder.values()].sort((a, b) => b.lastActivity - a.lastActivity)
  return { account, org, sessions, lastActivity, folders }
}

export async function scanDesktop(io: DesktopIo, env: DesktopEnv, platform: BraidPlatform): Promise<BraidDesktop> {
  const paths = await desktopPaths(io, env, platform)
  if (!paths) return { profiles: [], backups: [], error: platform === 'other' ? 'no-desktop' : 'no-paths' }
  const sep = platform === 'windows' ? '\\' : '/'
  const root = `${paths.appData}${sep}claude-code-sessions`
  const profiles: BraidProfile[] = []
  for (const a of await list(io, root)) {
    if (a.kind !== 'dir') continue
    for (const o of await list(io, `${root}${sep}${a.name}`)) {
      if (o.kind !== 'dir') continue
      const p = await readProfile(io, `${root}${sep}${a.name}${sep}${o.name}`, sep, a.name, o.name)
      if (p.sessions > 0) profiles.push(p)
    }
  }
  const backups: BraidBackup[] = []
  for (const b of await list(io, paths.backups.local)) {
    if (b.kind !== 'dir' || !/^\d{8}-\d{6}(-\d+)?$/.test(b.name)) continue
    if (!(await io.exists(`${paths.backups.local}${paths.backups.sep}${b.name}${paths.backups.sep}manifest.json`))) continue
    const toolSep = platform === 'mac' ? '/' : '\\'
    backups.push({ name: b.name, dir: `${paths.backups.win}${toolSep}${b.name}` })
  }
  backups.sort((x, y) => y.name.localeCompare(x.name))
  return { profiles: profiles.sort((x, y) => y.lastActivity - x.lastActivity), backups, error: null }
}

/** 備份資料夾名稱 20261016-140211 → 10/16 14:02。 */
export function backupLabel(name: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(name)
  return m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}` : name
}
