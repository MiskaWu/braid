#!/usr/bin/env bash
# 從 WSL 開一個新的 Windows 終端機視窗，在同一個 WSL 發行版裡執行 <腳本>（braid 的「接著做」與「新增帳號」）。
# 用 Start-Process 開，是獨立的 Windows 行程：Claude 結束了它也還在，使用者在那個視窗裡接著工作。
# 只把發行版名稱與腳本路徑交給 Windows 端（都是簡單的字），其餘參數已經寫在腳本裡，不經過 Windows 的引號規則。
# 用法：open-wsl.sh <腳本>
set -euo pipefail
script=${1:?用法：open-wsl.sh <腳本>}
distro=${WSL_DISTRO_NAME:?不在 WSL 裡}

win() {  # 找 Windows 端的執行檔：PATH 上沒有就用預設位置
  command -v "$1" 2>/dev/null || echo "/mnt/c/Windows/System32/${2:-}$1"
}
PWSH=$(win powershell.exe WindowsPowerShell/v1.0/)
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

# 從 Windows 的資料夾啟動，避免 \\wsl.localhost 當工作目錄
cd "$(dirname "$PWSH")"
"$PWSH" -NoProfile -Command "Start-Process -FilePath 'wsl.exe' -ArgumentList $(q -d),$(q "$distro"),$(q --cd),$(q '~'),$(q -e),$(q bash),$(q "$script")"
