$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$raizProjeto = Split-Path -Parent $PSScriptRoot
$node = "C:\Program Files\nodejs\node.exe"
$urlPainel = "http://127.0.0.1:3210"
$processoNode = $null

if (-not (Test-Path -LiteralPath $node)) {
    [System.Windows.Forms.MessageBox]::Show("Node.js nao encontrado. Execute INICIAR.bat primeiro.", "Central de Despesas") | Out-Null
    exit 1
}

function Porta-Ativa {
    try {
        $cliente = New-Object Net.Sockets.TcpClient
        $resultado = $cliente.BeginConnect("127.0.0.1", 3210, $null, $null)
        $ok = $resultado.AsyncWaitHandle.WaitOne(500)
        if ($ok) { $cliente.EndConnect($resultado) }
        $cliente.Close()
        return $ok
    } catch { return $false }
}

function Iniciar-Servidor {
    if (Porta-Ativa) { return }
    $env:NAO_ABRIR_NAVEGADOR = "1"
    $caminhoScript = Join-Path $raizProjeto "src\interface.js"

    # O caminho do projeto tem espaco ("PROGRAMA OCR"). Sem as aspas, o node
    # recebe o caminho cortado no espaco e morre antes de abrir o painel.
    $script:processoNode = Start-Process -FilePath $node -ArgumentList "`"$caminhoScript`"" `
        -WorkingDirectory $raizProjeto -WindowStyle Hidden -PassThru

    # Espera o painel subir de fato, para nao abrir o navegador em uma porta morta.
    for ($tentativa = 0; $tentativa -lt 30; $tentativa++) {
        Start-Sleep -Milliseconds 500
        if (Porta-Ativa) { return }
        if ($script:processoNode.HasExited) {
            [System.Windows.Forms.MessageBox]::Show(
                "O painel nao conseguiu iniciar.`n`nSe o programa ja estiver aberto, use o icone que esta na bandeja do Windows. Caso contrario, execute INICIAR.bat para ver a mensagem de erro.",
                "Central de Despesas") | Out-Null
            return
        }
    }
}

function Abrir-Painel { Start-Process $urlPainel }

Iniciar-Servidor

$icone = New-Object System.Windows.Forms.NotifyIcon
$icone.Icon = [System.Drawing.SystemIcons]::Application
$icone.Text = "Central de Despesas"
$icone.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$abrir = $menu.Items.Add("Abrir painel")
$status = $menu.Items.Add("Ver status")
$menu.Items.Add("-") | Out-Null
$sair = $menu.Items.Add("Encerrar aplicativo")

$abrir.Add_Click({ Abrir-Painel })
$icone.Add_DoubleClick({ Abrir-Painel })
$status.Add_Click({
    try {
        $dados = Invoke-RestMethod -Uri "$urlPainel/api/status" -TimeoutSec 3
        $mensagem = "WhatsApp: $($dados.whatsapp.status)`nAzure: $(if ($dados.azure.configurado) {'configurado'} else {'nao configurado'})`nEntrada: $($dados.filas.entrada) | Revisao: $($dados.filas.revisao)"
    } catch { $mensagem = "O servidor local nao esta respondendo." }
    $icone.ShowBalloonTip(5000, "Central de Despesas", $mensagem, [System.Windows.Forms.ToolTipIcon]::Info)
})
$sair.Add_Click({
    $icone.Visible = $false
    if ($script:processoNode -and -not $script:processoNode.HasExited) { Stop-Process -Id $script:processoNode.Id -Force }
    [System.Windows.Forms.Application]::Exit()
})

$icone.ContextMenuStrip = $menu
$icone.ShowBalloonTip(4000, "Central de Despesas", "Aplicativo ativo. Clique duas vezes no icone para abrir o painel.", [System.Windows.Forms.ToolTipIcon]::Info)
[System.Windows.Forms.Application]::Run()

$icone.Dispose()
