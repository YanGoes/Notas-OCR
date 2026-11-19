# =============================================================================
# ESCONDE / MOSTRA A JANELA DO ROBO DO CONTA AZUL
# =============================================================================
#
# O robo de tela (que anexa a foto no lancamento) usa um Chrome separado, com
# perfil proprio (dados/navegador-conta-azul[-oficial]). Ele funciona com a
# janela ESCONDIDA (fora da tela e da barra de tarefas); so precisa aparecer
# para a pessoa fazer o login quando a sessao expira.
#
#   powershell -File janela-robo.ps1 -Perfil <pasta do perfil> -Acao esconder
#   powershell -File janela-robo.ps1 -Perfil <pasta do perfil> -Acao mostrar
#
# Acha o processo principal do Chrome daquele perfil (pela linha de comando) e
# esconde/mostra as janelas de navegador dele. Nao fecha nada, nao mexe no
# Chrome do dia a dia (outro perfil). Texto sem acentos: PS 5.1 le .ps1 como ANSI.
# =============================================================================

param(
    [Parameter(Mandatory = $true)][string]$Perfil,
    [ValidateSet("esconder", "mostrar")][string]$Acao = "esconder"
)
$ErrorActionPreference = "Stop"

if (-not ([System.Management.Automation.PSTypeName]'VMac.JanelaRobo').Type) {
    Add-Type -Namespace VMac -Name JanelaRobo -MemberDefinition @'
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetWindowTextLength(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder nome, int tamanho);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr depois, int x, int y, int cx, int cy, uint flags);
'@
}

$pasta = [System.IO.Path]::GetFullPath($Perfil).TrimEnd('\')
# "navegador-conta-azul" e prefixo de "navegador-conta-azul-oficial": o nome
# do perfil tem de terminar ali (aspas, espaco ou fim da linha de comando).
$padrao = '--user-data-dir="?' + [regex]::Escape($pasta) + '"?(\s|$)'
$principal = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
    Where-Object { $_.CommandLine -match $padrao -and $_.CommandLine -notmatch '--type=' } |
    Select-Object -First 1
if (-not $principal) { Write-Output "janela do robo nao esta aberta"; exit 2 }

$alvo = [uint32]$principal.ProcessId
$janelas = New-Object System.Collections.Generic.List[System.IntPtr]
$coletar = [VMac.JanelaRobo+EnumWindowsProc] {
    param($h, $l)
    $dono = [uint32]0
    [void][VMac.JanelaRobo]::GetWindowThreadProcessId($h, [ref]$dono)
    if ($dono -eq $alvo -and [VMac.JanelaRobo]::GetWindowTextLength($h) -gt 0) {
        $classe = New-Object System.Text.StringBuilder 64
        [void][VMac.JanelaRobo]::GetClassName($h, $classe, 64)
        # Janela de navegador do Chrome/Edge (as auxiliares nao tem titulo).
        if ($classe.ToString() -eq "Chrome_WidgetWin_1") { $janelas.Add($h) }
    }
    return $true
}
[void][VMac.JanelaRobo]::EnumWindows($coletar, [System.IntPtr]::Zero)

$feitas = 0
foreach ($h in $janelas) {
    if ($Acao -eq "esconder") {
        if ([VMac.JanelaRobo]::IsWindowVisible($h)) { [void][VMac.JanelaRobo]::ShowWindow($h, 0); $feitas++ }   # SW_HIDE
    } else {
        [void][VMac.JanelaRobo]::ShowWindow($h, 9)                                                                 # SW_RESTORE
        # O robo abre a janela fora da tela: traz para dentro (mantem o tamanho).
        [void][VMac.JanelaRobo]::SetWindowPos($h, [System.IntPtr]::Zero, 80, 60, 0, 0, 0x0005)                   # SWP_NOSIZE|SWP_NOZORDER
        [void][VMac.JanelaRobo]::SetForegroundWindow($h)
        $feitas++
    }
}
Write-Output "$Acao`: $feitas janela(s) (processo $alvo)"
exit 0
