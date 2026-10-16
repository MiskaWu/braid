#requires -Version 5.1
<#
.SYNOPSIS
  Claude 桌面 app 換帳號遷移：把舊帳號 Code 分頁的 session 清單與「已儲存的環境」複製到目前登入的帳號。

.DESCRIPTION
  只複製、不搬移，舊帳號的資料原封不動；可以重跑，已經搬過的會略過；寫入前先備份。
  不需要系統管理員權限：所有讀寫都在自己的使用者資料夾裡。
  規則（哪些欄位要拿掉、認得哪些格式版本）寫在上一層的 spec.json，與 macOS 版共用。

.EXAMPLE
  雙擊同資料夾的 migrate.cmd。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File migrate.ps1 -DryRun
  只列出會做什麼，不寫入。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File migrate.ps1 -Restore "C:\Users\me\switchboard-backups\20261016-150000"
  用備份還原到遷移前的狀態。
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [string]$From,
    [string]$Restore,
    [string]$AppDataRoot = (Join-Path $env:APPDATA 'Claude'),
    [string]$ClaudeHome = (Join-Path $env:USERPROFILE '.claude'),
    [string]$BackupRoot = (Join-Path $env:USERPROFILE 'switchboard-backups'),
    [switch]$SkipAppCheck,
    [switch]$NoRelaunch,
    [string]$PlanJson
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$Utf8 = New-Object System.Text.UTF8Encoding $false
$Interactive = -not [Console]::IsInputRedirected
$script:BackupDir = $null

# ---------- 共用小工具 ----------

function Say([string]$Message, [string]$Color) {
    if ($Color) { Write-Host $Message -ForegroundColor $Color } else { Write-Host $Message }
}

# 問使用者。-Yes 或非互動執行時直接用 $Auto；直接按 Enter 用 $Default。
function Ask([string]$Prompt, [string[]]$Choices, [string]$Default, [string]$Auto) {
    if ($Yes -or -not $Interactive) { return $Auto }
    while ($true) {
        $a = (Read-Host $Prompt).Trim().ToUpper()
        if ($a -eq '') { return $Default }
        if ($Choices -contains $a) { return $a }
    }
}

# 做一件可能失敗的事；失敗時讓使用者選重試／略過／取消，而不是整個停掉。
function Invoke-Step([string]$What, [scriptblock]$Action) {
    while ($true) {
        try { & $Action; return $true }
        catch {
            Say "  ✗ $What 失敗：$($_.Exception.Message)" Yellow
            $a = Ask '    [R] 重試  [S] 略過這一項  [C] 取消全部（直接按 Enter＝重試）' @('R', 'S', 'C') 'R' 'C'
            if ($a -eq 'S') { return $false }
            if ($a -eq 'C') { throw 'CANCEL' }
        }
    }
}

function Read-JsonFile([string]$Path) { [IO.File]::ReadAllText($Path, $Utf8) | ConvertFrom-Json }

function Write-JsonFile([string]$Path, $Object) {
    $text = ConvertTo-Json -InputObject $Object -Depth 100 -Compress
    $tmp = "$Path.migrating"
    [IO.File]::WriteAllText($tmp, $text, $Utf8)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Has($Object, [string]$Name) { return ($null -ne $Object) -and ($null -ne $Object.PSObject.Properties[$Name]) }

function Set-Prop($Object, [string]$Name, $Value) {
    if (Has $Object $Name) { $Object.$Name = $Value } else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function As-Array($Value) { if ($null -eq $Value) { return , @() } return , @($Value) }

function Format-Time($Ms) {
    if (-not $Ms) { return '（無紀錄）' }
    return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Ms).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
}

function Short([string]$Id) { if ($Id.Length -gt 8) { return $Id.Substring(0, 8) } return $Id }

# ---------- app 是否開著 ----------

function Get-AppProcesses {
    return , @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and ($_.Path -like '*\WindowsApps\Claude_*' -or $_.Path -like '*\AnthropicClaude\*')
        })
}

