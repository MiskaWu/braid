#!/usr/bin/env bash
# braid：用另一個帳號接著同一段對話。在 braid 開的終端機視窗裡執行（macOS、Linux、WSL）。
# 用 --fork-session 複製一份對話接著做：原本的對話保留不動，兩個視窗不會寫進同一份紀錄。
# 憑證經由檔案描述元交給 Claude Code（CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR），不放進環境變數：
# Claude Code 讀完就把變數刪掉，管道也讀空了，Claude 在這個對話裡執行的指令拿不到它。
#
# 用法：resume.sh <憑證 id> <session id> <工作資料夾> <claude 執行檔> [帳號名稱] [帳號 id]
#   帳號 id 交給新的對話（BRAID_ACCOUNT），braid 才知道那邊量到的用量是哪個帳號的；沒給就用憑證 id。
#   憑證 id 是「-」：不帶憑證，用 Claude Code 自己登入的帳號（/login 的那個）接著做。
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
id=${1:-} sid=${2:-} cwd=${3:-} claude=${4:-claude} label=${5:-另一個帳號} account=${6:-${1:-}}

fail() {
  echo
  echo "$1"
  read -r -p '按 Enter 關閉這個視窗…' _ || true
  exit 1
}

token=
if [ "$id" != - ]; then
  token=$("$here/secret.sh" get "$id" 2>/dev/null) && [ -n "$token" ] \
    || fail "找不到「$label」的登入憑證。請在 Claude 輸入 /braid，到帳號頁重新新增這個帳號。"
fi
cd "$cwd" 2>/dev/null || fail "找不到工作資料夾：$cwd"
command -v "$claude" >/dev/null 2>&1 || fail "找不到 Claude Code：$claude"

# 從 Claude 裡開的視窗可能帶著上一個對話的變數（主要是 Linux 的終端機程式會繼承），清掉以免新的對話認錯身分。
# 桌面 app 會把 ANTHROPIC_BASE_URL 指向自己的代理，只有在那種情況才一起清。
if [ -n "${CLAUDE_CODE_DESKTOP_APP_VERSION:-}" ]; then unset ANTHROPIC_BASE_URL; fi
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_HOST_SESSION_ID CLAUDE_CODE_CHILD_SESSION \
  CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_ACCOUNT_UUID CLAUDE_CODE_USER_EMAIL CLAUDE_CODE_ORGANIZATION_UUID \
  CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_SCOPES CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH CLAUDE_CODE_MESSAGING_SOCKET \
  CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_DESKTOP_APP_VERSION CLAUDE_AGENT_SDK_VERSION CLAUDE_PID CLAUDE_CODE_EXECPATH

echo "用「$label」接著這段對話：複製一份新的對話接著做，原本的保留不動。"
echo
export BRAID_ACCOUNT="$account"
if [ -z "$token" ]; then exec "$claude" --resume "$sid" --fork-session; fi
export CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3
exec "$claude" --resume "$sid" --fork-session 3< <(printf '%s' "$token")
