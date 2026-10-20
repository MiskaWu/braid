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
  powershell -ExecutionPolicy Bypass -File migrate.ps1 -Projects "/home/me/work-a,/home/me/work-b" -Presets none
  不跳出勾選清單，直接指定要搬的專案資料夾與環境（逗號分隔；all＝全部，none＝都不要，
  環境寫 folders＝只帶工作資料夾在指定專案裡的環境）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File migrate.ps1 -Restore "C:\Users\me\braid-backups\20261016-150000"
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
    [string]$BackupRoot = (Join-Path $env:USERPROFILE 'braid-backups'),
    [switch]$SkipAppCheck,
    [switch]$NoRelaunch,
    [string]$PlanJson,
    [string]$Projects,
    [string]$Presets
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
        if ($a -eq '') { if ($Default) { return $Default } else { continue } }
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

# Local Storage 裡單一字串值（讀不到就回 $null；試跑模式的容忍讀，app 開著也行）
function Get-LsString([string]$Dir, [string]$Name) {
    try {
        $st = [CdmLevelDb]::Read($Dir, $Name, $true)
        foreach ($kv in $st.Entries.GetEnumerator()) {
            $e = $kv.Value
            if ($e.Deleted) { continue }
            $parts = [CdmLevelDb]::SplitKey($e.Key)
            if ($parts -and $parts[1] -eq $Name) { return ([CdmLevelDb]::DecodeValue($e.Value)).Trim('"') }
        }
    } catch { }
    return $null
}

# ---------- 環境（Local Storage）合併 ----------

function Get-PlaceKey($Target) {
    if (-not $Target) { return '||' }
    return ('{0}|{1}|{2}' -f $Target.kind, $Target.cwd, $Target.wslDistro)
}

# 來源有、目標沒有（同資料夾、同 id 都算有）的環境＝可以搬的候選；目標已有的列為略過
function Get-PresetCandidates($A, $B) {
    $have = @{}; $ids = @{}
    foreach ($p in (As-Array $B.presets)) { $have[(Get-PlaceKey $p.target)] = $true; $ids[[string]$p.id] = $true }
    $cand = New-Object System.Collections.ArrayList
    $skipped = New-Object System.Collections.ArrayList
    foreach ($p in (As-Array $A.presets)) {
        $k = Get-PlaceKey $p.target
        if ($have.ContainsKey($k) -or $ids.ContainsKey([string]$p.id)) { [void]$skipped.Add([string]$p.name); continue }
        [void]$cand.Add($p); $have[$k] = $true
    }
    return [pscustomobject]@{ Candidates = @($cand); Skipped = @($skipped) }
}

# placeDefaults 的鍵是「種類:發行版:資料夾」，資料夾本身可能含冒號（C:\...）
function Get-DefaultsFolder([string]$Key) { $parts = $Key.Split(':', 3); if ($parts.Count -eq 3) { return $parts[2] } return $Key }

