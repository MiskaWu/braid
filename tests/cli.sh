#!/usr/bin/env bash
# 測 mod/tool/cli 的帳號腳本（macOS、Linux、WSL 共用）：用假的 claude 頂替，不會真的登入或呼叫模型。
#   secret.sh：憑證存取（檔案模式；鑰匙圈只能在有桌面的機器上手動驗）
#   resume.sh：憑證經由檔案描述元交出去、不在環境變數裡；上一個對話的變數清掉；路徑裡的引號原樣送到
#   add-account.sh：貼上的憑證存起來，結果檔只說成功與否，不含憑證
#   open-linux.sh：沒有圖形桌面就結束碼 3；有就用找得到的終端機程式開
set -uo pipefail
cd "$(dirname "$0")"
CLI=$(cd ../mod/tool/cli && pwd)
T=$(mktemp -d /tmp/braid-cli-XXXXXX)
trap 'rm -rf "$T"' EXIT
ok() { echo "  ok  $1"; }
ng() { echo "  NG  $1"; exit 1; }
TOKEN='sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij-0123456789'
export BRAID_SECRET_BACKEND=file BRAID_SECRET_DIR="$T/cred"

echo "######## secret.sh"
out=$(printf '%s\n' "$TOKEN" | "$CLI/secret.sh" set tok-1) && [ "$out" = file ] && ok "存進檔案，回報 file" || ng "set 失敗：$out"
[ "$(stat -c %a "$T/cred")" = 700 ] && [ "$(stat -c %a "$T/cred/tok-1")" = 600 ] && ok "資料夾 700、檔案 600：只有自己讀得到" || ng "權限不對：$(stat -c %a "$T/cred" "$T/cred/tok-1")"
[ "$("$CLI/secret.sh" get tok-1)" = "$TOKEN" ] && ok "讀回同一個憑證" || ng "讀回來不一樣"
printf 'not-a-token' | "$CLI/secret.sh" set tok-2 2>/dev/null; [ $? = 2 ] && [ ! -e "$T/cred/tok-2" ] && ok "不像憑證的不存" || ng "存了不像憑證的東西"
printf '%s' "$TOKEN" | "$CLI/secret.sh" set '../escape' 2>/dev/null; [ $? = 2 ] && [ ! -e "$T/escape" ] && ok "帳號 id 不能帶路徑" || ng "帳號 id 沒擋住 ../"
"$CLI/secret.sh" delete tok-1 && ! "$CLI/secret.sh" get tok-1 >/dev/null 2>&1 && ok "刪掉後讀不到" || ng "刪不掉"

