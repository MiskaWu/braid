// 開一個新的終端機視窗跑 braid 的帳號腳本：用另一個帳號接著同一段對話（resume）、新增帳號（add）。
// 純函式：給平台、plugin 根目錄與工作，回要執行的動作。腳本本身在 tool/cli（bash）與 tool/windows（PowerShell）。
//
// 參數怎麼送進新視窗：
//   WSL、Linux、macOS：寫一個一次性的小腳本（第一行就刪掉自己），參數用單引號寫死在裡面，
//     開視窗的指令只帶這個腳本的路徑，不經過 Windows 或終端機程式的引號規則。
//   Windows：參數放在環境變數（中文路徑不經過命令列的編碼），新視窗繼承後由 PowerShell 腳本讀。
// 憑證從不經過這裡：腳本自己從鑰匙圈或認證管理員取。
import type { BraidPlatform } from '../types'

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

/** 新增帳號時給憑證的 id：tok- 加 8 個十六進位字。 */
export function newCredentialId(random: () => number): string {
  let hex = ''
  for (let i = 0; i < 8; i++) hex += Math.floor(random() * 16).toString(16)
  return `tok-${hex}`
}
