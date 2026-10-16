#!/usr/bin/env bash
# braid：新增一個帳號。在 braid 開的終端機視窗裡執行（macOS、Linux、WSL）。
#   1. 跑 claude setup-token：用瀏覽器登入要加的帳號，產生一年期的登入憑證。現在的登入不受影響。
#   2. 請使用者把畫面上的憑證貼進來（輸入時不顯示），交給 secret.sh 存進鑰匙圈（沒有就存成只有自己讀得到的檔案）。
#   3. 用這組憑證問 Claude 它屬於哪個帳號（GET /api/oauth/profile，Claude Code 自己也這樣查），
#      回應存到 <結果檔>.profile.json：面板靠它判斷是不是目前這個帳號、是不是已經加過。查不到就不寫。
#   4. 把結果寫到 <結果檔>：{"ok":true,"backend":"...","profile":true|false} 或 {"ok":false,"reason":"..."}。
#      braid 面板看到結果檔就接著問名稱。憑證本身不寫進任何檔案，也不經過 Claude；檔案都只有自己讀得到。
#
# 用法：add-account.sh <帳號 id> <結果檔> <claude 執行檔>
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
id=${1:-} result=${2:-} claude=${3:-claude}

finish() {
  (umask 077 && printf '%s\n' "$1" > "$result.tmp") && mv -f "$result.tmp" "$result"
}

# 問這組憑證是哪個帳號。憑證放在標頭、從標準輸入交給 curl（-H @-），不出現在指令參數裡。
# BRAID_PROFILE_URL 是測試用的，只接受 file://（本機檔案），憑證不會被送到別處。
lookup_account() {
  local url=https://api.anthropic.com/api/oauth/profile
  case "${BRAID_PROFILE_URL:-}" in file://*) url=$BRAID_PROFILE_URL ;; esac
  if (umask 077 && printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$1" \
      | curl -fsS --max-time 15 -H @- -o "$result.profile.json.tmp" "$url") 2>/dev/null; then
    mv -f "$result.profile.json.tmp" "$result.profile.json" && echo true && return
  fi
  rm -f "$result.profile.json.tmp"
  echo false
}
cancel() {
  finish '{"ok":false,"reason":"canceled"}'
  echo
  echo "已取消，什麼都沒存。這個視窗可以關了。"
  exit 1
}
trap cancel INT HUP TERM

echo "== braid：新增帳號 =="
echo
echo "接下來會開瀏覽器，請登入「要新增的那個帳號」。"
echo "你現在在 Claude 裡登入的帳號不會被登出。"
echo
read -r -p '準備好了按 Enter（不要了就關掉這個視窗）…' _ || cancel
"$claude" setup-token
echo
echo "把上面顯示的那一長串憑證（sk-ant- 開頭）貼在這裡，按 Enter。輸入時畫面上不會顯示。"
token=
for _try in 1 2 3; do
  IFS= read -rs -p '憑證：' token || cancel
  echo
  token=$(printf '%s' "$token" | tr -d '[:space:]')
  [ -n "$token" ] || cancel
  [[ "$token" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] && break
  echo "這不像 Claude 的登入憑證（應該是 sk-ant- 開頭的一長串），再貼一次；直接按 Enter 取消。"
  token=
done
[ -n "$token" ] || cancel

if backend=$(printf '%s' "$token" | "$here/secret.sh" set "$id"); then
  echo "確認這組憑證是哪個帳號…"
  has=$(lookup_account "$token")
  unset token
  finish "{\"ok\":true,\"backend\":\"$backend\",\"profile\":$has}"
  echo
  echo "完成，已存好。回到 Claude 的 braid 面板填名稱就好；這個視窗可以關了。"
  read -r -p '按 Enter 關閉…' _ || true
else
  unset token
  finish '{"ok":false,"reason":"store-failed"}'
  echo
  echo "憑證存不進去（上面有原因）。回到 braid 面板可以重試。"
  read -r -p '按 Enter 關閉…' _ || true
  exit 1
fi
