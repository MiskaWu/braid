#!/usr/bin/env bash
# 測 mod/tool/windows 的帳號腳本：在 WSL 裡叫 Windows 的 powershell.exe 跑。
#   secret.ps1：真的寫進「認證管理員」再讀回、刪掉（用測試專用的名稱，跑完一定刪）
#   resume.ps1：用假的 claude.cmd 頂替，驗參數、工作資料夾（中文）、憑證只在那個視窗的環境變數
#   add-account.ps1：用假的 claude.cmd 頂替 setup-token，從標準輸入貼憑證
set -uo pipefail
cd "$(dirname "$0")"
ok() { echo "  ok  $1"; }
ng() { echo "  NG  $1"; cleanup; exit 1; }
TOKEN='sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij-0123456789'
ID="braid-test-$$"
WINTEMP=$(wslpath -u "$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' | tr -d '\r')")
W="$WINTEMP/braid-cli-test-$$"
mkdir -p "$W/中文 資料夾"
SECRET=$(wslpath -w ../mod/tool/windows/secret.ps1)
# 每次都限時：腳本卡在等輸入時不要整個測試掛住
ps() { (cd /mnt/c && timeout 60 powershell.exe -NoProfile -ExecutionPolicy Bypass "$@") | tr -d '\r'; }
cleanup() {
  for id in "$ID" "$ID-add" "$ID-add2"; do ps -File "$SECRET" delete "$id" >/dev/null 2>&1; done
  rm -rf "$W"
}

echo "######## secret.ps1（Windows 認證管理員）"
out=$(printf '%s\n' "$TOKEN" | ps -File "$SECRET" set "$ID") && [ "$out" = credman ] && ok "存進認證管理員，回報 credman" || ng "set 失敗：$out"
[ "$(ps -File "$SECRET" get "$ID")" = "$TOKEN" ] && ok "讀回同一個憑證" || ng "讀回來不一樣"
printf 'not-a-token' | ps -File "$SECRET" set "$ID-bad" >/dev/null 2>&1; [ ${PIPESTATUS[1]} = 2 ] || true
ps -File "$SECRET" get "$ID-bad" >/dev/null 2>&1 && ng "存了不像憑證的東西" || ok "不像憑證的不存"

echo "######## resume.ps1"
# 假的 claude：記下參數、工作資料夾、環境變數裡的憑證與不該帶過來的變數
cat > "$W/claude.cmd" <<'EOF'
@echo off
> "%~dp0out.txt" echo args=%*
>> "%~dp0out.txt" echo cwd=%CD%
>> "%~dp0out.txt" echo token=%CLAUDE_CODE_OAUTH_TOKEN%
>> "%~dp0out.txt" echo account=%BRAID_ACCOUNT%
>> "%~dp0out.txt" echo leftover=%CLAUDECODE%%BRAID_SESSION%%BRAID_CREDENTIAL%
EOF
sed -i 's/$/\r/' "$W/claude.cmd"
BRAID_ACCOUNT=acct-1 BRAID_CREDENTIAL="$ID" BRAID_SESSION=sess-1 BRAID_CWD="$(wslpath -w "$W/中文 資料夾")" BRAID_CLAUDE="$(wslpath -w "$W/claude.cmd")" BRAID_LABEL='公司 2' CLAUDECODE=1 \
  WSLENV="BRAID_ACCOUNT:BRAID_CREDENTIAL:BRAID_SESSION:BRAID_CWD:BRAID_CLAUDE:BRAID_LABEL:CLAUDECODE${WSLENV:+:$WSLENV}" \
  ps -File "$(wslpath -w ../mod/tool/windows/resume.ps1)" </dev/null >/dev/null 2>&1
out=$(iconv -f cp950 -t utf-8 "$W/out.txt" 2>/dev/null || cat "$W/out.txt")
out=$(printf '%s' "$out" | tr -d '\r')
echo "$out" | grep -qx "args=--resume sess-1 --fork-session" && ok "用 --resume 加 --fork-session 接著同一段對話" || ng "參數不對：$out"
echo "$out" | grep -q "^cwd=.*braid-cli-test-$$\\\\中文 資料夾$" && ok "中文、空白的工作資料夾原樣送到" || ng "資料夾不對：$out"
echo "$out" | grep -qx "token=$TOKEN" && ok "憑證從認證管理員取出，放進那個視窗的 claude" || ng "憑證沒送到：$out"
echo "$out" | grep -qx "account=acct-1" && ok "新的對話知道自己是哪個帳號" || ng "帳號 id 不對：$out"
echo "$out" | grep -qx "leftover=" && ok "上一個對話與 braid 自己的參數變數都清掉了" || ng "還帶著變數：$out"

echo "######## add-account.ps1"
cat > "$W/claude-setup.cmd" <<'EOF'
@echo off
if "%1"=="setup-token" echo (fake setup-token)
EOF
sed -i 's/$/\r/' "$W/claude-setup.cmd"
res="$W/add.json"
printf '\r\n  %s  \r\n\r\n' "$TOKEN" | BRAID_ACCOUNT="$ID-add" BRAID_RESULT="$(wslpath -w "$res")" BRAID_CLAUDE="$(wslpath -w "$W/claude-setup.cmd")" \
  WSLENV="BRAID_ACCOUNT:BRAID_RESULT:BRAID_CLAUDE${WSLENV:+:$WSLENV}" ps -File "$(wslpath -w ../mod/tool/windows/add-account.ps1)" >/dev/null 2>&1
[ "$(cat "$res" 2>&1)" = '{"ok":true,"backend":"credman"}' ] && ok "成功：結果檔只寫存在哪裡" || ng "結果檔不對：$(cat "$res" 2>&1)"
grep -q sk-ant "$res" && ng "結果檔裡有憑證" || ok "結果檔裡沒有憑證"
[ "$(ps -File "$SECRET" get "$ID-add")" = "$TOKEN" ] && ok "貼上的憑證（前後空白去掉）存進認證管理員" || ng "憑證沒存好"
rm -f "$res"
printf '\r\nnope\r\n\r\n' | BRAID_ACCOUNT="$ID-add2" BRAID_RESULT="$(wslpath -w "$res")" BRAID_CLAUDE="$(wslpath -w "$W/claude-setup.cmd")" \
  WSLENV="BRAID_ACCOUNT:BRAID_RESULT:BRAID_CLAUDE${WSLENV:+:$WSLENV}" ps -File "$(wslpath -w ../mod/tool/windows/add-account.ps1)" >/dev/null 2>&1
[ "$(cat "$res" 2>&1)" = '{"ok":false,"reason":"canceled"}' ] && ok "貼錯再按 Enter：取消" || ng "取消時的結果不對：$(cat "$res" 2>&1)"
ps -File "$SECRET" get "$ID-add2" >/dev/null 2>&1 && ng "取消了卻存了憑證" || ok "取消時什麼都沒存"

ps -File "$SECRET" delete "$ID" >/dev/null
ps -File "$SECRET" get "$ID" >/dev/null 2>&1 && ng "刪不掉" || ok "刪掉後讀不到"
cleanup
echo; echo "Windows 帳號腳本測試全部通過"
