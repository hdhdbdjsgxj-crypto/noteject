$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = Join-Path $root '.apple-build\tools'
New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null

function Get-VerifiedArchive([string]$Url, [string]$Destination, [string]$ExpectedHash) {
    if (-not (Test-Path -LiteralPath $Destination) -or
        (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $ExpectedHash) {
        Invoke-WebRequest -Uri $Url -OutFile $Destination
    }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $ExpectedHash) {
        throw "Download checksum mismatch for $Destination"
    }
}

$goExecutable = Join-Path $toolsRoot 'go\bin\go.exe'
if (-not (Test-Path -LiteralPath $goExecutable)) {
    $releases = Invoke-RestMethod -Uri 'https://go.dev/dl/?mode=json'
    $release = $releases | Where-Object { $_.stable } | Select-Object -First 1
    $archive = $release.files | Where-Object {
        $_.os -eq 'windows' -and $_.arch -eq 'amd64' -and $_.kind -eq 'archive'
    } | Select-Object -First 1
    if (-not $archive.sha256) { throw 'Official Go toolchain metadata is unavailable.' }
    $archivePath = Join-Path $toolsRoot $archive.filename
    Get-VerifiedArchive ('https://go.dev/dl/' + $archive.filename) $archivePath $archive.sha256
    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolsRoot -Force
}

$signerFolder = Join-Path $toolsRoot 'rcodesign'
$signer = Join-Path $signerFolder 'apple-codesign-0.29.0-x86_64-pc-windows-msvc\rcodesign.exe'
if (-not (Test-Path -LiteralPath $signer)) {
    $filename = 'apple-codesign-0.29.0-x86_64-pc-windows-msvc.zip'
    $url = 'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/0.29.0/' + $filename
    $response = Invoke-WebRequest -Uri ($url + '.sha256')
    $text = if ($response.Content -is [byte[]]) {
        [Text.Encoding]::UTF8.GetString($response.Content)
    } else { [string]$response.Content }
    $checksum = ($text.Trim() -split '\s+')[0]
    if ($checksum -notmatch '^[0-9a-fA-F]{64}$') { throw 'Signing-tool checksum metadata is invalid.' }
    $archivePath = Join-Path $toolsRoot $filename
    Get-VerifiedArchive $url $archivePath $checksum
    Expand-Archive -LiteralPath $archivePath -DestinationPath $signerFolder -Force
}

& $goExecutable version
if ($LASTEXITCODE -ne 0) { throw 'The portable Go toolchain failed to start.' }
& $signer --version
if ($LASTEXITCODE -ne 0) { throw 'The portable signing tool failed to start.' }
Write-Host 'Apple packaging tools are installed inside .apple-build\tools.'
