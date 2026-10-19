// 開一個新的終端機視窗跑 braid 的帳號腳本：用另一個帳號接著同一段對話（resume）、新增帳號（add）。
// 純函式：給平台、plugin 根目錄與工作，回要執行的動作。腳本本身在 tool/cli（bash）與 tool/windows（PowerShell）。
//
// 參數怎麼送進新視窗：
//   WSL、Linux、macOS：寫一個一次性的小腳本（第一行就刪掉自己），參數用單引號寫死在裡面，
//     開視窗的指令只帶這個腳本的路徑，不經過 Windows 或終端機程式的引號規則。
//   Windows：參數放在環境變數（中文路徑不經過命令列的編碼），新視窗繼承後由 PowerShell 腳本讀。
// 憑證從不經過這裡：腳本自己從鑰匙圈或認證管理員取。
import type { BraidPlatform } from '../types'
import { TOOL_BACKUP_NAME } from './model'

export type Job =
  | { kind: 'resume'; account: string; credentialId: string; session: string; cwd: string; claude: string; label: string }
  | { kind: 'add'; credentialId: string; result: string; claude: string }

export type Step = { run: string[]; env?: Record<string, string> } | { write: { path: string; text: string } }

/** manual：開不了視窗時（Linux 沒有圖形桌面，open-linux.sh 結束碼 3），請使用者自己執行的指令。 */
export type TerminalPlan = { steps: Step[]; manual: string | null } | { unsupported: true }

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`

function cliArgs(job: Job): { script: string; args: string[] } {
  return job.kind === 'resume'
    ? { script: 'resume.sh', args: [job.credentialId, job.session, job.cwd, job.claude, job.label, job.account] }
    : { script: 'add-account.sh', args: [job.credentialId, job.result, job.claude] }
}

/** 一次性的小腳本：先刪掉自己，再把參數交給真正的腳本。 */
export function wrapperText(root: string, job: Job): string {
  const { script, args } = cliArgs(job)
  return `#!/bin/bash\nrm -f -- "$0"\nexec bash ${[`${root}/tool/cli/${script}`, ...args].map(sq).join(' ')}\n`
}

export function planTerminal(platform: BraidPlatform, root: string, job: Job, tmpDir: string): TerminalPlan {
  const tmp = tmpDir.replace(/[\\/]+$/, '')
  const name = `braid-${job.kind}-${job.credentialId}`
  switch (platform) {
    case 'wsl': {
      const wrapper = `${tmp}/${name}.sh`
      return {
        steps: [{ write: { path: wrapper, text: wrapperText(root, job) } }, { run: ['bash', `${root}/tool/cli/open-wsl.sh`, wrapper] }],
        manual: null,
      }
    }
    case 'other': {
      const wrapper = `${tmp}/${name}.sh`
      return {
        steps: [{ write: { path: wrapper, text: wrapperText(root, job) } }, { run: ['bash', `${root}/tool/cli/open-linux.sh`, wrapper] }],
        manual: `bash ${sq(wrapper)}`,
      }
    }
    case 'mac': {
      const wrapper = `${tmp}/${name}.command`
      return {
        steps: [
          { write: { path: wrapper, text: wrapperText(root, job) } },
          { run: ['chmod', '+x', wrapper] },
          { run: ['open', '-a', 'Terminal', wrapper] },
        ],
        manual: null,
      }
    }
    case 'windows': {
      const dir = `${root.replace(/\//g, '\\')}\\tool\\windows`
      const script = job.kind === 'resume' ? 'resume.ps1' : 'add-account.ps1'
      const env: Record<string, string> =
        job.kind === 'resume'
          ? { BRAID_ACCOUNT: job.account, BRAID_CREDENTIAL: job.credentialId, BRAID_SESSION: job.session, BRAID_CWD: job.cwd, BRAID_CLAUDE: job.claude, BRAID_LABEL: job.label }
          : { BRAID_ACCOUNT: job.credentialId, BRAID_RESULT: job.result, BRAID_CLAUDE: job.claude }
      const list = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${dir}\\${script}"`].map(psq).join(',')
      return { steps: [{ run: ['powershell.exe', '-NoProfile', '-Command', `Start-Process -FilePath 'powershell.exe' -ArgumentList ${list}`], env }], manual: null }
    }
  }
}

