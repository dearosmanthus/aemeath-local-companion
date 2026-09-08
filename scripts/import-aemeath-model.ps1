param(
  [string]$Source = "$env:USERPROFILE\Downloads"
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $projectRoot 'wallpaper\assets\models'
$stageDir = Join-Path $projectRoot 'data\model-import-staging'
New-Item -ItemType Directory -Force -Path $targetDir,$stageDir | Out-Null

if (Test-Path -LiteralPath $Source -PathType Leaf) {
  $sources = @(Get-Item -LiteralPath $Source)
} else {
  $sources = @(Get-ChildItem -LiteralPath $Source -File -ErrorAction Stop |
    Where-Object { $_.Extension -in '.zip','.7z','.rar','.vrm','.glb','.gltf','.fbx','.blend','.pmx','.pmd' } |
    Sort-Object LastWriteTime -Descending)
}

if (!$sources.Count) { throw "没有找到模型文件：$Source" }

$model = $null
foreach ($sourceFile in $sources) {
  if ($sourceFile.Extension -in '.vrm','.glb','.gltf') {
    $model = $sourceFile
    break
  }
  if ($sourceFile.Extension -eq '.zip') {
    $extractDir = Join-Path $stageDir ([IO.Path]::GetFileNameWithoutExtension($sourceFile.Name))
    Expand-Archive -LiteralPath $sourceFile.FullName -DestinationPath $extractDir -Force
    $model = Get-ChildItem -LiteralPath $extractDir -Recurse -File |
      Where-Object { $_.Extension -in '.vrm','.glb','.gltf' } |
      Sort-Object Length -Descending | Select-Object -First 1
    if ($model) { break }
  }
}

if (!$model) {
  $other = Get-ChildItem -LiteralPath $stageDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.blend','.fbx','.pmx','.pmd' } | Select-Object -First 1
  if ($other) { throw "找到 $($other.Extension) 模型：$($other.FullName)。它需要先在 Blender/Unity 中转换为 VRM，转换后再运行此脚本。" }
  throw '压缩包内没有找到 VRM、GLB 或 glTF 文件。'
}

$destination = Join-Path $targetDir ('aemeath' + $model.Extension.ToLowerInvariant())
Copy-Item -LiteralPath $model.FullName -Destination $destination -Force
Write-Output "已导入：$destination"
Write-Output '重载 http://127.0.0.1:17860/stage/ 即可验证。'
