# Restore-BTCT.ps1: restore a backup folder written by the app into the live volume.
#
# Stops the container, runs the restore CLI inside the image (it verifies the
# manifest, keeps the old data in /data/pre-restore-<stamp>/, then writes the
# SQLite file, rebuilds the Yjs rooms and copies the assets), and starts the
# container again.
#
#   .\Restore-BTCT.ps1 btct-backup-20260823-101500
#
# -Force skips the confirmation prompt. -Partial restores a backup that lacks a
# category (see Admin panel -> Backups checkboxes) on top of the existing data.

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $BackupName,   # a folder name under .\backups
    [switch] $Force,
    [switch] $Partial
)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI not found on PATH."
}

$RepoPath = Split-Path -Parent $PSCommandPath
$leaf = Split-Path -Leaf $BackupName
if (-not (Test-Path (Join-Path (Join-Path $RepoPath 'backups') $leaf))) {
    throw "No folder .\backups\$leaf. Backups are the btct-backup-YYYYMMDD-HHMMSS folders under .\backups."
}

if (-not $Force) {
    Write-Host "About to RESTORE .\backups\$leaf into the live data volume." -ForegroundColor Yellow
    Write-Host "The current data is kept in /data/pre-restore-<stamp>/ inside the volume." -ForegroundColor Yellow
    $resp = Read-Host "Type 'restore' to continue"
    if ($resp -ne 'restore') {
        Write-Host "[Restore-BTCT] cancelled." -ForegroundColor Red
        return
    }
}

Push-Location $RepoPath
try {
    Write-Host "[Restore-BTCT] stopping the container..." -ForegroundColor Cyan
    & docker compose stop btct
    if ($LASTEXITCODE -ne 0) { throw "docker compose stop failed." }

    $dockerArgs = @('compose', 'run', '--rm', 'btct', 'bun', 'server/restore.mjs', "/backups/$leaf", '--yes')
    if ($Partial) { $dockerArgs += '--partial' }
    Write-Host "[Restore-BTCT] restoring $leaf ..." -ForegroundColor Cyan
    & docker @dockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "restore failed (exit $LASTEXITCODE); the container is still stopped. Check the output above, then 'docker compose start btct'."
    }

    Write-Host "[Restore-BTCT] starting the container..." -ForegroundColor Cyan
    & docker compose start btct
    if ($LASTEXITCODE -ne 0) { throw "docker compose start failed." }

    Write-Host "[Restore-BTCT] done. App is reachable at http://127.0.0.1:8080" -ForegroundColor Green
}
finally {
    Pop-Location
}
