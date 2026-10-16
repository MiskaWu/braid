#requires -Version 5.1
<#
.SYNOPSIS
  braid：新增一個帳號（Windows）。在 braid 開的視窗裡執行。

.DESCRIPTION
  1. 跑 claude setup-token：用瀏覽器登入要加的帳號，產生一年期的登入憑證。現在的登入不受影響。
  2. 請使用者把畫面上的憑證貼進來（輸入時不顯示），存進認證管理員。
  3. 用這組憑證問 Claude 它屬於哪個帳號（GET /api/oauth/profile，Claude Code 自己也這樣查），
     回應存到「結果檔.profile.json」：面板靠它判斷是不是目前這個帳號、是不是已經加過。查不到就不寫。
  4. 把結果寫到結果檔：{"ok":true,"backend":"credman","profile":true|false} 或 {"ok":false,"reason":"..."}。
     braid 面板看到結果檔就接著問名稱。憑證本身不寫進任何檔案，也不經過 Claude。
  參數從環境變數讀：BRAID_ACCOUNT（帳號 id）、BRAID_RESULT（結果檔）、BRAID_CLAUDE（claude 執行檔）。
#>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Utf8 = New-Object System.Text.UTF8Encoding($false)

$id = $env:BRAID_ACCOUNT
$result = $env:BRAID_RESULT
$claude = if ($env:BRAID_CLAUDE) { $env:BRAID_CLAUDE } else { 'claude' }

function Finish([string]$Json) {
    [IO.File]::WriteAllText("$result.tmp", $Json, $Utf8)
    Move-Item -LiteralPath "$result.tmp" -Destination $result -Force
}
# 互動時用 Read-Host（輸入憑證不顯示）；標準輸入被導向時（自動測試）Read-Host 不讀它，改讀標準輸入
function Read-Line([string]$Prompt, [switch]$Secret) {
    if ([Console]::IsInputRedirected) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { return '' }
        return $line
    }
    if (-not $Secret) { return Read-Host $Prompt }
    $secure = Read-Host $Prompt -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
# 問這組憑證是哪個帳號。BRAID_PROFILE_URL 是測試用的，只接受 file://（本機檔案），憑證不會被送到別處。
function Save-Profile([string]$Token) {
    try {
        $url = 'https://api.anthropic.com/api/oauth/profile'
        if ($env:BRAID_PROFILE_URL -like 'file://*') {
            $text = [IO.File]::ReadAllText(([Uri]$env:BRAID_PROFILE_URL).LocalPath)
        } else {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $text = (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 15 -Headers @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }).Content
        }
        [IO.File]::WriteAllText("$result.profile.json", [string]$text, $Utf8)
        return 'true'
    } catch {
        return 'false'
    }
}
function Cancel {
    Finish '{"ok":false,"reason":"canceled"}'
    Write-Host ''
    Write-Host '已取消，什麼都沒存。這個視窗可以關了。'
    exit 1
}

try {
    Write-Host '== braid：新增帳號 ==' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '接下來會開瀏覽器，請登入「要新增的那個帳號」。'
    Write-Host '你現在在 Claude 裡登入的帳號不會被登出。'
    Write-Host ''
    [void](Read-Line '準備好了按 Enter（不要了就關掉這個視窗）')
    & $claude setup-token
    Write-Host ''
    Write-Host '把上面顯示的那一長串憑證（sk-ant- 開頭）貼在這裡，按 Enter。輸入時畫面上不會顯示。'
    $token = $null
    for ($try = 0; $try -lt 3; $try++) {
        $plain = (Read-Line '憑證' -Secret) -replace '\s', ''
        if (-not $plain) { Cancel }
        if ($plain -match '^sk-ant-[A-Za-z0-9_-]{20,}$') { $token = $plain; break }
        Write-Host '這不像 Claude 的登入憑證（應該是 sk-ant- 開頭的一長串），再貼一次；直接按 Enter 取消。' -ForegroundColor Yellow
    }
    if (-not $token) { Cancel }

    $backend = $token | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'secret.ps1') set $id
    $ok = $LASTEXITCODE -eq 0
    $hasProfile = 'false'
    if ($ok) {
        Write-Host '確認這組憑證是哪個帳號…'
        $hasProfile = Save-Profile $token
    }
    Remove-Variable token, plain
    if ($ok) {
        Finish "{`"ok`":true,`"backend`":`"$($backend.Trim())`",`"profile`":$hasProfile}"
        Write-Host ''
        Write-Host '完成，已存好。回到 Claude 的 braid 面板填名稱就好；這個視窗可以關了。' -ForegroundColor Green
    } else {
        Finish '{"ok":false,"reason":"store-failed"}'
        Write-Host ''
        Write-Host '憑證存不進去（上面有原因）。回到 braid 面板可以重試。' -ForegroundColor Yellow
    }
    [void](Read-Line '按 Enter 關閉')
} catch {
    Finish '{"ok":false,"reason":"error"}'
    Write-Host $_.Exception.Message -ForegroundColor Red
    [void](Read-Line '按 Enter 關閉')
    exit 1
}