# 把來源狀態 $A 併進目標狀態 $B（就地修改 $B）。目標已有同資料夾的環境就保留目標的。
# $OnlyIds：只搬這些環境（$null＝候選全部）；$Folders：資料夾設定只搬這些資料夾的（$null＝全部）。
function Merge-PresetState($A, $B, $OnlyIds, $Folders) {
    $c = Get-PresetCandidates $A $B
    $list = New-Object System.Collections.ArrayList
    foreach ($p in (As-Array $B.presets)) { [void]$list.Add($p) }
    $added = New-Object System.Collections.ArrayList
    $newIds = @{}
    foreach ($p in $c.Candidates) {
        if ($null -ne $OnlyIds -and -not $OnlyIds.ContainsKey([string]$p.id)) { continue }
        [void]$list.Add($p); [void]$added.Add([string]$p.name); $newIds[[string]$p.id] = $true
    }
    Set-Prop $B 'presets' @($list)
    $extra = 0

    if (Has $A 'placeDefaults') {
        if (-not (Has $B 'placeDefaults') -or $null -eq $B.placeDefaults) { Set-Prop $B 'placeDefaults' ([pscustomobject]@{}) }
        foreach ($prop in $A.placeDefaults.PSObject.Properties) {
            if ($null -ne $Folders -and -not $Folders.ContainsKey((Get-DefaultsFolder $prop.Name))) { continue }
            if ($null -eq $B.placeDefaults.PSObject.Properties[$prop.Name]) {
                $B.placeDefaults | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value
                $extra++
            }
        }
    }
    if (Has $A 'startedPlaces') {
        $places = New-Object System.Collections.ArrayList
        $seen = @{}
        foreach ($p in (As-Array $B.startedPlaces)) { [void]$places.Add($p); $seen[(Get-PlaceKey $p.target)] = $true }
        foreach ($p in (As-Array $A.startedPlaces)) {
            if ($null -ne $Folders -and -not ($p.target -and $Folders.ContainsKey([string]$p.target.cwd))) { continue }
            if (-not $seen.ContainsKey((Get-PlaceKey $p.target))) { [void]$places.Add($p); $newIds[[string]$p.id] = $true; $extra++ }
        }
        Set-Prop $B 'startedPlaces' @($places)
    }
    if (Has $A 'startedFrom') {
        $from = New-Object System.Collections.ArrayList
        foreach ($x in (As-Array $B.startedFrom)) { if (-not $from.Contains($x)) { [void]$from.Add($x) } }
        foreach ($x in (As-Array $A.startedFrom)) {
            # 全搬時照舊取聯集；有選擇時只帶跟著搬過去的環境與位置
            if (($null -eq $OnlyIds -and $null -eq $Folders) -or $newIds.ContainsKey([string]$x)) { if (-not $from.Contains($x)) { [void]$from.Add($x) } }
        }
        Set-Prop $B 'startedFrom' @($from)
    }
    return [pscustomobject]@{ Added = @($added); Skipped = @($c.Skipped); Extra = $extra }
}

# ---------- 選擇要搬什麼 ----------

function Get-ProjectKey($E) {
    if ((Has $E 'originCwd') -and $E.originCwd) { return [string]$E.originCwd }
    return [string]$E.cwd
}

# 「1,3,5-7」→ 1、3、5、6、7；a＝全部。看不懂回 $null。
function Parse-Picks([string]$Text, [int]$Max) {
    $t = $Text.Trim().ToLower()
    if ($t -eq 'a') { return , @(1..$Max) }
    if ($t -eq '') { return $null }
    $out = New-Object System.Collections.ArrayList
    foreach ($part in $t.Split(',')) {
        $q = $part.Trim()
        if ($q -match '^(\d+)-(\d+)$') { $lo = [int]$Matches[1]; $hi = [int]$Matches[2] }
        elseif ($q -match '^\d+$') { $lo = [int]$q; $hi = $lo }
        else { return $null }
        if ($lo -lt 1 -or $hi -gt $Max -or $lo -gt $hi) { return $null }
        foreach ($i in $lo..$hi) { if (-not $out.Contains($i)) { [void]$out.Add($i) } }
    }
    return , @($out)
}

# 讓人從清單勾選，回傳選到的列。順序：測試替身 → 跳出的勾選視窗 → 終端機輸入編號。
$script:TestPicks = $null
if ($env:BRAID_TEST_PICKS) { $script:TestPicks = New-Object System.Collections.Queue(, [object[]]$env:BRAID_TEST_PICKS.Split(';')) }
function Select-Rows([string]$Title, $Rows) {
    if ($null -ne $script:TestPicks) {
        $text = if ($script:TestPicks.Count) { $script:TestPicks.Dequeue() } else { '' }
        $idx = Parse-Picks $text $Rows.Count
        return , @($Rows | Where-Object { $idx -contains $_.'編號' })
    }
    if (Get-Command Out-GridView -ErrorAction SilentlyContinue) {
        try { return , @($Rows | Out-GridView -Title $Title -PassThru) } catch { Say "  打不開勾選視窗（$($_.Exception.Message)），改在這裡輸入編號。" Yellow }
    }
    Say $Title Cyan
    foreach ($r in $Rows) { Say ('  {0,3}. {1}  {2}' -f $r.'編號', $r.'類型', $r.'名稱') }
    while ($true) {
        $idx = Parse-Picks (Read-Host '輸入要搬的編號（例如 1,3,5-7；a＝全部）') $Rows.Count
        if ($null -ne $idx) { return , @($Rows | Where-Object { $idx -contains $_.'編號' }) }
        Say '  看不懂，請再輸入一次。' Yellow
    }
}

