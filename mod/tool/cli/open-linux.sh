#!/usr/bin/env bash
# 在 Linux 桌面開一個新的終端機視窗執行 <腳本>。找不到終端機程式、或不在圖形桌面（例如 SSH）就結束碼 3，
# braid 會改成給一行指令請使用者自己在終端機執行。
# 用法：open-linux.sh <腳本>
set -uo pipefail
script=${1:?用法：open-linux.sh <腳本>}
[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || exit 3

for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal kitty alacritty wezterm xterm; do
  command -v "$t" >/dev/null 2>&1 || continue
  case "$t" in
    gnome-terminal) set -- gnome-terminal -- bash "$script" ;;
    xfce4-terminal) set -- xfce4-terminal -x bash "$script" ;;
    kitty) set -- kitty bash "$script" ;;
    wezterm) set -- wezterm start -- bash "$script" ;;
    *) set -- "$t" -e bash "$script" ;;
  esac
  # 脫離 Claude 的行程群組、不留輸出管道：Claude 等的是這支腳本結束，不是終端機視窗
  setsid -f "$@" </dev/null >/dev/null 2>&1 && exit 0
done
exit 3
