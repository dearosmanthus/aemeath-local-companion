$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$modelDir = 'G:\LocalAI\CyberGirlfriend\Models\llm\Qwen3-4B'
$modelFile = Join-Path $modelDir 'Qwen3-4B-Q4_K_M.gguf'
$sourceUrl = 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true'
$expectedBytes = 2497280256
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

if ((Test-Path -LiteralPath $modelFile) -and (Get-Item -LiteralPath $modelFile).Length -eq $expectedBytes) {
    Write-Host '[OK] Companion model already exists.' -ForegroundColor Green
    exit 0
}

Import-Module BitsTransfer
$job = Get-BitsTransfer -Name 'CyberGF-Qwen3-4B' -ErrorAction SilentlyContinue
if (-not $job) {
    $job = Start-BitsTransfer -Source $sourceUrl -Destination $modelFile -DisplayName 'CyberGF-Qwen3-4B' -Asynchronous
}

Write-Host 'Downloading companion model with Windows BITS...' -ForegroundColor Cyan
while ($true) {
    $job = Get-BitsTransfer -Name 'CyberGF-Qwen3-4B' -ErrorAction Stop
    if ($job.JobState -eq 'Transferred') {
        Complete-BitsTransfer -BitsJob $job
        break
    }
    if ($job.JobState -eq 'Error') {
        Resume-BitsTransfer -BitsJob $job -Asynchronous | Out-Null
    }
    $total = if ($job.BytesTotal -lt [uint64]::MaxValue) { $job.BytesTotal } else { $expectedBytes }
    $percent = [math]::Round(100 * $job.BytesTransferred / $total, 1)
    Write-Progress -Activity 'Qwen3-4B companion model' -Status "$percent%" -PercentComplete $percent
    Start-Sleep -Seconds 2
}

if ((Get-Item -LiteralPath $modelFile).Length -ne $expectedBytes) {
    throw 'Companion model size validation failed.'
}
Write-Host '[OK] Companion model is ready.' -ForegroundColor Green
