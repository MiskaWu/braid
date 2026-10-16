#requires -Version 5.1
# 測試用：把 migrate.ps1 會收到的參數寫成 JSON，驗證 Start-Process → cmd 的 %* → PowerShell 這條路沒有弄壞參數。
param([switch]$DryRun, [string]$From, [string]$Projects, [string]$Presets, [string]$Restore)
$o = [ordered]@{ DryRun = [bool]$DryRun; From = $From; Projects = $Projects; Presets = $Presets; Restore = $Restore }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'args.json'), (ConvertTo-Json -InputObject $o), (New-Object System.Text.UTF8Encoding($false)))
