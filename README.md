# Been There, Conquered That (BTCT)

A LAN-hosted, multi-user, real-time collaborative note-taking and attack-path
graphing app for penetration testing engagements. Notion-style pages, an
attack-narrative graph canvas, and live Google-Docs-style co-editing across
every machine on the LAN.

---

## Table of Contents

- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
  - [Client](#client)
  - [Server (`server/`)](#server-server)
  - [Packaging / deployment](#packaging--deployment)
- [Repository layout](#repository-layout)
- [One-click launcher (Windows)](#one-click-launcher-windows)
- [What persists (and what doesn't)](#what-persists-and-what-doesnt)
- [Backups & restore](#backups--restore)
- [Edit history & rollback](#edit-history--rollback)
  - [Activity log (who edited what, when)](#activity-log-who-edited-what-when)
  - [Restore from history](#restore-from-history)
  - [Page version history (body snapshots)](#page-version-history-body-snapshots)
- [Lossless workspace export & import](#lossless-workspace-export--import)
- [Run locally on Windows with Docker Desktop](#run-locally-on-windows-with-docker-desktop)
  - [Prerequisites](#prerequisites)
  - [First-time setup](#first-time-setup)
  - [Useful commands](#useful-commands)
  - [LAN access from teammates](#lan-access-from-teammates)
  - [Dev mode (hot reload, without Docker)](#dev-mode-hot-reload-without-docker)
- [Releases](#releases)
  - [Push a release to GitHub (Windows)](#push-a-release-to-github-windows)
  - [Deploy / update on a Linux production host](#deploy--update-on-a-linux-production-host)
- [Tests](#tests)
- [Security posture](#security-posture)
- [License](#license)

---

## How it works

BTCT is two cooperating processes packaged into one Docker image:

1. **Bun HTTP/WebSocket server** (`server/`)
   - Serves a REST API for auth (`/api/login`, `/api/me`, admin routes).
   - Serves the built Vite client (`STATIC_DIR=/app/dist`) on the same port.
   - Hosts a Yjs WebSocket endpoint at `/yjs/<roomname>?token=<jwt>` that
     proxies clients into shared CRDT documents via
     `y-websocket/bin/utils.setupWSConnection`.
   - Stores users in `bun:sqlite` at `/data/data.sqlite`. Passwords are
     PBKDF2‑SHA256 (200 000 iterations); session tokens are HMAC‑SHA256.
   - Persists all Yjs rooms to `/data/yjs/` via LevelDB (`YPERSISTENCE`).

2. **Vite/React client** (`src/`)
   - Loads, authenticates against `/api/login`, then opens a WebSocket
     connection to `/yjs/...` for live collaboration.
   - Maintains **one shared Yjs doc** (`btct-shared`) holding workspaces,
     pages, graphs, nodes, edges, attack chains, change logs, page
     snapshots, and nmap scans + machines. Every collaboratively-edited
     text field (page title, slug, node label, etc.) is a `Y.Text` keyed
     `<entity>:<id>:<field>`, so two users typing in the same field merge
     character-by-character.
   - Maintains **per-page Y.Docs** for the markdown body, cached in
     IndexedDB so editors render instantly and sync in the background.
   - Awareness pushes `{ id, name, color }` per user, rendered as live
     carets and a presence row.

When a user drags a node, edits a page, or imports an nmap XML, the change
is written to the appropriate Yjs structure → broadcast over the WS → all
other peers' Zustand stores re-derive their UI from the merged doc state.
Auth and admin actions go through normal REST.

---

## Tech stack

### Client
- **Vite 8** + **React 19** + **TypeScript strict**
- **Milkdown 7 (Crepe)** + `@milkdown/plugin-collab` for the page editor
- **@xyflow/react 12** for the graph canvas (with `dagre` for auto-layout)
- **Yjs 13** + **y-websocket 2** + **y-prosemirror 1** + **y-indexeddb 9**
- **Zustand 5** for app state
- **Tailwind CSS 4** + **Radix UI** primitives + **lucide-react** icons
- **cmdk** command palette, **JSZip** export bundles, **date-fns** timestamps
- **Vitest 4** unit tests

### Server (`server/`)
- **Bun 1.3** runtime (uses `bun:sqlite`)
- Plain `node:http` + `ws.WebSocketServer`
- `y-websocket/bin/utils.setupWSConnection` for every Yjs room
- **`y-leveldb`** for durable Yjs persistence (enabled via `YPERSISTENCE`)
- PBKDF2-SHA256 password hashing, HMAC-SHA256 signed bearer tokens

### Packaging / deployment
- **Docker** + **docker compose** (multi-stage `Dockerfile`)
- Single image serves API + WebSocket + static client on one port
- Persistent SQLite + Yjs LevelDB volume at `/data`
- `Start-BTCT.ps1` + `Install-BTCTShortcut.ps1` → one-click desktop launcher
- `Backup-BTCT.ps1` + `Restore-BTCT.ps1` → volume-level backup/restore
- `Publish-BTCT.ps1` (Windows) → tags + pushes to GitHub
- `update-btct` (Linux) → fetches the tag, rebuilds the container

---

## Repository layout

```
src/
  api/                REST client for the auth server
  auth/               Auth store + login screen
  components/
    editor/           Milkdown page editor + floating format panel
    graph/            React Flow canvas, custom nodes/edges, palette
    findings/         AttackTimeline, FindingsCollector
    nmap/             Drag-drop import + per-machine view
    sidebar/          Left tree, right properties + backlinks + change log
                      + page history + last-edited badges
    ui/               TabBar, SplitContainer, MainContent, CommandPalette
  db/                 Repository layer over the shared Yjs doc, including
                      pageSnapshotRepo (page-body version history)
  export/             Markdown / GraphML / lossless workspace zip exporters
  lib/                Pathfinding, dagre layout, nmap parser, helpers
  realtime/           Shared doc, per-page providers, presence,
                      page-snapshots module (capture/restore)
  stores/             Zustand store + Yjs ↔ store bindings
                      (includes restoreFromLog action)
  test/               Vitest suites + fixtures
  types/              Shared TypeScript types
server/
  index.mjs           HTTP + WS entry
  auth.mjs            PBKDF2 + HMAC token helpers
  db.mjs              bun:sqlite user table
Dockerfile               Multi-stage build (client → server-deps → runtime)
docker-compose.yml       Single-container deployment
Start-BTCT.ps1           One-click launcher (Docker + browser)
Install-BTCTShortcut.ps1 Drops a Desktop shortcut to the launcher
Backup-BTCT.ps1          Tar the btct-data volume to a timestamped .tgz
Restore-BTCT.ps1         Restore a .tgz back into the volume
Publish-BTCT.ps1         Windows release script (auto-bumps patch tag)
```

---

## One-click launcher (Windows)

After the first-time setup below, the app launches via a Desktop
shortcut. To install:

```powershell
.\Install-BTCTShortcut.ps1
```

That creates a `Been There, Conquered That` shortcut on your Desktop.
Double-clicking it runs [`Start-BTCT.ps1`](Start-BTCT.ps1), which:

1. Starts Docker Desktop if it isn't already running.
2. Generates a `.env` with a fresh `AUTH_SECRET` on first launch.
3. `docker compose up -d` (no-op if already running).
4. Polls `/healthz` until the server answers.
5. Opens http://localhost:8080 in your default browser.

Pass `-Update` to either script to also `git pull` and rebuild before
starting (slower; only needed when you actually want a new version):

```powershell
.\Start-BTCT.ps1 -Update
.\Install-BTCTShortcut.ps1 -Update   # makes every click an updating click
```

---

## What persists (and what doesn't)

All your data lives in a single named Docker volume, `btct-data`, mounted
at `/data` inside the container:

| Data                                                          | Path inside container | Survives `up -d --build` |
| ------------------------------------------------------------- | --------------------- | ------------------------ |
| User accounts (passwords, admin flag, color)                  | `/data/data.sqlite`   | ✅                       |
| Notes, pages, graphs, attack chains, nmap scans (Yjs LevelDB) | `/data/yjs/`          | ✅                       |
| Activity log (every change, with author + timestamp)          | `/data/yjs/`          | ✅                       |
| Page-body version history (point-in-time snapshots)           | `/data/yjs/`          | ✅                       |

So **every code update, image rebuild, or container restart preserves
all of your data.** The only commands that destroy it are:

- `docker compose down -v` (explicitly wipes named volumes)
- Manually `docker volume rm beenthereconqueredthat_btct-data`

Neither `Start-BTCT.ps1`, `Install-BTCTShortcut.ps1`, nor any update flow
ever runs those.

> Yjs persistence is provided by y-leveldb, enabled via the
> `YPERSISTENCE=/data/yjs` env var on the server. Without it, the
> server would hold rooms only in memory and rely on clients to re-seed
> from their IndexedDB cache — fragile across restarts. With it, the
> server is the source of truth on disk.

---

## Backups & restore

True full-volume backup that captures every byte in `/data` (users,
notes, snapshots, everything):

```powershell
# Snapshot the live volume to a timestamped .tgz under ./backups
.\Backup-BTCT.ps1

# Tag the snapshot for context (recommended before risky operations)
.\Backup-BTCT.ps1 -Tag "before-import"
```

Restore (destructive — wipes current contents, prompts for confirmation):

```powershell
.\Restore-BTCT.ps1 -ArchivePath .\backups\btct-backup-20260521-031530.tgz
```

The restore script stops the container, replaces the volume contents
with the archive's, and brings the container back up. Pass `-Force` to
skip the "type `restore` to continue" prompt.

Schedule periodic backups with Windows Task Scheduler — point it at
`pwsh.exe -File C:\path\to\Backup-BTCT.ps1` on whatever cadence makes
sense (nightly is a sensible default for active engagements).

---

## Edit history & rollback

BTCT records who did what to every entity in your workspace, and lets
you roll back specific actions. There are two complementary systems:

### Activity log (who edited what, when)

Every create / update / delete on a workspace, page, graph, node, edge,
or attack chain writes a `changeLogs` entry into the shared Yjs doc
with:

- **Author** — the userId/username/color of whoever made the change,
  captured at write time so the history survives a user being renamed
  or removed.
- **Timestamp** — millisecond epoch.
- **Field-level delta** — for updates that touch a single named field
  (page title, node label, edge label, attack-chain name), the previous
  and new values are stored verbatim. That delta is what makes the
  entry reversible.
- **Full entity snapshot** — for deletes, the full prior JSON of the
  entity is stored so it can be re-created with all child references
  intact.

The activity log surfaces in two places:

1. **Right sidebar → History panel** — a real-time feed of every change
   in the active workspace, newest first. Each entry shows the author's
   color dot + name, a human-readable summary (e.g. `Renamed node "web01"
   → "web01.corp"`), and how long ago it happened.
2. **`Last edited by X · Tm ago` badge** — appears in the right sidebar
   when a node, edge, or page is selected. Shows the most recent author
   to touch that specific entity.

### Restore from history

Reversible entries (single-field updates with captured prev/new, and
deletes with the full prior JSON) get a **Restore** button next to them
in the History panel. Clicking it:

- For **updates**: re-applies the previous value of the changed field.
- For **deletes**: re-creates the entity from the captured snapshot,
  reusing the original ID so other entities (graph nodes pointing to a
  page, attack chains referencing a node) keep resolving cleanly.

Restores themselves are recorded as `restore` action entries for full
audit traceability.

### Page version history (body snapshots)

Long-form page bodies live in their own per-page Yjs doc, separate from
the metadata in the shared doc. The activity log only sees high-level
events for these ("Updated page content"), so page bodies have a
dedicated **Page Versions** panel in the right sidebar (visible when a
page tab is active). It shows two kinds of snapshots:

- **Auto-saved snapshots** — captured automatically ~2 minutes after
  the last keystroke. Up to the 20 most-recent auto snapshots per page
  are kept; older autos are pruned as new ones land.
- **Named versions** — typed a label into the input and clicked **Save**.
  Never pruned automatically.

Each snapshot stores the full `Y.encodeStateAsUpdate(pageDoc)` bytes
(base64) — that's the whole CRDT state, including formatting marks and
collab history. Restoring a snapshot:

1. Decodes the bytes into a throwaway Y.Doc.
2. Deep-clones its `prosemirror` XML fragment.
3. Atomically replaces the live page doc's body with the clone inside
   one Yjs transaction.

Because the swap is one transaction, every connected collaborator sees
the same rollback in real time. The previous live state is left in the
Yjs update log on disk — restoring is non-destructive in the CRDT sense.

---

## Lossless workspace export & import

The **Full Workspace → ZIP** button (Export / Import dialog) writes
every entity tied to the active workspace into a single zip, including:

- `workspace.json`, `pages.json`, `graphs.json`, `graphNodes.json`,
  `graphEdges.json`, `attackChains.json`, `nmapScans.json`,
  `nmapMachines.json`, `changeLogs.json`, `pageSnapshots.json`
- `pageYjsUpdates.json` — per-page `Y.encodeStateAsUpdate(pageDoc)`
  bytes (base64) for true CRDT-level body roundtrip
- Human-readable companion outputs: `pages/<title>.md`,
  `graphs/<name>.graphml`
- `manifest.json` — schema version + counts

On import you choose:

- **Import as new** (default): if the workspace ID already exists,
  generates a fresh workspace ID and remaps `workspaceId` on every
  child entity. Child entity IDs stay the same when they don't collide
  with anything in another workspace, so internal references survive.
- **Replace existing**: wipes the existing workspace's entities first,
  then re-imports with original IDs. Destructive — use when you really
  do mean "restore this workspace from this zip."

For full-system backups (users + all workspaces + everything else),
use [`Backup-BTCT.ps1`](#backups--restore) instead — the in-app zip is
per-workspace and excludes the SQLite users DB.

---

## Run locally on Windows with Docker Desktop

This is the simplest path: one container, one command, persistent data.

### Prerequisites
- **Docker Desktop for Windows** (with WSL2 backend) — installed and running
- **Git for Windows**
- **PowerShell 7+** (the built-in Windows PowerShell 5 also works)

### First-time setup

```powershell
# 1. Clone
git clone https://github.com/<you>/BeenThereConqueredThat.git
cd BeenThereConqueredThat

# 2. Install the Desktop shortcut (also generates .env on first launch).
.\Install-BTCTShortcut.ps1

# 3. Double-click the new "Been There, Conquered That" shortcut on your
#    Desktop. First launch builds the image (couple of minutes).
```

Default bootstrap admin:
- **Username:** `admin`
- **Password:** `changeme!`

Change it immediately from the in-app admin panel. (Override the
defaults by setting `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`
*before* the very first start.)

### Useful commands

```powershell
docker compose logs -f            # tail server logs
docker compose ps                 # container status
docker compose restart            # restart without rebuild
docker compose down               # stop (data volume preserved)
docker compose down -v            # stop AND wipe the SQLite + Yjs volume
docker compose up -d --build      # apply code changes
```

Inspect the data volume:
```powershell
docker run --rm -it -v beenthereconqueredthat_btct-data:/data alpine ls -la /data
```

### LAN access from teammates
The compose file binds `8080` on all interfaces, so any machine on your
LAN can hit `http://<your-windows-ip>:8080`. Allow it through Windows
Defender Firewall (TCP 8080 inbound) the first time someone connects.

### Dev mode (hot reload, without Docker)
For Vite HMR during active development, run the two processes directly:

```powershell
bun install
bun install --cwd server

# Terminal 1 — server
cd server
$env:AUTH_SECRET = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
$env:ALLOWED_ORIGIN = 'http://127.0.0.1:5173'
$env:YPERSISTENCE = '../data/yjs'   # local dev persistence; safe to delete
bun run start

# Terminal 2 — client
bun run dev
```

Then open http://127.0.0.1:5173.

---

## Releases

### Push a release to GitHub (Windows)

The `Publish-BTCT.ps1` script auto-bumps the patch version of the latest
`vMAJOR.MINOR.PATCH` tag. Pass `-Tag` only to override (e.g. cut a minor/major
bump).

```powershell
# Auto-bump patch from the latest tag (most common case)
.\Publish-BTCT.ps1 -Message "Add foo and fix bar"

# Explicit override for a minor or major bump
.\Publish-BTCT.ps1 -Message "Big rewrite" -Tag v0.4.0
```

What it does:
1. `git fetch --tags` so the bump is based on the real latest tag.
2. Finds the highest `vMAJOR.MINOR.PATCH` tag and bumps patch by 1
   (or starts at `v0.1.0` if there are none).
3. `git add -A` and commits the staged changes (skips if nothing to stage).
4. `git push origin main`.
5. `git tag -fa <tag>` and `git push origin <tag> --force`.
6. Prints the matching `update-btct <tag>` command for the Linux host.

### Deploy / update on a Linux production host

Production runs the same `Dockerfile` + `docker-compose.yml` as your
Windows dev box, just on a Linux server, behind a TLS reverse proxy
(nginx / Caddy / Traefik) for HTTPS termination.

One-time server setup on the Linux host:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git curl
sudo systemctl enable --now docker
sudo usermod -aG docker $USER

sudo mkdir -p /opt/btct
sudo chown $USER:$USER /opt/btct
git clone https://github.com/<you>/BeenThereConqueredThat.git /opt/btct
cd /opt/btct

echo "AUTH_SECRET=$(openssl rand -hex 32)" | sudo tee .env > /dev/null
sudo chmod 600 .env

git fetch --tags
git checkout v0.3.5      # whatever the latest tag is
sudo docker compose up -d --build
```

Install the `update-btct` helper:

```bash
sudo tee /usr/local/bin/update-btct >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/btct}"
TAG="${1:-v0.1.0}"

cd "$APP_DIR"
git fetch --tags --force --prune
git checkout -f "$TAG"
git reset --hard "$TAG"
sudo docker compose down
sudo docker compose up -d --build
sudo docker image prune -f >/dev/null

for i in {1..20}; do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null; then
    echo "[update-btct] healthy ✔  ($(curl -s http://127.0.0.1:8080/healthz))"
    sudo docker compose ps
    exit 0
  fi
  sleep 1
done
echo "[update-btct] healthz never came up; recent logs:" >&2
sudo docker compose logs --tail=80
exit 1
EOF
sudo chmod +x /usr/local/bin/update-btct
```

Update flow each release:

```powershell
# On Windows
.\Publish-BTCT.ps1 -Message "Whatever changed"
# → "[Publish-BTCT] bumping v0.3.5 -> v0.3.6"
```

```bash
# On Linux
update-btct v0.3.6
```

SQLite + Yjs data live in the `btct-data` volume, not in the image, so
they survive every redeploy.

---

## Tests
```powershell
bun install               # one-time
bun run test
```

---

## Security posture

This is a LAN tool for trusted operators. It is NOT hardened for hostile
internet exposure. Known limitations / gaps:

- **Tokens stored in `localStorage`** — XSS in the editor would leak them.
- **No CSRF protection on `/api/*`** beyond bearer-token convention.
- **No rate limiting** on `/api/login` (PBKDF2 is the only brute-force cost).
- **No account lockout, MFA, or self-service password reset.**
- **Yjs WebSocket auth checks the JWT once at upgrade** — revoked accounts
  keep editing until the connection drops.
- **No per-workspace authorisation** — every authenticated user sees every
  workspace.
- **`AUTH_SECRET` defaults to a random ephemeral value** when unset; tokens
  are silently invalidated on restart. Always set it in `.env`.
- **HTTPS / WSS is not built in** — terminate TLS in nginx/Caddy.
- **No CSP / Trusted Types.** Treat untrusted markdown as untrusted.

Threat model: trusted teammates on a LAN segment during an engagement.
Anything beyond that needs additional work.

## License

Internal tooling — not licensed for redistribution.
