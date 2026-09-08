$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$modelRoot = 'G:\LocalAI\CyberGirlfriend\Models\speech'
$downloadRoot = Join-Path $modelRoot '_downloads'
New-Item -ItemType Directory -Force -Path $modelRoot, $downloadRoot | Out-Null
$aria2 = (Get-Command aria2c.exe -ErrorAction SilentlyContinue).Source
if (-not $aria2) {
    $aria2 = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter aria2c.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
$sevenZip = (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source
if (-not $sevenZip) {
    $sevenZip = @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe") |
        Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Install-ArchiveModel {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$ExpectedFile
    )
    $targetFile = Join-Path $modelRoot $ExpectedFile
    if (Test-Path -LiteralPath $targetFile) {
        Write-Host "[OK] $Name already exists" -ForegroundColor Green
        return
    }
    $archive = Join-Path $downloadRoot "$Name.tar.bz2"
    Write-Host "[DOWNLOAD] $Name" -ForegroundColor Cyan
    Import-Module BitsTransfer -ErrorAction SilentlyContinue
    try {
        Start-BitsTransfer -Source $Url -Destination $archive -DisplayName "CyberGF-$Name"
    } catch {
        if ($aria2) {
        & $aria2 --continue=true --max-connection-per-server=8 --split=8 --min-split-size=4M --file-allocation=none --dir=$downloadRoot --out="$Name.tar.bz2" $Url
        } else {
            & curl.exe -L --fail --retry 8 --retry-all-errors --continue-at - --output $archive $Url
        }
    }
    if ($LASTEXITCODE -ne 0) { throw "$Name download failed" }
    Write-Host "[EXTRACT] $Name" -ForegroundColor Cyan
    if ($sevenZip) {
        & $sevenZip x -y "-o$downloadRoot" $archive | Out-Null
        $tarFile = Join-Path $downloadRoot "$Name.tar"
        & $sevenZip x -y "-o$modelRoot" $tarFile | Out-Null
    } else {
        & tar.exe -xjf $archive -C $modelRoot
    }
    if ($LASTEXITCODE -ne 0) { throw "$Name extraction failed" }
    if (-not (Test-Path -LiteralPath $targetFile)) { throw "$Name validation failed: $targetFile" }
    Write-Host "[OK] $Name installed" -ForegroundColor Green
}

Install-ArchiveModel `
    -Name 'sensevoice-int8' `
    -Url 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2' `
    -ExpectedFile 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17\model.int8.onnx'

Install-ArchiveModel `
    -Name 'kokoro-v1_0' `
    -Url 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2' `
    -ExpectedFile 'kokoro-multi-lang-v1_0\model.onnx'

$vad = Join-Path $modelRoot 'silero_vad.onnx'
if (-not (Test-Path -LiteralPath $vad)) {
    Write-Host '[DOWNLOAD] Silero VAD' -ForegroundColor Cyan
    & curl.exe -L --fail --retry 3 --output $vad 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
    if ($LASTEXITCODE -ne 0) { throw 'Silero VAD download failed' }
}

Write-Host ''
Write-Host 'All offline speech models are ready.' -ForegroundColor Green
