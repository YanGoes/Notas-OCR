# =============================================================================
# COLETA VMAC EM SEGUNDO PLANO (icone perto do relogio do Windows)
# =============================================================================
#
# - Abre a coleta do WhatsApp escondida (sem janela preta), porta 3211.
# - A cada 30 s confere se ela esta de pe; se parou, religa sozinha
#   (no maximo 5 vezes em 10 minutos, para nao ficar em loop num erro).
# - Mostra o estado no icone: verde = WhatsApp conectado, amarelo = programa
#   aberto mas WhatsApp desconectado, vermelho = programa parado.
# - Enquanto roda, impede o Windows de SUSPENDER (a tela ainda pode apagar):
#   PC dormindo = mensagens perdidas.
# - Menu (botao direito): abrir a Central, abrir o painel, reiniciar, sair.
#
# Iniciado pelo atalho "VMac Coleta" na pasta Inicializar do Windows
# (ATALHOS\16_SEGUNDO_PLANO_E_INICIAR_COM_WINDOWS.bat).
# Texto sem acentos de proposito: o PowerShell 5.1 le .ps1 como ANSI.
# =============================================================================

$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$raiz = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $raiz "dados\logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$porta = 3211
$painel = "http://127.0.0.1:$porta/"
$central = "http://127.0.0.1:$porta/central.html"

# Uma bandeja so por usuario.
$criado = $false
$trava = New-Object System.Threading.Mutex($true, "VMacColetaBandeja", [ref]$criado)
if (-not $criado) { exit 0 }

# Impede a suspensao enquanto a bandeja estiver aberta.
Add-Type -Namespace VMac -Name Energia -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
[void][VMac.Energia]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

$script:quedas = @()
$script:ultimoStatus = ""
$script:desistiu = $false
$script:processo = $null
$script:iniciadoEm = Get-Date

function Registrar([string]$texto) {
    $linha = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $texto
    Add-Content -Path (Join-Path $logs "bandeja.log") -Value $linha -Encoding UTF8
}

function Novo-Icone([System.Drawing.Color]$cor) {
    $imagem = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($imagem)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $cor), 1, 1, 14, 14)
    $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 1), 1, 1, 14, 14)
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($imagem.GetHicon())
}
$icones = @{
    ok      = Novo-Icone ([System.Drawing.Color]::FromArgb(22, 163, 74))
    atencao = Novo-Icone ([System.Drawing.Color]::FromArgb(234, 179, 8))
    parado  = Novo-Icone ([System.Drawing.Color]::FromArgb(220, 38, 38))
}

$bandeja = New-Object System.Windows.Forms.NotifyIcon
$bandeja.Icon = $icones.atencao
$bandeja.Text = "Coleta VMac: iniciando"
$bandeja.Visible = $true

function Mostrar-Estado([string]$tipo, [string]$texto) {
    $bandeja.Icon = $icones[$tipo]
    if ($texto.Length -gt 63) { $texto = $texto.Substring(0, 63) }
    $bandeja.Text = $texto
}

function Avisar([string]$titulo, [string]$texto, [System.Windows.Forms.ToolTipIcon]$tipo = [System.Windows.Forms.ToolTipIcon]::Info) {
    $bandeja.ShowBalloonTip(8000, $titulo, $texto, $tipo)
}

function Pid-Na-Porta {
    $conexao = Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conexao) { return $conexao.OwningProcess }
    return $null
}

function Iniciar-Coleta {
    if (Pid-Na-Porta) { return }
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Registrar "node nao encontrado"; Mostrar-Estado "parado" "Coleta VMac: Node.js nao encontrado"; return }
    foreach ($nome in @("coletor-saida.log", "coletor-erros.log")) {
        $arquivo = Join-Path $logs $nome
        if (Test-Path $arquivo) { Move-Item -Force $arquivo "$arquivo.anterior" }
    }
    $env:PORT = "$porta"
    $env:NAO_ABRIR_NAVEGADOR = "1"
    $processo = Start-Process -FilePath $node -ArgumentList "src\interface.js" -WorkingDirectory $raiz -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logs "coletor-saida.log") -RedirectStandardError (Join-Path $logs "coletor-erros.log")
    $script:processo = $processo
    $script:iniciadoEm = Get-Date
    Registrar "coleta iniciada (processo $($processo.Id))"
}

