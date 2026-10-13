@echo off
setlocal
cd /d "%~dp0.."

rem Treina e mede a categoria com a planilha do Conta Azul (somente leitura).
rem Para usar outra planilha, arraste o .xls/.xlsx sobre este arquivo.

set "PLANILHA=C:\Users\vmac_\Desktop\APRENDIZADO DE IA - DESPESAS\visao_contas_a_pagar (1).xls"
if not "%~1"=="" set "PLANILHA=%~1"

if not exist "%PLANILHA%" (
  echo ERRO: planilha nao encontrada:
  echo %PLANILHA%
  pause
  exit /b 1
)

node ferramentas\treinar-central.js "%PLANILHA%"
if errorlevel 1 (
  echo.
  echo O treino nao foi concluido. Leia a mensagem acima.
  pause
  exit /b 1
)

echo.
echo Medindo a maturidade da IA nas notas aprovadas...
node ferramentas\medir-contra-aprovadas.js
if errorlevel 1 (
  echo.
  echo A medicao de maturidade nao foi concluida. Leia a mensagem acima.
  pause
  exit /b 1
)

echo.
echo Treino concluido. O resultado e a maturidade aparecem na aba Treino da Central.
pause
