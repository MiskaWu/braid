#!/usr/bin/env bash
# 查一組 braid 存的憑證屬於哪個組織（macOS、Linux、WSL）。
# 一年期憑證（claude setup-token）只能呼叫模型，查帳號資料（/api/oauth/profile）會被拒絕（403）；
# 所以用它呼叫一次公開的「列出模型」API（不算用量、不用指定模型），回應標頭 anthropic-organization-id 就是組織。
# 只查得到組織，查不到是哪個帳號。
# 憑證從 secret.sh 讀出、經標準輸入交給 curl，不出現在參數裡；只印出組織 id，查不到就結束碼 1。
#
# 用法：org.sh <憑證 id>
# 測試用：BRAID_API_BASE 只接受 http://127.0.0.1:<埠>（本機），憑證不會被送到別處。
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
id=${1:-}
base=https://api.anthropic.com
[[ "${BRAID_API_BASE:-}" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] && base=$BRAID_API_BASE

token=$("$here/secret.sh" get "$id" 2>/dev/null) && [ -n "$token" ] || exit 1
headers=$(printf 'Authorization: Bearer %s\nanthropic-version: 2023-06-01\nanthropic-beta: oauth-2025-04-20\n' "$token" \
  | curl -fsS --max-time 15 -H @- -D - -o /dev/null "$base/v1/models?limit=1" 2>/dev/null) || exit 1
unset token
org=$(printf '%s\n' "$headers" | tr -d '\r' | awk -F': *' 'tolower($1) == "anthropic-organization-id" { print $2; exit }')
[[ "$org" =~ ^[0-9a-fA-F-]{36}$ ]] || exit 1
printf '%s\n' "$org"
