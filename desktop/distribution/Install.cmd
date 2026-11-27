@echo off
setlocal DisableDelayedExpansion
if not exist "%~dp0Install.ps1" (
  echo Install script is missing: "%~dp0Install.ps1". Next action: extract the complete verified Lodestar release; preserve the selected database and existing application.
  if "%~1"=="" pause
  exit /b 1
)
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 is required. Install it from https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows then run Install.cmd again.
  if "%~1"=="" pause
  exit /b 1
)
if /I "%~1"=="--help" goto lodestar_help
pwsh.exe -NoProfile -File "%~dp0Install.ps1" %*
set "lodestar_exit=%errorlevel%"
if not "%lodestar_exit%"=="0" if "%~1"=="" pause
exit /b %lodestar_exit%
:lodestar_help
pwsh.exe -NoProfile -File "%~dp0Install.ps1" -Help
exit /b %errorlevel%
