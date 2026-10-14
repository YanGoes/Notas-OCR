# Abre a coleta junto com o Windows, em segundo plano (bandeja nova:
# religa sozinha e mostra o estado). Remove o atalho antigo, se houver.
$antigo = Join-Path ([Environment]::GetFolderPath("Startup")) "Central de Despesas.lnk"
if (Test-Path -LiteralPath $antigo) { Remove-Item -LiteralPath $antigo -Force }
& (Join-Path (Split-Path -Parent $PSScriptRoot) "ferramentasinstalar-inicio.ps1")
Write-Host "Inicio automatico ativado. O computador precisa ficar ligado e com internet." -ForegroundColor Green
