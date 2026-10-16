#!/usr/bin/env bash
# 測 macOS 版核心（macos/core.js）：與 Windows 版同一份假資料、同一支驗證程式。
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null
W=/tmp/cdm-core-test; WSLDIR=/tmp/cdm-core-wsl
run() { node run-core.mjs --yes --from 11111111 --app-data-root "$W/app" --claude-home "$W/claude-home" --backup-root "$W/backups" "$@"; }

node fixture.mjs "$W" "$WSLDIR" >/dev/null
rm -rf "$W.before" && cp -r "$W" "$W.before"
echo "######## 試跑";  run --dry-run --plan-json "$W/plan.json" >/dev/null; node verify.mjs dryrun "$W" "$W.before"
echo "######## 寫入";  run --plan-json "$W/plan.json" >/dev/null;           node verify.mjs apply "$W" "$W.before"
echo "######## 重跑";  run | grep -q '沒有需要搬的東西' && echo "  ok  重跑無事可做" || { echo "  NG  重跑還想寫東西"; exit 1; }
echo "######## 還原";  node run-core.mjs --restore "$(ls -d "$W"/backups/*/ | head -1)" >/dev/null; node verify.mjs restored "$W" "$W.before"
rm -rf "$W" "$W.before" "$WSLDIR"
echo "######## LevelDB 邊界（JS）"; node leveldb-edge.mjs js | grep -v "^  ok"
echo "######## JXA 入口"; node jxa-pure.mjs | grep -v "^  ok"
echo; echo "macOS 版核心測試全部通過"
