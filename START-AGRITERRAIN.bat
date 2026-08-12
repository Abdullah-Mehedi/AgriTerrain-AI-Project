@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js and npm were not found. Install the current Node.js LTS version.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing website packages...
  call npm install
  if errorlevel 1 (
    echo Website package installation failed.
    pause
    exit /b 1
  )
)

start "AgriTerrain AI model service" cmd /k call "%~dp0ml-service\start-service.bat"

echo.
echo Starting the website. Keep this window and the AI-service window open.
call npm run dev
pause
