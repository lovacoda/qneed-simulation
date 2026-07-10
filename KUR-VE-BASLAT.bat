@echo off
chcp 65001 >nul
cd /d "%~dp0"
title qneed AI Ikiz

echo ==========================================
echo    qneed AI Ikiz - Kurulum ve Baslatma
echo ==========================================
echo.

REM --- 1) Node.js kurulu mu? Degilse winget ile kur ---
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi, kuruluyor... UAC penceresi cikarsa "Evet" de.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo [HATA] winget yok. https://nodejs.org adresinden LTS surumunu elle kur,
    echo        sonra bu dosyayi tekrar calistir.
    pause
    exit /b 1
  )
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  set "PATH=%ProgramFiles%\nodejs\;%PATH%"
)

REM PATH bu oturumda guncel degilse tamamla
where node >nul 2>nul
if errorlevel 1 set "PATH=%ProgramFiles%\nodejs\;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo [HATA] Node.js kurulamadi. https://nodejs.org LTS surumunu elle kurup tekrar dene.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo Node.js surumu: %%v
echo.

REM --- 2) Paketler (node_modules) ---
if not exist "node_modules\" (
  echo Paketler kuruluyor ^(npm install^)... ilk sefer birkac dakika surebilir.
  call npm install
  if errorlevel 1 (
    echo [HATA] npm install basarisiz oldu.
    pause
    exit /b 1
  )
) else (
  echo Paketler zaten kurulu.
)
echo.

REM --- 3) .env var mi? ---
if not exist ".env" (
  echo [UYARI] .env dosyasi yok - API anahtarlari olmadan calismaz.
  echo         Klasoru kopyalarken .env de icinde olmali
  echo         ^(git clone ile .env GELMEZ, elle kopyalanmali^).
  echo.
  pause
)

REM --- 4) Baslat ---
echo Arayuz baslatiliyor... tarayici otomatik acilacak.
echo Durdurmak icin bu pencerede Ctrl+C.
echo.
call npm run ui

pause
