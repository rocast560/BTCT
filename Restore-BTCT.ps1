# Restore-BTCT.ps1 — restore a Backup-BTCT.ps1 .tgz back into the live volume.
#
# DESTRUCTIVE: this WIPES the current btct-data volume contents and replaces
# them with the contents of the archive. The container is stopped during
# the restore and brought back up afterwards.
#
# Pass -Force to skip the confirmation prompt.

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ArchivePath,
    [string] $VolumeName = 'beenthereconqueredthat_btct-data',
    [switch] $Force
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ArchivePath)) {
    throw "Archive not found: $ArchivePath"
}
$ArchivePath = (Resolve-Path $ArchivePath).Path

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI not found on PATH."
}

if (-not $Force) {
    Write-Host "About to RESTORE from:" -ForegroundColor Yellow
    Write-Host "  $ArchivePath" -ForegroundColor Yellow
    Write-Host "This will WIPE the current contents of Docker volume:" -ForegroundColor Yellow
    Write-Host "  $VolumeName" -ForegroundColor Yellow
    $resp = Read-Host "Type 'restore' to continue"
    if ($resp -ne 'restore') {
        Write-Host "[Restore-BTCT] cancelled." -ForegroundColor Red
        return
    }
}

$RepoPath = Split-Path -Parent $PSCommandPath
Push-Location $RepoPath
try {
    Write-Host "[Restore-BTCT] stopping containers..." -ForegroundColor Cyan
    & docker compose down
    if ($LASTEXITCODE -ne 0) { throw "docker compose down failed." }

    # Ensure the volume exists (create it if this is a fresh host).
    $null = & docker volume inspect $VolumeName 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[Restore-BTCT] volume '$VolumeName' did not exist; creating it." -ForegroundColor Yellow
        & docker volume create $VolumeName | Out-Null
    }

    $archiveDir  = Split-Path -Parent $ArchivePath
    $archiveName = Split-Path -Leaf   $ArchivePath
    $hostMount   = $archiveDir -replace '\\', '/'

    Write-Host "[Restore-BTCT] wiping and replacing volume contents..." -ForegroundColor Cyan
    & docker run --rm `
        -v "${VolumeName}:/data" `
        -v "${hostMount}:/backup:ro" `
        alpine `
        sh -c "rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null; tar xzf /backup/$archiveName -C /data"
    if ($LASTEXITCODE -ne 0) { throw "docker restore failed (exit $LASTEXITCODE)." }

    Write-Host "[Restore-BTCT] bringing containers back up..." -ForegroundColor Cyan
    & docker compose up -d
    if ($LASTEXITCODE -ne 0) { throw "docker compose up failed." }

    Write-Host "[Restore-BTCT] done. App is reachable at http://localhost:8080" -ForegroundColor Green
}
finally {
    Pop-Location
}
