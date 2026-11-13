$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodePath = $nodeCommand.Source } else { $nodePath = $null }
}
if (-not $nodePath) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('Node.js is needed to run noteject. Install Node.js, then open noteject again.', 'noteject', 'OK', 'Error') | Out-Null
    exit 1
}
$port = 41783
$url = "http://127.0.0.1:$port/"
$filePort = 41784
$fileHealthUrl = "http://127.0.0.1:$filePort/api/file-status"
$fileReady = $false
$fileCheck = $null
try { $fileCheck = Invoke-RestMethod -Uri $fileHealthUrl -TimeoutSec 1; $fileReady = $fileCheck.fileStorage -eq $true -and $fileCheck.storageBrowserVersion -ge 3 } catch {}
if ($fileCheck -and $fileCheck.fileStorage -eq $true -and -not $fileReady) {
    # Upgrade only the project-file service owned by this noteject installation.
    # The separate AI service on port 41783 may hold a session key and stays running.
    try {
        $knownServerPaths = @([System.IO.Path]::GetFullPath((Join-Path $root 'ai-server.mjs')))
        if ((Split-Path -Leaf $root) -eq 'dist') {
            $knownServerPaths += [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $root) 'ai-server.mjs'))
        } else {
            $knownServerPaths += [System.IO.Path]::GetFullPath((Join-Path $root 'dist\ai-server.mjs'))
        }
        $listeners = @(Get-NetTCPConnection -LocalPort $filePort -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($listeners.Count -ne 1) { throw 'Could not identify the process using the project-file port.' }
        $fileProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0])" -ErrorAction Stop
        $matchesnoteject = $false
        if ($fileProcess.Name -ieq 'node.exe' -and $fileProcess.CommandLine) {
            foreach ($knownServerPath in $knownServerPaths) {
                $scriptArgument = '(?i)(?:^|\s)(?:"' + [regex]::Escape($knownServerPath) + '"|' + [regex]::Escape($knownServerPath) + ')(?=\s|$)'
                if ($fileProcess.CommandLine -match $scriptArgument) { $matchesnoteject = $true; break }
            }
        }
        if (-not $matchesnoteject) { throw 'The process on port 41784 could not be verified as this noteject installation.' }
        Stop-Process -Id $fileProcess.ProcessId -ErrorAction Stop
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (-not (Get-NetTCPConnection -LocalPort $filePort -State Listen -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 100
        }
    } catch {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("noteject's project-file service needs an update, but it could not be safely restarted. Close the old noteject project-file service, then launch noteject again. $($_.Exception.Message)", 'noteject', 'OK', 'Error') | Out-Null
        exit 1
    }
}
if (-not $fileReady) {
    $env:NOTEJECT_PORT = "$filePort"
    $env:NOTEJECT_APP_PORT = "$port"
    $fileServer = Join-Path $root 'ai-server.mjs'
    try { Start-Process -FilePath $nodePath -ArgumentList @("`"$fileServer`"") -WorkingDirectory $root -WindowStyle Hidden | Out-Null }
    catch { $env:NOTEJECT_PORT = "$port"; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show("Could not start noteject's project-file service: $($_.Exception.Message)", 'noteject', 'OK', 'Error') | Out-Null; exit 1 }
    $env:NOTEJECT_PORT = "$port"
    for ($attempt = 0; $attempt -lt 30; $attempt++) { Start-Sleep -Milliseconds 300; try { $fileCheck = Invoke-RestMethod -Uri $fileHealthUrl -TimeoutSec 1; if ($fileCheck.fileStorage -eq $true -and $fileCheck.storageBrowserVersion -ge 3) { $fileReady = $true; break } } catch {} }
}
if (-not $fileReady) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('noteject could not start its project-file service. Try again or check that port 41784 is available.', 'noteject', 'OK', 'Error') | Out-Null; exit 1 }

$healthUrl = "http://127.0.0.1:$port/api/key-status"
$ready = $false
try {
    $check = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    $ready = ($null -ne $check.configured) -and ([int]$check.serviceVersion -ge 2)
} catch {}
if ($null -ne $check -and $null -ne $check.configured -and [int]$check.serviceVersion -lt 2) {
    try {
        $knownServerPaths = @([System.IO.Path]::GetFullPath((Join-Path $root 'ai-server.mjs')))
        if ((Split-Path -Leaf $root) -eq 'dist') {
            $knownServerPaths += [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $root) 'ai-server.mjs'))
        } else {
            $knownServerPaths += [System.IO.Path]::GetFullPath((Join-Path $root 'dist\ai-server.mjs'))
        }
        $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($listeners.Count -ne 1) { throw 'Could not identify the process using the local AI service port.' }
        $aiProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0])" -ErrorAction Stop
        $matchesNoteject = $false
        if ($aiProcess.Name -ieq 'node.exe' -and $aiProcess.CommandLine) {
            foreach ($knownServerPath in $knownServerPaths) {
                $scriptArgument = '(?i)(?:^|\s)(?:"' + [regex]::Escape($knownServerPath) + '"|' + [regex]::Escape($knownServerPath) + ')(?=\s|$)'
                if ($aiProcess.CommandLine -match $scriptArgument) { $matchesNoteject = $true; break }
            }
        }
        if (-not $matchesNoteject) { throw 'The process on the local AI service port could not be verified as this noteject installation.' }
        Stop-Process -Id $aiProcess.ProcessId -ErrorAction Stop
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 100
        }
    } catch {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("noteject's local service needs an update, but it could not be safely restarted. Close the old noteject service, then launch noteject again. $($_.Exception.Message)", 'noteject', 'OK', 'Error') | Out-Null
        exit 1
    }
}
if (-not $ready) {
    $env:NOTEJECT_PORT = "$port"
    $env:NOTEJECT_APP_PORT = "$port"
    $server = Join-Path $root 'ai-server.mjs'
    try {
        Start-Process -FilePath $nodePath -ArgumentList @("`"$server`"") -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    } catch {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("Could not start noteject's local server: $($_.Exception.Message)", 'noteject', 'OK', 'Error') | Out-Null
        exit 1
    }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 300
        try {
            $check = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
            if (($null -ne $check.configured) -and ([int]$check.serviceVersion -ge 2)) { $ready = $true; break }
        } catch {}
    }
}
if (-not $ready) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('noteject could not reach its local server. Check that Node.js is installed and try again.', 'noteject', 'OK', 'Error') | Out-Null
    exit 1
}
$edgePath = $null
$edgeCommand = Get-Command msedge.exe -ErrorAction SilentlyContinue
if ($edgeCommand) { $edgePath = $edgeCommand.Source }
if (-not $edgePath) {
    $edgeCandidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    )
    $edgePath = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if ($edgePath) {
    Start-Process -FilePath $edgePath -ArgumentList @("--app=$url", '--new-window', '--no-first-run') | Out-Null
} else {
    Start-Process $url | Out-Null
}
