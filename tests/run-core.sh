#!/usr/bin/env bash
# 測 macOS 版核心（macos/core.js）：與 Windows 版同一份假資料、同一支驗證程式。
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null
W=/tmp/cdm-core-test-$$; WSLDIR=/tmp/cdm-core-wsl-$$   # 每次執行各用各的，同時跑也不互相干擾
run() { node run-core.mjs --yes --from 11111111 --app-data-root "$W/app" --claude-home "$W/claude-home" --backup-root "$W/backups" "$@"; }

node fixture.mjs "$W" "$WSLDIR" >/dev/null
rm -rf "$W.before" && cp -r "$W" "$W.before"
echo "######## 試跑";  run --dry-run --plan-json "$W/plan.json" >/dev/null; node verify.mjs dryrun "$W" "$W.before"
echo "######## 寫入";  run --plan-json "$W/plan.json" >/dev/null;           node verify.mjs apply "$W" "$W.before"
echo "######## 重跑";  run | grep -q '沒有需要搬的東西' && echo "  ok  重跑無事可做" || { echo "  NG  重跑還想寫東西"; exit 1; }
echo "######## 還原";  node run-core.mjs --restore "$(ls -d "$W"/backups/*/ | head -1)" >/dev/null; node verify.mjs restored "$W" "$W.before"
echo "######## 目前帳號說法不一致"
# 兩處紀錄對目前帳號說法不一致（config.json 指向舊帳號、Local Storage 確認的是新帳號）：要停下來、不寫任何東西
node -e 'const fs=require("fs"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f));c.lastKnownAccountUuid="11111111-1111-4111-8111-111111111111";fs.writeFileSync(f,JSON.stringify(c))' "$W/app/config.json"
cp -r "$W" "$W.mismatch-before"
set +e; out=$(node run-core.mjs --yes --app-data-root "$W/app" --claude-home "$W/claude-home" --backup-root "$W/backups2" 2>&1); rc=$?; set -e
[ "$rc" = 2 ] && echo "$out" | grep -q '說法不一致' && [ ! -e "$W/backups2" ] && diff -rq "$W/app" "$W.mismatch-before/app" >/dev/null \
  && echo "  ok  結束碼 2、說明原因、什麼都沒寫" || { echo "  NG  說法不一致時沒有正確停下（結束碼 $rc）"; echo "$out"; exit 1; }
rm -rf "$W.mismatch-before"
rm -rf "$W" "$W.before" "$WSLDIR"
echo "######## LevelDB 邊界（JS）"; node leveldb-edge.mjs js | grep -v "^  ok"
echo "######## JXA 入口"; node jxa-pure.mjs | grep -v "^  ok"
echo; echo "macOS 版核心測試全部通過"
