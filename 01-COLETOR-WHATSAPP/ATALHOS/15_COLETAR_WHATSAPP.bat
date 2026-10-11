@echo off
setlocal
cd /d "%~dp0.."

rem Coleta do WhatsApp (periodo de testes e treino da IA):
rem  - le as fotos e as mensagens de todos os grupos marcados;
rem  - NAO lanca no Conta Azul, NAO copia para o Drive e NAO escreve nos grupos;
rem  - respeita o limite mensal do Azure gratuito (config: pipeline.limite_paginas_azure_mes).
rem Porta 3211. Painel: http://127.0.0.1:3211   Central: http://127.0.0.1:3211/central.html

netstat -ano | findstr /R /C:":3210 .*LISTENING" >nul
if not errorlevel 1 (
  echo OUTRA VERSAO DO PROGRAMA ESTA ABERTA - porta 3210.
  echo Feche a outra antes: as duas coletando ao mesmo tempo leem cada foto
  echo duas vezes e gastam o limite do Azure em dobro.
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":3211 .*LISTENING" >nul
if not errorlevel 1 (
  echo A coleta ja esta aberta. Abrindo o painel no navegador...
  start "" "http://127.0.0.1:3211/"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado. Execute primeiro 01_INSTALAR_E_INICIAR.bat.
  pause
  exit /b 1
)

set "PORT=3211"
set "NAO_ABRIR_NAVEGADOR=1"
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://127.0.0.1:3211/"
echo Coleta aberta em http://127.0.0.1:3211
echo Na primeira vez: conecte o WhatsApp (QR Code) e marque os grupos de despesas.
echo Deixe esta janela aberta enquanto quiser coletar. Fechar = parar a coleta.
node src\interface.js
pause
