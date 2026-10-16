#requires -Version 5.1
<#
.SYNOPSIS
  查一組 braid 存的憑證屬於哪個組織（Windows）。

.DESCRIPTION
  一年期憑證（claude setup-token）只能呼叫模型，查帳號資料（/api/oauth/profile）會被拒絕（403）；
  所以用它呼叫一次公開的「列出模型」API（不算用量、不用指定模型），回應標頭 anthropic-organization-id 就是組織。
  只查得到組織，查不到是哪個帳號。憑證從認證管理員取出，只用在這個行程裡；只印出組織 id，查不到就結束碼 1。
  用法：org.ps1 <憑證 id>
  測試用：BRAID_API_BASE 只接受 http://127.0.0.1:<埠>（本機），憑證不會被送到別處。
#>
param([Parameter(Position = 0)][string]$Id)
$ErrorActionPreference = 'Stop'

# 同一個 PowerShell 裡呼叫的腳本成功時不會設 $LASTEXITCODE，所以看讀到的內容
$token = & (Join-Path $PSScriptRoot 'secret.ps1') get $Id 2>$null | Select-Object -First 1
if (-not ($token -match '^sk-ant-')) { exit 1 }
$base = 'https://api.anthropic.com'
if ($env:BRAID_API_BASE -match '^http://127\.0\.0\.1:\d+$') { $base = $env:BRAID_API_BASE }
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $r = Invoke-WebRequest -UseBasicParsing -Uri "$base/v1/models?limit=1" -TimeoutSec 15 -Headers @{
        Authorization       = "Bearer $token"
        'anthropic-version' = '2023-06-01'
        'anthropic-beta'    = 'oauth-2025-04-20'
    }
} catch {
    exit 1
} finally {
    Remove-Variable token -ErrorAction SilentlyContinue
}
$org = [string]$r.Headers['anthropic-organization-id']
if ($org -notmatch '^[0-9a-fA-F-]{36}$') { exit 1 }
$org