echo "######## resume.sh"
mkdir -p "$T/bin" "$T/it's here"
# 假的 claude：印出收到的參數、身分變數、從檔案描述元讀到的憑證，以及不該帶過來的變數
cat > "$T/bin/claude" <<'EOF'
#!/bin/bash
echo "args=$*"
echo "pwd=$PWD"
echo "account=$BRAID_ACCOUNT"
echo "fdvar=${CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR:-}"
echo "fd3=$(cat <&3)"
echo "envtoken=${CLAUDE_CODE_OAUTH_TOKEN:-none}"
echo "leftover=${CLAUDECODE:-}${CLAUDE_CODE_ACCOUNT_UUID:-}${ANTHROPIC_BASE_URL:-}"
EOF
chmod +x "$T/bin/claude"
printf '%s' "$TOKEN" | "$CLI/secret.sh" set tok-9 >/dev/null
# 一次性的小腳本：照 hooks/terminal.ts 的 wrapperText 寫法（單引號裡的 ' 寫成 '\''），驗它真的能原樣送到
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
wrapper="$T/braid-resume-tok-9.sh"
printf '#!/bin/bash\nrm -f -- "$0"\nexec bash %s %s %s %s %s %s %s\n' "$(sq "$CLI/resume.sh")" "$(sq tok-9)" "$(sq sess-1)" "$(sq "$T/it's here")" "$(sq "$T/bin/claude")" "$(sq '公司 2')" "$(sq acct-9)" > "$wrapper"
out=$(CLAUDECODE=1 CLAUDE_CODE_ACCOUNT_UUID=old CLAUDE_CODE_DESKTOP_APP_VERSION=1.0 ANTHROPIC_BASE_URL=http://proxy CLAUDE_CODE_OAUTH_TOKEN=stale bash "$wrapper" </dev/null)
echo "$out" | grep -qx "args=--resume sess-1 --fork-session" && ok "用 --resume 加 --fork-session 接著同一段對話" || ng "參數不對：$out"
echo "$out" | grep -qx "pwd=$T/it's here" && ok "工作資料夾（含單引號與空白）原樣送到" || ng "資料夾不對：$out"
echo "$out" | grep -qx "account=acct-9" && ok "新的對話知道自己是哪個帳號（BRAID_ACCOUNT）" || ng "帳號 id 不對：$out"
echo "$out" | grep -qx "fdvar=3" && echo "$out" | grep -qx "fd3=$TOKEN" && ok "憑證經由檔案描述元 3 交出去" || ng "檔案描述元沒有憑證：$out"
echo "$out" | grep -qx "envtoken=none" && ok "環境變數裡沒有憑證（Claude 執行的指令讀不到）" || ng "憑證出現在環境變數：$out"
echo "$out" | grep -qx "leftover=" && ok "上一個對話與桌面 app 代理的變數都清掉了" || ng "還帶著上一個對話的變數：$out"
[ ! -e "$wrapper" ] && ok "一次性的小腳本執行後刪掉自己" || ng "小腳本還在"
out=$(bash "$CLI/resume.sh" tok-404 sess-1 "$T" "$T/bin/claude" 個人 </dev/null 2>&1); rc=$?
[ $rc = 1 ] && echo "$out" | grep -q '找不到「個人」的登入憑證' && ok "沒有憑證：說明怎麼做，不啟動 claude" || ng "沒憑證時的處理不對（$rc）：$out"

echo "######## add-account.sh"
cat > "$T/bin/claude-setup" <<'EOF'
#!/bin/bash
[ "$1" = setup-token ] && echo "（假的 setup-token：這裡會顯示憑證）"
EOF
chmod +x "$T/bin/claude-setup"
res="$T/add.json"
out=$(printf '\n  %s  \n' "$TOKEN" | bash "$CLI/add-account.sh" tok-7 "$res" "$T/bin/claude-setup" 2>&1)
[ "$(cat "$res")" = '{"ok":true,"backend":"file"}' ] && ok "成功：結果檔只寫存在哪裡" || ng "結果檔不對：$(cat "$res" 2>&1) / $out"
grep -q sk-ant "$res" && ng "結果檔裡有憑證" || ok "結果檔裡沒有憑證"
[ "$("$CLI/secret.sh" get tok-7)" = "$TOKEN" ] && ok "貼上的憑證（前後空白去掉）存好了" || ng "存的憑證不對"
echo "$out" | grep -q '假的 setup-token' && ok "先跑 claude setup-token" || ng "沒跑 setup-token：$out"
rm -f "$res"
printf '\nnope\n\n' | bash "$CLI/add-account.sh" tok-8 "$res" "$T/bin/claude-setup" >/dev/null 2>&1
[ "$(cat "$res")" = '{"ok":false,"reason":"canceled"}' ] && ! "$CLI/secret.sh" get tok-8 >/dev/null 2>&1 && ok "貼錯再按 Enter：取消，什麼都沒存" || ng "取消時的結果不對：$(cat "$res" 2>&1)"

echo "######## open-linux.sh"
env -u DISPLAY -u WAYLAND_DISPLAY bash "$CLI/open-linux.sh" "$T/x.sh"; [ $? = 3 ] && ok "沒有圖形桌面：結束碼 3（改給使用者一行指令）" || ng "沒有圖形桌面時沒有回 3"
cat > "$T/bin/x-terminal-emulator" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$T/term-args"
EOF
chmod +x "$T/bin/x-terminal-emulator"
DISPLAY=:9 PATH="$T/bin:/usr/bin:/bin" bash "$CLI/open-linux.sh" "$T/x.sh"; rc=$?
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -e "$T/term-args" ] && break; sleep 0.2; done
[ $rc = 0 ] && [ "$(tr '\n' ' ' < "$T/term-args")" = "-e bash $T/x.sh " ] && ok "用找得到的終端機程式開，腳本路徑原樣傳" || ng "終端機程式沒被正確呼叫（$rc）：$(cat "$T/term-args" 2>&1)"

echo; echo "CLI 帳號腳本測試全部通過"
