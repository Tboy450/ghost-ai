param([string]$DesktopDirectory)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $projectRoot 'Start Ghost.cmd'
$iconPath = Join-Path $projectRoot 'studio\assets\ghost.ico'

foreach ($requiredPath in @($launcherPath, $iconPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required file is missing: $requiredPath"
    }
}

if (-not $DesktopDirectory) {
    $DesktopDirectory = [Environment]::GetFolderPath('DesktopDirectory')
}
if (-not $DesktopDirectory) {
    $desktopSettings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -Name Desktop
    $DesktopDirectory = [Environment]::ExpandEnvironmentVariables($desktopSettings.Desktop)
}
if (-not $DesktopDirectory -or -not (Test-Path -LiteralPath $DesktopDirectory -PathType Container)) {
    throw 'Could not locate the Windows desktop folder.'
}

$shortcutPath = Join-Path $DesktopDirectory 'Ghost.lnk'
$shell = New-Object -ComObject WScript.Shell
try {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.TargetPath -ne $launcherPath) {
        throw "A different shortcut already exists at $shortcutPath. Rename it before installing Ghost's shortcut."
    }
    $shortcut.TargetPath = $launcherPath
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Description = 'Start Ghost local AI studio and its local model engine'
    $shortcut.WindowStyle = 7
    $shortcut.Save()

    $saved = $shell.CreateShortcut($shortcutPath)
    if ($saved.TargetPath -ne $launcherPath -or $saved.WorkingDirectory -ne $projectRoot -or $saved.IconLocation -ne "$iconPath,0") {
        throw 'The saved Ghost shortcut did not match the requested launcher and icon.'
    }
    Write-Output "Ghost desktop shortcut verified: $shortcutPath"
} finally {
    if ($saved) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($saved) }
    if ($shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
