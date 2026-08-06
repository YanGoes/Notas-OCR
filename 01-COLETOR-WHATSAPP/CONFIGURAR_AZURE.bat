@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" copy ".env.exemplo" ".env" >nul
echo Preencha AZURE_DOCUMENT_ENDPOINT e AZURE_DOCUMENT_KEY, salve e feche.
notepad.exe ".env"