# 決定要搬哪些。回傳三個集合（$null＝不限）：專案資料夾、對話檔名、環境 id。
function Select-Migration($Copy, $PresetCands, [string]$TargetName) {
    $result = [pscustomobject]@{ Projects = $null; Sessions = $null; PresetIds = $null }
    $listed = @{ 'all' = $true; '' = $true }
    if ($Projects -or $Presets) {
        # 參數直接指定：all＝全部、none＝都不要、其他＝逗號分隔的資料夾或環境名稱
        if ($Projects -and -not $listed.ContainsKey($Projects.Trim().ToLower())) {
            $result.Projects = @{}
            if ($Projects.Trim().ToLower() -ne 'none') { foreach ($f in $Projects.Split(',')) { $result.Projects[$f.Trim()] = $true } }
        }
        if ($Presets -and -not $listed.ContainsKey($Presets.Trim().ToLower())) {
            $result.PresetIds = @{}
            if ($Presets.Trim().ToLower() -eq 'folders') {
                # folders＝環境跟著資料夾走：只帶工作資料夾在選到的專案裡的（同步用）
                foreach ($p in $PresetCands) {
                    $cwd = if ((Has $p 'target') -and (Has $p.target 'cwd')) { [string]$p.target.cwd } else { '' }
                    if ($null -eq $result.Projects -or $result.Projects.ContainsKey($cwd)) { $result.PresetIds[[string]$p.id] = $true }
                }
            } elseif ($Presets.Trim().ToLower() -ne 'none') {
                $names = @{}; foreach ($n in $Presets.Split(',')) { $names[$n.Trim()] = $true }
                foreach ($p in $PresetCands) { if ($names.ContainsKey([string]$p.name)) { $result.PresetIds[[string]$p.id] = $true } }
            }
        }
        return $result
    }
    if ($null -eq $script:TestPicks -and ($Yes -or -not $Interactive)) { return $result }

    # 第一步：專案（依最近活動排）＋環境
    $groups = [ordered]@{}
    foreach ($x in @($Copy | Sort-Object { if (Has $_.Data 'lastActivityAt') { $_.Data.lastActivityAt } else { 0 } } -Descending)) {
        $k = Get-ProjectKey $x.Data
        if (-not $groups.Contains($k)) { $groups[$k] = New-Object System.Collections.ArrayList }
        [void]$groups[$k].Add($x)
    }
    if ($groups.Count + @($PresetCands).Count -eq 0) { return $result }
    $rows = New-Object System.Collections.ArrayList
    $n = 0
    foreach ($k in $groups.Keys) {
        $n++; $first = $groups[$k][0].Data
        [void]$rows.Add([pscustomobject]@{ '編號' = $n; '類型' = '專案'; '名稱' = $k; '對話數' = $groups[$k].Count; '最近的對話' = $(if (Has $first 'title') { $first.title } else { '' }); '最後活動' = (Format-Time $first.lastActivityAt) })
    }
    foreach ($p in $PresetCands) {
        $n++
        [void]$rows.Add([pscustomobject]@{ '編號' = $n; '類型' = '環境'; '名稱' = [string]$p.name; '對話數' = ''; '最近的對話' = [string]$p.target.cwd; '最後活動' = '' })
    }
    while ($true) {
        $picked = Select-Rows "勾選要搬到 $TargetName 的專案與環境（Ctrl+A 全選；Ctrl＋點擊可多選），按「確定」" $rows
        if ($picked.Count) { break }
        $a = Ask '沒有勾任何項目。[R] 重新選  [A] 全部都搬  [C] 取消' @('R', 'A', 'C') '' 'C'
        if ($a -eq 'A') { return $result }
        if ($a -eq 'C') { throw 'CANCEL' }
    }
    $result.Projects = @{}; $result.PresetIds = @{}
    foreach ($r in $picked) {
        if ($r.'類型' -eq '專案') { $result.Projects[[string]$r.'名稱'] = $true }
        else { foreach ($p in $PresetCands) { if ([string]$p.name -eq $r.'名稱') { $result.PresetIds[[string]$p.id] = $true } } }
    }

    # 第二步（可選）：在選到的專案裡逐筆挑對話
    if ($result.Projects.Count) {
        $expand = 'N'
        if ($null -ne $script:TestPicks) { if ($script:TestPicks.Count -and $script:TestPicks.Peek()) { $expand = 'Y' } }
        else { $expand = Ask '要在這些專案裡逐筆挑選對話嗎？[Y/N]（直接按 Enter＝N，整個專案都搬）' @('Y', 'N') 'N' 'N' }
        if ($expand -eq 'Y') {
            $srows = New-Object System.Collections.ArrayList
            $n = 0
            foreach ($k in $groups.Keys) {
                if (-not $result.Projects.ContainsKey($k)) { continue }
                foreach ($x in $groups[$k]) {
                    $n++
                    [void]$srows.Add([pscustomobject]@{ '編號' = $n; '類型' = '對話'; '名稱' = $(if (Has $x.Data 'title') { $x.Data.title } else { '（無標題）' }); '專案' = $k; '最後活動' = (Format-Time $x.Data.lastActivityAt); '檔名' = $x.File.Name })
                }
            }
            $spicked = Select-Rows '勾選要搬的對話（Ctrl+A 全選後，Ctrl＋點擊取消不要的），按「確定」' $srows
            $result.Sessions = @{}
            foreach ($r in $spicked) { $result.Sessions[[string]$r.'檔名'] = $true }
        }
    }
    return $result
}

