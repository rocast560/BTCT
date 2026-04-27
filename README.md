# SYNote

A LAN-hosted, multi-user, real-time collaborative note-taking and attack-path
graphing app for penetration testing engagements. Notion-style pages, an
attack-narrative graph canvas, and live Google-Docs-style co-editing across
every machine on the LAN.

---

## How it works

SYNote is two cooperating processes packaged into one Docker image:

1. **Bun HTTP/WebSocket server** (`server/`)
   - Serves a REST API for auth (`/api/login`, `/api/me`, admin routes).
   - Serves the built Vite client (`STATIC_DIR=/app/dist`) on the same port.
   - Hosts a Yjs WebSocket endpoint at `/yjs/<roomname>?token=<jwt>` that
     proxies clients into shared CRDT documents via
     `y-websocket/bin/utils.setupWSConnection`.
   - Stores users in `bun:sqlite` at `/data/data.sqlite`. Passwords are
     PBKDF2‑SHA256 (200 000 iterations); session tokens are HMAC‑SHA256.

2. **Vite/React client** (`src/`)
   - Loads, authenticates against `/api/login`, then opens a WebSocket
     connection to `/yjs/...` for live collaboration.
   - Maintains **one shared Yjs doc** (`alysa-shared`) holding workspaces,
     pages, graphs, nodes, edges, attack chains, change logs, and nmap
     scans + machines. Every collaboratively-edited text field
     (page title, slug, node label, etc.) is a `Y.Text` keyed
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
- PBKDF2-SHA256 password hashing, HMAC-SHA256 signed bearer tokens

### Packaging / deployment
- **Docker** + **docker compose** (multi-stage `Dockerfile`)
- Single image serves API + WebSocket + static client on one port
- Persistent SQLite volume at `/data`
- `Publish-Alysa.ps1` (Windows) → tags + pushes to GitHub
- `update-synote` (Linux) → fetches the tag, rebuilds the container

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
    ui/               TabBar, SplitContainer, MainContent, CommandPalette
  db/                 Repository layer over the shared Yjs doc
  export/             Markdown / GraphML / bundle / zip exporters
  lib/                Pathfinding, dagre layout, nmap parser, helpers
  realtime/           Shared doc, per-page providers, presence
  stores/             Zustand store + Yjs ↔ store bindings
  test/               Vitest suites + fixtures
  types/              Shared TypeScript types
server/
  index.mjs           HTTP + WS entry
  auth.mjs            PBKDF2 + HMAC token helpers
  db.mjs              bun:sqlite user table
Dockerfile            Multi-stage build (client → server-deps → runtime)
docker-compose.yml    Single-container deployment
Publish-Alysa.ps1     Windows release script
```

---

## Run locally on Windows with Docker Desktop

This is the simplest path: one container, one command, persistent data.

### Prerequisites
- **Docker Desktop for Windows** (with WSL2 backend) — installed and running
- **Git for Windows**
- **PowerShell 7+** (the built-in Windows PowerShell 5 also works)

### 1. Clone the repo
```powershell
git clone https://github.com/<you>/AlysaFramework.git
cd AlysaFramework
```

### 2. Create your `.env`
The container refuses to start without `AUTH_SECRET`. Generate one and
write it to `.env` (docker compose reads it automatically):
```powershell
$secret = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
"AUTH_SECRET=$secret" | Out-File -FilePath .env -Encoding ascii
```

### 3. Build and start
```powershell
docker compose up -d --build
```
First build takes a few minutes (Bun installs deps + Vite builds the
client). After that, restarts are seconds.

### 4. Open the app
http://localhost:8080

Default bootstrap admin:
- **Username:** `admin`
- **Password:** `changeme!`

Change it immediately from the in-app admin panel. (Override the
defaults by setting `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` *before*
the very first start.)

### 5. Useful commands
```powershell
docker compose logs -f            # tail server logs
docker compose ps                 # container status
docker compose restart            # restart without rebuild
docker compose down               # stop (data volume preserved)
docker compose down -v            # stop AND wipe the SQLite volume
docker compose up -d --build      # apply code changes
```

The SQLite database lives in the named Docker volume `alysa-data` and
survives container rebuilds. Inspect it with:
```powershell
docker run --rm -it -v alysaframework_alysa-data:/data alpine ls -la /data
```

### 6. (Optional) LAN access from teammates
The compose file binds `8080` on all interfaces, so any machine on your
LAN can hit `http://<your-windows-ip>:8080`. Allow it through Windows
Defender Firewall (TCP 8080 inbound) the first time someone connects.

