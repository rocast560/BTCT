#!/usr/bin/env bash
# Assemble the sidecar bundle next to the built app so a packaged BTCT.exe is
# self-contained: the Go shell looks for <exeDir>/sidecar/{server,frontend/dist,bun.exe}.
# Run this AFTER `wails build` (build.sh does both).
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="build/bin"
SIDE="$BIN/sidecar"
[ -f "$BIN"/*.exe ] 2>/dev/null || echo "note: no exe in $BIN yet (run wails build first)"

rm -rf "$SIDE"
mkdir -p "$SIDE/server" "$SIDE/frontend"

echo "[pack] server (with node_modules)"
cp -r server/. "$SIDE/server/"
rm -f "$SIDE"/server/data.sqlite* 2>/dev/null || true
rm -rf "$SIDE"/server/backups 2>/dev/null || true

echo "[pack] frontend/dist"
cp -r frontend/dist "$SIDE/frontend/dist"

echo "[pack] bun runtime"
BUN="$(command -v bun || true)"
if [ -n "$BUN" ] && [ -f "$BUN.exe" ]; then BUN="$BUN.exe"; fi
if [ -z "$BUN" ] || [ ! -f "$BUN" ]; then
  echo "[pack] ERROR: could not find the bun executable to bundle" >&2
  exit 1
fi
cp "$BUN" "$SIDE/bun.exe"

echo "[pack] done -> $SIDE"
du -sh "$SIDE" 2>/dev/null || true
