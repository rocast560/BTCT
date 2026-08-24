# Backup-BTCT.ps1: trigger a BTCT backup through the app's own engine.
#
# The app writes consistent snapshots itself (Admin panel -> Backups), one
# folder per run into the host folder bind-mounted at /backups (./backups next
# to docker-compose.yml by default). This script only calls the "run now"
# endpoint, so it can be scheduled from Windows Task Scheduler (run the task as
# your own user: Docker Desktop needs a logged-in session).
#
# Token: Admin panel -> Backups -> Reveal. Pass -Token or set BTCT_BACKUP_TOKEN.

[CmdletBinding()]
param(
    [string] $BaseUrl = 'http://127.0.0.1:8080',   # 127.0.0.1, not localhost (see README "Running on Windows")
    [string] $Token   = $env:BTCT_BACKUP_TOKEN
)
$ErrorActionPreference = 'Stop'

if (-not $Token) {
    throw "No token. Pass -Token or set BTCT_BACKUP_TOKEN (Admin panel -> Backups -> Reveal)."
}

$headers = @{ Authorization = "Bearer $Token" }
Write-Host "[Backup-BTCT] requesting a backup from $BaseUrl ..." -ForegroundColor Cyan
try {
    $r = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/backup/run" -Headers $headers -TimeoutSec 3600
} catch {
    throw "Backup request failed: $($_.Exception.Message)"
}

if ($r.ran) {
    $mb = [math]::Round($r.bytes / 1MB, 1)
    $secs = [math]::Round($r.durationMs / 1000)
    Write-Host "[Backup-BTCT] wrote $($r.name) ($mb MB, $($r.files) files, $secs s)" -ForegroundColor Green
} else {
    Write-Host "[Backup-BTCT] a backup is already running" -ForegroundColor Yellow
}
