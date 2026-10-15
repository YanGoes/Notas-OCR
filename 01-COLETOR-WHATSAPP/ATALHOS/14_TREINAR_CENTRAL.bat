@echo off
setlocal
cd /d "%~dp0.."

rem Treina e mede a categoria com a planilha do Conta Azul (somente leitura).
rem Para usar outra planilha, arraste o .xls/.xlsx sobre este arquivo.

rem Exportacao mais recente do Conta Azul (pasta acima do programa); sem ela, a antiga.
set "PLANILHA=%~dp0..\..\visao_contas_a_pagar (3).xlsx"
if not exist "%PLANILHA%" set "PLANILHA=C:\Users\vmac_\Desktop\APRENDIZADO DE IA - DESPESAS\visao_contas_a_pagar (1).xls"
if not "%~1"=="" set "PLANILHA=%~1"

if not exist "%PLANILHA%" (
  echo ERRO: planilha nao encontrada:
  echo %PLANILHA%
  pause
  exit /b 1
)

rem Catalogo completo (centros, categorias, fornecedores) com os nomes exatos do Conta Azul.
node ferramentas\importar-catalogo-conta-azul.js "%PLANILHA%"
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
echo Atualizando as notas ainda em revisao com o que a IA sabe agora...
rem So refaz as previas sem correcao humana: o que voce ja corrigiu fica como esta.
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3211/api/central/regerar-pendentes' -ContentType 'application/json' -Body '{}' -TimeoutSec 180; Write-Host ('Notas em revisao atualizadas: ' + $r.regeradas + '. As que voce ja corrigiu ficam como estao.') } catch { Write-Host 'A coleta esta fechada: abra-a e use o botao Refazer previas pendentes na Central.' }"

echo.
echo Treino concluido. O resultado e a maturidade aparecem na aba Treino da Central.
pause
