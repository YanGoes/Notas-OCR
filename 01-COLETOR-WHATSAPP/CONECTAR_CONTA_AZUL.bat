@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" copy ".env.exemplo" ".env" >nul
echo Abra o arquivo .env, preencha as tres informacoes e salve.
notepad.exe ".env"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:Path='C:\Program Files\nodejs;'+$env:Path; npm.cmd run conta-azul:conectar"
pause
