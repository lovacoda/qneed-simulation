@echo off
chcp 65001 >nul
cd /d "%~dp0"
title qneed AI Ikiz

echo qneed AI Ikiz baslatiliyor...
echo Durdurmak icin bu pencerede Ctrl+C.
echo.

call npm run ui

pause
