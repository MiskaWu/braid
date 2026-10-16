#!/usr/bin/env bash
# 從 WSL 開 Windows 端的遷移視窗。/desktop-migrate 在 WSL 裡的 session 呼叫這支。
# 先把工具複製到 Windows 的暫存資料夾再開，不直接從 \\wsl.localhost 跑：
#   cmd.exe 不支援網路路徑當工作目錄；而且結束 Claude 之後 WSL 可能跟著關，路徑會消失。
# 視窗用 Start-Process 開，是獨立的 Windows 行程，結束 Claude 不會把它一起關掉。
# 用法：launch-from-wsl.sh [migrate.ps1 的參數…]，例如 -DryRun、-From <帳號> -Projects "a,b" -Presets folders、-Restore <資料夾>
# 參數名稱原樣傳，值加上雙引號（cmd 的 %* 會原樣交給 PowerShell）；值裡有 " 或 % 會被 cmd 解讀，直接拒絕。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

win() {  # 找 Windows 端的執行檔：PATH 上沒有就用預設位置
  command -v "$1" 2>/dev/null || echo "/mnt/c/Windows/System32/${2:-}$1"
}
CMD=$(win cmd.exe)
PWSH=$(win powershell.exe WindowsPowerShell/v1.0/)

wintemp="$("$CMD" /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')"
[ -n "$wintemp" ] || { echo "讀不到 Windows 的暫存資料夾位置" >&2; exit 1; }
dest="$(wslpath -u "$wintemp")/braid"
rm -rf "$dest"
mkdir -p "$dest"
cp -r "$here/windows" "$here/spec.json" "$dest/"

psq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }
list=""
for a in "$@"; do
  case "$a" in *'"'*|*%*) echo "參數裡不能有 \" 或 %：$a" >&2; exit 2 ;; esac
  if [[ "$a" == -* ]]; then item="$a"; else item="\"$a\""; fi
  list="${list:+$list,}$(psq "$item")"
done
ps="Start-Process -FilePath $(psq "$(wslpath -w "$dest/windows/migrate.cmd")")"
if [ -n "$list" ]; then ps="$ps -ArgumentList $list"; fi
cd "$dest"
"$PWSH" -NoProfile -Command "$ps"
echo "已開啟遷移視窗：$(wslpath -w "$dest")"
