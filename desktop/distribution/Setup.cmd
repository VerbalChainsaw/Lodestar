@echo off
setlocal DisableDelayedExpansion
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo Lodestar setup failed: pwsh.exe is unavailable. Next action: install PowerShell 7, reopen the console, and run Setup.cmd again. Preserve interfaces.json and the database.
  exit /b 1
)
if not exist "%~dp0Setup.ps1" goto missing_script
if /I "%~1"=="--help" goto help
pwsh.exe -NoProfile -File "%~dp0Setup.ps1" %*
exit /b %errorlevel%
:help
pwsh.exe -NoProfile -File "%~dp0Setup.ps1" -Help
exit /b %errorlevel%
:missing_script
>&2 echo Lodestar script_missing: "%~dp0Setup.ps1". Next action: restore a complete verified Lodestar bundle; preserve interfaces.json, the database and any retained update journal before rerunning Setup.cmd.
exit /b 1
