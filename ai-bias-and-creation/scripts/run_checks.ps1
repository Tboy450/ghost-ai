param(
    [switch]$Log,
    [string]$Python,
    [int]$MinScore = 16
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Candidates = @()
$script:LastPythonExitCode = 1

if ($Python) {
    $Candidates += ,@($Python)
}

if ($env:PACK_PYTHON) {
    $Candidates += ,@($env:PACK_PYTHON)
}

foreach ($Name in @("python3", "python")) {
    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($Command) {
        $Candidates += ,@($Command.Source)
    }
}

$PyLauncher = Get-Command "py" -ErrorAction SilentlyContinue
if ($PyLauncher) {
    $Candidates += ,@($PyLauncher.Source, "-3")
}

function Invoke-CandidatePython {
    param(
        [string[]]$Candidate,
        [string[]]$Arguments
    )

    $Executable = $Candidate[0]
    $PrefixArguments = @()
    if ($Candidate.Length -gt 1) {
        $PrefixArguments = $Candidate[1..($Candidate.Length - 1)]
    }

    & $Executable @PrefixArguments @Arguments
    $script:LastPythonExitCode = $LASTEXITCODE
}

$Selected = $null
foreach ($Candidate in $Candidates) {
    Invoke-CandidatePython -Candidate $Candidate -Arguments @("--version") *> $null
    if ($script:LastPythonExitCode -eq 0) {
        $Selected = $Candidate
        break
    }
}

if (-not $Selected) {
    Write-Error "No Python 3 executable was found. Install Python, set PACK_PYTHON, or pass -Python C:\Path\To\python.exe."
    exit 1
}

$Arguments = @("scripts/run_checks.py", "--min-score", "$MinScore")
if ($Log) {
    $Arguments += @("--log", "tests/results_log.md")
}

Set-Location -LiteralPath $Root
Invoke-CandidatePython -Candidate $Selected -Arguments $Arguments
exit $script:LastPythonExitCode
