@echo off
cd /d "%~dp0"
echo === Installing JavaScript packages ===
call npm.cmd install
if errorlevel 1 (
  echo npm install failed. Install Node.js 22 or newer and try again.
  pause
  exit /b 1
)
echo.
echo === Checking configuration and connectivity ===
call npm.cmd run check
echo.
echo === Starting OpenERLC at http://localhost:8000 (keep this window open) ===
start "" http://localhost:8000
call npm.cmd start
echo.
echo OpenERLC stopped. Scroll up to read the error.
pause
