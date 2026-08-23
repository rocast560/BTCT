# Been There, Conquered That (BTCT)

A real-time, multi-user pentest note-taking and reporting app: collaborative
markdown pages, attack-narrative graphs, nmap import, findings and timeline,
Typst report typesetting, an embedded Claude assistant, a hosted MCP server,
team command-log capture, and consistent backups.

BTCT ships as a **cross-platform desktop app built with Wails**. A thin Go shell
runs the app's Bun server as a local sidecar and shows it in a native window;
because the sidecar binds the LAN, one operator can host and teammates join in
real time (another desktop, or a plain browser).

## Repository

```
wails/     the desktop app
  README.md      how to develop, build, and run it (start here)
  REFERENCE.md   the full feature tour, HTTP API table, DB notes, and recipes
  CLAUDE.md      the architecture + invariants dev guide
docs/      design specs and the performance audit
```

The app was previously a Bun server plus a React client shipped as a Docker
image. That server and client are unchanged; they now live inside `wails/`
(`wails/server` and `wails/frontend`), wrapped in the Go desktop shell. See
[`wails/README.md`](wails/README.md).

## Quick start (Windows)

Requires Go 1.21+, the [Wails CLI](https://wails.io), Bun, MinGW (a C compiler),
and Windows 11's WebView2 runtime.

```powershell
cd wails\frontend; bun install; bun run build   # build the client once
cd ..; wails dev                                 # run the app with hot reload
```

Production build:

```powershell
cd wails; bash scripts/build.sh                  # -> build\bin\BTCT.exe + sidecar\
```

An unsigned build will not launch while Windows Smart App Control or an
Application Control policy is enforced; sign the binary or relax the policy.

Full instructions, macOS/Linux builds, and the multi-user story are in
[`wails/README.md`](wails/README.md).
