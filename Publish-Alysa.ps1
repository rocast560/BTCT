[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Tag,
    [Parameter(Mandatory)] [string] $Message
)
$ErrorActionPreference = 'Stop'

if ($Tag -notmatch '^v\d+\.\d+\.\d+$') {
    throw "Tag must look like vMAJOR.MINOR.PATCH (got '$Tag')."
}

# Always operate on the repo this script lives in, regardless of cwd.
$RepoPath = Split-Path -Parent $PSCommandPath
Push-Location $RepoPath
try {
    git add -A
    if (git diff --cached --name-only) {
        git commit -m $Message
    } else {
        Write-Host "[Publish-Alysa] no staged changes; skipping commit"
    }
    git push origin main
    git tag -fa $Tag -m $Message
    git push origin $Tag --force
    Write-Host "[Publish-Alysa] released $Tag"                 -ForegroundColor Green
    Write-Host "[Publish-Alysa] on Kali run:   update-alysa $Tag" -ForegroundColor Cyan
} finally {
    Pop-Location
}
