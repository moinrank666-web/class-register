@echo off
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed or not on PATH.
  echo Install Python 3 from python.org and try again.
  pause
  exit /b 1
)
python server.py
pause
