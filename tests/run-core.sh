#!/usr/bin/env bash
# 測 macOS 版核心（macos/core.js）：與 Windows 版同一份假資料、同一支驗證程式。
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null
W=/tmp/cdm-core-test-$$; WSLDIR=/tmp/cdm-core-wsl-$$   # 每次執行各用各的，同時跑也不互相干擾
run() { node run-core.mjs --yes --from 11111111 --app-data-root "$W/app" --claude-home "$W/claude-home" --backup-root "${BK:-$W/backups}" "$@"; }
restore() { node run-core.mjs --restore "$(ls -d "$1"/*/ | head -1)" >/dev/null; node verify.mjs restored "$W" "$W.before"; }

node fixture.mjs "$W" "$WSLDIR" >/dev/null
rm -rf "$W.before" && cp -r "$W" "$W.before"
echo "######## 試跑";  run --dry-run --plan-json "$W/plan.json" >/dev/null; node verify.mjs dryrun "$W" "$W.before"
echo "######## 寫入";  run --plan-json "$W/plan.json" >/dev/null;           node verify.mjs apply "$W" "$W.before"
echo "######## 重跑";  run | grep -q '沒有需要搬的東西' && echo "  ok  重跑無事可做" || { echo "  NG  重跑還想寫東西"; exit 1; }
echo "######## 還原";  restore "$W/backups"
echo "######## 依參數選擇（專案 /p/a、/p/c＋環境 garden）"
BK="$W/backups-sel" run --projects "/p/a,/p/c" --presets garden --plan-json "$W/plan.json" >/dev/null; node verify.mjs selected "$W" "$W.before"
restore "$W/backups-sel"
echo "######## 全部資料夾（同步選「全部」：專案 all＋環境 all，結果要和不指定一樣）"
BK="$W/backups-all" run --projects all --presets all --plan-json "$W/plan.json" >/dev/null; node verify.mjs apply "$W" "$W.before"
restore "$W/backups-all"
echo "######## 環境跟著資料夾走（專案 /p/a、/p/garden＋環境 folders）"
BK="$W/backups-fold" run --projects "/p/a,/p/garden" --presets folders --plan-json "$W/plan.json" >/dev/null; node verify.mjs folders "$W" "$W.before"
restore "$W/backups-fold"
echo "######## 勾選視窗（測試替身：專案 f、a＋環境 notebook，展開只留 f）"
BRAID_TEST_PICKS='2,4,6;1' BK="$W/backups-pick" run --plan-json "$W/plan.json" >/dev/null; node verify.mjs picked "$W" "$W.before"
restore "$W/backups-pick"
echo "######## 備份資料夾同一秒不撞名"
# 先把接下來 30 秒會用到的時間名稱（本地時間與 UTC 都建）佔掉：工具要改用 -2，不能寫進已存在的資料夾。
# 時間只讀一次、以它為基準連續建：每圈重讀現在時間的話，/mnt/c 上建資料夾慢，跨秒就會空出一格（2026-10-19 假紅過）
mkdir -p "$W/backups-col"; base=$(date +%s)
for i in $(seq 0 30); do mkdir -p "$W/backups-col/$(date -d "@$((base + i))" +%Y%m%d-%H%M%S)" "$W/backups-col/$(date -u -d "@$((base + i))" +%Y%m%d-%H%M%S)"; done
BK="$W/backups-col" run --projects "/p/a" --presets none >/dev/null
made=$(find "$W/backups-col" -name manifest.json | xargs -r dirname)
[ "$(echo "$made" | grep -c -- '-2$')" = 1 ] && [ "$(find "$W/backups-col" -mindepth 2 | grep -vc "^$made")" = 0 ] \
  && echo "  ok  改用 -2，佔住的資料夾都沒被寫入" || { echo "  NG  備份資料夾撞名處理不對"; find "$W/backups-col" -maxdepth 2; exit 1; }
node run-core.mjs --restore "$made" >/dev/null; node verify.mjs restored "$W" "$W.before"
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
