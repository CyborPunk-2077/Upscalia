@echo off
REM ============================================================================
REM  Visionance - reset local build state
REM
REM  Deliberately separate from RUN_VISIONANCE.cmd, and it will NOT delete
REM  anything until you type RESET at the prompt.
REM
REM  Removes: node_modules, dist, logs, .visionance
REM  Keeps:   your source code, your Git history, and your saved settings
REM           and presets (those live in %APPDATA%\Visionance).
REM
REM  Use this only if the app will not start and RUN_VISIONANCE.cmd told you to.
REM ============================================================================

setlocal
cd /d "%~dp0"
title Visionance - reset

where node >nul 2>&1
if errorlevel 1 goto :no_node

node "tools\launcher.js" --reset
echo.
pause
endlocal & exit /b 0

:no_node
echo.
echo   Node.js is not installed or not on your PATH, so this script cannot run.
echo   Install it from https://nodejs.org and try again.
echo.
pause
endlocal & exit /b 1
