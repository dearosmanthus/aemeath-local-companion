$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
& (Join-Path $root 'Start-Desktop-Companion-Services.ps1')
$chromeCandidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
$url = 'http://127.0.0.1:17860/stage/'
if ($chrome) { Start-Process -FilePath $chrome -ArgumentList @("--app=$url", '--start-maximized') } else { Start-Process $url }
