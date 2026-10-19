#!/usr/bin/env bash
# 測 mod/tool/launch-from-wsl.sh：用假的 cmd.exe／powershell.exe 頂替，不會真的開視窗。
set -euo pipefail
cd "$(dirname "$0")"
REAL_TEMP=$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' | tr -d '\r')
FAKE=/tmp/cdm-fake-bin-$$; rm -rf "$FAKE"; mkdir -p "$FAKE"
TEST_TEMP="$REAL_TEMP\\cdm-launch-test-$$"
trap 'rm -rf "$(wslpath -u "$TEST_TEMP")" "$FAKE"' EXIT   # 失敗或被中斷也清掉
printf '#!/bin/bash\necho "%s"\n' "$TEST_TEMP" > "$FAKE/cmd.exe"
printf '#!/bin/bash\nprintf "%%s\\n" "$@" > %s/args\n' "$FAKE" > "$FAKE/powershell.exe"
chmod +x "$FAKE"/*.exe
ok() { echo "  ok  $1"; }; ng() { echo "  NG  $1"; exit 1; }

for mode in normal dry sync; do
  arg=(); [ $mode = dry ] && arg=(-DryRun)
  [ $mode = sync ] && arg=(-From 11111111 -Projects "/p/a,/p/中文 資料夾,/p/o'neil" -Presets folders)
  out=$(PATH="$FAKE:$PATH" bash ../mod/tool/launch-from-wsl.sh "${arg[@]}")
  dest="$(wslpath -u "$TEST_TEMP")/braid"
  for f in spec.json windows/migrate.ps1 windows/migrate.cmd windows/LevelDbLite.cs; do
    cmp -s "../mod/tool/$f" "$dest/$f" || ng "[$mode] $f 沒有完整複製到 Windows 暫存"
  done
  ok "[$mode] 工具完整複製到 Windows 暫存資料夾"
  mapfile -t a < "$FAKE/args"
  [ "${a[0]}" = "-NoProfile" ] && [ "${a[1]}" = "-Command" ] || ng "[$mode] powershell 參數不對：${a[*]}"
  want="Start-Process -FilePath '$TEST_TEMP\\braid\\windows\\migrate.cmd'"
  [ $mode = dry ] && want="$want -ArgumentList '-DryRun'"
  # 值加雙引號交給 cmd 的 %*，PowerShell 單引號裡的 ' 寫成 ''
  [ $mode = sync ] && want="$want -ArgumentList '-From','\"11111111\"','-Projects','\"/p/a,/p/中文 資料夾,/p/o''neil\"','-Presets','\"folders\"'"
  [ "${a[2]}" = "$want" ] || ng "[$mode] Start-Process 指令不對：${a[2]}"
  ok "[$mode] 用 Start-Process 開 Windows 路徑上的 migrate.cmd"
  echo "$out" | grep -q '已開啟遷移視窗' && ok "[$mode] 回報已開啟" || ng "[$mode] 沒有回報"
  if [ $mode = sync ]; then
    # 真的走一次 Start-Process → cmd 的 %* → PowerShell，驗參數沒有走樣。
    # 絕不能碰到真的遷移工具（2026-10-16 這裡的路徑替換靜默失敗，真工具在隱藏視窗跑起來過）：
    #   先刪掉複製出去的真工具；用字面字串替換；執行前斷言指令只指向 dump-args.cmd。
    rm -rf "$dest"
    real="$(wslpath -u "$TEST_TEMP")/dump"; mkdir -p "$real"; cp fixtures/dump-args.cmd fixtures/dump-args.ps1 "$real/"
    cmdline=$(node -e 'const [c,from,to]=process.argv.slice(1);if(!c.includes(from))process.exit(3);process.stdout.write(c.split(from).join(to)+" -Wait -WindowStyle Hidden")' \
      "${a[2]}" "$TEST_TEMP\\braid\\windows\\migrate.cmd" "$TEST_TEMP\\dump\\dump-args.cmd") || ng "[$mode] 找不到要替換的 migrate.cmd 路徑"
    case "$cmdline" in *migrate*) ng "[$mode] 替換後還指向遷移工具，不執行：$cmdline" ;; *dump-args.cmd*) ;; *) ng "[$mode] 替換結果不對：$cmdline" ;; esac
    (cd /mnt/c && timeout 60 powershell.exe -NoProfile -Command "$cmdline") || ng "[$mode] 隱藏視窗沒有正常結束"
    got=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify([j.DryRun,j.From,j.Projects,j.Presets]))' "$real/args.json")
    [ "$got" = '[false,"11111111","/p/a,/p/中文 資料夾,/p/o'"'"'neil","folders"]' ] && ok "[$mode] 中文、空格、單引號經過 cmd 與 PowerShell 後原樣送到" || ng "[$mode] 參數走樣：$got"
  fi
done
# cmd 會解讀值裡的 " 與 %：直接拒絕，不開視窗
rm -f "$FAKE/args"
for bad in '/p/100%' '/p/a"b'; do
  set +e; PATH="$FAKE:$PATH" bash ../mod/tool/launch-from-wsl.sh -Projects "$bad" >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" = 2 ] && [ ! -e "$FAKE/args" ] && ok "值裡有 \" 或 % 就拒絕（$bad）" || ng "沒有拒絕 $bad（結束碼 $rc）"
done
rm -rf "$(wslpath -u "$TEST_TEMP")" "$FAKE"
echo; echo "WSL 啟動腳本測試全部通過"
