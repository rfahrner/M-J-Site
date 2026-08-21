param(
    [string]$OutputPath = "$env:USERPROFILE\Desktop\M-J Site Upload",
    [string]$Cutoff
)

$ErrorActionPreference = 'Stop'

if (-not $env:SUPABASE_URL) {
    throw 'SUPABASE_URL is not set in this Windows session.'
}
if (-not $env:SUPABASE_SERVICE_ROLE_KEY) {
    throw 'SUPABASE_SERVICE_ROLE_KEY is not set in this Windows session. Do not put this key in GitHub.'
}

$archiveScript = Join-Path $PSScriptRoot 'archive-old-loads.mjs'
if (-not (Test-Path -LiteralPath $archiveScript)) {
    throw "Archive script not found: $archiveScript"
}

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
$resolvedOutput = (Resolve-Path -LiteralPath $OutputPath).Path

$args = @($archiveScript, $resolvedOutput)
if ($Cutoff) { $args += "--cutoff=$Cutoff" }

Write-Host "Browser-upload archive mode"
Write-Host "Output folder: $resolvedOutput"
Write-Host "Mode: ARCHIVE ONLY (no Supabase deletion)"
if ($Cutoff) { Write-Host "Cutoff: $Cutoff" }

& node @args
if ($LASTEXITCODE -ne 0) {
    throw "Archive process exited with code $LASTEXITCODE"
}

$instructions = @"
M-J SITE ARCHIVE - READY FOR BROWSER UPLOAD

1. Open the online OneDrive folder: M-J Site Backups.
2. Upload/merge the Archive folder from this directory.
3. Confirm the expected Year > Month > Day > Load folders and files are visible online.
4. Do NOT purge Supabase records until the OneDrive upload has been verified.

This browser-upload runner never deletes Supabase records.
"@
Set-Content -LiteralPath (Join-Path $resolvedOutput 'UPLOAD INSTRUCTIONS.txt') -Value $instructions -Encoding UTF8

Write-Host ''
Write-Host 'Archive created successfully. Opening the upload folder...'
Start-Process explorer.exe $resolvedOutput
