$ErrorActionPreference = 'Stop'

& "$PSScriptRoot\Download-Companion-Model.ps1"

$health = $null
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$PSScriptRoot\Start-Companion-Model.bat`"" -WindowStyle Hidden
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:1235/health' -TimeoutSec 2
        if ($health.status -eq 'ok') { break }
    } catch {}
}
if (-not $health -or $health.status -ne 'ok') { throw 'Companion model server did not become ready.' }

Write-Host '[OK] Local companion installation is complete.' -ForegroundColor Green
schtasks.exe /Delete /TN 'Codex-CyberGF-Finalize' /F | Out-Null
