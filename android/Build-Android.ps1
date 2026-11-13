param([ValidateSet('universal', 'arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64')][string]$Architecture = 'universal')
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolchainRoot = Join-Path $PSScriptRoot '.toolchain'
$gradleCommand = Join-Path $toolchainRoot 'gradle\gradle-8.9\bin\gradle.bat'
$javaDirectory = Get-ChildItem -LiteralPath (Join-Path $toolchainRoot 'jdk') -Directory | Select-Object -First 1
$useLocalToolchain = $javaDirectory -and (Test-Path -LiteralPath $gradleCommand)
$gradleWrapper = Join-Path $PSScriptRoot 'gradlew.bat'
if (-not $useLocalToolchain) {
    if (-not (Test-Path -LiteralPath $gradleWrapper)) { throw 'Install the project-local toolchain or use the included Gradle wrapper.' }
    if (-not $env:ANDROID_HOME -and $env:ANDROID_SDK_ROOT) { $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT }
    if (-not $env:ANDROID_SDK_ROOT -and $env:ANDROID_HOME) { $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME }
    if (-not $env:ANDROID_HOME) { throw 'Set ANDROID_HOME or ANDROID_SDK_ROOT to an installed Android SDK.' }
    if (-not $env:JAVA_HOME -and -not (Get-Command java -ErrorAction SilentlyContinue)) { throw 'Install JDK 17 and set JAVA_HOME or add java to PATH.' }
    $gradleCommand = $gradleWrapper
}

& (Join-Path $PSScriptRoot 'Sync-Android-Assets.ps1')
if ($useLocalToolchain) {
    $env:JAVA_HOME = $javaDirectory.FullName
    $env:ANDROID_HOME = Join-Path $toolchainRoot 'sdk'
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    $env:ANDROID_USER_HOME = Join-Path $toolchainRoot '.android-user'
}
Push-Location $PSScriptRoot
try {
    $buildArguments = @('--no-daemon', 'assembleDebug')
    if ($Architecture -ne 'universal') { $buildArguments += "-PnotejectAbi=$Architecture" }
    & $gradleCommand @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'The Android APK build failed.' }
} finally { Pop-Location }

$versionMatch = [regex]::Match([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'app\build.gradle')), 'versionName\s+''([^'']+)''')
if (-not $versionMatch.Success) { throw 'Could not read the Android version.' }
$releaseRoot = Join-Path $workspaceRoot 'release'
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$architectureSuffix = if ($Architecture -eq 'universal') { '' } else { '-' + $Architecture }
$apk = Join-Path $releaseRoot ('Noteject-Android-' + $versionMatch.Groups[1].Value + $architectureSuffix + '.apk')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'app\build\outputs\apk\debug\app-debug.apk') -Destination $apk -Force
Write-Output "Android APK created: $apk"
