@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo Python Launcher was not found. Install Python 3.11 from python.org.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating the Python environment...
  py -3.11 -m venv .venv
  if errorlevel 1 (
    echo Python 3.11 is required for the AI service.
    pause
    exit /b 1
  )
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo The AI packages could not be installed.
  pause
  exit /b 1
)

echo.
echo AgriTerrain AI service is starting at http://127.0.0.1:8000
echo Keep this window open while using Satellite Analysis.
python -m uvicorn main:app --host 127.0.0.1 --port 8000
pause
