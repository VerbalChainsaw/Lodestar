@echo off
setlocal DisableDelayedExpansion
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo Lodestar update failed: pwsh.exe is unavailable. Next action: install PowerShell 7, reopen the console, and run Update.cmd again. Preserve the application, update journal, interfaces.json and database.
  exit /b 1
)
if not exist "%~dp0Update.ps1" goto missing_script
if /I "%~1"=="--help" goto help
if "%~1"=="" (
  echo Usage: In the new release, Update.cmd ^<absolute path to existing portable bundle^>
  exit /b 1
)
pwsh.exe -NoProfile -File "%~dp0Update.ps1" -Destination "%~1"
exit /b %errorlevel%
:help
pwsh.exe -NoProfile -File "%~dp0Update.ps1" -Help
exit /b %errorlevel%
:missing_script
>&2 echo Lodestar script_missing: "%~dp0Update.ps1". Next action: restore a complete verified Lodestar bundle; preserve interfaces.json, the database and any retained update journal before rerunning Update.cmd.
exit /b 1
