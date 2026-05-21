# Start-BTCT.ps1 — one-click launcher for Been There, Conquered That.
#
# What it does, in order:
#   1. cd to the repo this script lives in.
#   2. Make sure Docker Desktop is running (start it and wait if not).
#   3. Make sure .env exists with an AUTH_SECRET (generate one on first run).
#   4. `docker compose up -d` (idempotent — no-op if already running).
#       Pass -Update to pull, rebuild the image, and restart.
#   5. Poll http://localhost:8080/healthz until the server answers.
#   6. Open the default browser to the app.
#
# Data persistence:
#   The btct-data named Docker volume survives container restarts AND
#   rebuilds. It holds /data/data.sqlite (users) and /data/yjs (notes,
#   pages, graphs, etc.). The ONLY way to wipe it is `docker compose
#   down -v`, which this script never does.

[CmdletBinding()]
param(
    [switch] $Update,                # git pull + rebuild image before starting
    [int]    $HealthTimeoutSeconds = 60,
    [switch] $NoBrowser              # skip opening the browser
)
$ErrorActionPreference = 'Stop'

$RepoPath = Split-Path -Parent $PSCommandPath
Push-Location $RepoPath
try {
    Write-Host "[Start-BTCT] repo: $RepoPath" -ForegroundColor DarkGray

    # ── 1. Docker Desktop ──────────────────────────────────────────────
    function Test-DockerReady {
        try {
            $null = & docker info 2>$null
            return $LASTEXITCODE -eq 0
        } catch { return $false }
    }

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker CLI not found on PATH. Install Docker Desktop for Windows first."
    }

    if (-not (Test-DockerReady)) {
        Write-Host "[Start-BTCT] Docker engine isn't responding; starting Docker Desktop..." -ForegroundColor Yellow
        $dockerExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (Test-Path $dockerExe) {
            Start-Process -FilePath $dockerExe | Out-Null
        } else {
            Write-Host "[Start-BTCT] couldn't find Docker Desktop.exe; please start it manually." -ForegroundColor Yellow
        }
        $waited = 0
        while (-not (Test-DockerReady)) {
            if ($waited -ge 120) { throw "Docker engine never came up after 120s." }
            Start-Sleep -Seconds 2
            $waited += 2
            Write-Host "  waiting for Docker engine... ${waited}s" -ForegroundColor DarkGray
        }
        Write-Host "[Start-BTCT] Docker engine ready." -ForegroundColor Green
    }

    # ── 2. .env ────────────────────────────────────────────────────────
    $envPath = Join-Path $RepoPath '.env'
    if (-not (Test-Path $envPath)) {
        Write-Host "[Start-BTCT] .env not found; generating one with a fresh AUTH_SECRET." -ForegroundColor Yellow
        $secret = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
        "AUTH_SECRET=$secret" | Out-File -FilePath $envPath -Encoding ascii
    }

    # ── 3. docker compose ──────────────────────────────────────────────
    if ($Update) {
        Write-Host "[Start-BTCT] -Update: pulling latest and rebuilding..." -ForegroundColor Cyan
        & git fetch --tags --quiet
        & git pull --ff-only
        if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)." }
        & docker compose up -d --build
    } else {
        & docker compose up -d
    }
    if ($LASTEXITCODE -ne 0) { throw "docker compose up failed (exit $LASTEXITCODE)." }

    # ── 4. wait for healthz ────────────────────────────────────────────
    Write-Host "[Start-BTCT] waiting for http://localhost:8080/healthz ..." -ForegroundColor Cyan
    $healthy = $false
    for ($i = 0; $i -lt $HealthTimeoutSeconds; $i++) {
        try {
            $r = Invoke-WebRequest -Uri 'http://localhost:8080/healthz' `
                                   -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch { }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) {
        Write-Host "[Start-BTCT] healthz didn't respond in ${HealthTimeoutSeconds}s. Recent logs:" -ForegroundColor Red
        & docker compose logs --tail=50
        throw "Server didn't become healthy in time."
    }
    Write-Host "[Start-BTCT] healthy. App is at http://localhost:8080" -ForegroundColor Green

    # ── 5. open browser ────────────────────────────────────────────────
    if (-not $NoBrowser) {
        Start-Process 'http://localhost:8080'
    }
}
finally {
    Pop-Location
}
