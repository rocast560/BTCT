# SYNote

A LAN-hosted, multi-user, real-time collaborative note-taking and attack-path
graphing app for penetration testing engagements. Notion-style pages, an
attack-narrative graph canvas, and live Google-Docs-style co-editing across
every machine on the LAN.

## Features

### Authoring
- Notion / Milkdown (Crepe) markdown editor with code blocks, tables, task
  lists, image embeds, and a custom highlight plugin.
- Per-page Y.Doc with IndexedDB cache so the editor renders instantly and
  syncs in the background.
- Floating format panel (bold / italic / strike / code / link / heading /
  list / quote / highlight) that appears next to the current selection.
- Workspace tree of nested pages with icons, tags, sortable order, and slugs.

### Real-time collaboration (Google-Docs style)
- Single shared Yjs document (`alysa-shared`) holds every record visible in
  the sidebar (workspaces, pages, graphs, nodes, edges, attack chains,
  change logs, nmap scans, nmap machines).
- Every collaboratively-edited text field — page title, slug, node label,
  edge label, nmap hostname — is a `Y.Text` keyed `<entity>:<id>:<field>`.
  React inputs emit insert/delete deltas instead of overwriting the whole
  string, so two users typing in the same field merge character-by-character.
- A central `observeDeep` mirrors each `Y.Text` back into the JSON record
  snapshot so sidebars, tab labels, search, and exports keep working
  without knowing anything about CRDTs.
- Remote carets are rendered as a thin colored bar in the user's color
  with a small Google-Docs-style name tag floating above (see
  `.ProseMirror-yjs-cursor` styles).
- Awareness pushes `{ id, name, color }` per connected user; presence
  avatars appear in the top bar.

### Attack narrative graph
- React Flow canvas with five custom node types: Host, Credential, Service,
  Finding, Pivot — each auto-creates a linked sub-page for notes.
- Six edge types: AdminTo, HasSession, MemberOf, Exploits, PivotsTo, Custom.
- Node palette, right-click context menu, multi-select, dagre auto-layout.
- "Highlight Path" runs Dijkstra between two selected nodes and animates
  the result.
- Attack-chain panel groups paths into named scenarios.

### Nmap workflow
- Drag-drop or paste nmap XML; machines are upserted by IP across imports.
- Per-machine view with editable hostname (CRDT) and OS dropdown, plus
  per-port enable/disable that mirrors into the linked Host node's
  `openPorts`.
- Optional one-click link to a graph Host node.

### Findings & change log
- Findings collector aggregates across pages and graphs.
- Append-only change log records who did what (create/update/delete).

### Export / Import
| Format               | Description                                                      |
| -------------------- | ---------------------------------------------------------------- |
| Markdown             | Pages → `.md` files (single or zip)                              |
| GraphML              | Graph → valid GraphML XML with custom `<data>` keys              |
| JSON                 | Graph → raw React Flow JSON                                       |
| Attack Path Bundle   | XML wrapping selected-path GraphML + linked-page Markdown        |
| Workspace ZIP        | Full workspace dump (`workspace.json`, `pages/`, `graphs/`, …)   |
| Import GraphML / ZIP | Re-creates a graph or full workspace from disk                   |

## Tech stack

### Client
- **Vite 8** + **React 19** + **TypeScript strict**
- **Milkdown 7 (Crepe)** for the page editor
- **@xyflow/react 12** for the graph canvas
- **Yjs 13** + **y-websocket 2** + **y-prosemirror 1** + **y-indexeddb 9**
  for the CRDT layer
- **Zustand 5** for app state
- **Tailwind CSS 4** + **Radix UI** for primitives
- **dagre** for graph layout, **cmdk** for the command palette,
  **JSZip** for export bundles, **lucide-react** for icons,
  **date-fns** for timestamps
- **Vitest 4** for unit tests

### Server (`server/`)
- **Bun 1.3** runtime (uses `bun:sqlite`)
- Plain `node:http` + `ws` WebSocketServer
- `y-websocket/bin/utils.setupWSConnection` handles every Yjs room
- PBKDF2-SHA256 password hashing (200 000 iterations, 16-byte salt,
  32-byte key) and HMAC-SHA256 signed bearer tokens
- Optional static-file serving so the same Bun process delivers the
  built Vite client and the realtime backend on one port

## Repository layout

```
src/
  api/             REST client for the auth server
  auth/            Auth store + login screen
  components/
    editor/        Milkdown page editor + floating format panel
    graph/         React Flow canvas, custom nodes/edges, palette, context menu
      nodes/         HostNode, CredentialNode, ServiceNode, FindingNode, PivotNode
      edges/         LabeledEdge
    findings/      AttackTimeline, FindingsCollector
    nmap/          Drag-drop import + per-machine view
    sidebar/       Left tree, right properties + backlinks + change log
    ui/            TabBar, SplitContainer, MainContent, CommandPalette, …
  db/              Repository layer over the shared Yjs doc
  export/          Markdown / GraphML / bundle / zip exporters
  lib/             Pathfinding, dagre layout, pane layout, nmap parser, helpers
  realtime/
    shared-doc.ts    Single shared Yjs doc + Y.Text registry + JSON mirror
    use-y-text.ts    React hook binding inputs to Y.Texts via diff deltas
    yjs-providers.ts Per-page Y.Doc for the markdown body
    PresenceAvatars.tsx
  stores/          Zustand store + Yjs ↔ store bindings
  test/            Vitest suites + fixtures
  types/           Shared TypeScript types
server/
  index.mjs        HTTP + WS entry
  auth.mjs         PBKDF2 + HMAC token helpers
  db.mjs           bun:sqlite user table
```

