@echo off
setlocal
cd /d "%~dp0.."

rem Abre a Central de revisao em modo treino (porta 3211).
rem  - Se a coleta (15_COLETAR_WHATSAPP.bat) ja estiver aberta, so abre
rem    a Central no navegador: ela ja esta rodando junto com a coleta.
rem  - Senao, sobe so a Central, SEM conectar o WhatsApp.
rem  - Nada e lancado no Conta Azul nem copiado para o Drive.

netstat -ano | findstr /R /C:":3211 .*LISTENING" >nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:3211/central.html"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado. Execute primeiro 01_INSTALAR_E_INICIAR.bat.
  pause
  exit /b 1
)

if not exist "config.json" (
  echo ERRO: config.json nao encontrado. Copie config.exemplo.json para config.json.
  pause
  exit /b 1
)

set "PORT=3211"
set "NAO_CONECTAR_WHATSAPP=1"
set "NAO_ABRIR_NAVEGADOR=1"
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://127.0.0.1:3211/central.html"
echo Central aberta em http://127.0.0.1:3211/central.html
echo Feche esta janela para encerrar.
node src\interface.js
pause
