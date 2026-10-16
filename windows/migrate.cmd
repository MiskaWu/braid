@echo off
rem Claude desktop account migration launcher. Double-click this file.
rem -ExecutionPolicy Bypass applies to this run only; it does not change system settings.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -Command "Get-ChildItem -LiteralPath '%~dp0..' -Recurse -File | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate.ps1" %*
set rc=%errorlevel%
if "%rc%"=="1" (
  echo.
  echo If you saw "running scripts is disabled" above, your company policy blocks PowerShell scripts. Please contact IT.
)
echo.
pause
exit /b %rc%
