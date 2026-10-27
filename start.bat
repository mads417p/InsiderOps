@echo off
chcp 65001 >nul
title InsiderOps Terminal v1.2-RADAR
color 0B
cls
echo ===============================================================================
echo          INSIDEROPS // INFORMATION ASYMMETRY TERMINAL
echo ===============================================================================
echo.
echo [*] Skifter til projektmappen: C:\Users\Mads\Documents\InsiderOps
cd /d "C:\Users\Mads\Documents\InsiderOps"

echo [*] Starter InsiderOps webserver via Next.js Turbopack...
echo [*] Din standardbrowser aabner automatisk paa http://localhost:3000 om et ojeblik...
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000'"

npm run dev

echo.
echo [*] Serveren er stoppet.
pause
