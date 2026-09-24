@echo off
setlocal
cd /d "%~dp0"
title Email Validator Advanced v6.4 Validect API

echo.
echo ===============================================
echo   Email Validator Advanced v6.4 Validect API
echo   Validect RapidAPI backend
echo ===============================================
echo.

if not exist .env copy .env.example .env

if not exist node_modules (
  echo Installing required Node packages once...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed. Install Node.js 20+ and run this file again.
    pause
    exit /b 1
  )
)

set PORT=3093
set LOCAL_TEST_MODE=1
set API_KEY=

echo Starting backend on http://localhost:3093
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3093"
node server.js
pause
