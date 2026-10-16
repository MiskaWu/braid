#!/usr/bin/env bash
# 跑全部測試。macOS 版核心與 CLI 帳號腳本在任何有 Node、bash 的環境都能跑；Windows 版要在 WSL（叫得到 powershell.exe）。
set -euo pipefail
cd "$(dirname "$0")"
./run-core.sh
echo
./cli.sh
echo
if command -v powershell.exe >/dev/null; then ./run-windows.sh; echo; ./cli-windows.sh; else echo "（沒有 powershell.exe，略過 Windows 版）"; fi
