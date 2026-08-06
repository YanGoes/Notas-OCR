$ErrorActionPreference = "Stop"
$raizProjeto = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $raizProjeto

function Atualizar-Path {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js nao encontrado. Instalando a versao LTS..." -ForegroundColor Yellow

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Nao foi possivel instalar o Node.js automaticamente. Instale a versao LTS em https://nodejs.org e execute o INICIAR.bat novamente."
    }

    & winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "A instalacao automatica do Node.js falhou (codigo $LASTEXITCODE)."
    }

    Atualizar-Path
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "O npm nao foi encontrado. Feche esta janela, abra novamente e execute o INICIAR.bat."
}

Write-Host "Verificando bibliotecas do projeto..." -ForegroundColor Cyan
if (Test-Path -LiteralPath (Join-Path $raizProjeto "package-lock.json")) {
    & npm.cmd ci --omit=dev
} else {
    & npm.cmd install --omit=dev
}
if ($LASTEXITCODE -ne 0) {
    throw "Nao foi possivel instalar as bibliotecas (codigo $LASTEXITCODE)."
}

Write-Host "`nIniciando o coletor...`n" -ForegroundColor Green
& npm.cmd start
if ($LASTEXITCODE -ne 0) {
    throw "O coletor encerrou com erro (codigo $LASTEXITCODE)."
}
