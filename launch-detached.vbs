Set shell = CreateObject("WScript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
command = "cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\Start-Companion-Server.ps1"" 1>>data\server.log 2>>data\server-error.log"
shell.Run command, 0, False
