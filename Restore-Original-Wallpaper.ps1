$ErrorActionPreference = 'Stop'

$backupPath = Join-Path $PSScriptRoot 'data\wallpaper-backup.json'
$backup = Get-Content -LiteralPath $backupPath -Raw -Encoding UTF8 | ConvertFrom-Json
$candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Lively Wallpaper\Lively.exe'),
    (Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Lively.exe'),
    'C:\Program Files\Lively Wallpaper\Lively.exe'
)
$lively = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($lively) {
    & $lively closewp --monitor -1 | Out-Null
    & $lively --shutdown true | Out-Null
}

Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name WallpaperStyle -Value ([string]$backup.wallpaperStyle)
Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name TileWallpaper -Value ([string]$backup.tileWallpaper)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DesktopWallpaperRestore {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool SystemParametersInfo(int action, int param, string value, int flags);
}
'@
$ok = [DesktopWallpaperRestore]::SystemParametersInfo(20, 0, [string]$backup.wallpaper, 3)
if (-not $ok) { throw 'Windows did not accept the original wallpaper path.' }
Write-Host 'The original wallpaper is restored.' -ForegroundColor Green
