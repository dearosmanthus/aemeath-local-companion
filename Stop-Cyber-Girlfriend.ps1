$ErrorActionPreference = 'SilentlyContinue'
foreach ($port in 17860, 17861, 1235) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen
    foreach ($connection in $connections) {
        Stop-Process -Id $connection.OwningProcess -Force
    }
}
Write-Host 'Local cyber companion services stopped.'
Start-Sleep -Seconds 1
