@echo off
setlocal
cd /d "%~dp0.."
echo Esta etapa apenas CONSULTA categorias e centros de custo no Conta Azul.
echo Nenhum lancamento ou cadastro sera criado ou alterado no ERP.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:Path='C:\Program Files\nodejs;'+$env:Path; npm.cmd run conta-azul:ids"
echo.
pause
