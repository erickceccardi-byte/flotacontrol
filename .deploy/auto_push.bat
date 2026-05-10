@echo off
title FlotaControl Auto-Push
cd /d "%~dp0\.."

echo ===============================================
echo  FlotaControl AUTO-PUSH activo
echo ===============================================
echo.
echo Carpeta: %CD%
echo.
echo Cada 30 segundos chequea si hay commits sin pushear y los sube.
echo Mientras esta ventana este abierta, Claude puede modificar archivos
echo y los cambios salen a GitHub Pages solos.
echo.
echo Para parar: cerra esta ventana.
echo.

:loop
git fetch origin main >nul 2>&1
git rev-list --count origin/main..HEAD > "%TEMP%\fc_pend.txt" 2>nul
set /p PENDIENTES=<"%TEMP%\fc_pend.txt"
del "%TEMP%\fc_pend.txt" >nul 2>&1

if "%PENDIENTES%"=="" set PENDIENTES=0

if "%PENDIENTES%"=="0" (
    REM nada que subir, espera siguiente check
    echo [%TIME:~0,8%] sin cambios.
) else (
    echo [%TIME:~0,8%] subiendo %PENDIENTES% commit^(s^)...
    git push origin main
    echo.
)

timeout /t 30 /nobreak >nul
goto loop
