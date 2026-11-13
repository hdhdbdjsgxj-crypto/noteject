$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
& node (Join-Path $sourceRoot 'scripts/generate-release-version.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Could not generate release metadata.' }
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot 'dist'))
if (-not (Test-Path -LiteralPath $distRoot -PathType Container)) {
    throw "The Windows distribution folder was not found: $distRoot"
}

$assets = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$pending = [System.Collections.Generic.Queue[string]]::new()

function Add-AssetReference([string]$baseFile, [string]$reference) {
    if ([string]::IsNullOrWhiteSpace($reference)) { return }
    $value = [System.Uri]::UnescapeDataString($reference.Trim().Trim('"', "'"))
    if ($value -match '^(?:[a-z][a-z0-9+.-]*:|//|#)' -or $value.StartsWith('data:', [System.StringComparison]::OrdinalIgnoreCase)) { return }
    $value = ($value -split '[?#]', 2)[0]
    if (-not $value) { return }
    if ($value.StartsWith('/')) {
        $fullPath = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot $value.TrimStart([char[]]@('/'))))
    } elseif ([System.IO.Path]::IsPathRooted($value)) {
        $fullPath = [System.IO.Path]::GetFullPath($value)
    } else {
        $relative = $value.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $fullPath = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetDirectoryName($baseFile)) $relative))
    }
    if (-not $fullPath.StartsWith($sourceRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "A referenced app asset points outside the source folder: $reference"
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { return }
    $path = $fullPath.Substring($sourceRoot.Length + 1)
    if ($assets.Add($path)) { $pending.Enqueue($fullPath) }
}

$index = Join-Path $sourceRoot 'index.html'
if (-not (Test-Path -LiteralPath $index -PathType Leaf)) { throw 'The source index.html file is missing.' }
$assets.Add('index.html') | Out-Null
$pending.Enqueue($index)
foreach ($required in @('ai-server.mjs', 'Start-Noteject.ps1', 'noteject-logo.svg', 'noteject-logo.png', 'reader-mupdf-worker.js', 'reader-mupdf-cache.js', 'smart-search-worker.js')) {
    if (Test-Path -LiteralPath (Join-Path $sourceRoot $required) -PathType Leaf) { $assets.Add($required) | Out-Null }
}

while ($pending.Count -gt 0) {
    $current = $pending.Dequeue()
    if ([System.IO.Path]::GetExtension($current) -notin @('.html', '.css')) { continue }
    $text = [System.IO.File]::ReadAllText($current)
    if ([System.IO.Path]::GetExtension($current) -eq '.html') {
        foreach ($match in [regex]::Matches($text, '(?:src|href)\s*=\s*["'']([^"'']+)["'']', 'IgnoreCase')) {
            Add-AssetReference $current $match.Groups[1].Value
        }
    }
    if ([System.IO.Path]::GetExtension($current) -eq '.css') {
        foreach ($match in [regex]::Matches($text, 'url\(\s*["'']?([^"'')\s]+)', 'IgnoreCase')) {
            Add-AssetReference $current $match.Groups[1].Value
        }
        foreach ($match in [regex]::Matches($text, '@import\s+["'']([^"'']+)["'']', 'IgnoreCase')) {
            Add-AssetReference $current $match.Groups[1].Value
        }
    }
}

foreach ($relative in $assets) {
    $source = Join-Path $sourceRoot $relative
    $destination = Join-Path $distRoot $relative
    $destinationDirectory = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) { New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

$sourceVendor = Join-Path $sourceRoot 'vendor'
if (Test-Path -LiteralPath $sourceVendor -PathType Container) {
    $destinationVendor = Join-Path $distRoot 'vendor'
    if (-not (Test-Path -LiteralPath $destinationVendor -PathType Container)) { New-Item -ItemType Directory -Path $destinationVendor -Force | Out-Null }
    Get-ChildItem -LiteralPath $sourceVendor -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destinationVendor -Recurse -Force
    }
}

foreach ($retired in @('reader-pdf.js', 'android-pdf-renderer.js', 'workspace-planner.js', 'workspace-planner.css', 'vendor\pdfjs')) {
    $retiredPath = [IO.Path]::GetFullPath((Join-Path $distRoot $retired))
    if (-not $retiredPath.StartsWith($distRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Retired Reader asset points outside dist.' }
    if (Test-Path -LiteralPath $retiredPath) { Remove-Item -LiteralPath $retiredPath -Recurse -Force }
}
Write-Host "Synchronized $($assets.Count) referenced app assets into dist. The EXE, runtime, and project data were left in place."
