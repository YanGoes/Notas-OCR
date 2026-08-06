$ErrorActionPreference = "Stop"
$raizProjeto = Split-Path -Parent $PSScriptRoot
$iniciar = Join-Path $raizProjeto "ABRIR_APLICATIVO.bat"
$startup = [Environment]::GetFolderPath("Startup")
$atalho = Join-Path $startup "Central de Despesas.lnk"
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($atalho)
$link.TargetPath = $iniciar
$link.WorkingDirectory = $raizProjeto
$link.Description = "Inicia a Central de Despesas na bandeja do Windows"
$link.Save()
Write-Host "Inicio automatico ativado." -ForegroundColor Green
Write-Host "O programa abrira quando este usuario entrar no Windows."
Write-Host "O computador precisa permanecer ligado e conectado a internet para operar continuamente."
