#!/usr/bin/env bash
# 在 WSL 裡測 Windows 版：造假資料 → 試跑 → 寫入 → 重跑（應無事可做）→ 還原。
# 需要：WSL、Windows 端的 powershell.exe、Node（只有測試要）。
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null

WINTEMP=$(wslpath -u "$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' | tr -d '\r')")
W="$WINTEMP/cdm-test-$$"               # Windows 看得到的位置
LOCAL=/tmp/cdm-fixture-$$              # 造資料用（LevelDB 在 /mnt/c 上開鎖檔不穩）
WSLDIR=/tmp/cdm-test-wsl-$$            # 假的 WSL 端對話紀錄
PS1=$(wslpath -w ../mod/tool/windows/migrate.ps1)

run_ps() {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS1" \
    -AppDataRoot "$(wslpath -w "$W/app")" -ClaudeHome "$(wslpath -w "$W/claude-home")" \
    -BackupRoot "$(wslpath -w "$W/backups")" -SkipAppCheck -NoRelaunch -Yes -From 11111111 "$@" | tr -d '\r'
}

# 守門：Windows PowerShell 5.1 把沒有 BOM 的 UTF-8 當 Big5 讀，中文註解會吞掉下一行程式碼
for f in ../mod/tool/windows/*.ps1 ../mod/tool/windows/*.cs ./*.ps1; do
  [ "$(head -c3 "$f" | od -An -tx1 | tr -d ' ')" = "efbbbf" ] || { echo "  NG  $f 缺 UTF-8 BOM"; exit 1; }
done
echo "  ok  所有 .ps1／.cs 都有 BOM"

node fixture.mjs "$LOCAL" "$WSLDIR" >/dev/null
rm -rf "$W" && mkdir -p "$W" && cp -r "$LOCAL/." "$W/"
rm -rf "$W.before" && cp -r "$W" "$W.before"

echo "######## 試跑"
run_ps -DryRun -PlanJson "$(wslpath -w "$W/plan.json")"
node verify.mjs dryrun "$W" "$W.before"

echo; echo "######## 寫入"
run_ps -PlanJson "$(wslpath -w "$W/plan.json")"
node verify.mjs apply "$W" "$W.before"

echo; echo "######## 重跑（已搬過，應該什麼都不做）"
out=$(run_ps)
echo "$out" | tail -3
echo "$out" | grep -q '沒有需要搬的東西' && echo "  ok  重跑無事可做" || { echo "  NG  重跑還想寫東西"; exit 1; }

echo; echo "######## 還原"
B=$(ls -d "$W"/backups/*/ | head -1)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS1" -AppDataRoot "$(wslpath -w "$W/app")" \
  -SkipAppCheck -Yes -Restore "$(wslpath -w "$B")" | tr -d '\r'
node verify.mjs restored "$W" "$W.before"

echo; echo "######## 目前帳號說法不一致"
# 兩處紀錄對目前帳號說法不一致（config.json 指向舊帳號、Local Storage 確認的是新帳號）：要停下來、不寫任何東西
node -e 'const fs=require("fs"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f));c.lastKnownAccountUuid="11111111-1111-4111-8111-111111111111";fs.writeFileSync(f,JSON.stringify(c))' "$W/app/config.json"
cp -r "$W" "$W.mismatch-before"
set +e
out=$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS1" -AppDataRoot "$(wslpath -w "$W/app")" -ClaudeHome "$(wslpath -w "$W/claude-home")" \
  -BackupRoot "$(wslpath -w "$W/backups2")" -SkipAppCheck -NoRelaunch -Yes 2>&1 | tr -d '\r'; exit "${PIPESTATUS[0]}")
rc=$?
set -e
[ "$rc" = 2 ] && echo "  ok  結束碼 2" || { echo "  NG  結束碼 $rc（預期 2）"; echo "$out"; exit 1; }
echo "$out" | grep -q '說法不一致' && echo "  ok  說明為什麼停" || { echo "  NG  沒有說明"; echo "$out"; exit 1; }
[ ! -e "$W/backups2" ] && diff -rq "$W/app" "$W.mismatch-before/app" >/dev/null && echo "  ok  什麼都沒寫" || { echo "  NG  有東西被改了"; exit 1; }
rm -rf "$W.mismatch-before"

rm -rf "$W" "$W.before" "$LOCAL" "$WSLDIR"
echo; echo "######## LevelDB 邊界"
node leveldb-edge.mjs ps
echo; echo "Windows 版測試全部通過"
