@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo =======================================================================
echo                 ENVIO MANUAL DE NOTA ESPECIFICA
echo =======================================================================
echo.
echo Arraste o arquivo da nota/comprovante para esta janela e pressione ENTER,
echo ou digite o caminho completo do arquivo (imagem JPG/PNG ou PDF).
echo.

set /p CAMINHO="Caminho do arquivo: "
if "!CAMINHO!"=="" (
    echo Nenhum arquivo informado.
    goto FIM
)

set CAMINHO=!CAMINHO:"=!

set /p LEGENDA="Legenda / Comentario (opcional, ex: almoco consol mg-050): "

echo.
echo Copiando arquivo para o pipeline de processamento...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:Path='C:\Program Files\nodejs;'+$env:Path; node.exe ferramentas/subir_nota.js \"!CAMINHO!\" --legenda \"!LEGENDA!\""

:FIM
echo.
pause
