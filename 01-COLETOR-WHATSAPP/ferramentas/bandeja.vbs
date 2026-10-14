' Abre a bandeja da Coleta VMac sem mostrar janela (usado pelo atalho da
' pasta Inicializar do Windows).
Set shell = CreateObject("WScript.Shell")
pasta = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & pasta & "\bandeja.ps1""", 0, False
