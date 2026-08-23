# CLAUDE.md

This file guides Claude Code (claude.ai/code) when working in this repository.

BTCT ("Been There, Conquered That") is a real-time, multi-user pentest
note-taking and reporting app: collaborative markdown pages, attack-narrative
graphs, nmap import, findings/timeline, Typst reports, an embedded Claude
assistant, a hosted MCP server, command-log ingest, and consistent backups.

## This repo is now the Wails desktop app

BTCT was a Bun server plus a Vite/React client shipped as one Docker image. It
is now packaged as a **cross-platform desktop app with Wails v2**: a thin **Go
shell** (`wails/`) runs the **existing Bun server as a local sidecar** and shows
it in a native window, keeping real-time collaboration (the sidecar binds
`0.0.0.0`, so teammates join over the LAN). The server was not rewritten in Go.

The former standalone web/Docker deployment was removed from the repo on
2026-08-23 (git history retains it). Its code now lives, unchanged, inside the
Wails app:

| Was (old top level) | Now |
|---|---|
| `src/` (React client) | `wails/frontend/src/` |
| `server/` (Bun server) | `wails/server/` |
| `Dockerfile`, `docker-compose.yml`, `*.ps1` | removed (the Wails shell packages the app instead) |

## Layout

```
wails/            the desktop app (Go shell + copied frontend + copied server)
  frontend/       the React client (Vite); built to frontend/dist, served by the sidecar
  server/         the Bun server (index.mjs + friends + node_modules)
  loading/        the launcher page shown first (embedded via go:embed)
  app.go main.go  the Go shell: spawn/stop the sidecar, report readiness
  scripts/        build.sh (wails build + pack), pack-sidecar.sh
  CLAUDE.md       the detailed architecture + invariants dev guide (read this before touching the server/client)
  README.md       desktop dev/build/run
  REFERENCE.md    the exhaustive feature tour, HTTP API table, DB notes, recipes
docs/             design specs (incl. the Wails design + the backups/history/theming plan) and the perf audit
```

## Commands

Run these from `wails/`. Requires Go 1.21+, the Wails CLI, Bun, a C compiler
(MinGW on Windows), and the platform webview (WebView2 ships with Windows 11).

- `cd wails/frontend && bun install && bun run build`: build the React client
  into `wails/frontend/dist` (the canonical "does the client compile" check is
  `bun run build`, which runs `tsc -b && vite build`).
- `cd wails && wails dev`: run the app with Go hot-reload; the sidecar serves the
  pre-built client.
- `cd wails && bash scripts/build.sh`: production Windows build ->
  `wails/build/bin/BTCT.exe` plus a self-contained `sidecar/` folder beside it.
- The Bun server (`wails/server/*.mjs`) is not covered by `tsc`. Sanity-check
  syntax with `bun build ./wails/server/<file>.mjs --target=bun --external '*' --outfile /tmp/x.js`.

**Running an unsigned build on Windows**: Smart App Control / Defender
Application Control blocks unsigned executables, so a locally built `BTCT.exe`
will not launch until it is code-signed or the policy is relaxed. This is a
machine security setting, not a build problem.

## Architecture and invariants

The Bun server and React client are unchanged from the web app, so their
architecture (two-tier Yjs/CRDT design, per-page docs, the Y.Text mirror,
repos/stores, Typst pipeline, AI assistant, MCP server, command-log ingest,
backups) and all critical invariants are documented in **`wails/CLAUDE.md`**.
Read it before touching anything under `wails/server/` or `wails/frontend/src/`.
`wails/REFERENCE.md` has the full HTTP API table, DB schema notes, keyboard
shortcuts, and extension recipes.

The desktop shell itself is small: `wails/app.go` starts the sidecar (per-user
data dir, stable `AUTH_SECRET`, `bun index.mjs` with `HOST=0.0.0.0` + a port +
`STATIC_DIR`/`DB_PATH`/`YPERSISTENCE`/`ASSETS_DIR`/`BACKUP_DIR`), polls
`/healthz`, then the launcher (`wails/loading/index.html`) navigates the window
to the local server (or a remote one the operator types in). Design and
rationale: `docs/superpowers/specs/2026-08-23-wails-desktop-shell-design.md`.

## Writing style for generated prose

**Never use em dashes (the long dash) in anything you write.** Not in docs, not
in commit messages, not in code comments, not in PR descriptions. Make the
decision the dash skips: use a full stop, a colon, parentheses, or a comma
instead. En dashes are fine in real numeric ranges. Run `grep -c` for the
character before calling a doc change done; it should be 0.

Skip the ban-list words (seamless, leverage, robust, comprehensive, delve,
unlock, supercharge), do not bold every feature noun, and vary sentence length.

## Keep the docs in sync (on every change)

When you change the code, update the relevant docs in the same change:
`wails/CLAUDE.md` (architecture/invariants), `wails/REFERENCE.md` (features, API
table, DB notes, shortcuts), `wails/README.md` (desktop dev/build), and this
file (big picture, commands). Prefer editing existing sections over appending.
