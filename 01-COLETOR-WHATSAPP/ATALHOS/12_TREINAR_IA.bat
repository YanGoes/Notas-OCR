@echo off
setlocal
cd /d "%~dp0.."

set "PLANILHA=C:\Users\vmac_\Desktop\APRENDIZADO DE IA - DESPESAS\visao_contas_a_pagar (1).xls"
if not "%~1"=="" set "PLANILHA=%~1"

if not exist "%PLANILHA%" (
  echo ERRO: planilha nao encontrada:
  echo %PLANILHA%
  echo.
  echo Arraste a planilha sobre este arquivo BAT e tente novamente.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo ERRO: Node.js/npm nao encontrado. Execute primeiro 01_INSTALAR_E_INICIAR.bat.
  pause
  exit /b 1
)

echo Instalando a biblioteca necessaria para ler a planilha...
call npm.cmd install --include=dev
if errorlevel 1 goto :erro

echo.
echo Treinando com: %PLANILHA%
call npm.cmd run treinar-historico -- "%PLANILHA%"
if errorlevel 1 goto :erro

echo.
echo Treinamento concluido. Feche e abra o aplicativo para carregar o novo modelo.
pause
exit /b 0

:erro
echo.
echo O treinamento nao foi concluido. Leia a mensagem acima.
pause
exit /b 1
