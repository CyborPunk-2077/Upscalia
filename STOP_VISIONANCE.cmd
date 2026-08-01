@echo off
REM ============================================================================
REM  Visionance - stop a running instance
REM
REM  Safe to run at any time. If Visionance is not running it simply says so.
REM  This only stops the app process; it never deletes anything.
REM ============================================================================

setlocal
cd /d "%~dp0"
title Visionance - stop

where node >nul 2>&1
if errorlevel 1 goto :no_node

node "tools\launcher.js" --stop
endlocal & exit /b 0

:no_node
echo.
echo   Node.js is not installed or not on your PATH, so this script cannot
echo   look up the running process.
echo.
echo   You can close Visionance from its own window, or end "electron.exe"
echo   in Task Manager.
echo.
pause
endlocal & exit /b 1
