param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
# A PowerShell stack trace is not something to hand a person who double-clicked an icon.
# Print the reason plainly and exit non-zero so the launcher pauses and it stays readable.
trap {
    Write-Host ''
    Write-Host 'Ghost could not start.' -ForegroundColor Red
    Write-Host ''
    Write-Host $_.Exception.Message
    Write-Host ''
    exit 1
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
$dataRoot = Join-Path $projectRoot '.ghost'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeExe = $nodeCommand.Source } else {
    # A shortcut does not always inherit the PATH a terminal has, so node being missing
    # here does not mean node is missing. Check where it normally lands before giving up.
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:APPDATA 'npm\node.exe'),
        (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
    )
    $nodeExe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) { throw 'Node.js 24 or newer is required. Install it from https://nodejs.org/ and start Ghost again.' }
$env:OLLAMA_HOST = '127.0.0.1:11435'
$env:OLLAMA_MODELS = Join-Path $runtimeRoot 'models'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_FLASH_ATTENTION = '1'
$env:OLLAMA_KV_CACHE_TYPE = 'q8_0'
$engineExe = Join-Path $runtimeRoot 'ollama/ollama.exe'
try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:11435/api/version' -TimeoutSec 2 } catch {
    if (-not (Test-Path -LiteralPath $engineExe)) { throw 'Run scripts/Setup-LocalModel.ps1 once to download the local engine and model.' }
    $engineProcess = Start-Process -FilePath $engineExe -ArgumentList 'serve' -WorkingDirectory (Split-Path -Parent $engineExe) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'ollama.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'ollama.stderr.log') -PassThru
    $engineProcess.Id | Set-Content -LiteralPath (Join-Path $runtimeRoot 'ollama.pid')
}
$running = $false
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/bootstrap' -TimeoutSec 4
    if ($health.name -ne 'Ghost') { throw 'Port 4317 is being used by another application.' }
    $running = $true
} catch {
    if ($_.Exception.Message -like '*another application*') { throw }
}
if (-not $running) {
    $serverScript = Join-Path $projectRoot 'studio/server.mjs'
    $serverProcess = Start-Process -FilePath $nodeExe -ArgumentList @('"' + $serverScript + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'server.stdout.log') -RedirectStandardError (Join-Path $dataRoot 'server.stderr.log') -PassThru
    $serverProcess.Id | Set-Content -LiteralPath (Join-Path $dataRoot 'server.pid')
}
$ready = $false
for ($attempt=0; $attempt -lt 25; $attempt++) {
    try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/bootstrap' -TimeoutSec 3; if ($health.name -eq 'Ghost') { $ready=$true; break } } catch { Start-Sleep -Milliseconds 400 }
}
if (-not $ready) {
    # Telling someone to go and read a log file is not an error message. The reason the
    # server refused to start is already sitting in that file, so show it here.
    $errLog = Join-Path $dataRoot 'server.stderr.log'
    $detail = if (Test-Path -LiteralPath $errLog) { (Get-Content -LiteralPath $errLog -Tail 15 | Out-String).Trim() } else { '' }
    if ($detail) { throw "Ghost did not start.`n`n$detail" }
    throw "Ghost did not start, and it did not report a reason. Check $errLog."
}
Write-Output 'Ghost is ready at http://127.0.0.1:4317'
if (-not $NoBrowser) {
    # No -WindowStyle here. A URL is opened through ShellExecute, which passes the style
    # straight to the browser it launches, so 'Hidden' started the browser with its window
    # hidden: Ghost was running and healthy and the screen stayed empty, which is exactly
    # what "it does not work when I open it" looks like.
    try { Start-Process 'http://127.0.0.1:4317' }
    catch { Write-Output 'Could not open a browser automatically. Go to http://127.0.0.1:4317' }
}
