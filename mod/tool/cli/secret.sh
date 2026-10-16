#!/usr/bin/env bash
# braid 的登入憑證存放（macOS、Linux、WSL）。每個帳號一筆。
#   macOS：鑰匙圈。Linux：系統鑰匙圈（Secret Service，要有 secret-tool 與桌面工作階段）；
#   沒有的話（WSL、伺服器）存成只有自己讀得到的檔案，和 Claude Code 在 Linux 存自己登入的方式相同。
# 憑證只經過標準輸入與輸出，不出現在任何指令參數裡（其他程式從行程清單看不到）。
#
# 用法：secret.sh set <帳號 id>     從標準輸入讀憑證存起來，印出存在哪一種（keychain、secret-service、file）
#       secret.sh get <帳號 id>     印出憑證；沒有就結束碼 1
#       secret.sh delete <帳號 id>
# 測試用：BRAID_SECRET_BACKEND=file 固定用檔案，BRAID_SECRET_DIR 指定檔案放哪。
set -uo pipefail
SERVICE=braid
cmd=${1:-}
id=${2:-}
[[ "$id" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || { echo "帳號 id 不對：$id" >&2; exit 2; }

dir=${BRAID_SECRET_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/braid/credentials}
mac() { [ -z "${BRAID_SECRET_BACKEND:-}" ] && [ "$(uname -s)" = Darwin ] && command -v security >/dev/null; }
sst() { [ -z "${BRAID_SECRET_BACKEND:-}" ] && command -v secret-tool >/dev/null && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; }

case "$cmd" in
  set)
    token=$(tr -d '[:space:]')
    [[ "$token" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] || { echo "這不像 Claude 的登入憑證（應該是 sk-ant- 開頭）" >&2; exit 2; }
    if mac; then
      # 用 security 的互動模式從標準輸入下指令，憑證才不會出現在參數裡
      printf 'add-generic-password -U -s %s -a %s -w %s\n' "$SERVICE" "$id" "$token" | security -i >/dev/null && { echo keychain; exit 0; }
      echo "存進鑰匙圈失敗" >&2; exit 1
    fi
    if sst && printf '%s' "$token" | timeout 20 secret-tool store --label="braid $id" service "$SERVICE" account "$id" 2>/dev/null; then
      echo secret-service; exit 0
    fi
    (umask 077 && mkdir -p "$dir" && chmod 700 "$dir" && printf '%s' "$token" > "$dir/$id.tmp" && mv -f "$dir/$id.tmp" "$dir/$id") \
      || { echo "寫不進 $dir" >&2; exit 1; }
    echo file
    ;;
  get)
    if mac; then security find-generic-password -s "$SERVICE" -a "$id" -w 2>/dev/null; exit; fi
    if sst; then
      out=$(timeout 20 secret-tool lookup service "$SERVICE" account "$id" 2>/dev/null) && [ -n "$out" ] && { printf '%s\n' "$out"; exit 0; }
    fi
    [ -f "$dir/$id" ] || exit 1
    cat "$dir/$id"; echo
    ;;
  delete)
    if mac; then security delete-generic-password -s "$SERVICE" -a "$id" >/dev/null 2>&1; fi
    if sst; then timeout 20 secret-tool clear service "$SERVICE" account "$id" >/dev/null 2>&1; fi
    rm -f "$dir/$id"
    exit 0
    ;;
  *)
    echo "用法：secret.sh set|get|delete <帳號 id>" >&2; exit 2
    ;;
esac
