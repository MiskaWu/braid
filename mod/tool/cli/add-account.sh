#!/usr/bin/env bash
# braid：新增一個帳號。在 braid 開的終端機視窗裡執行（macOS、Linux、WSL）。
#   1. 跑 claude setup-token：用瀏覽器登入要加的帳號，產生一年期的登入憑證。現在的登入不受影響。
#   2. 請使用者把畫面上的憑證貼進來（輸入時不顯示），交給 secret.sh 存進鑰匙圈（沒有就存成只有自己讀得到的檔案）。
#   3. 用 org.sh 查這組憑證屬於哪個組織（一年期憑證查不了帳號資料，只查得到組織）。
#   4. 把結果寫到 <結果檔>：{"ok":true,"backend":"...","orgId":"<組織>"|null} 或 {"ok":false,"reason":"..."}。
#      braid 面板看到結果檔，用組織判斷是不是目前這個帳號、是不是已經認得的帳號，再問名稱。
#      憑證本身不寫進任何檔案，也不經過 Claude；結果檔只有自己讀得到。
#
# 用法：add-account.sh <帳號 id> <結果檔> <claude 執行檔>
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
id=${1:-} result=${2:-} claude=${3:-claude}

finish() {
  (umask 077 && printf '%s\n' "$1" > "$result.tmp") && mv -f "$result.tmp" "$result"
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
# 面板交來的是它找到的完整路徑；開視窗之後才不見（移除了、桌面 app 更新換掉舊版）就先講，不要等使用者準備好登入
if ! command -v "$claude" >/dev/null 2>&1; then
  finish '{"ok":false,"reason":"no-claude"}'
  echo "找不到 Claude Code 的命令列程式：$claude"
  echo "回到 braid 面板再按一次：面板會重新找，真的沒裝會給安裝指令。"
  read -r -p '按 Enter 關閉…' _ || true
  exit 1
fi
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
  unset token
  echo "確認這組憑證屬於哪個組織…"
  if org=$("$here/org.sh" "$id"); then org="\"$org\""; else org=null; fi
  finish "{\"ok\":true,\"backend\":\"$backend\",\"orgId\":$org}"
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
