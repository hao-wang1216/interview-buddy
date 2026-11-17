@echo off
setlocal
cd /d "%~dp0"
if not exist "dist\main.mjs" (
  call npm run build
  if errorlevel 1 exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  call npm run start
  exit /b
)
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
