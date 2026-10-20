@echo off
setlocal

rem ============================================================
rem  QQ Bot Template - One-click launcher (source mode)
rem  Double-click to start. Keep the window open = bot online.
rem  Press Ctrl+C to stop (conversation memory is saved).
rem
rem  NOTE: This file is intentionally ASCII-only.
rem  cmd.exe reads .bat using the local ANSI codepage, so non-ASCII
rem  text here is fragile. All Chinese output comes from Node.
rem ============================================================

cd /d "%~dp0"

set "NODE_EXE="

rem 1) Prefer the Node runtime bundled with DSH
if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  goto :run
)

rem 2) Fall back to Node from PATH
where node >nul 2>nul
if %errorlevel%==0 (
  set "NODE_EXE=node"
  goto :run
)

rem 3) No runtime found - fail loudly with instructions
echo.
echo   [ERROR] Node.js runtime not found.
echo.
echo   Fix it in either way:
echo     1. Install Node.js 22+ from https://nodejs.org/
echo     2. Keep the DSH environment intact (its bundled Node is preferred)
echo.
echo   Hint: this folder should contain src\main.js
echo.
pause
exit /b 1

:run
echo.
echo  ============================================
echo   QQ Bot Template starting...
echo   Working dir: %CD%
echo   Stop with Ctrl+C (memory will be saved)
echo  ============================================
echo.

rem 2026-10-20: also tee output into data\live.log, so the bot's history stays
rem inspectable after the console window is closed (previously console-only).
"%NODE_EXE%" "%~dp0src\main.js"
set "EXITCODE=%errorlevel%"

echo.
if "%EXITCODE%"=="0" (
  echo  Bot stopped normally.
) else (
  echo  Bot exited with code %EXITCODE%
  echo  Common causes: bad credentials, no network, or another instance is already running.
)
echo.
pause
exit /b %EXITCODE%
