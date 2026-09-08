[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$companionRoot = $PSScriptRoot
. (Join-Path $companionRoot 'scripts/companion-runtime.ps1')

function Test-LocalPort {
  param([int]$Port)
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $result = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $connected = $result.AsyncWaitHandle.WaitOne(250) -and $client.Connected
    if ($connected) { $client.EndConnect($result) }
    $client.Dispose()
    return $connected
  } catch {
    return $false
  }
}

$config = Get-Content -Raw -Encoding UTF8 (Join-Path $companionRoot 'config.json') | ConvertFrom-Json
& node (Join-Path $companionRoot 'scripts/check-local-config.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Companion configuration failed local-only validation. No services were started.' }
if ($config.app.host -ne '127.0.0.1' -or $config.app.port -ne 17860) { throw 'This desktop launcher expects 127.0.0.1:17860.' }
$companionAlreadyRunning = Test-LocalPort 17860
if ($companionAlreadyRunning -and -not (Test-CompanionRuntime)) {
  throw 'Port 17860 is occupied by an old or unknown service. Stop the companion you started, then reopen this launcher. No process was killed or reused.'
}
if ($config.llm.mode -eq 'local' -and -not (Test-LocalPort 1235)) {
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList @("/c", "call `"$(Join-Path $companionRoot 'Start-Companion-Model.bat')`"") `
    -WorkingDirectory $companionRoot `
    -WindowStyle Hidden
}

if (-not (Test-LocalPort 17861)) {
  Start-Process -FilePath "wscript.exe" `
    -ArgumentList @("`"$(Join-Path $companionRoot 'launch-natural-voice.vbs')`"") `
    -WorkingDirectory $companionRoot `
    -WindowStyle Hidden
}

if (-not $companionAlreadyRunning) {
  Start-Process -FilePath "wscript.exe" `
    -ArgumentList @("`"$(Join-Path $companionRoot 'launch-detached.vbs')`"") `
    -WorkingDirectory $companionRoot `
    -WindowStyle Hidden
}

$runtimeDeadline = (Get-Date).AddSeconds(45)
while (-not (Test-CompanionRuntime)) {
  if ((Get-Date) -ge $runtimeDeadline) { throw 'The companion runtime did not become ready. Inspect data/server-error.log; stage was not opened.' }
  Start-Sleep -Milliseconds 500
}
Write-Host 'Aemeath companion runtime verified: selectable-chat-v1. API setup is manual and session-only; local models may still be warming up.'
