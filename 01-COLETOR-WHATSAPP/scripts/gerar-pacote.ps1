$ErrorActionPreference = "Stop"
$raizProjeto = Split-Path -Parent $PSScriptRoot
$data = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$arquivoZip = Join-Path $raizProjeto "coletor-whatsapp-$data.zip"
$itens = @(
    "src", "public", "scripts", "ferramentas", "configuracao", "testes", "ATALHOS", "INICIAR.bat", "ABRIR_APLICATIVO.bat", "CONECTAR_CONTA_AZUL.bat", "CONFIGURAR_AZURE.bat", "TESTAR_PIPELINE.bat", "ATIVAR_INICIO_AUTOMATICO.bat", "REMOVER_INICIO_AUTOMATICO.bat", "GERAR_PACOTE_PARA_ENVIO.bat",
    "config.json", "config.exemplo.json", "package.json",
    "package-lock.json", ".gitignore", ".env.exemplo", "README.md"
) | ForEach-Object { Join-Path $raizProjeto $_ }

Compress-Archive -LiteralPath $itens -DestinationPath $arquivoZip -CompressionLevel Optimal
Write-Host "`nPacote criado com sucesso:" -ForegroundColor Green
Write-Host $arquivoZip
Write-Host "`nSessoes, bibliotecas instaladas e fotos nao foram incluidas."
