@echo off
setlocal DisableDelayedExpansion
if not exist "%~dp0Cli.ps1" (
  echo Lodestar CLI script is missing: "%~dp0Cli.ps1". Next action: extract the complete verified Lodestar release; preserve interfaces.json and the selected database.
  exit /b 1
)
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 is required. See Install.cmd --help.
  exit /b 1
)
pwsh.exe -NoProfile -File "%~dp0Cli.ps1" %*
exit /b %errorlevel%
