# Coloca a Coleta VMac para abrir junto com o Windows (atalho na pasta
# Inicializar do usuario) e abre a bandeja agora. Para desfazer: apague
# "VMac Coleta.lnk" em shell:startup (Win+R > shell:startup).
$raiz = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot "bandeja.vbs"
$atalho = Join-Path ([Environment]::GetFolderPath("Startup")) "VMac Coleta.lnk"
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($atalho)
$link.TargetPath = "wscript.exe"
$link.Arguments = '"' + $vbs + '"'
$link.WorkingDirectory = $raiz
$link.Description = "Coleta VMac em segundo plano"
$link.Save()
Write-Output "Inicio automatico configurado: $atalho"
Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"')
Write-Output "Bandeja aberta: procure a bolinha colorida perto do relogio (seta ^ da barra de tarefas)."
