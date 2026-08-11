@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo =======================================================================
echo              TESTADOR INTERATIVO DO ENRIQUECEDOR CONTA AZUL
echo =======================================================================
echo.
echo Insira os dados da despesa para testar o enriquecimento.
echo (Pressione ENTER em campos entre chaves [] para usar o valor de exemplo)
echo.

set /p VALOR="1. Valor da despesa [48.00]: "
if "!VALOR!"=="" set VALOR=48.00

set /p DATA="2. Data de competencia AAAA-MM-DD [2026-08-11]: "
if "!DATA!"=="" set DATA=2026-08-11

set /p CATEGORIA="3. Categoria/Tipo (ex: almoco, combustivel, pedagio) [almoco]: "
if "!CATEGORIA!"=="" set CATEGORIA=almoco

set /p CENTRO="4. Centro de Custo (opcional, ex: consol mg-050): "

set /p PAGAMENTO="5. Forma de Pagamento (opcional, ex: pix, dinheiro, credito): "

set /p VEICULO="6. Placa/Veiculo (opcional, ex: sgr4b54): "

echo.
echo -----------------------------------------------------------------------
echo Escolha o modo de execucao:
echo [1] SIMULACAO (Dry-Run: testa a busca e resolucao sem alterar o ERP)
echo [2] EXECUCAO REAL (Envia o PATCH para a API do Conta Azul)
set /p MODO="Digite 1 ou 2 [Padrao: 1]: "

set ARGS=--valor !VALOR! --data !DATA! --categoria "!CATEGORIA!"

if not "!CENTRO!"=="" set ARGS=!ARGS! --centro "!CENTRO!"
if not "!PAGAMENTO!"=="" set ARGS=!ARGS! --pagamento "!PAGAMENTO!"
if not "!VEICULO!"=="" set ARGS=!ARGS! --veiculo "!VEICULO!"
if "!MODO!"=="2" set ARGS=!ARGS! --executar

echo.
echo =======================================================================
echo Executando enriquecedor...
echo =======================================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:Path='C:\Program Files\nodejs;'+$env:Path; npm.cmd run enriquecedor:testar -- !ARGS!"

echo.
pause
