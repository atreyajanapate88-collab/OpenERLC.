@echo off
cd /d "%~dp0"
echo === Installing packages ===
python -m pip install -r requirements.txt
echo.
echo === Checking everything (read the OK / FAIL lines) ===
python check.py
echo.
echo === Starting OpenERLC at http://localhost:8000 (keep this window open) ===
start "" http://localhost:8000
python app.py
echo.
echo OpenERLC stopped. Scroll up to read the error.
pause
