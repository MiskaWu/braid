# 測試用：直接呼叫 LevelDbLite 的追加寫入。
param([string]$Dir, [string]$KeyFile, [string]$ValueFile)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '..\windows\LevelDbLite.cs')
$seq = [CdmLevelDb]::Append($Dir, [IO.File]::ReadAllBytes($KeyFile), [IO.File]::ReadAllBytes($ValueFile))
$st = [CdmLevelDb]::Read($Dir, 'probe')
"seq=$seq maxSeq=$($st.MaxSeq) found=$($st.Entries.Count)"