### Dev mode (hot reload, without Docker)
If you want Vite HMR for active development, run the two processes
directly instead of in Docker:
```powershell
bun install
bun install --cwd server

# Terminal 1 — server
cd server
$env:AUTH_SECRET = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
$env:ALLOWED_ORIGIN = 'http://127.0.0.1:5173'
bun run start

# Terminal 2 — client
bun run dev
```
Then open http://127.0.0.1:5173.

---

## Push a release to GitHub (Windows)

The `Publish-Alysa.ps1` script handles staging, committing, pushing, and
tagging in one go.

```powershell
.\Publish-Alysa.ps1 -Tag v0.3.5 -Message "Add foo and fix bar"
```

What it does:
1. Validates the tag matches `vMAJOR.MINOR.PATCH`.
2. `git add -A` and commits the staged changes (skips if nothing to stage).
3. `git push origin main`.
4. `git tag -fa <tag>` and `git push origin <tag> --force` (so re-publishing
   the same version overwrites the old tag).
5. Prints the matching `update-synote <tag>` command for the Linux host.

> Bump the tag every release (e.g. `v0.3.5` → `v0.3.6`). The Linux side
> uses the tag to know what to deploy.

---

## Deploy / update on a Linux production host

Production runs the same `Dockerfile` + `docker-compose.yml` as your
Windows dev box, just on a Linux server, behind a TLS reverse proxy
(nginx / Caddy / Traefik) for HTTPS termination.

### One-time server setup
On the Linux host (Debian/Ubuntu/Kali example):

```bash
# Docker engine + compose plugin
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git curl
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # log out/in to take effect

# Clone the repo to /opt/synote
sudo mkdir -p /opt/synote
sudo chown $USER:$USER /opt/synote
git clone https://github.com/<you>/AlysaFramework.git /opt/synote
cd /opt/synote

# Create /opt/synote/.env with a real AUTH_SECRET
echo "AUTH_SECRET=$(openssl rand -hex 32)" | sudo tee .env > /dev/null
sudo chmod 600 .env

# First boot — checkout a release tag and build
git fetch --tags
git checkout v0.3.5      # whatever the latest tag is
sudo docker compose up -d --build
```

Verify it's healthy:
```bash
curl -s http://127.0.0.1:8080/healthz   # → {"ok":true}
sudo docker compose ps
```

Then put nginx/Caddy in front and point `:443` at `127.0.0.1:8080`.

### Install the `update-synote` helper
This one-liner script automates "fetch tag → rebuild container → wait
for healthz" so updates are a single command.

```bash
sudo tee /usr/local/bin/update-synote >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/synote}"
TAG="${1:-v0.1.0}"

cd "$APP_DIR"
echo "[update-synote] fetching tags…"
git fetch --tags --force --prune
echo "[update-synote] checking out $TAG"
git checkout -f "$TAG"
git reset --hard "$TAG"

echo "[update-synote] rebuilding container…"
sudo docker compose down
sudo docker compose up -d --build
sudo docker image prune -f >/dev/null

echo "[update-synote] waiting for healthz…"
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null; then
    echo "[update-synote] healthy ✔  ($(curl -s http://127.0.0.1:8080/healthz))"
    sudo docker compose ps
    exit 0
  fi
  sleep 1
done
echo "[update-synote] healthz never came up; recent logs:" >&2
sudo docker compose logs --tail=80
exit 1
EOF
sudo chmod +x /usr/local/bin/update-synote
```

### Update flow (every release)

On Windows:
```powershell
.\Publish-Alysa.ps1 -Tag v0.3.6 -Message "Whatever changed"
```

On Linux:
```bash
update-synote v0.3.6
```

The script pulls the new tag, rebuilds the image (with layer cache reuse),
drops the old container, brings up the new one, and waits for `/healthz`
to confirm it's serving. SQLite data is untouched — it lives in the
`alysa-data` volume, not in the image.

### Manual rollback
```bash
update-synote v0.3.5     # just point at the previous tag
```

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
