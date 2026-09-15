param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
$dataRoot = Join-Path $projectRoot '.ghost'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeExe = $nodeCommand.Source } else {
    $nodeExe = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
}
if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Node.js 24 or newer is required. Install it from https://nodejs.org/.' }
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
if (-not $ready) { throw 'Ghost did not start. Check .ghost/server.stderr.log.' }
Write-Output 'Ghost is ready at http://127.0.0.1:4317'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:4317' -WindowStyle Hidden }
