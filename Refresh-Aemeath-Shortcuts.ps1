$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$oldNameMarker = [char]0x7EAB
Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' | Where-Object { $_.Name.Contains($oldNameMarker) } | Remove-Item -Force
$shell = New-Object -ComObject WScript.Shell
$start = $shell.CreateShortcut((Join-Path $desktop 'Aemeath-Local-Companion.lnk'))
$start.TargetPath = 'cmd.exe'
$start.Arguments = '/c "' + (Join-Path $PSScriptRoot 'Start-Aemeath-Companion.bat') + '"'
$start.WorkingDirectory = $PSScriptRoot
$start.IconLocation = 'shell32.dll,14'
$start.Save()
$stop = $shell.CreateShortcut((Join-Path $desktop 'Stop-Aemeath-Local-Companion.lnk'))
$stop.TargetPath = 'cmd.exe'
$stop.Arguments = '/c "' + (Join-Path $PSScriptRoot 'Stop-Aemeath-Companion.bat') + '"'
$stop.WorkingDirectory = $PSScriptRoot
$stop.IconLocation = 'shell32.dll,132'
$stop.Save()
Write-Host 'Aemeath desktop shortcuts refreshed.'
