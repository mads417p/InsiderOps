@echo off
title InsiderOps v2.0 Quant Terminal
if exist "%~dp0package.json" (
    cd /d "%~dp0"
) else (
    cd /d "c:\Users\Mads\Documents\InsiderOps"
)
cls
echo =====================================================================
echo              INSIDEROPS v2.0 QUANT TERMINAL
echo   SEC Form 4 Omni-Scanner ^& Multi-Agent Asymmetry Council
echo =====================================================================
echo.
echo [*] Starter InsiderOps v2.0 pa http://127.0.0.1:3000...
echo [*] Standardbrowseren abnes automatisk om 3 sekunder...
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3000'"
npm run dev
