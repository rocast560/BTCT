# BTCT desktop app (Wails)

A cross-platform desktop build of BTCT. It is a thin **Go shell** (Wails v2)
that runs the existing **Bun server as a local sidecar** and shows it in a
native window. All application logic still lives in the Bun server and the
React client; the Go layer only launches the server, hosts the window, and lets
you join another operator's server.

Why a sidecar: Wails backends are Go, and BTCT's backend is a Bun multi-user
collaboration server (Yjs relay over WebSockets, SQLite, the AI loop, MCP). So
the server runs as a child process rather than being rewritten in Go. See the
design at `../docs/superpowers/specs/2026-08-23-wails-desktop-shell-design.md`.

## Layout

```
wails/
  frontend/     the React client (Vite). Built to frontend/dist and served by the sidecar.
  server/       the Bun server (index.mjs + friends + node_modules).
  loading/      the launcher page the window shows first (embedded via go:embed).
  app.go        starts/stops the Bun sidecar, reports readiness to the launcher.
  main.go       Wails entry point; embeds loading/.
  wails.json    project config (frontend build via bun).
  scripts/      build.sh (wails build + pack), pack-sidecar.sh.
```

## How it runs

1. The window shows `loading/index.html` immediately.
2. `app.go` picks a per-user data dir (`%AppData%/BTCT`, `~/Library/Application
   Support/BTCT`, `~/.config/BTCT`), ensures a stable `AUTH_SECRET`, then spawns
   `bun index.mjs` with `HOST=0.0.0.0` and a port (8899, or a free one) plus
   `STATIC_DIR`/`DB_PATH`/`YPERSISTENCE`/`ASSETS_DIR`/`BACKUP_DIR` under that dir.
3. When `/healthz` is green the launcher navigates the window to
   `http://127.0.0.1:<port>/`. Closing the window kills the sidecar.

**Multi-user is preserved.** The sidecar binds `0.0.0.0`, so another operator
(desktop app or plain browser) joins at `http://<your-LAN-ip>:<port>/`. The
launcher's "join another operator's server" field points this app at a remote
BTCT instead (another hosting desktop, or a Docker deployment).

## Develop

Requires Go 1.21+, the Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`),
Bun, a C compiler (MinGW on Windows), and the platform webview (WebView2 on
Windows, ships with Windows 11).

```
cd wails
wails dev          # hot-reload Go; the sidecar serves the pre-built client
```

First time (or after client changes), build the client so the sidecar has
something to serve: `cd frontend && bun install && bun run build`.

## Build (Windows)

```
cd wails
bash scripts/build.sh            # = wails build -platform windows/amd64 + pack-sidecar
# -> build/bin/BTCT.exe  and  build/bin/sidecar/{server,frontend/dist,bun.exe}
```

Ship the whole `build/bin` folder (the `.exe` plus its `sidecar/`), or wrap it
with `wails build -nsis` for a Windows installer.

**Running an unsigned build on Windows.** If Windows **Smart App Control** or a
Defender Application Control policy is enforced, it blocks unsigned executables,
so a locally built `BTCT.exe` will not launch until it is code-signed or the
policy is relaxed. This is a machine security setting, not a build problem. For
distribution, sign the binary (Authenticode on Windows, notarization on macOS).

## Build (macOS / Linux)

Wails v2 cannot cross-compile macOS, and CGO generally wants each OS to build
its own target, so build on the target OS or in CI:

```
# on macOS
bash scripts/build.sh darwin/universal    # then sign + notarize the .app
# on Linux
bash scripts/build.sh linux/amd64
```

`pack-sidecar.sh` currently bundles the host's `bun` as `bun.exe`; for macOS and
Linux, bundle the matching `bun` binary (or produce a per-OS `bun build
--compile` server, once Yjs persistence is off the native LevelDB addon). A CI
matrix (windows-latest, macos-latest, ubuntu-latest) is the intended path.

## Known follow-ups

- The sidecar bundles the whole server `node_modules` because `y-leveldb` uses a
  native addon that `bun build --compile` cannot rebuild across targets. Moving
  Yjs persistence to a SQLite/file backend would let the server compile to a
  single per-OS binary and shrink the bundle.
- The "join a server" flow is launcher-only for now; an in-app menu item and a
  remembered server list are natural next steps.