/** 刪掉一個帳號的憑證（不開視窗，直接執行）。 */
export function secretDelete(platform: BraidPlatform, root: string, credentialId: string): string[] {
  if (platform === 'windows') {
    return ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${root.replace(/\//g, '\\')}\\tool\\windows\\secret.ps1`, 'delete', credentialId]
  }
  return ['bash', `${root}/tool/cli/secret.sh`, 'delete', credentialId]
}

/** 刪掉一個暫存檔（新增帳號的結果檔：面板讀完就不需要了）。 */
export function removeFile(platform: BraidPlatform, path: string): string[] {
  if (platform === 'windows') return ['powershell.exe', '-NoProfile', '-Command', `Remove-Item -LiteralPath ${psq(path)} -Force -ErrorAction SilentlyContinue`]
  return ['rm', '-f', '--', path]
}

/**
 * 刪掉一份遷移工具的整份備份（資料夾）。只收備份資料夾的名稱、路徑由這裡組，名稱不像備份就丟錯：
 * 遞迴刪除只會落在 <備份資料夾>/<時間> 這一層。
 */
export function removeToolBackup(platform: BraidPlatform, root: string, name: string): string[] {
  if (!TOOL_BACKUP_NAME.test(name)) throw new Error(`不是備份資料夾：${name}`)
  if (platform === 'windows') {
    return ['powershell.exe', '-NoProfile', '-Command', `Remove-Item -LiteralPath ${psq(`${root.replace(/[\\/]+$/, '')}\\${name}`)} -Recurse -Force -ErrorAction SilentlyContinue`]
  }
  return ['rm', '-rf', '--', `${root.replace(/\/+$/, '')}/${name}`]
}

/** 新增帳號時給憑證的 id：tok- 加 8 個十六進位字。 */
export function newCredentialId(random: () => number): string {
  let hex = ''
  for (let i = 0; i < 8; i++) hex += Math.floor(random() * 16).toString(16)
  return `tok-${hex}`
}

// ── 找 claude 執行檔 ─────────────────────────────────────────
// 新增帳號、接著做、面板內更新都要跑 claude。開出去的視窗不一定有使用者平常的 PATH
// （WSL 是 wsl.exe -e bash，不讀 .bashrc），所以一律交完整路徑。
// 只裝桌面 app 的電腦 PATH 上沒有 claude，但桌面 app 自己帶了一份，可以單獨執行。

/** 去哪裡找：files 依序試；bundles 是版本資料夾的上一層，新版先試。 */
export type ClaudeLookup = {
  files: string[]
  /** exe 是 null：版本那一項本身就是執行檔（WSL 的 ~/.claude/remote/ccd-cli/<版本>）；
   *  否則找 <版本>/<exe> 與再下一層的 <版本>/<任意>/<exe>（Windows 是 <版本>\<雜湊>\claude.exe）。 */
  bundles: { dir: string; exe: string | null }[]
}

export type ClaudeHints = {
  /** CLAUDE_CODE_EXECPATH：跑這個對話的 claude；npm 安裝時是 node，不能拿來用 */
  execPath?: string
  path?: string
  /** macOS、Linux 的 HOME；Windows 的 USERPROFILE */
  home?: string
  /** Windows 的 APPDATA */
  appData?: string
}

export function claudeLookup(platform: BraidPlatform, hints: ClaudeHints): ClaudeLookup {
  const win = platform === 'windows'
  const sep = win ? '\\' : '/'
  const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
  const files: string[] = []
  const exec = hints.execPath?.trim()
  if (exec && !/^(node|bun|deno)(\.exe)?$/i.test(exec.split(/[\\/]/).pop() ?? '')) files.push(exec)
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude']
  for (const dir of (hints.path ?? '').split(win ? ';' : ':')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1')
    // WSL 的 PATH 帶著 Windows 的資料夾；那邊的 claude 是 Windows 的，接不上 WSL 裡的對話
    if (!d || (platform === 'wsl' && d.startsWith('/mnt/'))) continue
    for (const n of names) files.push(join(d, n))
  }
  const home = hints.home
  const bundles: ClaudeLookup['bundles'] = []
  if (win) {
    if (home) files.push(join(home, '.local\\bin\\claude.exe'))
    if (hints.appData) {
      files.push(join(hints.appData, 'npm\\claude.cmd'))
      bundles.push({ dir: join(hints.appData, 'Claude\\claude-code'), exe: 'claude.exe' })
    }
  } else {
    if (home) files.push(join(home, '.local/bin/claude'), join(home, '.claude/local/claude'))
    files.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude')
    if (home && platform === 'mac') bundles.push({ dir: join(home, 'Library/Application Support/Claude/claude-code'), exe: 'claude' })
    if (home) bundles.push({ dir: join(home, '.claude/remote/ccd-cli'), exe: null })
  }
  return { files: [...new Set(files)], bundles }
}

/** 版本資料夾由新到舊（2.1.299-686c67ec1014 看前面的數字）；不像版本的排最後。 */
export function newestFirst(names: string[]): string[] {
  const parts = (n: string) => /^\d+(\.\d+)*/.exec(n)?.[0].split('.').map(Number) ?? null
  return [...names].sort((a, b) => {
    const x = parts(a)
    const y = parts(b)
    if (!x || !y) return x ? -1 : y ? 1 : 0
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] ?? 0) - (x[i] ?? 0)
      if (d) return d
    }
    return 0
  })
}

/** 真的找不到 claude 時給使用者的安裝指令（官方的安裝程式）。 */
export function claudeInstall(platform: BraidPlatform): { shell: string; command: string } {
  return platform === 'windows'
    ? { shell: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' }
    : { shell: '終端機', command: 'curl -fsSL https://claude.ai/install.sh | bash' }
}
