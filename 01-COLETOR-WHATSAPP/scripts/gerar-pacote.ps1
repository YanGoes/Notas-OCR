$ErrorActionPreference = "Stop"
$raizProjeto = Split-Path -Parent $PSScriptRoot
$data = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$arquivoZip = Join-Path $raizProjeto "coletor-whatsapp-$data.zip"

# Somente codigo e configuracoes sem dado pessoal. Ficam de fora: sessoes do
# WhatsApp, .env, tokens, config.json (empresa/grupos), configuracao/pessoas.json
# (telefones), banco da Central, fotos e bibliotecas instaladas.
$itens = @(
    "src", "public", "scripts", "ferramentas", "configuracao", "testes", "docs", "ATALHOS",
    "INICIAR.bat", "ABRIR_APLICATIVO.bat", "mapeamento.json",
    "config.exemplo.json", "package.json", "package-lock.json", ".gitignore", ".env.exemplo", "README.md"
)
$excluirArquivos = @("pessoas.json", "*.bak", "*.db", "*.db-wal", "*.db-shm")

$staging = Join-Path ([IO.Path]::GetTempPath()) "pacote-central-$data"
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    foreach ($item in $itens) {
        $origem = Join-Path $raizProjeto $item
        if (-not (Test-Path -LiteralPath $origem)) { Write-Host "Ignorado (nao existe): $item" -ForegroundColor Yellow; continue }
        Copy-Item -LiteralPath $origem -Destination $staging -Recurse
    }
    # Filtro explicito: no PowerShell 5.1, -Include junto de -LiteralPath casa com tudo.
    Get-ChildItem -LiteralPath $staging -Recurse -File |
        Where-Object { $nome = $_.Name; $excluirArquivos | Where-Object { $nome -like $_ } } |
        Remove-Item -Force
    Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $arquivoZip -CompressionLevel Optimal
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force
}
Write-Host "`nPacote criado com sucesso:" -ForegroundColor Green
Write-Host $arquivoZip
Write-Host "`nSessoes, credenciais, telefones, banco, bibliotecas instaladas e fotos nao foram incluidos."
