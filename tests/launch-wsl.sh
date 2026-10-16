#!/usr/bin/env bash
# 測 mod/tool/launch-from-wsl.sh：用假的 cmd.exe／powershell.exe 頂替，不會真的開視窗。
set -euo pipefail
cd "$(dirname "$0")"
REAL_TEMP=$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' | tr -d '\r')
FAKE=/tmp/cdm-fake-bin; rm -rf "$FAKE"; mkdir -p "$FAKE"
TEST_TEMP="$REAL_TEMP\\cdm-launch-test"
printf '#!/bin/bash\necho "%s"\n' "$TEST_TEMP" > "$FAKE/cmd.exe"
printf '#!/bin/bash\nprintf "%%s\\n" "$@" > %s/args\n' "$FAKE" > "$FAKE/powershell.exe"
chmod +x "$FAKE"/*.exe
ok() { echo "  ok  $1"; }; ng() { echo "  NG  $1"; exit 1; }

for mode in normal dry; do
  arg=(); [ $mode = dry ] && arg=(-DryRun)
  out=$(PATH="$FAKE:$PATH" bash ../mod/tool/launch-from-wsl.sh "${arg[@]}")
  dest="$(wslpath -u "$TEST_TEMP")/switchboard"
  for f in spec.json windows/migrate.ps1 windows/migrate.cmd windows/LevelDbLite.cs; do
    cmp -s "../mod/tool/$f" "$dest/$f" || ng "[$mode] $f 沒有完整複製到 Windows 暫存"
  done
  ok "[$mode] 工具完整複製到 Windows 暫存資料夾"
  mapfile -t a < "$FAKE/args"
  [ "${a[0]}" = "-NoProfile" ] && [ "${a[1]}" = "-Command" ] || ng "[$mode] powershell 參數不對：${a[*]}"
  want="Start-Process -FilePath '$TEST_TEMP\\switchboard\\windows\\migrate.cmd'"
  [ $mode = dry ] && want="$want -ArgumentList '-DryRun'"
  [ "${a[2]}" = "$want" ] || ng "[$mode] Start-Process 指令不對：${a[2]}"
  ok "[$mode] 用 Start-Process 開 Windows 路徑上的 migrate.cmd"
  echo "$out" | grep -q '已開啟遷移視窗' && ok "[$mode] 回報已開啟" || ng "[$mode] 沒有回報"
done
rm -rf "$(wslpath -u "$TEST_TEMP")" "$FAKE"
echo; echo "WSL 啟動腳本測試全部通過"
