#!/bin/bash
# 在 Finder 裡雙擊這個檔案就會開 Terminal 執行遷移。
# 從瀏覽器下載的話，第一次要按右鍵 →「打開」→ 再按「打開」，macOS 才會放行。
cd "$(dirname "$0")" || exit 1
osascript -l JavaScript ./migrate.js "$@"
echo
read -n 1 -s -r -p "按任意鍵關閉視窗…"
echo
