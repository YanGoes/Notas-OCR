$ErrorActionPreference = "Stop"
$pasta = [Environment]::GetFolderPath("Startup")
foreach ($nome in @("VMac Coleta.lnk", "Central de Despesas.lnk")) {
    $atalho = Join-Path $pasta $nome
    if (Test-Path -LiteralPath $atalho) { Remove-Item -LiteralPath $atalho -Force }
}
Write-Host "Inicio automatico removido. A coleta aberta agora continua ate voce sair pelo icone." -ForegroundColor Green
