#!/usr/bin/env bash
# 測 mod/tool/cli 的帳號腳本（macOS、Linux、WSL 共用）：用假的 claude 頂替，不會真的登入或呼叫模型。
#   secret.sh：憑證存取（檔案模式；鑰匙圈只能在有桌面的機器上手動驗）
#   add-account.sh：貼上的憑證存起來，結果檔只說成功與否，不含憑證；找不到 claude 時先講，不收憑證
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

mkdir -p "$T/bin"

echo "######## add-account.sh"
cat > "$T/bin/claude-setup" <<'EOF'
#!/bin/bash
[ "$1" = setup-token ] && echo "（假的 setup-token：這裡會顯示憑證）"
EOF
chmod +x "$T/bin/claude-setup"
# 假的 Claude API（只聽 127.0.0.1）：回組織標頭，記下收到的 Authorization 與路徑。org.sh 只在 BRAID_API_BASE
# 是 http://127.0.0.1:<埠> 時才連過來，所以用真的 curl 走完整條路，不會拿假憑證去連 Claude
python3 fixtures/fake-api.py "$T/api-seen" > "$T/api-port" & API=$!
python3 fixtures/fake-api.py "$T/api-seen-403" status:403 > "$T/api-port-403" & API403=$!
trap 'kill $API $API403 2>/dev/null; rm -rf "$T"' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$T/api-port" ] && [ -s "$T/api-port-403" ] && break; sleep 0.2; done
BASE="http://127.0.0.1:$(cat "$T/api-port")"
res="$T/add.json"
out=$(printf '\n  %s  \n' "$TOKEN" | BRAID_API_BASE="$BASE" bash "$CLI/add-account.sh" tok-7 "$res" "$T/bin/claude-setup" 2>&1)
[ "$(cat "$res")" = '{"ok":true,"backend":"file","orgId":"0000aaaa-1111-2222-3333-444455556666"}' ] && ok "成功：結果檔只寫存在哪裡、屬於哪個組織" || ng "結果檔不對：$(cat "$res" 2>&1) / $out"
grep -q sk-ant "$res" && ng "結果檔裡有憑證" || ok "結果檔裡沒有憑證"
[ "$(stat -c %a "$res")" = 600 ] && ok "結果檔只有自己讀得到" || ng "權限不對：$(stat -c %a "$res")"
[ "$(cat "$T/api-seen")" = "Bearer $TOKEN	/v1/models?limit=1" ] && ok "用存好的憑證呼叫「列出模型」，從回應標頭讀組織" || ng "API 收到的不對：$(cat "$T/api-seen")"
rm -f "$res"
printf '\n%s\n\n' "$TOKEN" | BRAID_API_BASE="http://127.0.0.1:$(cat "$T/api-port-403")" bash "$CLI/add-account.sh" tok-6 "$res" "$T/bin/claude-setup" >/dev/null 2>&1
[ "$(cat "$res")" = '{"ok":true,"backend":"file","orgId":null}' ] && ok "查不到組織（被拒絕或連不上）：照樣存好，組織寫 null" || ng "查不到時的結果不對：$(cat "$res" 2>&1)"
[ "$("$CLI/secret.sh" get tok-7)" = "$TOKEN" ] && ok "貼上的憑證（前後空白去掉）存好了" || ng "存的憑證不對"
echo "$out" | grep -q '假的 setup-token' && ok "先跑 claude setup-token" || ng "沒跑 setup-token：$out"
rm -f "$res"
printf '\nnope\n\n' | BRAID_API_BASE="$BASE" bash "$CLI/add-account.sh" tok-8 "$res" "$T/bin/claude-setup" >/dev/null 2>&1
[ "$(cat "$res")" = '{"ok":false,"reason":"canceled"}' ] && ! "$CLI/secret.sh" get tok-8 >/dev/null 2>&1 && ok "貼錯再按 Enter：取消，什麼都沒存" || ng "取消時的結果不對：$(cat "$res" 2>&1)"
# 面板交來的 claude 不見了（完整路徑、或裸名稱在 PATH 上找不到）：開頭就講，不要使用者準備登入，也不收憑證
for claude in "$T/bin/no-such-claude" braid-no-such-claude; do
  rm -f "$res"
  out=$(printf '\n%s\n\n' "$TOKEN" | bash "$CLI/add-account.sh" tok-5 "$res" "$claude" 2>&1); rc=$?
  [ $rc = 1 ] && [ "$(cat "$res")" = '{"ok":false,"reason":"no-claude"}' ] && echo "$out" | grep -q "找不到 Claude Code 的命令列程式：$claude" \
    && ! echo "$out" | grep -q '接下來會開瀏覽器' && ! "$CLI/secret.sh" get tok-5 >/dev/null 2>&1 \
    && ok "找不到 claude（$(basename "$claude")）：開頭就講、結果檔寫 no-claude，不收憑證" || ng "找不到 claude 時的處理不對（$rc）：$(cat "$res" 2>&1) / $out"
done

echo "######## org.sh"
[ "$(BRAID_API_BASE="$BASE" bash "$CLI/org.sh" tok-7)" = 0000aaaa-1111-2222-3333-444455556666 ] && ok "只印出組織 id" || ng "org.sh 輸出不對"
BRAID_API_BASE="$BASE" bash "$CLI/org.sh" tok-404 >/dev/null 2>&1 && ng "沒有憑證卻成功" || ok "沒有這組憑證：結束碼 1"
# 假的 curl：記下參數與標準輸入，驗憑證只經過標準輸入，而且測試用的網址變數只接受本機
cat > "$T/bin/curl" <<FAKE
#!/bin/bash
printf '%s\n' "\$@" > "$T/curl-args"
cat > "$T/curl-stdin"
printf 'HTTP/1.1 200 OK\r\nanthropic-organization-id: 0000aaaa-1111-2222-3333-444455556666\r\n\r\n'
FAKE
chmod +x "$T/bin/curl"
PATH="$T/bin:$PATH" BRAID_API_BASE=https://evil.example bash "$CLI/org.sh" tok-7 >/dev/null
grep -q "^Authorization: Bearer $TOKEN$" "$T/curl-stdin" && ! grep -q sk-ant "$T/curl-args" && ok "憑證經由標準輸入交給 curl，不在參數裡" || ng "憑證出現在 curl 參數，或沒送出：$(cat "$T/curl-args")"
[ "$(tail -1 "$T/curl-args")" = 'https://api.anthropic.com/v1/models?limit=1' ] && ok "只問 api.anthropic.com；測試用的網址變數只接受 127.0.0.1" || ng "網址不對：$(tail -1 "$T/curl-args")"
printf '#!/bin/bash\ncat >/dev/null\nprintf "HTTP/1.1 200 OK\\r\\nanthropic-organization-id: x\\"; rm -rf /tmp/nope\\r\\n\\r\\n"\n' > "$T/bin/curl"
PATH="$T/bin:$PATH" bash "$CLI/org.sh" tok-7 >/dev/null 2>&1 && ng "收了格式不對的組織 id" || ok "標頭裡的組織 id 格式不對就不收（不會被塞進結果檔）"
rm -f "$T/bin/curl"

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
