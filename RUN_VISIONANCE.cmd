@echo off
REM ============================================================================
REM  Visionance - one-click launcher
REM
REM  Just double-click this file. It checks prerequisites, installs
REM  dependencies if they are missing or out of date, starts the app, and
REM  keeps the log visible in this window.
REM
REM  This wrapper is deliberately tiny. The real logic lives in
REM  tools\launcher.js so it can be tested; the only thing batch has to get
REM  right is finding Node.js and reporting clearly when it is absent.
REM ============================================================================

setlocal
cd /d "%~dp0"
title Visionance

where node >nul 2>&1
if errorlevel 1 goto :no_node

node "tools\launcher.js" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" goto :failed
endlocal & exit /b 0

:no_node
echo.
echo   Could not start Visionance
echo.
echo   Node.js is not installed, or it is not on your PATH.
echo.
echo   What to do:
echo     1. Install the LTS version from https://nodejs.org
echo     2. Close this window and open a new one ^(so PATH refreshes^)
echo     3. Double-click RUN_VISIONANCE.cmd again
echo.
echo   Nothing else is needed - no Docker, no database, no extra terminals.
echo.
pause
endlocal & exit /b 1

:failed
echo.
echo   Visionance stopped with errors ^(exit code %EXITCODE%^).
echo   The reason is printed above; the full log is in the logs folder.
echo.
pause
endlocal & exit /b %EXITCODE%
