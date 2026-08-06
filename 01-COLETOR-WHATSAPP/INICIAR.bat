@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo  COLETOR DE FOTOS DO WHATSAPP
echo ========================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\instalar-e-iniciar.ps1"

if errorlevel 1 (
  echo.
  echo Ocorreu um erro. Leia a mensagem acima.
  pause
)
