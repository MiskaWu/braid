#requires -Version 5.1
<#
.SYNOPSIS
  braid：用另一個帳號接著同一段對話（Windows）。在 braid 開的視窗裡執行。

.DESCRIPTION
  用 --fork-session 複製一份對話接著做：原本的對話保留不動，兩個視窗不會寫進同一份紀錄。
  參數從環境變數讀（braid 開視窗時帶進來，中文路徑不經過命令列的編碼）：
    BRAID_ACCOUNT  帳號 id（留給新的對話，braid 才知道用量是哪個帳號的）
    BRAID_CREDENTIAL  憑證 id    BRAID_SESSION  session id
    BRAID_CWD      工作資料夾   BRAID_CLAUDE   claude 執行檔   BRAID_LABEL  帳號名稱
  憑證從認證管理員取出，只放進這個視窗裡 Claude Code 的環境變數 CLAUDE_CODE_OAUTH_TOKEN。
  BRAID_CREDENTIAL 是「-」：不帶憑證，用 Claude Code 自己登入的帳號（/login 的那個）接著做。
#>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Fail([string]$Message) {
    Write-Host ''
    Write-Host $Message -ForegroundColor Yellow
    [void](Read-Host '按 Enter 關閉這個視窗')
    exit 1
}

$id = if ($env:BRAID_CREDENTIAL) { $env:BRAID_CREDENTIAL } else { $env:BRAID_ACCOUNT }
$session = $env:BRAID_SESSION
$label = if ($env:BRAID_LABEL) { $env:BRAID_LABEL } else { '另一個帳號' }
$claude = if ($env:BRAID_CLAUDE) { $env:BRAID_CLAUDE } else { 'claude' }

# 同一個 PowerShell 裡呼叫的腳本成功時不會設 $LASTEXITCODE（還是 $null），所以看讀到的內容，不看結束碼
$token = $null
if ($id -ne '-') {
    $token = & (Join-Path $PSScriptRoot 'secret.ps1') get $id 2>$null | Select-Object -First 1
    if (-not ($token -match '^sk-ant-')) { Fail "找不到「$label」的登入憑證。請在 Claude 輸入 /braid，到帳號頁重新新增這個帳號。" }
}
if (-not (Test-Path -LiteralPath $env:BRAID_CWD)) { Fail "找不到工作資料夾：$($env:BRAID_CWD)" }
Set-Location -LiteralPath $env:BRAID_CWD

# 從 Claude 裡開的視窗會帶著上一個對話的變數，清掉以免新的對話認錯身分。
# 桌面 app 會把 ANTHROPIC_BASE_URL 指向自己的代理，只有在那種情況才一起清。
if ($env:CLAUDE_CODE_DESKTOP_APP_VERSION) { Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue }
foreach ($name in 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_USER_EMAIL', 'CLAUDE_CODE_ORGANIZATION_UUID',
    'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_DESKTOP_APP_VERSION', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_PID', 'CLAUDE_CODE_EXECPATH',
    'BRAID_CREDENTIAL', 'BRAID_SESSION', 'BRAID_CWD', 'BRAID_CLAUDE', 'BRAID_LABEL') {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

Write-Host "用「$label」接著這段對話：複製一份新的對話接著做，原本的保留不動。"
Write-Host ''
Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue
if ($token) { $env:CLAUDE_CODE_OAUTH_TOKEN = $token }
Remove-Variable token
& $claude --resume $session --fork-session
if ($LASTEXITCODE -ne 0) { [void](Read-Host "Claude 結束了（結束碼 $LASTEXITCODE）。按 Enter 關閉這個視窗") }
