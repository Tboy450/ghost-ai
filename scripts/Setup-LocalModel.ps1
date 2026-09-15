param([string]$Model = 'qwen3:4b-instruct')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
$engineRoot = Join-Path $runtimeRoot 'ollama'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$engineExe = Join-Path $engineRoot 'ollama.exe'
if (-not (Test-Path -LiteralPath $engineExe)) {
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/ollama/ollama/releases/latest'
    $asset = $release.assets | Where-Object { $_.name -eq 'ollama-windows-amd64.zip' }
    if (-not $asset -or $asset.browser_download_url -notlike 'https://github.com/ollama/ollama/releases/download/*') { throw 'Official Ollama asset not found.' }
    Write-Output ('Downloading official Ollama {0}: {1:N1} MB' -f $release.tag_name, ($asset.size / 1MB))
    $archive = Join-Path $runtimeRoot 'ollama-windows-amd64.zip'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -TimeoutSec 1800
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($asset.digest -and $asset.digest -ne ('sha256:' + $actualHash)) { throw 'Ollama download checksum mismatch.' }
    @{ version = $release.tag_name; url = $asset.browser_download_url; sha256 = $actualHash; githubDigest = $asset.digest } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'ollama-download.json') -Encoding UTF8
    Expand-Archive -LiteralPath $archive -DestinationPath $engineRoot
}
$env:OLLAMA_HOST = '127.0.0.1:11435'
$env:OLLAMA_MODELS = Join-Path $runtimeRoot 'models'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_FLASH_ATTENTION = '1'
$env:OLLAMA_KV_CACHE_TYPE = 'q8_0'
try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:11435/api/version' -TimeoutSec 2 } catch {
    $process = Start-Process -FilePath $engineExe -ArgumentList 'serve' -WorkingDirectory $engineRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'ollama.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'ollama.stderr.log') -PassThru
    $process.Id | Set-Content -LiteralPath (Join-Path $runtimeRoot 'ollama.pid')
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:11435/api/version' -TimeoutSec 2; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'Ollama failed to start. See .runtime/ollama.stderr.log.' }
}
Write-Output ('Downloading local model ' + $Model + '. This may take several minutes.')
$pullBody = @{ model = $Model; stream = $false } | ConvertTo-Json -Compress
$result = Invoke-RestMethod -Uri 'http://127.0.0.1:11435/api/pull' -Method Post -ContentType 'application/json' -Body $pullBody -TimeoutSec 1800
if ($result.status -ne 'success') { throw 'Model download failed.' }
Write-Output ('Local model ready: ' + $Model)
