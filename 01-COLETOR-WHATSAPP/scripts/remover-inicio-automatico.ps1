$ErrorActionPreference = "Stop"
$atalho = Join-Path ([Environment]::GetFolderPath("Startup")) "Central de Despesas.lnk"
if (Test-Path -LiteralPath $atalho) { Remove-Item -LiteralPath $atalho -Force }
Write-Host "Inicio automatico removido." -ForegroundColor Green
