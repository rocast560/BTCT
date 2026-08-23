# BTCT as a Wails cross-platform desktop app (design)

Date: 2026-08-23. Status: approved approach, implementing.

## Goal

Ship BTCT as a native cross-platform desktop app using Wails v2, without
rewriting the working Bun server or losing real-time multi-user collaboration.
Preserve the current app in a subfolder; build the Wails app in a new folder
alongside. The user will build off the Wails version going forward.

## Decisions (from the user)

- Approach **A**: a Wails **Go shell** that runs the existing **Bun server as a
  sidecar** and shows it in a native window. Not a Go rewrite.
- Keep **live multi-user collaboration**: the sidecar binds `0.0.0.0`, so one
  desktop hosts and other operators (desktop or browser) join over the LAN; a
  desktop can also point at a remote BTCT server instead.
- Folders: current app moves to **`web/`**; the Wails app is **`wails/`**.
- First deliverable: a working app via `wails dev` plus a launchable **Windows
  `.exe`**. macOS/Linux build config written and documented, not compiled here
  (Wails v2 cannot cross-compile macOS; CGO wants per-OS builds).

## Why not the alternatives

- Wails backends are **Go only**; a Bun/Node process cannot be the backend, so
  the server must run as a sidecar (confirmed by research).
- Rewriting the server in Go re-implements the Yjs relay, SQLite, AI and MCP for
  weeks and throws away working code. Deferred unless a single-binary constraint
  forces it.

## Repository layout after the move

```
BeenThereConqueredThat/     git root, .claude, slim root CLAUDE.md + README
  web/                      the entire current app, moved via git mv (history kept)
                            still builds and runs under Docker; can be the shared server
  wails/                    the Wails desktop app
    frontend/               the React client (copied from web/): src, index.html,
                            vite.config.ts, tsconfig.json, package.json, public
    server/                 the Bun server (copied from web/server)
    loading/               tiny embedded "starting BTCT" page (Wails AssetServer)
    build/                  Wails build assets (icon, NSIS config) from `wails init`
    app.go  main.go  wails.json  go.mod  go.sum
  docs/superpowers/specs/   this spec
```

## Runtime flow (approach A)

1. Go `main.go` runs Wails; its AssetServer serves the embedded `loading/` page,
   so the window shows a spinner immediately.
2. `OnStartup(ctx)` (`app.go`):
   - Resolve a per-user data dir: `%APPDATA%/BTCT` (win), `~/Library/Application
     Support/BTCT` (mac), `~/.local/share/BTCT` (linux).
   - Ensure a persistent `AUTH_SECRET` in `<data>/auth.secret` (generate 32 random
     bytes on first run) so tokens survive restarts.
   - On a packaged build, extract the embedded sidecar bundle (bun runtime +
     `server/` + its `node_modules` + built `frontend/dist`) into
     `<data>/runtime/<appVersion>/` if not already present. In `wails dev`, use
     the on-disk `wails/server` and `wails/frontend/dist`.
   - Pick a port (default 34115; fall back to an OS-assigned free port if busy).
   - Spawn the Bun server: `bun index.mjs` with env `HOST=0.0.0.0`,
     `PORT=<port>`, `STATIC_DIR=<frontend/dist>`, `DB_PATH=<data>/data.sqlite`,
     `YPERSISTENCE=<data>/yjs`, `ASSETS_DIR=<data>/assets`, `BACKUP_DIR=<data>/backups`,
     `AUTH_SECRET=<secret>`. Keep the `*exec.Cmd`.
   - Poll `http://127.0.0.1:<port>/healthz` until ok (timeout ~20s).
   - Navigate the WebView to the server: `runtime.WindowExecJS(ctx,
     'location.replace("http://127.0.0.1:<port>/")')`. Go IPC is not needed after
     this (the app talks to the server over HTTP/WS like a browser), so losing the
     `window.go.*` bridge on the localhost origin is fine.
3. `OnBeforeClose`/`OnShutdown`: kill the sidecar process (kill the whole process
   group so `bun`'s children die too). `wails dev` does not reliably fire
   `OnShutdown` (Wails issue #2421), so cleanup is verified in a real build.

## Multi-user

- Hosting is automatic: the sidecar binds `0.0.0.0`, so `http://<host-ip>:<port>`
  is reachable on the LAN by another desktop app or a browser. The client already
  defaults to same-origin, so a peer browser needs no configuration.
- Joining: a Wails application menu item "Connect to server…" collects a URL and
  navigates the WebView there instead of the local server (same mechanism). The
  local sidecar keeps running (so the user can still host); a future refinement
  can stop it when purely joining. A saved "last server" is kept in
  `<data>/config.json`.

## Sidecar packaging (Windows v1)

The one cross-compile hazard is `y-leveldb` -> `classic-level`/`leveldown`
(native C++ addon), which `bun build --compile` does not rebuild across targets.
For Windows-on-Windows we avoid the problem entirely:

- Bundle the real `bun.exe` plus `wails/server` **including its `node_modules`**
  (which already contains the Windows-native LevelDB build) and the built
  `frontend/dist`. Zip them into `wails/build/sidecar/sidecar.zip` at build time
  and `go:embed` that single file; extract on first run.
- Cross-platform later: either bundle a per-OS `bun` + per-OS `node_modules`, or
  switch Yjs persistence off LevelDB to a SQLite/file backend so
  `bun build --compile --target=bun-<os>-<arch>` yields one clean server binary.
  Out of scope for v1; noted for Epic follow-up.

## Dev and build

- `wails dev`: Go hot-reload; a pre-step builds `frontend/dist` (`bun run build`
  in `wails/frontend`) so the sidecar has something to serve. The Go shell spawns
  the on-disk sidecar. (Frontend HMR via Vite is a later refinement; v1 serves the
  built client through the sidecar for simplicity and parity with production.)
- `wails build -platform windows/amd64`: builds `frontend/dist`, zips the sidecar
  bundle, embeds it, compiles `BTCT.exe`. `-nsis` optionally produces an installer.
- macOS/Linux: `wails build` config is present; building requires that OS (CGO).
  A CI matrix (windows-latest, macos-latest, ubuntu-latest) is the documented path.

## What does NOT change

- The entire `web/` app (Bun server, React client, Docker, backups, AI, MCP)
  is untouched by the move except path references in Docker/scripts, which are
  fixed so `cd web && docker compose up` still works.
- The client and server code copied into `wails/` are byte-for-byte the same at
  first; the Wails app adds only the Go shell around them.

## Testing / acceptance

- `web/` still builds: `cd web && bun run build` and `docker compose config` ok.
- `wails/frontend` builds to `dist`.
- Go compiles: `cd wails && go build ./...`.
- The app launches (`wails dev` or the built `.exe`), shows the loading page,
  then the BTCT login screen served by the sidecar; login works; the sidecar dies
  when the window closes (verified on the built exe).
- A second machine/browser can reach `http://<host>:<port>` (multi-user smoke).

## Risks

- go:embed of `node_modules` makes a large exe (~150MB). Acceptable for v1;
  revisit with `bun build --compile` once LevelDB is off native addons.
- `OnShutdown` not firing in `wails dev` -> orphan `bun`. Mitigated by process-group
  kill and verifying on the real build.
- Port conflicts -> fall back to an OS-assigned free port and pass it to the WebView.
- Moving the repo breaks Docker/script paths -> fixed inside `web/` as part of the move.
