# Backup-BTCT.ps1 — snapshot the BTCT Docker volume to a timestamped .tgz.
#
# What it captures:
#   - /data/data.sqlite       (user accounts)
#   - /data/yjs/              (Yjs LevelDB: all pages, graphs, attack chains,
#                              nmap scans, change logs)
#
# Output filename: btct-backup-YYYYMMDD-HHmmss.tgz under -OutputDir
# (default: <repo>\backups\).

[CmdletBinding()]
param(
    [string] $OutputDir  = (Join-Path (Split-Path -Parent $PSCommandPath) 'backups'),
    [string] $VolumeName = 'beenthereconqueredthat_btct-data',
    [string] $Tag                                # optional human-readable suffix
)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI not found on PATH. Install Docker Desktop for Windows first."
}

# Confirm the volume actually exists; bail clearly if not.
$volumeExists = & docker volume inspect $VolumeName 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Docker volume '$VolumeName' not found. Has the app ever been started? Run Start-BTCT.ps1 first."
}

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}
$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$suffix   = if ($Tag) { "-$Tag" } else { '' }
$fileName = "btct-backup-$stamp$suffix.tgz"
$outPath  = Join-Path $OutputDir $fileName

Write-Host "[Backup-BTCT] dumping '$VolumeName' -> $outPath" -ForegroundColor Cyan

# Mount the volume into a throwaway alpine container and tar it out to the
# host via a bind mount. -C /data so paths inside the archive are relative.
$hostMount = (Resolve-Path $OutputDir).Path -replace '\\', '/'
& docker run --rm `
    -v "${VolumeName}:/data:ro" `
    -v "${hostMount}:/backup" `
    alpine `
    tar czf "/backup/$fileName" -C /data .
if ($LASTEXITCODE -ne 0) { throw "docker tar failed (exit $LASTEXITCODE)." }

$size = (Get-Item $outPath).Length
Write-Host ("[Backup-BTCT] wrote {0} ({1:N1} MB)" -f $outPath, ($size/1MB)) -ForegroundColor Green
