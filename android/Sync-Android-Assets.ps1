$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& node (Join-Path $workspaceRoot 'scripts/generate-release-version.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Could not generate release metadata.' }
$androidRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$assetRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'app\src\main\assets'))
if (-not $assetRoot.StartsWith($androidRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Android asset target is outside the project.'
}
foreach ($speechModelSpec in @(
    @{ Name = 'audio-model-en.zip'; Hash = '30F26242C4EB449F948E42CB302DD7A686CB29A3423A8367F99FF41780942498' },
    @{ Name = 'audio-model-en-accurate.zip'; Hash = 'D9838B4AAA82A75C4A17F5ACA300EACA129AAAB2A7CBF951BAFBB500EB9C4334' }
)) {
    $speechModel = Join-Path $assetRoot $speechModelSpec.Name
    if (-not (Test-Path -LiteralPath $speechModel -PathType Leaf)) { throw "The bundled offline English model is missing: $($speechModelSpec.Name). Restore it in app/src/main/assets before building." }
    $speechHasher = [Security.Cryptography.SHA256]::Create()
    $speechStream = [IO.File]::OpenRead($speechModel)
    try { $speechHash = [BitConverter]::ToString($speechHasher.ComputeHash($speechStream)).Replace('-', '') }
    finally { $speechStream.Dispose(); $speechHasher.Dispose() }
    if ($speechHash -ne $speechModelSpec.Hash) { throw "The bundled English model checksum did not match: $($speechModelSpec.Name)." }
}
$sourceHtml = [IO.File]::ReadAllText((Join-Path $workspaceRoot 'index.html'))
$references = [regex]::Matches($sourceHtml, '(?:src|href)="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($reference in $references) {
    if ($reference -match '^(?:https?:|data:|#)') { continue }
    $relative = [uri]::UnescapeDataString(($reference -split '\?', 2)[0]).Replace('/', [IO.Path]::DirectorySeparatorChar)
    $source = [IO.Path]::GetFullPath((Join-Path $workspaceRoot $relative))
    if (-not $source.StartsWith($workspaceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Asset escapes the project: $reference" }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing Android web asset: $reference" }
    $destination = Join-Path $assetRoot $relative
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}
$vendorSource = Join-Path $workspaceRoot 'vendor'
foreach ($workerAsset in @('reader-mupdf-worker.js', 'reader-mupdf-cache.js', 'smart-search-worker.js')) {
    $workerSource = Join-Path $workspaceRoot $workerAsset
    if (-not (Test-Path -LiteralPath $workerSource -PathType Leaf)) { throw "Missing background worker asset: $workerAsset" }
    Copy-Item -LiteralPath $workerSource -Destination (Join-Path $assetRoot $workerAsset) -Force
}
if (Test-Path -LiteralPath $vendorSource -PathType Container) {
    $vendorDestination = Join-Path $assetRoot 'vendor'
    New-Item -ItemType Directory -Path $vendorDestination -Force | Out-Null
    Get-ChildItem -LiteralPath $vendorSource -Force -Recurse | ForEach-Object {
        $relative = $_.FullName.Substring($vendorSource.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        $target = Join-Path $vendorDestination $relative
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Path $target -Force | Out-Null
        } else {
            $targetParent = Split-Path -Parent $target
            New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force
        }
    }
}
Get-ChildItem -LiteralPath $workspaceRoot -File | Where-Object { $_.Extension -in '.png', '.jpg', '.jpeg', '.svg', '.webp' } | Copy-Item -Destination $assetRoot -Force
$androidHtml = $sourceHtml
foreach ($mobileAsset in @('android-responsive.css', 'android-shell-ui.css', 'android-mobile.js', 'android-api.js', 'android-native-reader.js', 'android-reader-ui.js', 'android-reader-ui.css', 'android-notes-ui.js', 'android-notes-ui.css', 'android-projects-ui.js', 'android-projects-ui.css', 'android-audio-bridge.js', 'android-audio.js', 'android-audio.css', 'android-canvas-ui.js', 'android-canvas-ui.css', 'android-touch-selection.js', 'android-touch-selection.css')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('ui\' + $mobileAsset)) -Destination (Join-Path $assetRoot $mobileAsset) -Force
}
if ($androidHtml -notmatch 'android-responsive\.css') {
    $androidHtml = $androidHtml.Replace('</head>', '<link rel="stylesheet" href="android-responsive.css"><link rel="stylesheet" href="android-shell-ui.css"><link rel="stylesheet" href="android-reader-ui.css"><link rel="stylesheet" href="android-notes-ui.css"><link rel="stylesheet" href="android-projects-ui.css"><link rel="stylesheet" href="android-audio.css"><link rel="stylesheet" href="android-touch-selection.css"><link rel="stylesheet" href="android-canvas-ui.css"></head>')
}
$paletteLink = '<link rel="stylesheet" href="noteject-palette.css?v=8">'
$androidHtml = $androidHtml.Replace($paletteLink, '')
$androidHtml = $androidHtml.Replace('</head>', $paletteLink + '</head>')
if ($androidHtml -notmatch 'android-api\.js') {
    $androidHtml = $androidHtml.Replace('<script src="folder-picker.js', '<script src="android-api.js"></script><script src="folder-picker.js')
}
$androidHtml = $androidHtml.Replace('</body>', '<script src="android-native-reader.js"></script><script src="android-reader-ui.js"></script><script src="android-notes-ui.js"></script><script src="android-projects-ui.js"></script><script src="android-mobile.js"></script><script src="android-audio-bridge.js"></script><script src="android-audio.js"></script><script src="android-touch-selection.js"></script><script src="android-canvas-ui.js"></script><script>window.NotejectNativeReader?.drain()</script></body>')
Set-Content -LiteralPath (Join-Path $assetRoot 'index.html') -Value $androidHtml -Encoding utf8
$licenseRoot = Join-Path $assetRoot 'licenses\mupdf-android'
New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'vendor\maven\com\artifex\mupdf\COPYING') -Destination (Join-Path $licenseRoot 'COPYING') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'vendor\maven\com\artifex\mupdf\NOTICE.md') -Destination (Join-Path $licenseRoot 'NOTICE.md') -Force
$djvuLicenseRoot = Join-Path $assetRoot 'licenses\djvulibre'
New-Item -ItemType Directory -Path $djvuLicenseRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'vendor\djvulibre\NOTICE.md') -Destination (Join-Path $djvuLicenseRoot 'NOTICE.md') -Force
foreach ($notice in @('COPYING', 'COPYRIGHT')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('vendor\djvulibre\djvulibre-3.5.29\' + $notice)) -Destination (Join-Path $djvuLicenseRoot $notice) -Force
}
foreach ($notice in @('LICENSE.md', 'README.ijg')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('vendor\libjpeg-turbo\libjpeg-turbo-3.1.4.1\' + $notice)) -Destination (Join-Path $djvuLicenseRoot ('libjpeg-turbo-' + $notice)) -Force
}
foreach ($retired in @('reader-pdf.js', 'android-pdf-renderer.js', 'workspace-planner.js', 'workspace-planner.css', 'vendor\pdfjs')) {
    $retiredPath = [IO.Path]::GetFullPath((Join-Path $assetRoot $retired))
    if (-not $retiredPath.StartsWith($assetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Retired Reader asset is outside the Android asset folder.' }
    if (Test-Path -LiteralPath $retiredPath) { Remove-Item -LiteralPath $retiredPath -Recurse -Force }
}
Write-Output "Synced $($references.Count) web assets into the Android app."
