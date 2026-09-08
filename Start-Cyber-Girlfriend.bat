@echo off
title Aemeath Local Companion
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\sherpa-onnx-node" (
  echo Installing local dependencies...
  call npm install --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Desktop-Companion-Services.ps1"
if errorlevel 1 (
  echo Companion startup was stopped. See the message above.
  pause
  exit /b 1
)
rem Open the animated Aemeath stage by default; the control panel remains at /
set "APP_URL=http://127.0.0.1:17860"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app="%APP_URL%/stage/" --start-maximized --autoplay-policy=no-user-gesture-required --user-data-dir="%~dp0data\chrome-profile"
) else (
  start "" "%APP_URL%/stage/"
)
