# 測試用：直接呼叫 LevelDbLite 的追加寫入。
param([string]$Dir, [string]$KeyFile, [string]$ValueFile, [string]$Mode = 'append')
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '..\mod\tool\windows\LevelDbLite.cs')
switch ($Mode) {
    'append' {
        $seq = [CdmLevelDb]::Append($Dir, [IO.File]::ReadAllBytes($KeyFile), [IO.File]::ReadAllBytes($ValueFile))
        $st = [CdmLevelDb]::Read($Dir, 'probe')
        "seq=$seq maxSeq=$($st.MaxSeq) found=$($st.Entries.Count)"
    }
    'held' {
        # 模擬 app 開著：像 Chromium 一樣以「允許別人讀寫」開著 MANIFEST 與日誌在寫
        $handles = @(Get-ChildItem -LiteralPath $Dir | Where-Object { $_.Name -like 'MANIFEST-*' -or $_.Name -like '*.log' } |
                ForEach-Object { [IO.File]::Open($_.FullName, 'Open', 'ReadWrite', 'ReadWrite') })
        try {
            try { $st = [CdmLevelDb]::Read($Dir, 'old', $true); "read-ok found=$($st.Entries.Count)" } catch { "read-failed: $($_.Exception.Message)" }
            try { [void][CdmLevelDb]::Append($Dir, [byte[]](1, 2), [byte[]](3)); 'append-ok' } catch { 'append-refused' }
        } finally { $handles | ForEach-Object { $_.Dispose() } }
    }
    'tail' {
        try { $st = [CdmLevelDb]::Read($Dir, 'old', $true); "tolerant-ok found=$($st.Entries.Count)" } catch { "tolerant-failed: $($_.Exception.Message)" }
        try { [void][CdmLevelDb]::Read($Dir, 'old', $false); 'strict-ok' } catch { 'strict-refused' }
        try { [void][CdmLevelDb]::Append($Dir, [byte[]](1, 2), [byte[]](3)); 'append-ok' } catch { 'append-refused' }
    }
}
