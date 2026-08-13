@echo off
setlocal
cd /d "%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:Path='C:\Program Files\nodejs;'+$env:Path; npm.cmd run pipeline:testar"
pause
