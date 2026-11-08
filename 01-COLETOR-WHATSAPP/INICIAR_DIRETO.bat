@echo off
rem Inicia o programa direto, sem instalar nada nem abrir bandeja.
cd /d "%~dp0"
node src/interface.js
pause
