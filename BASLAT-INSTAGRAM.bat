@echo off
chcp 65001 >nul
cd /d "%~dp0"
title qneed AI Ikiz - Instagram

echo Instagram DM sunucusu baslatiliyor...
echo Bu pencere acik kaldigi surece ikiz DM'lere cevap verir.
echo Durdurmak icin Ctrl+C.
echo.
echo NOT: Ayri bir pencerede tunel de acik olmali:
echo   cloudflared tunnel --url http://localhost:3940
echo.

call npm run instagram

pause