## Run locally on Windows (dev)

Two processes: the Bun auth/realtime server and the Vite client.

### Prerequisites
- **Bun** ≥ 1.3 — `winget install Oven-sh.Bun` or `irm bun.sh/install.ps1 | iex`
- **Git**

### One-time setup
```powershell
git clone https://github.com/<you>/AlysaFramework.git
cd AlysaFramework
bun install
bun install --cwd server
```

### Start the server (Terminal 1)
```powershell
cd server
$env:AUTH_SECRET = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
$env:ALLOWED_ORIGIN = 'http://127.0.0.1:5173'
bun run start
```
You should see `[alysa-server] HTTP/WS listening on http://127.0.0.1:1234`.

### Start the client (Terminal 2)
```powershell
cd C:\path\to\AlysaFramework
bun run dev
```
Open http://127.0.0.1:5173, register an account, and start editing.
Open a second browser profile (or another machine on the LAN pointed at
your machine's IP and the same Vite port if you bind Vite to `0.0.0.0`)
to see live co-editing.

### Tests
```powershell
bun run test
```

## Build for production
```powershell
bun run build
```
Outputs `dist/`. Set `STATIC_DIR=<path-to-dist>` on the server to have it
serve the built client and the WebSocket on one port.

## Release workflow

The repo is published from Windows and pulled down on the Linux deployment
host. Two scripts drive it.

### `Publish-Alysa.ps1` — Windows side
Stages, commits, pushes `main`, and tags. Run from anywhere; it `cd`s to
the repo containing the script.

```powershell
.\Publish-Alysa.ps1 -Tag v0.1.8 -Message "Fix graph node edit page not loading"
```

What it does:
1. Validates the tag matches `vMAJOR.MINOR.PATCH`.
2. `git add -A` then commits the staged changes (skips if nothing to
   stage).
3. `git push origin main`.
4. `git tag -fa <tag>` and `git push origin <tag> --force` (rewrites
   the tag if you re-publish the same version).
5. Prints the matching `update-alysa <tag>` command for the server.

### `update-alysa` — Linux side
A small system command on the Linux deployment host that pulls the
release, rebuilds the client, and restarts the Bun service. Typical run:

```bash
update-alysa v0.1.8
```

What it does on the server:
1. `git fetch --tags` and `git checkout <tag>` in the repo working tree.
2. `bun install` for both root and `server/`.
3. `bun run build` to produce `dist/`.
4. Restarts the Bun service (e.g. `systemctl restart alysa`) so it picks
   up the new client bundle from `STATIC_DIR=.../dist`.
5. Tails the journal until `[alysa-server] HTTP/WS listening` appears.

If you don't have `update-alysa` installed yet, the equivalent manual
steps are:

```bash
cd /opt/alysa
sudo -u alysa git fetch --tags
sudo -u alysa git checkout v0.1.8
sudo -u alysa bun install
sudo -u alysa bun install --cwd server
sudo -u alysa bun run build
sudo systemctl restart alysa
```

## Security posture

This is a LAN tool for trusted operators. It is NOT hardened for hostile
internet exposure. Known limitations:

- **Tokens stored in `localStorage`.** XSS in the markdown editor or any
  user-supplied HTML would leak tokens. The Milkdown / Crepe pipeline does
  not currently sanitise pasted HTML; treat untrusted markdown as
  untrusted.
- **No CSRF protection on `/api/*`.** Mitigated only by `Authorization:
  Bearer` (no cookies), but a same-origin XSS still trivially calls the
  API.
- **No rate limiting** on `/api/login` or `/api/register`. Brute-force is
  bounded only by PBKDF2 cost (~50 ms/attempt).
- **No account lockout, MFA, or password reset.** Lose your password →
  edit the SQLite file.
- **Yjs WebSocket auth checks the JWT once at upgrade.** A revoked
  account's existing connection keeps editing until it disconnects.
  Restart the server to kick everyone.
- **No per-workspace authorisation.** Every authenticated user sees
  every workspace; there are no ACLs.
- **Shared doc is global.** A malicious user can clobber other users'
  records; only text fields are CRDT-safe. Non-text edits are
  last-writer-wins.
- **`AUTH_SECRET` defaults to a random ephemeral value when unset.**
  Tokens are silently invalidated on server restart unless you set it.
- **HTTPS / WSS is not built in.** Run behind a reverse proxy (nginx,
  Caddy) for TLS on real deployments. The `tls/` folder in the repo is
  not wired into the server.
- **CORS allows the configured origin only**, but defaults to same-origin
  which is fine for production deployments serving the client from the
  same Bun process.
- **No CSP or Trusted Types.** A future hardening pass should add a strict
  CSP, sanitise pasted HTML, and rotate `AUTH_SECRET` to a KMS-backed
  value.

Threat model: trusted teammates on a LAN segment during an engagement.
Anything beyond that needs additional work.

## License

Internal tooling — not licensed for redistribution.