# ---------- 還原 ----------

function Test-SameSet($A, $B) { return ((@($A | Sort-Object) -join "`n") -eq (@($B | Sort-Object) -join "`n")) }

# 還原側欄：只拿掉那次寫進去的紀錄（manifest 的 addedSessions），之後新開的、遷移後在新帳號用過的都留著。
# 不整個資料夾換回備份：開著 braid 的同步時，換掉的紀錄會從另一個帳號再被帶回來，之後新開的對話也會從側欄消失。
# 不寫刪除紀錄（deleted_<id>）：同步夥伴若就是遷移來源，braid 會照刪除紀錄把來源帳號原本那份也刪掉。
function Undo-Added($m, [string]$Dir) {
    $removed = 0
    $kept = New-Object System.Collections.ArrayList
    $keptIds = @{}
    foreach ($entry in (As-Array $m.addedSessions)) {
        $file = [string]$entry.file
        $rec = Join-Path $m.sessionsDir $file
        if (-not (Test-Path -LiteralPath $rec)) { continue }
        $now = $null
        try { $now = (Read-JsonFile $rec).lastActivityAt } catch { $now = $null }
        if ($null -ne $now -and $null -ne $entry.lastActivityAt -and [double]$now -gt [double]$entry.lastActivityAt) {
            [void]$kept.Add($file); $keptIds[$file.Substring(0, $file.Length - 5)] = $true; continue
        }
        $ok = Invoke-Step "拿掉「$file」" {
            if (Test-Path -LiteralPath "$rec.tmp") { Remove-Item -LiteralPath "$rec.tmp" -Force }   # app 載入時會把孤兒 .tmp 救回成紀錄
            Remove-Item -LiteralPath $rec -Force
        }
        if ($ok) { $removed++ }
    }
    $idx = Join-Path $m.sessionsDir $spec.sessions.archivedIndex
    $idxBak = Join-Path (Join-Path $Dir 'sessions') $spec.sessions.archivedIndex
    $undo = @((As-Array $m.addedArchived) | Where-Object { -not $keptIds.ContainsKey([string]$_) })
    if ($undo.Count -gt 0 -and (Test-Path -LiteralPath $idx)) {
        Invoke-Step '還原封存清單' {
            $cur = Read-JsonFile $idx
            $left = @((As-Array $cur.archived) | Where-Object { $undo -notcontains $_ })
            $was = if (Test-Path -LiteralPath $idxBak) { @(As-Array (Read-JsonFile $idxBak).archived) } else { @() }
            if (Test-SameSet $left $was) {   # 和備份時一樣：放回備份那份（備份時沒有就拿掉）
                if (Test-Path -LiteralPath $idxBak) { Copy-Item -LiteralPath $idxBak -Destination $idx -Force } else { Remove-Item -LiteralPath $idx -Force }
            } else {
                Set-Prop $cur 'archived' $left
                Write-JsonFile $idx $cur
            }
        } | Out-Null
    }
    Say "側欄：拿掉這次搬進來的 $removed 筆。" Green
    if ($kept.Count -gt 0) { Say "遷移後在新帳號用過的 $($kept.Count) 筆留著：$($kept -join '、')" Yellow }
}

