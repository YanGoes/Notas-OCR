@echo off
rem Treino automatico (Agendador de Tarefas do Windows): retreina com a planilha
rem e com as notas APROVADAS na Central, mede o acerto contra o que foi aprovado
rem e grava tudo em dados\logs\treino-agendado.log. Nao lanca nada em lugar nenhum
rem e nao chama o Azure (usa as leituras ja guardadas).
setlocal
cd /d "%~dp0.."
if not exist "dados\logs" mkdir "dados\logs"
set "LOG=dados\logs\treino-agendado.log"
echo ===== Treino agendado: %DATE% %TIME% ===== >> "%LOG%"
node ferramentas\treinar-central.js >> "%LOG%" 2>&1
echo. >> "%LOG%"
echo ----- Acerto contra as notas aprovadas ----- >> "%LOG%"
node ferramentas\medir-contra-aprovadas.js >> "%LOG%" 2>&1
echo ===== Fim: %DATE% %TIME% ===== >> "%LOG%"
echo. >> "%LOG%"
