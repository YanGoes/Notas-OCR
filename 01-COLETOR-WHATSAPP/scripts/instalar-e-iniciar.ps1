$ErrorActionPreference = "Stop"
$raizProjeto = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $raizProjeto

# Coleta ja aberta (em segundo plano ou noutra janela): nao reinstala nada
# por baixo dela nem abre uma segunda copia; so mostra o painel.
if (Get-NetTCPConnection -LocalPort 3211 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "A coleta ja esta aberta neste computador (icone perto do relogio). Abrindo o painel..." -ForegroundColor Green
    Start-Process "http://127.0.0.1:3211/"
    exit 0
}

function Atualizar-Path {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

# A Central usa o banco SQLite embutido do Node (node:sqlite), que exige
# Node 22.5 ou mais novo. Versao antiga instalada tambem e atualizada.
$versaoAtual = $null
if (Get-Command node -ErrorAction SilentlyContinue) { $versaoAtual = [version]((& node --version).TrimStart("v")) }
$precisaInstalar = (-not $versaoAtual) -or ($versaoAtual -lt [version]"22.5.0")
if ($precisaInstalar) {
    if ($versaoAtual) { Write-Host "Node.js $versaoAtual e antigo demais (precisa 22.5 ou mais novo). Atualizando para a versao LTS..." -ForegroundColor Yellow }
    else { Write-Host "Node.js nao encontrado. Instalando a versao LTS..." -ForegroundColor Yellow }

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
    # Inclui as bibliotecas de desenvolvimento: o treino da IA (atalho 14) usa o exceljs.
    & npm.cmd ci
} else {
    & npm.cmd install
}
if ($LASTEXITCODE -ne 0) {
    throw "Nao foi possivel instalar as bibliotecas (codigo $LASTEXITCODE)."
}

Write-Host "`nIniciando o coletor...`n" -ForegroundColor Green
& npm.cmd start
if ($LASTEXITCODE -ne 0) {
    throw "O coletor encerrou com erro (codigo $LASTEXITCODE)."
}
