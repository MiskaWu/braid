@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dump-args.ps1" %*
