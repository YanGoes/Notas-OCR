@echo off
setlocal
cd /d "%~dp0.."

rem Treino com o historico: fotos antigas do Drive passam pela Central como se o
rem operador tivesse mandado no padrao (grupo "Eu e Eu"), conferidas com o que o
rem Conta Azul lancou. Igual ao Conta Azul = aprovada como exemplo; diferente =
rem fica em "Para revisar". GASTA a cota do Azure (1 leitura por foto nova) e
rem guarda 80 leituras para as notas reais do mes.

set "OPERADOR=Almir"
set /p "OPERADOR=Operador (Enter = Almir): "
set "QTD=30"
set /p "QTD=Quantas fotos (Enter = 30): "

echo.
node ferramentas\treino-historico.js --operador "%OPERADOR%" --max %QTD%
echo.
set "OK=N"
set /p "OK=Ler e registrar essas fotos agora? (S/N): "
if /i not "%OK%"=="S" exit /b 0

node ferramentas\treino-historico.js --operador "%OPERADOR%" --max %QTD% --reservar 80 --executar
echo.
echo Pronto. Veja na Central: aprovadas pelo "Conta Azul (historico)" e as que ficaram para revisar.
echo Depois rode o atalho 14 para retreinar e medir a maturidade.
pause
