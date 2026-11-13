param([string]$OutputDirectory = 'release')
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$dist = Join-Path $root 'dist'
$stageRoot = Join-Path $root '.desktop-build'
$appStage = Join-Path $stageRoot 'app'

function Reset-WorkspaceStage([string]$target) {
    $fullTarget = [System.IO.Path]::GetFullPath($target)
    $prefix = $root.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullTarget.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a staging folder outside the Noteject workspace: $fullTarget"
    }
    if (Test-Path -LiteralPath $fullTarget) { Remove-Item -LiteralPath $fullTarget -Recurse -Force }
    New-Item -ItemType Directory -Path $fullTarget -Force | Out-Null
}

Write-Host 'Preparing the current Noteject app files…'
& npm.cmd run sync:dist
if ($LASTEXITCODE -ne 0) { throw 'Could not synchronize the current Noteject app files.' }

if (-not (Test-Path -LiteralPath (Join-Path $dist 'runtime\node.exe') -PathType Leaf)) {
    throw 'The bundled Node runtime is missing from dist\runtime\node.exe.'
}
if (-not (Test-Path -LiteralPath (Join-Path $dist 'projects') -PathType Container)) {
    throw 'The current dist\projects attachment folder is missing. It was not changed.'
}

Reset-WorkspaceStage $appStage
Reset-WorkspaceStage (Join-Path $stageRoot 'legacy-projects')
$allowedExtensions = @('.html', '.js', '.mjs', '.css', '.jpg', '.jpeg', '.png', '.svg', '.webp', '.woff', '.woff2', '.ttf', '.wasm')
Get-ChildItem -LiteralPath $dist -File | Where-Object { $allowedExtensions -contains $_.Extension.ToLowerInvariant() } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $appStage -Force
}
$vendorSource = Join-Path $dist 'vendor'
if (Test-Path -LiteralPath $vendorSource -PathType Container) {
    Copy-Item -LiteralPath $vendorSource -Destination $appStage -Recurse -Force
}
$storageConfig = Join-Path $dist '.noteject-storage.json'
$legacySource = Join-Path $dist 'projects'
if (Test-Path -LiteralPath $storageConfig -PathType Leaf) {
    $configured = Get-Content -LiteralPath $storageConfig -Raw | ConvertFrom-Json
    if ($configured.projectsRoot) { $legacySource = [System.IO.Path]::GetFullPath([string]$configured.projectsRoot) }
}
$profileRoot = [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd([char[]]@('\', '/'))
$fullLegacySource = [System.IO.Path]::GetFullPath($legacySource)
if ($fullLegacySource.StartsWith($profileRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    $legacySourceForApp = '%USERPROFILE%' + $fullLegacySource.Substring($profileRoot.Length)
} else {
    $legacySourceForApp = $fullLegacySource
}
$migrationSettings = @{ legacyProjectsRoot = $legacySourceForApp } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $stageRoot 'legacy-projects-location.json'), $migrationSettings, [System.Text.UTF8Encoding]::new($false))

if (-not (Test-Path -LiteralPath (Join-Path $appStage 'index.html') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $appStage 'ai-server.mjs') -PathType Leaf)) {
    throw 'Desktop staging did not include the app page and its local server.'
}

$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
Reset-WorkspaceStage (Join-Path $releaseRoot 'win-unpacked')

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\electron-builder\out\cli\cli.js') -PathType Leaf)) {
    Write-Host 'Installing the desktop packaging tools…'
    if (Test-Path -LiteralPath (Join-Path $root 'package-lock.json')) { & npm.cmd ci }
    else { & npm.cmd install }
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the desktop packaging tools.' }
}

Write-Host 'Building the Windows desktop installer…'
& (Join-Path $root 'node_modules\.bin\electron-builder.cmd') --win nsis --x64 "--config.directories.output=$releaseRoot"
if ($LASTEXITCODE -ne 0) { throw 'The Windows installer build failed.' }

$notejectDesktopVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $releaseRoot ('Noteject-Setup-' + $notejectDesktopVersion + '-x64.exe')
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    $installer = Get-ChildItem -LiteralPath $releaseRoot -Filter 'Noteject-Setup-*.exe' -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $installer) { throw 'The installer build completed, but no setup EXE was found.' }
Write-Host "Windows installer created: $installer"
