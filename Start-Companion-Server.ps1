[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$launchConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json

if ($launchConfig.llm.mode -ne 'local') { throw 'This companion only supports local mode.' }
# Remove inherited variables from this child process only. Never read key stores.
[Environment]::SetEnvironmentVariable('CYBER_GIRLFRIEND_API_KEY', $null, 'Process')
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $null, 'Process')

Set-Location $PSScriptRoot
& node server.js
exit $LASTEXITCODE
