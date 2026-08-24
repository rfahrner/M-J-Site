param(
    [string]$BackupPath,
    [string]$Cutoff,
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'

function Find-BackupFolder {
    param([string]$ExplicitPath)

    if ($ExplicitPath) {
        $resolved = Resolve-Path -LiteralPath $ExplicitPath -ErrorAction SilentlyContinue
        if (-not $resolved) {
            throw "Backup folder not found: $ExplicitPath"
        }
        return $resolved.Path
    }

    $roots = @()
    foreach ($candidate in @($env:OneDriveCommercial, $env:OneDrive)) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $roots += $candidate
        }
    }

    if ($env:USERPROFILE) {
        $roots += Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'OneDrive*' } |
            Select-Object -ExpandProperty FullName
    }

    $roots = $roots | Where-Object { $_ } | Select-Object -Unique

    foreach ($root in $roots) {
        $direct = Join-Path $root 'M-J Site Backups'
        if (Test-Path -LiteralPath $direct) {
            return (Resolve-Path -LiteralPath $direct).Path
        }

        # Check one level below the OneDrive root for shared/shortcut folders
        # without recursively scanning the user's entire OneDrive.
        foreach ($child in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue) {
            $nested = Join-Path $child.FullName 'M-J Site Backups'
            if (Test-Path -LiteralPath $nested) {
                return (Resolve-Path -LiteralPath $nested).Path
            }
        }
    }

    throw @"
Could not find a locally synced folder named 'M-J Site Backups'.
Open the folder in OneDrive/SharePoint and make sure it is available in File Explorer,
or run this script with -BackupPath "C:\full\path\to\M-J Site Backups".
"@
}

if (-not $env:SUPABASE_URL) {
    throw 'SUPABASE_URL is not set in this Windows session.'
}
if (-not $env:SUPABASE_SERVICE_ROLE_KEY) {
    throw 'SUPABASE_SERVICE_ROLE_KEY is not set in this Windows session. Do not put this key in GitHub.'
}

$destination = Find-BackupFolder -ExplicitPath $BackupPath
Write-Host "Archive destination: $destination"

$repoRoot = Split-Path -Parent $PSScriptRoot
$archiveScript = Join-Path $PSScriptRoot 'archive-old-loads.mjs'
if (-not (Test-Path -LiteralPath $archiveScript)) {
    throw "Archive script not found: $archiveScript"
}

$args = @($archiveScript, $destination)
if ($Cutoff) { $args += "--cutoff=$Cutoff" }
if ($Purge) { $args += '--purge' }

Write-Host ("Mode: " + $(if ($Purge) { 'ARCHIVE + PURGE' } else { 'ARCHIVE ONLY' }))
if ($Cutoff) { Write-Host "Cutoff: $Cutoff" }

& node @args
if ($LASTEXITCODE -ne 0) {
    throw "Archive process exited with code $LASTEXITCODE"
}

Write-Host 'Archive process completed successfully.'
