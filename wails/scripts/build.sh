#!/usr/bin/env bash
# Build the Windows desktop app and bundle the sidecar.
# Result: wails/build/bin/BTCT.exe plus a sidecar/ folder beside it. Ship the
# whole build/bin folder (or wrap it with `wails build -nsis` for an installer).
set -euo pipefail
cd "$(dirname "$0")/.."
PLATFORM="${1:-windows/amd64}"
echo "[build] wails build -platform $PLATFORM"
wails build -platform "$PLATFORM"
bash scripts/pack-sidecar.sh
echo "[build] done. Launch: build/bin/BTCT.exe"