function Parar-Coleta {
    $id = Pid-Na-Porta
    if ($id) {
        try { Stop-Process -Id $id -Force -ErrorAction Stop; Registrar "coleta parada (processo $id)" } catch { Registrar "nao consegui parar o processo ${id}: $_" }
    }
}

function Verificar {
    if (-not (Pid-Na-Porta)) {
        if ($script:desistiu) { return }
        # Ainda abrindo (o programa leva alguns segundos para atender na porta).
        if ($script:processo -and -not $script:processo.HasExited -and $script:iniciadoEm -gt (Get-Date).AddSeconds(-90)) { return }
        $agora = Get-Date
        $script:quedas = @($script:quedas | Where-Object { $_ -gt $agora.AddMinutes(-10) })
        if ($script:quedas.Count -ge 5) {
            $script:desistiu = $true
            Registrar "5 quedas em 10 minutos: parei de religar"
            Mostrar-Estado "parado" "Coleta VMac PARADA (erro repetido)"
            Avisar "Coleta VMac parada" "O programa caiu 5 vezes seguidas. Use 'Reiniciar coleta' ou veja dados\logs\coletor-erros.log." ([System.Windows.Forms.ToolTipIcon]::Error)
            return
        }
        if ($script:ultimoStatus -ne "") {
            Registrar "coleta tinha parado; religando"
            Avisar "Coleta VMac religada" "O programa tinha parado e foi aberto de novo automaticamente." ([System.Windows.Forms.ToolTipIcon]::Warning)
        }
        $script:quedas += $agora
        Mostrar-Estado "parado" "Coleta VMac: religando..."
        Iniciar-Coleta
        $script:ultimoStatus = "religando"
        return
    }
    try {
        $status = Invoke-RestMethod -Uri "$($painel)api/status" -TimeoutSec 8
        $whats = [string]$status.whatsapp.status
    } catch {
        Mostrar-Estado "atencao" "Coleta VMac: abrindo..."
        return
    }
    if ($whats -eq "conectado") {
        Mostrar-Estado "ok" "Coleta VMac: WhatsApp conectado"
    } else {
        Mostrar-Estado "atencao" "Coleta VMac: WhatsApp $whats"
        if ($script:ultimoStatus -eq "conectado") {
            Avisar "WhatsApp desconectado" "A coleta esta aberta, mas o WhatsApp caiu. Abra o painel para reconectar." ([System.Windows.Forms.ToolTipIcon]::Warning)
        }
    }
    $script:ultimoStatus = $whats
}

# Menu do botao direito
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemCentral = $menu.Items.Add("Abrir Central de revisao")
$itemCentral.Font = New-Object System.Drawing.Font($itemCentral.Font, [System.Drawing.FontStyle]::Bold)
$itemCentral.Add_Click({ Start-Process $central })
$menu.Items.Add("Abrir painel do WhatsApp").Add_Click({ Start-Process $painel })
$menu.Items.Add("Reiniciar coleta").Add_Click({
    Registrar "reinicio pedido pelo menu"
    $script:desistiu = $false
    $script:quedas = @()
    Parar-Coleta
    Start-Sleep -Seconds 2
    Iniciar-Coleta
    Mostrar-Estado "atencao" "Coleta VMac: reiniciando..."
})
$menu.Items.Add("Ver registro (logs)").Add_Click({ Start-Process explorer.exe $logs })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$menu.Items.Add("Sair (parar a coleta)").Add_Click({
    $resposta = [System.Windows.Forms.MessageBox]::Show("Parar a coleta do WhatsApp? Enquanto estiver parada, novas notas podem se perder.", "Coleta VMac", "YesNo", "Warning")
    if ($resposta -eq "Yes") {
        Registrar "saida pedida pelo menu"
        $timer.Stop()
        Parar-Coleta
        $bandeja.Visible = $false
        [void][VMac.Energia]::SetThreadExecutionState($ES_CONTINUOUS)
        [System.Windows.Forms.Application]::Exit()
    }
})
$bandeja.ContextMenuStrip = $menu
$bandeja.Add_DoubleClick({ Start-Process $central })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.Add_Tick({ Verificar })

Registrar "bandeja aberta"
Iniciar-Coleta
$script:ultimoStatus = ""
$timer.Start()
[System.Windows.Forms.Application]::Run()
$bandeja.Dispose()
$trava.ReleaseMutex()