function Wait-AppClosed {
    if ($SkipAppCheck) { return }
    if ((Get-AppProcesses).Count -eq 0) { return }
    Say ''
    Say 'Claude 桌面 app 還開著。請從右下角系統匣的 Claude 圖示按右鍵 →「結束」（只關掉視窗不夠）。' Yellow
    if ($Interactive) { Say '等待 app 結束中……（按 K＝由這裡強制結束 app，按 Q＝取消）' }
    else { Say '等待 app 結束中……' }
    while ((Get-AppProcesses).Count -gt 0) {
        if ($Interactive -and [Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true).Key
            if ($key -eq 'Q') { throw 'CANCEL' }
            if ($key -eq 'K') {
                $ok = Ask '  確定要強制結束 Claude？app 裡還沒存檔的設定可能會遺失 [Y/N]（預設 N）' @('Y', 'N') 'N' 'N'
                if ($ok -eq 'Y') { Get-AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue }
                else { Say '  好，繼續等你從系統匣結束。' }
            }
        }
        Start-Sleep -Milliseconds 300
    }
    Start-Sleep -Milliseconds 500
    Say 'app 已結束。' Green
}

function Start-App {
    try {
        $entry = Get-StartApps -Name 'Claude' -ErrorAction Stop | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1
        if ($entry) { Start-Process ('shell:AppsFolder\' + $entry.AppID); Say '已重新開啟 Claude。' Green; return }
    } catch { }
    Say '找不到 Claude 的啟動項目，請自己從開始功能表打開 Claude。' Yellow
}

# ---------- 讀取帳號資料 ----------

function Read-Profile($AccountDir, $OrgDir) {
    $entries = New-Object System.Collections.ArrayList
    foreach ($f in Get-ChildItem -LiteralPath $OrgDir.FullName -Filter "$($spec.sessions.filePrefix)*.json" -File) {
        try { [void]$entries.Add([pscustomobject]@{ File = $f; Data = (Read-JsonFile $f.FullName) }) }
        catch { Say "  略過無法解析的檔案：$($f.Name)" DarkYellow }
    }
    $last = 0
    foreach ($x in $entries) {
        if ((Has $x.Data 'lastActivityAt') -and ($x.Data.lastActivityAt -gt $last)) { $last = $x.Data.lastActivityAt }
    }
    return [pscustomobject]@{
        Account = $AccountDir.Name; Org = $OrgDir.Name; Dir = $OrgDir.FullName
        Entries = @($entries); Count = $entries.Count; Last = $last
    }
}

function Get-Titles($Profile, [int]$N) {
    $sorted = @($Profile.Entries | Sort-Object { if (Has $_.Data 'lastActivityAt') { $_.Data.lastActivityAt } else { 0 } } -Descending)
    return , @($sorted | Select-Object -First $N | ForEach-Object { if (Has $_.Data 'title') { $_.Data.title } else { '（無標題）' } })
}

function Show-Profile($Profile, [string]$Label) {
    Say ("  {0}帳號 {1}…／組織 {2}…：{3} 筆 session，最後活動 {4}" -f $Label, (Short $Profile.Account), (Short $Profile.Org), $Profile.Count, (Format-Time $Profile.Last))
    foreach ($t in (Get-Titles $Profile 3)) { Say "      · $t" DarkGray }
}

# 對話紀錄還在不在：found／missing／unverifiable（在 WSL 或遠端主機、這裡看不到）
function Test-Transcript($E) {
    $id = $E.cliSessionId
    $distro = $null
    if ((Has $E 'wslConfig') -and $E.wslConfig -and (Has $E.wslConfig 'distro')) { $distro = $E.wslConfig.distro }
    $remotePath = $null
    if (Has $E 'sshRemoteTranscriptPath') { $remotePath = $E.sshRemoteTranscriptPath }
    if ($distro) {
        foreach ($root in @(('\\wsl.localhost\' + $distro), ('\\wsl$\' + $distro))) {
            if (-not (Test-Path -LiteralPath ($root + '\'))) { continue }
            if ($remotePath) {
                if (Test-Path -LiteralPath ($root + ($remotePath -replace '/', '\'))) { return 'found' }
                return 'missing'
            }
            if (Test-Path -Path ($root + '\home\*\.claude\projects\*\' + $id + '.jsonl')) { return 'found' }
            return 'missing'
        }
        return 'unverifiable'
    }
    if ($remotePath) { return 'unverifiable' }
    if (Test-Path -Path (Join-Path $ClaudeHome ('projects\*\' + $id + '.jsonl'))) { return 'found' }
    return 'missing'
}

# ---------- 環境（Local Storage）合併 ----------

function Get-PlaceKey($Target) {
    if (-not $Target) { return '||' }
    return ('{0}|{1}|{2}' -f $Target.kind, $Target.cwd, $Target.wslDistro)
}

# 把來源狀態 $A 併進目標狀態 $B（就地修改 $B）。目標已有同資料夾的環境就保留目標的。
function Merge-PresetState($A, $B) {
    $have = @{}; $ids = @{}
    $list = New-Object System.Collections.ArrayList
    foreach ($p in (As-Array $B.presets)) { [void]$list.Add($p); $have[(Get-PlaceKey $p.target)] = $true; $ids[[string]$p.id] = $true }
    $added = New-Object System.Collections.ArrayList
    $skipped = New-Object System.Collections.ArrayList
    foreach ($p in (As-Array $A.presets)) {
        $k = Get-PlaceKey $p.target
        if ($have.ContainsKey($k) -or $ids.ContainsKey([string]$p.id)) { [void]$skipped.Add([string]$p.name); continue }
        [void]$list.Add($p); [void]$added.Add([string]$p.name); $have[$k] = $true
    }
    Set-Prop $B 'presets' @($list)

    if (Has $A 'placeDefaults') {
        if (-not (Has $B 'placeDefaults') -or $null -eq $B.placeDefaults) { Set-Prop $B 'placeDefaults' ([pscustomobject]@{}) }
        foreach ($prop in $A.placeDefaults.PSObject.Properties) {
            if ($null -eq $B.placeDefaults.PSObject.Properties[$prop.Name]) {
                $B.placeDefaults | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value
            }
        }
    }
    if (Has $A 'startedPlaces') {
        $places = New-Object System.Collections.ArrayList
        $seen = @{}
        foreach ($p in (As-Array $B.startedPlaces)) { [void]$places.Add($p); $seen[(Get-PlaceKey $p.target)] = $true }
        foreach ($p in (As-Array $A.startedPlaces)) { if (-not $seen.ContainsKey((Get-PlaceKey $p.target))) { [void]$places.Add($p) } }
        Set-Prop $B 'startedPlaces' @($places)
    }
    if (Has $A 'startedFrom') {
        $from = New-Object System.Collections.ArrayList
        foreach ($x in @((As-Array $B.startedFrom) + (As-Array $A.startedFrom))) { if (-not $from.Contains($x)) { [void]$from.Add($x) } }
        Set-Prop $B 'startedFrom' @($from)
    }
    return [pscustomobject]@{ Added = @($added); Skipped = @($skipped) }
}

# ---------- 還原 ----------

function Invoke-Restore([string]$Dir) {
    $manifestPath = Join-Path $Dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "這不是遷移備份資料夾（找不到 manifest.json）：$Dir" }
    $m = Read-JsonFile $manifestPath
    Wait-AppClosed
    Say "從備份還原：$Dir"
    if ((Has $m 'sessionsDir') -and (Test-Path -LiteralPath (Join-Path $Dir 'sessions'))) {
        Invoke-Step '還原 session 清單' {
            if (Test-Path -LiteralPath $m.sessionsDir) { Remove-Item -LiteralPath $m.sessionsDir -Recurse -Force }
            Copy-Item -LiteralPath (Join-Path $Dir 'sessions') -Destination $m.sessionsDir -Recurse
        } | Out-Null
    }
    if ((Has $m 'mirrorFile') -and (Test-Path -LiteralPath (Join-Path $Dir 'mirror.json'))) {
        Invoke-Step '還原環境清單檔' { Copy-Item -LiteralPath (Join-Path $Dir 'mirror.json') -Destination $m.mirrorFile -Force } | Out-Null
    }
    if ((Has $m 'localStorageDir') -and (Test-Path -LiteralPath (Join-Path $Dir 'leveldb'))) {
        Invoke-Step '還原 Local Storage' {
            Get-ChildItem -LiteralPath $m.localStorageDir -Force | Remove-Item -Recurse -Force
            Get-ChildItem -LiteralPath (Join-Path $Dir 'leveldb') -Force | Copy-Item -Destination $m.localStorageDir -Recurse
        } | Out-Null
    }
    Say '還原完成。' Green
}

# ================= 主流程 =================

function Main {
    Say '== Claude 桌面 app 換帳號遷移 ==' Cyan
    Say '只複製、不搬移；寫入前會先備份。不需要系統管理員權限。'
    Say ''

    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
        Say "這台電腦的 PowerShell 被公司政策限制在「$($ExecutionContext.SessionState.LanguageMode)」模式，本工具無法執行。請聯絡 IT。" Red
        exit 2
    }

    $script:spec = Read-JsonFile (Join-Path $PSScriptRoot '..\spec.json')
    if ($Restore) { Invoke-Restore $Restore; return }

    if (-not (Test-Path -LiteralPath $AppDataRoot)) { throw "找不到 Claude 桌面 app 的資料夾：$AppDataRoot" }

    $lsAvailable = $true
    try { Add-Type -Path (Join-Path $PSScriptRoot 'LevelDbLite.cs') }
    catch {
        Say "無法載入讀寫環境資料的元件：$($_.Exception.Message)" Yellow
        $a = Ask '  [Y] 只搬側欄 session、略過環境  [N] 取消（直接按 Enter＝Y）' @('Y', 'N') 'Y' 'Y'
        if ($a -ne 'Y') { throw 'CANCEL' }
        $lsAvailable = $false
    }

    Wait-AppClosed

    # --- 找帳號 ---
    $sessRoot = Join-Path $AppDataRoot $spec.sessions.dir
    if (-not (Test-Path -LiteralPath $sessRoot)) { throw "找不到 session 資料夾：$sessRoot（這台電腦還沒用過 Code 分頁？）" }
    $profiles = New-Object System.Collections.ArrayList
    foreach ($acct in Get-ChildItem -LiteralPath $sessRoot -Directory) {
        foreach ($org in Get-ChildItem -LiteralPath $acct.FullName -Directory) { [void]$profiles.Add((Read-Profile $acct $org)) }
    }

    $current = $null
    $configPath = Join-Path $AppDataRoot $spec.app.configFile
    if (Test-Path -LiteralPath $configPath) {
        $cfg = Read-JsonFile $configPath
        if (Has $cfg $spec.app.currentAccountKey) { $current = $cfg.($spec.app.currentAccountKey) }
    }
    $target = @($profiles | Where-Object { $_.Account -eq $current } | Sort-Object Last -Descending) | Select-Object -First 1
    if (-not $target) {
        Say '找不到目前登入帳號的 session 資料夾。' Red
        Say '請先用新帳號登入桌面 app，在 Code 分頁開一個新對話（打一句話就好），結束 app 後再執行一次。'
        exit 2
    }

    $sources = @($profiles | Where-Object { $_.Dir -ne $target.Dir -and $_.Count -gt 0 } | Sort-Object Last -Descending)
    if ($sources.Count -eq 0) { Say '這台電腦上沒有其他帳號的 session 可以遷移。' Green; return }

    Say '目前登入（搬到這裡）：' Cyan
    Show-Profile $target ''
    Say ''
    $source = $null
    if ($From) {
        $source = @($sources | Where-Object { $_.Account -like "$From*" -or "$($_.Account).$($_.Org)" -like "$From*" }) | Select-Object -First 1
        if (-not $source) { throw "找不到 -From 指定的帳號：$From" }
    } elseif ($sources.Count -eq 1) {
        $source = $sources[0]
    } else {
        Say '這台電腦上有多個舊帳號，請選要從哪一個搬：' Cyan
        for ($i = 0; $i -lt $sources.Count; $i++) { Show-Profile $sources[$i] "[$($i + 1)] " }
        if ($Yes -or -not $Interactive) { throw '有多個舊帳號，請用 -From 指定' }
        while (-not $source) {
            $n = Read-Host "輸入編號 1-$($sources.Count)"
            $k = 0
            if ([int]::TryParse($n, [ref]$k) -and $k -ge 1 -and $k -le $sources.Count) { $source = $sources[$k - 1] }
        }
    }
    Say '從這個帳號搬：' Cyan
    Show-Profile $source ''
    Say ''

    # --- 規劃 session ---
    $prefix = $spec.sessions.filePrefix
    $tgtNames = @{}
    foreach ($x in $target.Entries) { $tgtNames[$x.File.Name] = $true }
    $tombs = @{}
    foreach ($f in Get-ChildItem -LiteralPath $target.Dir -Filter "$($spec.sessions.tombstonePrefix)*" -File) {
        $tombs[$f.Name.Substring($spec.sessions.tombstonePrefix.Length)] = $true
    }
    $latestTarget = @($target.Entries | Sort-Object { if (Has $_.Data 'lastActivityAt') { $_.Data.lastActivityAt } else { 0 } } -Descending) | Select-Object -First 1
    $replace = @{}
    foreach ($k in $spec.sessions.replaceFromTarget) {
        if ($latestTarget -and (Has $latestTarget.Data $k)) { $replace[$k] = $latestTarget.Data.$k }
    }

    $copy = New-Object System.Collections.ArrayList
    $skip = New-Object System.Collections.ArrayList
    $unverifiable = New-Object System.Collections.ArrayList
    foreach ($x in $source.Entries) {
        $name = $x.File.Name; $e = $x.Data
        $uuid = $name.Substring($prefix.Length, $name.Length - $prefix.Length - 5)
        $title = if (Has $e 'title') { $e.title } else { '（無標題）' }
        $reason = $null
        if ($tgtNames.ContainsKey($name)) { $reason = 'exists' }
        elseif ($tombs.ContainsKey($uuid)) { $reason = 'tombstone' }
        else {
            foreach ($k in $spec.sessions.requiredKeys) { if (-not (Has $e $k)) { $reason = 'invalid' } }
        }
        if (-not $reason) {
            $t = Test-Transcript $e
            if ($t -eq 'missing') { $reason = 'missing-transcript' }
            elseif ($t -eq 'unverifiable') { [void]$unverifiable.Add($x); continue }
        }
        if ($reason) { [void]$skip.Add([pscustomobject]@{ File = $name; Title = $title; Reason = $reason }) }
        else { [void]$copy.Add($x) }
    }
    if ($unverifiable.Count -gt 0) {
        Say "有 $($unverifiable.Count) 筆 session 的對話紀錄在 WSL 或遠端主機上，這裡確認不到是否還在：" Yellow
        foreach ($x in $unverifiable) { Say "      · $(if (Has $x.Data 'title') { $x.Data.title } else { '（無標題）' })" DarkGray }
        $a = Ask '  仍要複製這些 session 嗎？[Y/N]（直接按 Enter＝Y）' @('Y', 'N') 'Y' 'Y'
        foreach ($x in $unverifiable) {
            if ($a -eq 'Y') { [void]$copy.Add($x) }
            else { [void]$skip.Add([pscustomobject]@{ File = $x.File.Name; Title = $x.Data.title; Reason = 'unverifiable-declined' }) }
        }
    }

    # 封存清單：來源封存、且目標會有那一筆的，併進目標
    $idxSrc = Join-Path $source.Dir $spec.sessions.archivedIndex
    $idxDst = Join-Path $target.Dir $spec.sessions.archivedIndex
    $present = @{}
    foreach ($n in $tgtNames.Keys) { $present[$n.Substring(0, $n.Length - 5)] = $true }
    foreach ($x in $copy) { $present[$x.File.BaseName] = $true }
    $dstIdx = if (Test-Path -LiteralPath $idxDst) { Read-JsonFile $idxDst } else { [pscustomobject]@{ v = 1; archived = @() } }
    $addArchived = New-Object System.Collections.ArrayList
    if (Test-Path -LiteralPath $idxSrc) {
        foreach ($id in (As-Array (Read-JsonFile $idxSrc).archived)) {
            if ($present.ContainsKey($id) -and -not ((As-Array $dstIdx.archived) -contains $id)) { [void]$addArchived.Add($id) }
        }
    }

    # --- 規劃環境 ---
    $presetPlans = New-Object System.Collections.ArrayList
    $lsDir = Join-Path $AppDataRoot ($spec.presets.localStorageDir -replace '/', '\')
    if ($lsAvailable -and (Test-Path -LiteralPath $lsDir)) {
        try {
            $state = [CdmLevelDb]::Read($lsDir, $spec.presets.keyPrefix)
            $byName = @{}
            foreach ($kv in $state.Entries.GetEnumerator()) {
                $en = $kv.Value
                if ($en.Deleted) { continue }
                $parts = [CdmLevelDb]::SplitKey($en.Key)
                if (-not $parts -or -not $parts[1].StartsWith($spec.presets.keyPrefix)) { continue }
                $byName[$parts[1]] = [pscustomobject]@{ Origin = $parts[0]; Json = [CdmLevelDb]::DecodeValue($en.Value) }
            }
            $kp = $spec.presets.keyPrefix
            $scopes = @(
                [pscustomobject]@{ Scope = 'account'; Label = '帳號層級'; Src = $kp + $source.Account; Dst = $kp + $target.Account },
                [pscustomobject]@{ Scope = 'org'; Label = '組織層級'; Src = "$kp$($source.Account).$($source.Org)"; Dst = "$kp$($target.Account).$($target.Org)" }
            )
            foreach ($s in $scopes) {
                $plan = [pscustomobject]@{ Scope = $s.Scope; Label = $s.Label; Status = 'none'; Reason = $null; Added = @(); Skipped = @(); Origin = $null; DstName = $s.Dst; NewJson = $null; Presets = $null }
                [void]$presetPlans.Add($plan)
                if (-not $byName.ContainsKey($s.Src)) { continue }
                $a = $byName[$s.Src].Json | ConvertFrom-Json
                if (-not (Has $a 'state') -or -not (Has $a.state 'presets') -or (As-Array $a.state.presets).Count -eq 0) { continue }
                if (-not ($spec.presets.supportedVersions -contains $a.version)) {
                    $plan.Status = 'skip'; $plan.Reason = "unsupported-version:$($a.version)"; continue
                }
                if (-not $byName.ContainsKey($s.Dst)) { $plan.Status = 'skip'; $plan.Reason = 'target-missing'; continue }
                $b = $byName[$s.Dst].Json | ConvertFrom-Json
                if ($b.version -ne $a.version -or -not (Has $b 'state')) { $plan.Status = 'skip'; $plan.Reason = "version-mismatch:$($a.version)/$($b.version)"; continue }
                $m = Merge-PresetState $a.state $b.state
                $plan.Added = $m.Added; $plan.Skipped = $m.Skipped
                if ($m.Added.Count -eq 0) { $plan.Status = 'nothing-new'; continue }
                $plan.Status = 'merge'; $plan.Origin = $byName[$s.Dst].Origin
                $plan.NewJson = ConvertTo-Json -InputObject $b -Depth 100 -Compress
                $plan.Presets = $b.state.presets
            }
        } catch {
            Say "讀不了環境資料：$($_.Exception.Message)" Yellow
            $a = Ask '  [Y] 只搬側欄 session、略過環境  [N] 取消（直接按 Enter＝Y）' @('Y', 'N') 'Y' 'Y'
            if ($a -ne 'Y') { throw 'CANCEL' }
            $presetPlans.Clear()
            [void]$presetPlans.Add([pscustomobject]@{ Scope = 'account'; Label = '帳號層級'; Status = 'skip'; Reason = 'read-failed'; Added = @(); Skipped = @() })
        }
    }

    # --- 列出計畫 ---
    $reasonText = @{
        'exists' = '新帳號已經有了'; 'tombstone' = '曾在新帳號刪除過'; 'invalid' = '檔案格式不符'
        'missing-transcript' = '找不到對話紀錄檔'; 'unverifiable-declined' = '你選擇不複製'
    }
    Say '== 遷移計畫 ==' Cyan
    Say "側欄 session：複製 $($copy.Count) 筆，略過 $($skip.Count) 筆；封存狀態補 $($addArchived.Count) 筆"
    foreach ($x in $copy) { Say "  + $(if (Has $x.Data 'title') { $x.Data.title } else { '（無標題）' })" Green }
    foreach ($s in ($skip | Where-Object { $_.Reason -ne 'exists' })) { Say "  - $($s.Title)（$($reasonText[$s.Reason])）" DarkGray }
    $existsCount = @($skip | Where-Object { $_.Reason -eq 'exists' }).Count
    if ($existsCount -gt 0) { Say "  （另有 $existsCount 筆新帳號已經有了）" DarkGray }
    Say '已儲存的環境：'
    if ($presetPlans.Count -eq 0) { Say '  這台電腦沒有環境資料，略過。' DarkGray }
    foreach ($p in $presetPlans) {
        switch ($p.Status) {
            'merge' { Say "  $($p.Label)：加入 $($p.Added -join '、')" Green; if ($p.Skipped.Count) { Say "    略過（新帳號已有同一個資料夾）：$($p.Skipped -join '、')" DarkGray } }
            'nothing-new' { Say "  $($p.Label)：都已經有了" DarkGray }
            'skip' {
                $why = switch -Wildcard ($p.Reason) {
                    'target-missing' { '新帳號還沒有環境資料：請先用新帳號在 Code 分頁開過一次對話' }
                    'unsupported-version*' { 'app 的環境資料格式改版了，本工具還不認得，請更新工具' }
                    'version-mismatch*' { '新舊帳號的環境資料格式版本不同' }
                    default { '讀取失敗' }
                }
                Say "  $($p.Label)：略過（$why）" Yellow
            }
        }
    }
    Say ''

    if ($PlanJson) {
        $plan = [ordered]@{
            source   = [ordered]@{ account = $source.Account; org = $source.Org }
            target   = [ordered]@{ account = $target.Account; org = $target.Org }
            sessions = [ordered]@{
                copy = @($copy | ForEach-Object { $_.File.Name } | Sort-Object)
                skip = @($skip | Sort-Object File | ForEach-Object { [ordered]@{ file = $_.File; reason = $_.Reason } })
            }
            archived = @($addArchived | Sort-Object)
            presets  = @($presetPlans | ForEach-Object { [ordered]@{ scope = $_.Scope; status = $_.Status; reason = $_.Reason; add = @($_.Added); skip = @($_.Skipped) } })
        }
        [IO.File]::WriteAllText($PlanJson, (ConvertTo-Json -InputObject $plan -Depth 10), $Utf8)
    }

    $mergeScopes = @($presetPlans | Where-Object { $_.Status -eq 'merge' })
    if ($copy.Count -eq 0 -and $addArchived.Count -eq 0 -and $mergeScopes.Count -eq 0) { Say '沒有需要搬的東西，結束。' Green; return }
    if ($DryRun) { Say '試跑模式：沒有寫入任何東西。' Cyan; return }
    $go = Ask '開始寫入？[Y/N]（直接按 Enter＝Y）' @('Y', 'N') 'Y' 'Y'
    if ($go -ne 'Y') { throw 'CANCEL' }

    # --- 備份 ---
    $mirrorPath = Join-Path $AppDataRoot $spec.presets.mirrorFile
    $script:BackupDir = Join-Path $BackupRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
    Invoke-Step '備份' {
        New-Item -ItemType Directory -Path $script:BackupDir -Force | Out-Null
        $manifest = [ordered]@{ createdAt = (Get-Date).ToString('o'); sessionsDir = $target.Dir }
        Copy-Item -LiteralPath $target.Dir -Destination (Join-Path $script:BackupDir 'sessions') -Recurse
        if ($mergeScopes.Count -gt 0) {
            Copy-Item -LiteralPath $lsDir -Destination (Join-Path $script:BackupDir 'leveldb') -Recurse
            $manifest.localStorageDir = $lsDir
            if (Test-Path -LiteralPath $mirrorPath) {
                Copy-Item -LiteralPath $mirrorPath -Destination (Join-Path $script:BackupDir 'mirror.json')
                $manifest.mirrorFile = $mirrorPath
            }
        }
        [IO.File]::WriteAllText((Join-Path $script:BackupDir 'manifest.json'), (ConvertTo-Json -InputObject $manifest), $Utf8)
    } | Out-Null
    Say "已備份到：$script:BackupDir" Green

    # --- 寫入 session ---
    $written = 0
    foreach ($x in $copy) {
        $e = $x.Data
        foreach ($k in $spec.sessions.dropKeys) { $e.PSObject.Properties.Remove($k) }
        foreach ($k in $spec.sessions.nullKeys) { if (Has $e $k) { $e.$k = $null } }
        foreach ($k in $replace.Keys) { if (Has $e $k) { $e.$k = $replace[$k] } }
        $dest = Join-Path $target.Dir $x.File.Name
        if (Invoke-Step "寫入 session「$($e.title)」" { Write-JsonFile $dest $e }) { $written++ }
    }
    if ($addArchived.Count -gt 0) {
        Invoke-Step '更新封存清單' {
            Set-Prop $dstIdx 'archived' @((As-Array $dstIdx.archived) + @($addArchived))
            Write-JsonFile $idxDst $dstIdx
        } | Out-Null
    }

    # --- 寫入環境 ---
    $envDone = New-Object System.Collections.ArrayList
    foreach ($p in $mergeScopes) {
        $ok = Invoke-Step "寫入$($p.Label)環境" {
            $key = [CdmLevelDb]::MakeKey($p.Origin, $p.DstName)
            [void][CdmLevelDb]::Append($lsDir, $key, [CdmLevelDb]::EncodeValue($p.NewJson))
            $check = [CdmLevelDb]::Read($lsDir, $p.DstName)
            $got = $null
            [void]$check.Entries.TryGetValue([Text.Encoding]::GetEncoding(28591).GetString($key), [ref]$got)
            if (-not $got -or [CdmLevelDb]::DecodeValue($got.Value) -ne $p.NewJson) { throw '寫入後讀回的內容不一致' }
        }
        if ($ok) { [void]$envDone.Add($p) }
    }
    $acctPlan = @($envDone | Where-Object { $_.Scope -eq 'account' }) | Select-Object -First 1
    if ($acctPlan -and (Test-Path -LiteralPath $mirrorPath)) {
        Invoke-Step '同步環境清單檔' {
            $mirror = Read-JsonFile $mirrorPath
            if (-not (Has $mirror 'byAccount')) { Set-Prop $mirror 'byAccount' ([pscustomobject]@{}) }
            if (-not (Has $mirror.byAccount $target.Account)) { Set-Prop $mirror.byAccount $target.Account ([pscustomobject]@{ presets = @() }) }
            Set-Prop $mirror.byAccount.($target.Account) 'presets' @($acctPlan.Presets)
            Write-JsonFile $mirrorPath $mirror
        } | Out-Null
    }

    Say ''
    Say '== 完成 ==' Green
    Say "側欄 session 寫入 $written 筆；環境寫入 $($envDone.Count) 層。"
    Say "備份在：$script:BackupDir"
    Say '想還原的話：結束 app 後執行'
    Say "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Restore `"$script:BackupDir`"" DarkGray

    if (-not $NoRelaunch -and -not $SkipAppCheck) {
        $a = Ask '要現在重新開啟 Claude 嗎？[Y/N]（直接按 Enter＝Y）' @('Y', 'N') 'Y' 'N'
        if ($a -eq 'Y') { Start-App }
    }
}

try {
    Main
    exit 0
} catch {
    if ($_.Exception.Message -eq 'CANCEL' -or "$_" -eq 'CANCEL') {
        Say '已取消。' Yellow
    } else {
        Say "發生錯誤：$($_.Exception.Message)" Red
    }
    if ($script:BackupDir) {
        Say '寫入可能只完成一部分。要回到遷移前的狀態，結束 app 後執行：' Yellow
        Say "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Restore `"$script:BackupDir`"" DarkGray
    }
    exit 1
}