function Invoke-Restore([string]$Dir) {
    $manifestPath = Join-Path $Dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "這不是遷移備份資料夾（找不到 manifest.json）：$Dir" }
    $m = Read-JsonFile $manifestPath
    Wait-AppClosed
    Say "從備份還原：$Dir"
    if ((Has $m 'sessionsDir') -and (Test-Path -LiteralPath (Join-Path $Dir 'sessions'))) {
        if (Has $m 'addedSessions') { Undo-Added $m $Dir }
        else {
            Say '這份備份是舊版工具做的，沒有記下搬了哪些：側欄清單整個換回備份時的樣子（之後新開的對話也會從側欄拿掉，對話紀錄檔還在）。' Yellow
            Invoke-Step '還原 session 清單' {
                if (Test-Path -LiteralPath $m.sessionsDir) { Remove-Item -LiteralPath $m.sessionsDir -Recurse -Force }
                Copy-Item -LiteralPath (Join-Path $Dir 'sessions') -Destination $m.sessionsDir -Recurse
            } | Out-Null
        }
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

    # 試跑只讀不寫，app 開著也能看；正式寫入才要等 app 結束（它開著時會把寫入蓋回去）
    if ($DryRun) { Say '試跑：只讀不寫，Claude 開著也沒關係。' DarkGray } else { Wait-AppClosed }

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

    # 目前登入的帳號：config.json 與 Local Storage 各記一份，說法不一致就停，避免搬錯方向
    $lsDir = Join-Path $AppDataRoot ($spec.presets.localStorageDir -replace '/', '\')
    $email = $null
    if ($lsAvailable -and (Test-Path -LiteralPath $lsDir)) {
        $email = Get-LsString $lsDir $spec.app.loginEmailKey
        $confirmed = Get-LsString $lsDir $spec.app.confirmedAccountKey
        if ($confirmed -and $confirmed -ne $current) {
            Say '桌面 app 的兩處紀錄對「目前登入哪個帳號」說法不一致。為了不搬錯方向，先停下來。' Red
            Say '請打開桌面 app，確認登入的是要搬過去的帳號（例如公司帳號），在 Code 分頁開一個對話，結束 app 後再執行一次。'
            exit 2
        }
    }
    $targetName = if ($email) { $email } else { "帳號 $(Short $target.Account)…（讀不到登入信箱）" }

    $sources = @($profiles | Where-Object { $_.Dir -ne $target.Dir -and $_.Count -gt 0 } | Sort-Object Last -Descending)
    if ($sources.Count -eq 0) { Say '這台電腦上沒有其他帳號的 session 可以遷移。' Green; return }

    Say "目前登入（搬到這裡）：$targetName" Cyan
    Say '  不是你要搬過去的帳號（例如公司帳號）的話，現在按 Ctrl+C 取消，到桌面 app 換帳號後再執行。' Yellow
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
    if ($lsAvailable -and (Test-Path -LiteralPath $lsDir)) {
        try {
            $state = [CdmLevelDb]::Read($lsDir, $spec.presets.keyPrefix, [bool]$DryRun)
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
                $c = Get-PresetCandidates $a.state $b.state
                $plan.Skipped = $c.Skipped
                $plan.Status = 'pending'; $plan.Origin = $byName[$s.Dst].Origin
                $plan | Add-Member -NotePropertyName A -NotePropertyValue $a.state
                $plan | Add-Member -NotePropertyName B -NotePropertyValue $b
                $plan | Add-Member -NotePropertyName Candidates -NotePropertyValue $c.Candidates
            }
        } catch {
            Say "讀不了環境資料：$($_.Exception.Message)" Yellow
            $a = Ask '  [Y] 只搬側欄 session、略過環境  [N] 取消（直接按 Enter＝Y）' @('Y', 'N') 'Y' 'Y'
            if ($a -ne 'Y') { throw 'CANCEL' }
            $presetPlans.Clear()
            [void]$presetPlans.Add([pscustomobject]@{ Scope = 'account'; Label = '帳號層級'; Status = 'skip'; Reason = 'read-failed'; Added = @(); Skipped = @() })
        }
    }

    # --- 選擇要搬什麼，再依選擇合併環境 ---
    $acctCands = @($presetPlans | Where-Object { $_.Scope -eq 'account' -and $_.Status -eq 'pending' } | ForEach-Object { $_.Candidates })
    $sel = Select-Migration $copy $acctCands $targetName
    if ($null -ne $sel.Projects -or $null -ne $sel.Sessions) {
        $kept = New-Object System.Collections.ArrayList
        foreach ($x in $copy) {
            $ok = ($null -eq $sel.Projects -or $sel.Projects.ContainsKey((Get-ProjectKey $x.Data))) -and ($null -eq $sel.Sessions -or $sel.Sessions.ContainsKey($x.File.Name))
            if ($ok) { [void]$kept.Add($x) }
            else { [void]$skip.Add([pscustomobject]@{ File = $x.File.Name; Title = $(if (Has $x.Data 'title') { $x.Data.title } else { '（無標題）' }); Reason = 'not-selected' }) }
        }
        $copy = $kept
        $present = @{}
        foreach ($n in $tgtNames.Keys) { $present[$n.Substring(0, $n.Length - 5)] = $true }
        foreach ($x in $copy) { $present[$x.File.BaseName] = $true }
        $addArchived = New-Object System.Collections.ArrayList
        if (Test-Path -LiteralPath $idxSrc) {
            foreach ($id in (As-Array (Read-JsonFile $idxSrc).archived)) {
                if ($present.ContainsKey($id) -and -not ((As-Array $dstIdx.archived) -contains $id)) { [void]$addArchived.Add($id) }
            }
        }
    }
    # 資料夾設定（預設模型、最近位置）只跟著選到的專案與環境走，個人專案不會被帶進公司帳號
    $folders = $null
    if ($null -ne $sel.Projects -or $null -ne $sel.PresetIds) {
        $folders = @{}
        if ($null -ne $sel.Projects) { foreach ($k in $sel.Projects.Keys) { $folders[$k] = $true } } else { foreach ($x in $copy) { $folders[(Get-ProjectKey $x.Data)] = $true } }
        foreach ($p in $acctCands) { if ($null -eq $sel.PresetIds -or $sel.PresetIds.ContainsKey([string]$p.id)) { $folders[[string]$p.target.cwd] = $true } }
    }
    foreach ($plan in @($presetPlans | Where-Object { $_.Status -eq 'pending' })) {
        $m = Merge-PresetState $plan.A $plan.B.state $sel.PresetIds $folders
        $plan.Added = $m.Added
        if ($m.Added.Count -eq 0 -and $m.Extra -eq 0) { $plan.Status = 'nothing-new'; continue }
        $plan.Status = 'merge'
        $plan.NewJson = ConvertTo-Json -InputObject $plan.B -Depth 100 -Compress
        $plan.Presets = $plan.B.state.presets
    }

    # --- 列出計畫 ---
    $reasonText = @{
        'exists' = '新帳號已經有了'; 'tombstone' = '曾在新帳號刪除過'; 'invalid' = '檔案格式不符'
        'missing-transcript' = '找不到對話紀錄檔'; 'unverifiable-declined' = '你選擇不複製'; 'not-selected' = '沒有勾選'
    }
    Say '== 遷移計畫 ==' Cyan
    Say "側欄 session：複製 $($copy.Count) 筆，略過 $($skip.Count) 筆；封存狀態補 $($addArchived.Count) 筆"
    foreach ($x in $copy) { Say "  + $(if (Has $x.Data 'title') { $x.Data.title } else { '（無標題）' })" Green }
    foreach ($s in ($skip | Where-Object { $_.Reason -ne 'exists' -and $_.Reason -ne 'not-selected' })) { Say "  - $($s.Title)（$($reasonText[$s.Reason])）" DarkGray }
    $notSel = @($skip | Where-Object { $_.Reason -eq 'not-selected' }).Count
    if ($notSel -gt 0) { Say "  （另有 $notSel 筆沒有勾選，留在原帳號）" DarkGray }
    $existsCount = @($skip | Where-Object { $_.Reason -eq 'exists' }).Count
    if ($existsCount -gt 0) { Say "  （另有 $existsCount 筆新帳號已經有了）" DarkGray }
    Say '已儲存的環境：'
    if ($presetPlans.Count -eq 0) { Say '  這台電腦沒有環境資料，略過。' DarkGray }
    foreach ($p in $presetPlans) {
        switch ($p.Status) {
            'merge' {
                if ($p.Added.Count) { Say "  $($p.Label)：加入 $($p.Added -join '、')" Green } else { Say "  $($p.Label)：補上選到的資料夾的預設設定" Green }
                if ($p.Skipped.Count) { Say "    略過（新帳號已有同一個資料夾）：$($p.Skipped -join '、')" DarkGray }
            }
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
            target   = [ordered]@{ account = $target.Account; org = $target.Org; email = $email }
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
    if ($DryRun) { Say '試跑模式：沒有寫入任何東西。要正式搬，不加 -DryRun 再跑一次（會請你先結束 Claude）。' Cyan; return }
    Say ("確認方向：把帳號 {0}… 的資料（{1} 筆對話，環境 {2} 層）複製到 {3}。" -f (Short $source.Account), $copy.Count, $mergeScopes.Count, $targetName) Yellow
    $go = Ask '  方向對嗎？輸入 Y 開始寫入，N 取消' @('Y', 'N') '' 'Y'
    if ($go -ne 'Y') { throw 'CANCEL' }

    # --- 備份 ---
    $mirrorPath = Join-Path $AppDataRoot $spec.presets.mirrorFile
    $script:BackupDir = Join-Path $BackupRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
    $base = $script:BackupDir; $i = 2
    while (Test-Path -LiteralPath $script:BackupDir) { $script:BackupDir = "$base-$i"; $i++ }   # 同一秒跑兩次也不會疊進同一個資料夾
    Invoke-Step '備份' {
        New-Item -ItemType Directory -Path $script:BackupDir -Force | Out-Null
        $manifest = [ordered]@{ createdAt = (Get-Date).ToString('o'); sessionsDir = $target.Dir }
        # 還原只拿掉這次寫進去的：檔名與寫入時的最後活動時間（之後在新帳號用過的，還原時留著）、這次補進封存清單的
        $manifest.addedSessions = @($copy | ForEach-Object { [ordered]@{ file = $_.File.Name; lastActivityAt = $(if (Has $_.Data 'lastActivityAt') { $_.Data.lastActivityAt } else { $null }) } })
        $manifest.addedArchived = @($addArchived)
        Copy-Item -LiteralPath $target.Dir -Destination (Join-Path $script:BackupDir 'sessions') -Recurse
        if ($mergeScopes.Count -gt 0) {
            Copy-Item -LiteralPath $lsDir -Destination (Join-Path $script:BackupDir 'leveldb') -Recurse
            $manifest.localStorageDir = $lsDir
            if (Test-Path -LiteralPath $mirrorPath) {
                Copy-Item -LiteralPath $mirrorPath -Destination (Join-Path $script:BackupDir 'mirror.json')
                $manifest.mirrorFile = $mirrorPath
            }
        }
        [IO.File]::WriteAllText((Join-Path $script:BackupDir 'manifest.json'), (ConvertTo-Json -InputObject $manifest -Depth 5), $Utf8)
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
