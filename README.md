# Been There, Conquered That (BTCT)

A LAN-hosted, multi-user, **real-time collaborative** note-taking and attack-path
graphing app for penetration-testing engagements. It combines Notion-style
pages, an attack-narrative graph canvas, nmap import, findings/timeline
reporting, and Google-Docs-style live co-editing across every machine on the LAN
— all from a single Docker container.

> **New here?** Jump to the [Feature tour](#feature-tour) for what it does, the
> [Keyboard shortcuts](#keyboard-shortcuts--gestures) for how to drive it fast,
> or [Run locally](#run-locally-on-windows-with-docker-desktop) to get it up.
>
> **AI agent / new contributor working on the code?** Start at
> [Architecture & internals](#architecture--internals-for-developers--llms) —
> it's written to be your onboarding doc: the mental model, the data model,
> every key file, the non-obvious invariants, and "how to extend X" recipes.

---

## Table of Contents

- [Feature tour](#feature-tour)
  - [Pages & the markdown editor](#pages--the-markdown-editor)
  - [Typst documents (local typesetting)](#typst-documents-local-typesetting)
  - [Attack-narrative graph](#attack-narrative-graph)
  - [Recon & reporting (nmap, findings, timeline)](#recon--reporting-nmap-findings-timeline)
  - [AI assistant (Claude)](#ai-assistant-claude)
  - [MCP server (connect an external client)](#mcp-server-connect-an-external-client)
  - [Real-time collaboration](#real-time-collaboration)
  - [Workspaces, navigation & layout](#workspaces-navigation--layout)
  - [Edit history & versioning](#edit-history--versioning)
  - [Export & import](#export--import)
  - [Accounts, roles & settings](#accounts-roles--settings)
- [Keyboard shortcuts & gestures](#keyboard-shortcuts--gestures)
- [How it works (runtime)](#how-it-works-runtime)
- [Tech stack](#tech-stack)
- [Architecture & internals (for developers & LLMs)](#architecture--internals-for-developers--llms)
  - [The mental model](#the-mental-model)
  - [The two-tier Yjs/CRDT design](#the-two-tier-yjscrdt-design)
  - [Data model](#data-model)
  - [Data layer: database, repos, stores](#data-layer-database-repos-stores)
  - [Editor internals](#editor-internals)
  - [Server & HTTP API reference](#server--http-api-reference)
  - [Key files map](#key-files-map)
  - [Conventions & invariants (read before changing anything)](#conventions--invariants-read-before-changing-anything)
  - [Recipes: how to extend](#recipes-how-to-extend)
- [Repository layout](#repository-layout)
- [Run locally on Windows with Docker Desktop](#run-locally-on-windows-with-docker-desktop)
- [One-click launcher (Windows)](#one-click-launcher-windows)
- [What persists (and what doesn't)](#what-persists-and-what-doesnt)
- [Backups & restore](#backups--restore)
- [Releases & production deploy](#releases--production-deploy)
- [Tests](#tests)
- [Security posture](#security-posture)
- [License](#license)

---

## Feature tour

### Pages & the markdown editor

Pages are Notion-style documents with a title, an editable `/slug` path, tags,
and an optional icon. They live in a nestable tree (drag a page onto another to
re-parent it; a cycle guard stops you dropping a parent into its own child).

The body is a **live-preview markdown editor** ([Milkdown](https://milkdown.dev)
+ Crepe — Obsidian-style): you type markdown and it renders inline as you go.

- **Block syntax** — `# ` … `###### ` headings, `- ` / `1. ` lists, `- [ ]`
  task lists (click to toggle), `> ` quotes, `|` tables, `---` rules, `![](url)`
  images, `[text](url)` links.
- **Slash menu** — type `/` to open Crepe's block-insert menu (Heading, lists,
  quote, **Code**, table, image, …). Inserting **Code** defaults the new block
  to the `shell` language.
- **Inline formatting** — `**bold**`, `*italic*`, `~~strike~~`, and inline code.
  Select text and press **`` ` ``** to wrap the selection as inline code (or type
  `` `x` `` to convert as you type).
- **Floating format panel** — appears whenever you select text. Buttons for
  bold / italic / strikethrough / inline-code / link, block conversions
  (H1–H3, bullet/numbered list, quote), and a **7-color highlighter** (yellow,
  green, blue, pink, orange, purple, red) + a clear button. A gear/keyboard icon
  opens the **Keybinds** dialog. *Highlight marks are session-only* — they're an
  annotation aid and are intentionally stripped when the page is saved (CommonMark
  has no highlight syntax), so the saved markdown stays portable.
- **Code blocks** — full syntax highlighting via CodeMirror using the **GitHub
  Dark** palette. Click the language button to pick a language; or press
  **Ctrl+Shift+L** inside a block to jump to the picker and **arrow-key** through
  it (Enter selects, Esc closes). New code blocks default to `shell`.
- **Notion-style block selection** — tap **Esc twice** to leave text editing and
  select whole blocks. Then **↑/↓** to move, **Shift+↑/↓** to multi-select,
  **Backspace/Delete** to delete the selected block(s), **Ctrl/⌘+A** to select
  all, **Enter** to edit the focused block, **Esc/click** to exit.
- **Per-account personalization** — each account can rebind the editor shortcuts
  (Keybinds dialog) and choose a **code accent** color that retints code-block
  keywords. Both follow your account (stored server-side) and apply live.
- **Backlinks** — for a graph-linked page, the right sidebar lists the graph
  nodes and edges that reference it. (Note: there's no `[[wikilink]]` syntax;
  use standard markdown links.)
- **Graph-linked pages** — pages auto-created for graph nodes show structured
  property editors inline (host/service/finding/pivot fields, see below) plus a
  "Connected nodes" list and a "Narrative" button back to the canvas.

### Typst documents (local typesetting)

The Pages section has a dedicated **Typst** tab — a [typst.app](https://typst.app)-style
split view for the [Typst](https://typst.app) typesetting language, **compiled and
rendered entirely in the browser** (no calls to typst.app or any remote service):

- **Side-by-side editor + preview** — the raw Typst source in a collaborative
  CodeMirror editor on the left, the live-rendered document (SVG) on the right.
  Drag the divider to resize, or hit the **Code** toggle to hide the editor and
  see the preview full-width. Zoom the preview in/out.
- **Local WebAssembly compiler** — bundled [`typst.ts`](https://github.com/Myriad-Dreamin/typst.ts)
  (compiler + renderer wasm) ships with the app, and the default Typst font set
  is embedded in the compiler, so it renders **fully offline / air-gapped** — no
  internet needed during an engagement.
- **Live errors** — Typst compile diagnostics (with `file:line` ranges) surface
  in a banner while the last good render stays on screen, so a transient typo
  doesn't blank the preview.
- **Collaborative source** — the Typst source is a per-workspace `Y.Text` in the
  shared doc, so it's character-by-character co-edited (with remote carets) and
  persisted exactly like every other field in BTCT. One Typst scratchpad per
  workspace; open it from the **Pages** sidebar, the command palette
  (*Open Typst Document*), or `Ctrl/⌘+K`.
- **Export** — one-click **PDF** and **SVG** export of the compiled document.

### Attack-narrative graph

Each **Attack Narrative** is a graph canvas ([React Flow](https://reactflow.dev))
for modeling an engagement's attack path.

- **Node types** — Host, Credential, Service, Finding, Pivot. Drag from the
  palette (top) or right-click the canvas → *Add Node*. Each carries structured
  data:
  - **Host**: hostname, IP, OS, open ports
  - **Credential**: username, secret, source
  - **Service**: name, version, port, CVEs
  - **Finding**: title, severity (critical→info), CVSS + vector, likelihood,
    impact, description, business impact, exploit steps, MITRE ATT&CK / mitigation,
    remediation, affected hosts, references
  - **Pivot**: description
- **Edges** — drag handle-to-handle to connect; typed as AdminTo, HasSession,
  MemberOf, Exploits, PivotsTo, or Custom. Double-click an edge label to rename;
  changing the type resets the label to match.
- **Every node has a page** — double-click a node to open its linked write-up
  page; node properties and the page's inline editors stay in sync.
- **Node search** — **Ctrl/⌘+F** fuzzy-searches across all node fields; **↑/↓**
  to navigate, **Enter** to zoom to the node.
- **Pathfinding** — select two nodes and **Highlight Path** (BFS shortest path),
  or right-click → *Set as Path Start* / *Set as Path End*. Highlighted edges get
  gold marching-ants; nodes pulse.
- **Attack chains** — select 2+ nodes → right-click → *Add to Attack Chain*
  (new or existing). Chains are ordered by canvas position, listed in the
  sidebar, get an auto-created write-up page, and can be highlighted (red) on the
  canvas.
- **Auto-layout** — dagre hierarchical layout with adjustable node/rank/edge
  spacing.
- **Export** — high-resolution **PNG** of the canvas, plus GraphML/JSON (see
  [Export & import](#export--import)). Viewport (pan/zoom) is cached per graph so
  switching tabs preserves position.
- **Nmap link** — Host nodes can bind to an imported nmap machine; hostname and
  open ports sync between them, and a *Go to Nmap* action jumps across.

### Recon & reporting (nmap, findings, timeline)

- **Nmap import** — create a scan group in the sidebar, then drag-drop (or pick)
  one or more nmap **XML** files. The parser extracts host IP, hostname, OS
  (osmatch/osclass with a port-signature fallback), and per-port service/version/
  script output, skipping hosts that are down. Re-importing the same IP merges
  ports. Each machine has an editable, collaboratively-synced hostname and an OS
  dropdown; machines can be linked to Host nodes (with port sync).
- **Findings Collector** — aggregates every Finding node across all narratives in
  the workspace, grouped by severity and sorted by CVSS, with a summary bar.
  Click to open the finding's page; **Shift+click** to focus it on its graph.
- **Attack Timeline** — every node across the workspace ordered by its
  `discoveredAt` time, grouped by day, with type/narrative filters and each
  node's incoming edges shown as lineage. **Copy as Markdown** exports the whole
  timeline as a hierarchical outline.

### AI assistant (Claude)

A built-in Claude assistant that can read — and, when allowed, edit — your live
workspace, so you can explore a network and have it document findings as you go.

- **Admin-configured, key stays server-side.** An admin opens **Admin panel →
  Claude AI Assistant** to paste an **Anthropic API key** (write-only: the server
  never returns it — you only see *Connected ✓ / Not configured*), pick a
  **mode**, set the **model** (default `claude-opus-4-8`), toggle **Enabled**, and
  **Test** the connection. The key is stored in the SQLite `settings` table and
  never reaches the browser or the JS bundle.
- **View vs Edit mode** (global, admin-set). **View** = read/analyze only.
  **Edit** = also create/update pages, attack-narrative graphs, nodes, edges,
  findings, and link nmap hosts to nodes. Write tools are only exposed — and are
  re-checked server-side — in Edit mode. There are no delete tools.
- **What it can see/do** (tools run in-process against the live shared CRDT, so
  edits appear on everyone's canvas instantly and are recorded in the change log):
  read pages/search, list & read attack-narrative graphs (nodes + edges),
  findings (severity/CVSS), and nmap scans (hosts, open ports, service/version,
  NSE script output); and in Edit mode **create a new attack narrative**, spawn
  host/service/credential/finding/pivot **nodes**, connect them with **edges**,
  add **findings**, create pages, and turn a scanned nmap host into a linked graph
  node. Great for "read the latest scan, tell me what to hit first, then document
  it in the graph."
- **It's a normal tab/pane view.** Open it from the **left sidebar → Claude
  Assistant**, the **command palette** (*Ask Claude*), or **`Mod+Shift+A`**. Like
  Findings and the Attack Timeline it's a tab, so you can **split it into its own
  pane**, move it between panes, or full-screen it.
- **Live markdown replies with syntax highlighting.** Responses stream
  token-by-token and render as markdown (headings, lists, tables, code) — batched
  per animation frame so long, table-heavy answers stay fast and readable. Code
  blocks are syntax-highlighted (shiki, many languages, grey theme).
- **Durable chat history (per account).** Conversations are saved server-side per
  user, so a chat **survives closing the Claude pane and refreshing the browser**,
  and follows you across browsers/devices. **`+ New chat`** starts a fresh one and
  the **History** switcher revisits, renames, or deletes past sessions (auto-titled
  from your first message). Sessions store the plain conversation turns, so
  reopening one and continuing keeps full context. Endpoints: `GET/POST/DELETE
  /api/ai/sessions[/:id]` (each scoped to the caller's account).
- **Usage vs config.** Any signed-in user can chat with the assistant; only admins
  configure the key/mode/model. Endpoints: `GET/POST /api/ai/config` (config;
  POST is admin-only) and `POST /api/ai/chat` (SSE stream) — see the
  [API reference](#server--http-api-reference).

### MCP server (connect an external client)

BTCT can expose itself as a **hosted MCP (Model Context Protocol) server** so an
external MCP client — e.g. the **Claude Code CLI** — can read (and, if allowed,
write) all your workspace context: pages, attack-narrative graphs, attack chains,
findings, the attack timeline, nmap scans/hosts, users, and the change log.

- **Admin-configured, like the API key.** **Admin panel → MCP Server**: enable it,
  toggle **Edit permissions** (Read-only vs Edit), and copy the generated **access
  token** (Reveal / Copy / Regenerate). The token is stored server-side and is the
  bearer the client authenticates with.
- **Streamable HTTP at `POST /mcp`.** Stateless MCP over HTTP; auth is the bearer
  token, checked with a constant-time compare. Read tools are always exposed; write
  tools (create/update pages, graphs, nodes, edges, findings; nmap→node linking)
  appear only in **Edit** mode — reconnect the client after toggling to pick up the
  new tool set. It reuses the same tool catalog as the in-app assistant, so both
  stay in sync.
- **Scoping:** read tools return context across all workspaces; `list_users`
  returns usernames/colors/roles only (never password hashes). Treat the token like
  a password; **Regenerate** rotates it.

**Connect & check from the Claude Code CLI**

First get the token: Admin panel → **MCP Server** → **Enable** → **Reveal/Copy**
(or copy the pre-filled connect command). Then, in a terminal:

```bash
# 1. Register BTCT as an MCP server. Use localhost if the CLI is on the same
#    machine as the container; otherwise use the host's LAN IP (e.g. 192.168.x.x).
claude mcp add --transport http btct http://localhost:8080/mcp \
  --header "Authorization: Bearer <your-token>"
#    Add --scope user to make it available in every project (default: this project only).

# 2. Confirm it's registered and connected (look for a ✓ / "Connected").
claude mcp list
claude mcp get btct

# 3. Start a session and inspect the server + its tools from inside it.
claude
#    then run the /mcp slash command in the session to see status + tool list.

# Rotate the token or fix a bad connection: remove and re-add.
claude mcp remove btct
#    ...then re-run the `claude mcp add` command above with the current token.
```

Then just ask in plain language — Claude calls the tools automatically, e.g.
*"Using the btct server, list my workspaces and their findings"* or *"show the hosts
in the latest nmap scan."* Tools appear namespaced as `mcp__btct__list_workspaces`,
`mcp__btct__get_graph`, etc. **Read** tools always work; **write** tools require
**Edit** mode — after toggling Read↔Edit in the admin panel, reconnect
(`claude mcp remove btct` + re-add, or restart the session) so the CLI re-fetches
the tool list.

**Troubleshooting:** if `claude mcp list` shows the server failed to connect, check
that MCP is **Enabled** in the admin panel, that the **token** matches
(Regenerate invalidates old ones), and that the **URL/port** is reachable
(`curl -s -o /dev/null -w "%{http_code}" -X POST <origin>/mcp` → `401` means the
endpoint is up and rejecting an unauthenticated request, which is expected).

### Real-time collaboration

Everything is live and multi-user over the LAN:

- **Character-by-character merge** on every text field (page title/slug, node &
  edge labels, workspace/graph/scan names, nmap hostnames, chain names) — two
  people typing in the same field never clobber each other (Yjs `Y.Text` CRDTs).
- **Live page co-editing** with remote carets and name tags (Google-Docs style),
  backed by a per-page CRDT document and Milkdown's collab plugin.
- **Presence & follow** — each user broadcasts `{ id, name, color }` plus their
  current view. Press **`Mod+Shift+U`** (or the command palette → *Active Users /
  Follow*) to open the active-users window and **follow** a teammate: your view
  live-mirrors theirs — jumping to the graph node they select, scrolling to their
  text caret, or opening the nmap host they're inspecting. If you have split panes
  the first follow asks whether to drop the view into a pane or take over; per-
  teammate **precision** (jump to their exact spot vs. just open their view) is set
  in **Profile → Following**. Press **Stop** or navigate away to detach.
- **Offline-first** — IndexedDB caches every doc so the UI renders instantly and
  reconciles when the connection returns.

### Workspaces, navigation & layout

- **Workspaces** — create/switch/delete from the sidebar footer; the active
  workspace is remembered across reloads. All pages/graphs/scans/findings are
  scoped to it.
- **Tabs** — open pages, narratives, nmap groups/machines, Findings, Timeline,
  the Typst editor, and the Claude assistant as tabs. Cycle with **←/→**, close
  with **Alt+W**, and the **browser back/forward** buttons walk your tab history.
- **Split panes** — drag a tab to a pane edge (left/right/top/bottom) to split;
  drag the divider to resize; emptying a pane collapses the split automatically.
- **Command palette** — **Ctrl/⌘+K** to create pages/narratives, toggle dark
  mode, or jump to any page/graph by name. (If text is selected in the editor,
  Ctrl/⌘+K instead inserts a link.)
- **Search** — the sidebar search box does live title/tag search over pages.
- **Sidebars** — left = navigation tree (Pages, Attack Narratives, Attack Chains,
  Nmap Scans, plus Findings/Timeline shortcuts); right = context properties
  (node/edge editors, backlinks, "last edited by" badge, change log, page
  versions, export/import).

### Edit history & versioning

Two complementary systems, both stored in the shared CRDT and synced to everyone
— see [Edit history & rollback](#edit-history--versioning-detail) below for the
full mechanics:

- **Activity log** — every create/update/delete/restore on a workspace, page,
  graph, node, edge, or attack chain, with author + timestamp + a reversible
  field delta (or a full entity snapshot for deletes). Surfaced as a feed and as
  per-entity "Last edited by …" badges; reversible entries get a **Restore**
  button.
- **Page version history** — long-form page bodies get auto-snapshots ~2 minutes
  after you stop typing (20 most-recent kept) plus unlimited **named** versions.
  Restoring swaps the body in one CRDT transaction so all collaborators roll back
  together.

### Export & import

- **Markdown** — per page (single `.md` or a `.zip`).
- **GraphML / JSON** — per attack narrative.
- **Lossless workspace ZIP** — the full workspace (every entity as JSON, plus
  per-page raw CRDT state and human-readable `.md`/`.graphml` companions), with
  *import-as-new* (re-IDed) or *replace-existing* modes.
- **Attack-path bundle** — an XML document combining path metadata, a filtered
  GraphML, and the linked write-up pages as markdown.

### Accounts, roles & settings

- **Auth** — username/password login (no self-signup; admins create accounts). A
  bootstrap `admin` account is created on first launch.
- **Admin panel** (admins only) — create/delete users, reset passwords, toggle
  admin (the server blocks deleting yourself or the last admin), configure the
  **Claude AI Assistant** (API key, View/Edit mode, model, enable — see
  [AI assistant](#ai-assistant-claude)), and the **MCP Server** (enable, edit
  permissions, access token — see [MCP server](#mcp-server-connect-an-external-client)).
- **Profile** — your presence **color** and your per-account **code accent**.
- **Theme** (admins only) — the workspace-wide accent color (saved server-side,
  applied to every client). Plus a per-client **dark/light** toggle.

---

## Keyboard shortcuts & gestures

"Mod" = **Ctrl** on Windows/Linux, **⌘** on macOS. Editor shortcuts marked ⚙ are
rebindable per account via the Keybinds dialog (gear icon in the floating format
panel).

| Context | Shortcut / gesture | Action |
| --- | --- | --- |
| Global | `Mod+K` | Command palette (or insert link if text is selected) |
| Global | `Mod+Shift+A` | Open / focus the **Claude assistant** tab |
| Global | `Mod+Shift+U` | Open the **active-users / follow** window |
| Global | `←` / `→` | Cycle tabs in the active pane |
| Global | `Alt+W` | Close active tab |
| Global | Browser back/forward | Navigate tab history |
| Editor | `Mod+B` ⚙ / `Mod+I` ⚙ / `Mod+Shift+X` ⚙ | Bold / Italic / Strikethrough |
| Editor | `Mod+E` ⚙ | Inline code |
| Editor | `Mod+Shift+K` ⚙ | Insert link |
| Editor | `Mod+Shift+H` ⚙ | Highlight (yellow) |
| Editor | `` ` `` around a selection | Wrap selection as inline code |
| Editor | `/` | Slash block-insert menu |
| Editor | **double `Esc`** | Enter block-selection mode |
| Block mode | `↑`/`↓`, `Shift+↑`/`↓`, `Mod+A` | Move / extend / select-all blocks |
| Block mode | `Backspace`/`Delete`, `Enter`, `Esc`/click | Delete / edit / exit |
| Code block | `Mod+Shift+L` ⚙ | Focus language picker |
| Language picker | `↑`/`↓`, `Enter`, `Esc` | Navigate / select / close |
| Graph | `Mod+F` | Node search (↑/↓, Enter to focus) |
| Graph | `Delete` | Delete selected node/edge |
| Graph | double-click node · shift-click · right-click | Open page · multi-select · context menu |
| Nmap | `Ctrl+Shift+click` a machine card | Open machine in a new tab |
| Findings / Timeline | `Shift+click` a row | Focus the node on its graph |

---

## How it works (runtime)

BTCT is two cooperating processes packaged into one Docker image:

1. **Bun HTTP/WebSocket server** (`server/`)
   - REST API for auth (`/api/login`, `/api/me`, `/api/me/profile`, admin routes,
     `/api/settings`) — see the [API reference](#server--http-api-reference).
   - Serves the built Vite client (`STATIC_DIR=/app/dist`) on the same port, with
     SPA fallback to `index.html`.
   - Hosts a Yjs WebSocket endpoint at `/yjs/<roomname>?token=<jwt>` that proxies
     clients into shared CRDT documents via `y-websocket/bin/utils.setupWSConnection`.
     The JWT is verified once at the WS upgrade.
   - Stores users + settings in `bun:sqlite` at `/data/data.sqlite`. Passwords are
     PBKDF2‑SHA256 (200 000 iterations); session tokens are HMAC‑SHA256 (7-day TTL).
   - Persists all Yjs rooms to `/data/yjs/` via LevelDB (`YPERSISTENCE`).

2. **Vite/React client** (`src/`)
   - Authenticates against `/api/login`, then opens WebSockets to `/yjs/...`.
   - Holds **one shared Yjs doc** (room `btct-shared`) with all workspaces, pages,
     graphs, nodes, edges, attack chains, change logs, page snapshots, and nmap
     scans + machines. Every collaboratively-edited text field is a `Y.Text` keyed
     `<entity>:<id>:<field>`.
   - Holds **one Y.Doc per page** (room = the page id) for the markdown body,
     cached in IndexedDB.
   - Awareness pushes `{ id, name, color }`, rendered as carets + a presence row.

When a user drags a node, edits a page, or imports nmap XML, the change is written
to the appropriate Yjs structure → broadcast over the WS → every peer's Zustand
store re-derives its UI from the merged doc state. Auth/admin/settings go through
normal REST.

---

## Tech stack

### Client
- **Vite 8** + **React 19** + **TypeScript (strict)**
- **Milkdown 7 (Crepe)** + `@milkdown/plugin-collab` + **CodeMirror 6** code blocks
  (`@codemirror/language-data`, GitHub-Dark token theme)
- **`@myriaddreamin/typst.ts`** in-browser (WASM) Typst compiler + renderer for
  the local Typst tab; **`y-codemirror.next`** binds the Typst source CodeMirror
  editor to a shared Yjs `Y.Text` for live co-editing
- **@xyflow/react 12** graph canvas with **`@dagrejs/dagre`** auto-layout
- **Yjs 13** + **y-websocket 2** + **y-prosemirror 1** + **y-indexeddb 9**
- **Zustand 5** for app/auth/theme state
- **Tailwind CSS 4** + **Radix UI** primitives + **lucide-react** icons
- **cmdk** command palette, **JSZip** export bundles, **date-fns** timestamps
- **Vitest 4** unit tests

### Server (`server/`)
- **Bun 1.3** runtime (`bun:sqlite`)
- Plain `node:http` + `ws.WebSocketServer`
- `y-websocket/bin/utils.setupWSConnection` for every Yjs room
- **`y-leveldb`** for durable Yjs persistence (via `YPERSISTENCE`)
- PBKDF2-SHA256 password hashing, HMAC-SHA256 signed bearer tokens

### Packaging / deployment
- **Docker** + **docker compose** (multi-stage `Dockerfile`)
- Single image serves API + WebSocket + static client on one port
- Persistent SQLite + Yjs LevelDB on the `btct-data` volume at `/data`
- PowerShell automation: `Start-BTCT.ps1`, `Install-BTCTShortcut.ps1`,
  `Backup-BTCT.ps1`, `Restore-BTCT.ps1`, `Publish-BTCT.ps1`

---

## Architecture & internals (for developers & LLMs)

> This section is the orientation guide for anyone (human or AI) changing the
> code. Read [Conventions & invariants](#conventions--invariants-read-before-changing-anything)
> before you touch the data layer — several non-obvious rules keep collaboration
> from corrupting.

### The mental model

There is **no application database in the traditional sense.** The "database" is
a set of **Yjs CRDT documents** synced over WebSockets and cached in IndexedDB.
The flow for any data change is always:

```
UI event → repo/store action → write to a Y.Map / Y.Text  (inside doc.transact)
        → y-websocket broadcasts to the server + peers
        → each client's Y observer fires
        → shared-bindings re-derives Zustand state (debounced)
        → React re-renders
```

The Bun server is intentionally thin: it does **auth + static hosting + a Yjs
relay with on-disk persistence**. It does *not* understand pages, graphs, or
findings — those only exist inside the CRDT documents the clients share.

### The two-tier Yjs/CRDT design

| | Shared doc | Per-page doc |
| --- | --- | --- |
| Room name | `btct-shared` | the page's `id` |
| Holds | all entity records + every collaborative text field | one page body |
| Structure | one `Y.Map` per table + one `texts` `Y.Map` of `Y.Text`s | a `prosemirror` `Y.XmlFragment` |
| Edited by | repos / stores | Milkdown collab plugin |
| Cache | IndexedDB `btct-btct-shared` | IndexedDB `btct-page-<id>` |
| Files | `src/realtime/shared-doc.ts` | `src/realtime/yjs-providers.ts` |

- **Records** are plain JSON in a per-table `Y.Map` keyed by `id`
  (last-writer-wins). Tables: `workspaces`, `pages`, `graphs`, `graphNodes`,
  `graphEdges`, `attackChains`, `changeLogs`, `pageSnapshots`, `nmapScans`,
  `nmapMachines`.
- **Collaborative text fields** are `Y.Text`s in the single `texts` map, keyed
  `<entity>:<id>:<field>` (e.g. `page:<id>:title`, `node:<id>:label`). A
  `mirrorTextsToRecords` observer writes each `Y.Text`'s value back into the JSON
  record's field, so the rest of the app (sidebar, search, exports) can read plain
  JSON. The collaborative fields are: page `title`/`slug`, node `label`, edge
  `label`, workspace `name`, graph `name`, nmap scan `name`, nmap machine
  `hostname`, attack-chain `name`.
- **Page bodies** never go in the shared doc. They live in the per-page doc and
  are checkpointed via [page snapshots](#edit-history--versioning-detail).

### Data model

All types live in [src/types/index.ts](src/types/index.ts). IDs are UUIDv4.
Fields shown as *(Y.Text)* are collaborative; everything else is last-writer-wins.

| Entity | Key fields |
| --- | --- |
| **Workspace** | `id`, `name` *(Y.Text)*, `description`, timestamps |
| **Page** | `id`, `workspaceId`, `parentId`, `title` *(Y.Text)*, `slug` *(Y.Text)*, `icon`, `tags[]`, `content` (markdown), `sortOrder`, `isGraphPage`, timestamps |
| **Graph** (narrative) | `id`, `workspaceId`, `name` *(Y.Text)*, timestamps |
| **GraphNode** | `id`, `graphId`, `type` (`host`\|`credential`\|`service`\|`finding`\|`pivot`), `label` *(Y.Text)*, `position{x,y}`, `data` (type-specific), `linkedPageId`, `discoveredAt`, timestamps |
| **GraphEdge** | `id`, `graphId`, `sourceNodeId`, `targetNodeId`, `edgeType` (AdminTo\|HasSession\|MemberOf\|Exploits\|PivotsTo\|Custom), `label` *(Y.Text)*, `linkedPageId?`, timestamps |
| **AttackChain** | `id`, `workspaceId`, `graphId`, `name` *(Y.Text)*, `nodeIds[]` (ordered), `linkedPageId`, timestamps |
| **NmapScan** | `id`, `workspaceId`, `name` *(Y.Text)*, `importedAt`, `rawXml?` |
| **NmapMachine** | `id`, `scanId`, `ip`, `hostname` *(Y.Text)*, `os` (windows\|linux\|attacker\|unknown), `ports[]`, `linkedNodeId?`, timestamps |
| **ChangeLogEntry** | `id`, `workspaceId`, `action`, `target`, `targetId`, `summary`, `timestamp`, author (`userId`/`userName`/`userColor`), `field?`, `prevValue?`, `newValue?`, `reversible` |
| **PageSnapshot** | `id`, `pageId`, `workspaceId`, `timestamp`, author, `label?`, `updateBase64` (`Y.encodeStateAsUpdate`), `byteLength` |

Node `data` is polymorphic — `HostData` / `CredentialData` / `ServiceData` /
`FindingData` / `PivotData` (fields listed in the [graph feature
tour](#attack-narrative-graph)). Cast explicitly when reading.

### Data layer: database, repos, stores

- **[src/db/database.ts](src/db/database.ts)** — a Dexie-*shaped* API
  (`get`/`add`/`put`/`update`/`delete`/`where().equals()`) backed by the shared
  Y.Maps instead of IndexedDB tables. Every write is wrapped in a Yjs transaction.
- **`src/db/*-repo.ts`** — one repo per entity (`pageRepo`, `graphRepo`,
  `graphNodeRepo`, `graphEdgeRepo`, `attackChainRepo`, `workspaceRepo`,
  `changelogRepo`, `pageSnapshotRepo`, `nmapScanRepo`/`nmapMachineRepo`). Repos do
  CRUD + queries, **pre-seed `Y.Text`s on create**, and cascade deletes (deleting
  a node removes its edges, unlinks nmap, drops it from chains, and deletes its
  hidden page).
- **[src/stores/app-store.ts](src/stores/app-store.ts)** — the Zustand store:
  workspaces, pages, graphs, tabs, pane layout, selection, search, change log,
  nmap, attack chains. Mutating actions call the repos **and** the `log()` helper
  to write a change-log entry.
- **[src/stores/shared-bindings.ts](src/stores/shared-bindings.ts)** —
  `bindSharedSubscriptions()` wires each table's `Y.Map.observe` to a debounced
  store reload (`queueMicrotask`), so a burst of CRDT changes coalesces into one
  re-render.
- **[src/realtime/use-y-text.ts](src/realtime/use-y-text.ts)** —
  `useYTextInput(key, initial)` binds an `<input>` to a `Y.Text` with diff-based
  deltas and caret-preservation on remote edits.

### Editor internals

The page editor ([src/components/editor/PageEditor.tsx](src/components/editor/PageEditor.tsx))
mounts one Crepe instance per page, with the Toolbar feature disabled and these
custom plugins layered on:

- [src/lib/highlight-plugin.ts](src/lib/highlight-plugin.ts) — the 7-color
  `highlight` mark + `ToggleHighlight` command. **Session-only**: its
  `parseMarkdown` is a no-op and `toMarkdown` drops the mark (keeps the text).
- [src/lib/code-theme.ts](src/lib/code-theme.ts) — CodeMirror language list +
  a class-based `HighlightStyle` (`Prec.highest`) whose colors come from
  `--code-*` CSS vars; `applyCodeAccent(hex)` live-retints `--code-keyword`.
- [src/lib/editor-keybinds.ts](src/lib/editor-keybinds.ts) —
  `codeBlockShellDefault` (schema default language = shell), `userKeybindsPlugin`
  (runs *before* commonmark's keymap so rebinds win; also implements
  backtick-wrap), and `focusLanguageKeymap` + `installLanguagePickerNav()` for the
  language picker.
- [src/lib/editor-prefs.ts](src/lib/editor-prefs.ts) — `EditorPrefs` shape,
  defaults, and the `parseShortcut`/`matchShortcut`/`shortcutFromEvent` helpers.
- [src/lib/block-select.ts](src/lib/block-select.ts) — the Notion-style block
  selection plugin (its own selection state + node decorations).
- [src/lib/active-editor.ts](src/lib/active-editor.ts) — module-level handle to
  the focused editor so `App.tsx` can hijack `Mod+K` for link insertion.

Live settings (keybinds, code accent) are applied through **module-level refs**
updated by an effect in `App.tsx` — never by rebuilding the editor, which would
tear down the Yjs collab binding.

### Server & HTTP API reference

Base URL defaults to the same origin. Bearer token from `/api/login`
(`Authorization: Bearer <jwt>`, 7-day TTL). Implemented in
[server/index.mjs](server/index.mjs); auth crypto in
[server/auth.mjs](server/auth.mjs); SQLite in [server/db.mjs](server/db.mjs).

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/healthz` | — | Liveness probe (`{ ok: true }`) |
| `GET` | `/api/settings` | — | Public theme color (so login paints correctly) |
| `POST` | `/api/settings/theme` | admin | Set the global accent color (SQLite) |
| `POST` | `/api/login` | — | Authenticate → `{ token, user }` |
| `GET` | `/api/me` | yes | Current user |
| `POST` | `/api/me/profile` | yes | Update own `color` and/or `prefs` (`codeAccent` + `keybinds`) |
| `GET` | `/api/admin/users` | admin | List users |
| `POST` | `/api/admin/users` | admin | Create user (username 3–32, password ≥8) |
| `DELETE` | `/api/admin/users/:id` | admin | Delete user (not self / not last admin) |
| `POST` | `/api/admin/users/:id/password` | admin | Reset a user's password |
| `GET` | `/api/ai/config` | yes | Claude assistant config — `{ enabled, mode, model, configured }` (never the key) |
| `POST` | `/api/ai/config` | admin | Set the API key / mode (`view`\|`edit`) / model / enabled |
| `POST` | `/api/ai/config/test` | admin | Live connection test with the stored key (no key returned) |
| `POST` | `/api/ai/chat` | yes | Agentic chat over workspace data; **SSE** stream. Tool loop runs server-side against the live CRDT; write tools gated to `edit` mode |
| `GET` | `/api/ai/sessions` | yes | List the caller's saved chat sessions (metadata, newest first) |
| `GET` | `/api/ai/sessions/:id` | yes | Get one session incl. messages (404 if not the caller's) |
| `POST` | `/api/ai/sessions/:id` | yes | Create/update a session (`{ title, messages }`) — upsert, scoped to caller |
| `DELETE` | `/api/ai/sessions/:id` | yes | Delete one of the caller's sessions |
| `GET` | `/api/mcp/config` | admin | MCP server config incl. the bearer token (so it can be copied) |
| `POST` | `/api/mcp/config` | admin | Enable/disable + set mode (`read`/`edit`); mints a token on first enable |
| `POST` | `/api/mcp/token` | admin | Regenerate (rotate) the MCP bearer token |
| `POST` | `/mcp` | MCP token | Streamable-HTTP MCP endpoint (own bearer auth). Read tools always; write tools in `edit` mode |
| WS | `/yjs/<room>?token=<jwt>` | yes (at upgrade) | Yjs CRDT relay; rooms = `btct-shared` + one per page id |

The `users` table is `(id, username [NOCASE unique], salt, hash, iter, color,
avatar, is_admin, prefs [JSON], created_at)` — the `prefs` column is added by an
idempotent migration. Per-account editor prefs (`codeAccent`, `keybinds`) are
validated at the REST edge and stored as a JSON blob. The `settings` table is a
simple key/value store: `theme_color`, the Claude assistant config
(`anthropic_api_key`, `ai_mode`, `ai_model`, `ai_enabled`) — the key is
write-only and never returned to clients — and the MCP server config
(`mcp_enabled`, `mcp_mode`, `mcp_token`; the token is admin-readable so it can be
copied into a client). The `chat_sessions` table
(`id, user_id, title, messages [JSON], created_at, updated_at`) holds each
account's durable Claude conversations, scoped and pruned per user.

**Environment variables:** `AUTH_SECRET` (required in prod; HMAC key — random &
ephemeral if unset, which silently invalidates tokens on restart), `HOST`,
`PORT`, `STATIC_DIR`, `DB_PATH`, `YPERSISTENCE` (LevelDB dir — **set it or Yjs
rooms are memory-only**), `ALLOWED_ORIGIN` (CORS; unset = same-origin),
`ADMIN_USERNAME`/`ADMIN_PASSWORD` (bootstrap admin, default `admin`/`changeme!`).
Client build-time: `VITE_API_URL`, `VITE_WS_URL` (default same-origin).

### Key files map

```
src/
  App.tsx                     Root: auth gate, global hotkeys (Mod+K, tab nav),
                              browser-history tab nav, applies per-account prefs
  api/client.ts               REST client base
  auth/                       auth-store.ts (Zustand + REST), LoginScreen.tsx
  components/
    editor/PageEditor.tsx     Milkdown/Crepe editor + floating format panel
    editor/KeybindsDialog.tsx Per-account keybind capture UI
    graph/                    GraphCanvas + nodes/ + edges/ + palette + ctx menu
                              + Node/EdgeProperties
    findings/                 FindingsCollector.tsx, AttackTimeline.tsx
    nmap/NmapScanView.tsx     XML import, machine grid/detail, host-node linking
    typst/                    TypstView (split editor+preview tab), TypstEditor
                              (collab CodeMirror), TypstPreview (local SVG render)
    sidebar/                  LeftSidebar (tree/nav), RightSidebar (properties),
                              AdminPanel, ProfileEditor, ThemePicker,
                              ChangeLogPanel, PageHistoryPanel, BacklinksPanel,
                              LastEditedBadge
    ui/                       TabBar, SplitContainer (panes), MainContent,
                              CommandPalette, WorkspaceSelector, ExportDialog
  db/                         database.ts (Y.Map-backed table API) + *-repo.ts
  export/                     markdown.ts, graphml.ts, bundle.ts, workspace-zip.ts
  lib/                        editor-* + highlight-plugin + code-theme +
                              block-select + active-editor + auto-layout +
                              pathfinding + nmap-parser + pane-layout + theme +
                              typst-compiler (local WASM compile→SVG/PDF) +
                              typst-language (CodeMirror Typst highlighting) +
                              utils
  realtime/                   shared-doc.ts (shared Y.Doc + Y.Text registry),
                              yjs-providers.ts (per-page docs), page-snapshots.ts,
                              use-y-text.ts, PresenceAvatars.tsx
  stores/                     app-store.ts, shared-bindings.ts, theme-store.ts
  test/                       Vitest suites + fixtures
  types/index.ts              All shared types + default factories
server/
  index.mjs                   HTTP + WS entry, all REST routes, static serving
  auth.mjs                    PBKDF2 hashing + HMAC token sign/verify
  db.mjs                      bun:sqlite users + settings, prefs migration
```

### Conventions & invariants (read before changing anything)

1. **Pre-seed `Y.Text`s in `create()`.** When a repo creates an entity, it must
   `getOrInitYText(textKey(entity, id, field), initial)` for each collaborative
   field, or two clients can race and orphan a text. To add a new collaborative
   field you must touch *all four* of: `TEXT_FIELDS_BY_ENTITY` and
   `TEXT_FIELD_TO_TABLE` in [shared-doc.ts](src/realtime/shared-doc.ts), the repo
   `create()`, and the UI (`useYTextInput`).
2. **Reads use the JSON record, not the `Y.Text`.** The mirror observer keeps them
   in sync; don't read `texts` directly outside the editor/input layer.
3. **Never rebuild the editor to apply settings.** Keybinds and code accent flow
   through module-level refs + CSS vars precisely so the Yjs collab binding
   survives. Rebuilding mid-session breaks live cursors and can drop edits.
4. **Page bodies aren't in the change log.** Per-keystroke logging would be noise;
   rollback for bodies is via page snapshots instead.
5. **Highlight marks are intentionally not persisted** (no CommonMark syntax).
6. **Deletes cascade and are logged with a full snapshot** so they're restorable.
7. **The server is dumb about domain data.** Don't add page/graph logic to the
   server; it only relays Yjs, serves static files, and does auth/settings.
8. **DB migrations must be idempotent** — guard every `ALTER TABLE` with a column
   check (see the `prefs`/`avatar`/`is_admin` migration in `db.mjs`).
9. **Set `AUTH_SECRET` and `YPERSISTENCE`** in any real deployment, or tokens and
   rooms evaporate on restart.

### Recipes: how to extend

- **New entity type** → add the type + factory in `types/index.ts`; add a
  `*-repo.ts`; register the table name in `shared-doc.ts`; add a `Table<T>` in
  `database.ts`; add store actions in `app-store.ts`; wire a subscription in
  `shared-bindings.ts`; pre-seed any `Y.Text` fields.
- **New collaborative text field** → see invariant #1.
- **New graph node type** → extend `NODE_TYPES` + a `*Data` interface + factory;
  add `components/graph/nodes/<X>Node.tsx` and register it; add a palette entry;
  add a property-fields case (graph `NodeProperties` and the page editor).
- **New edge type** → add to `EDGE_TYPES`; it auto-appears in the type selector.
- **New editor shortcut/action** → add to `KeybindAction` + `DEFAULT_KEYBINDS` +
  `KEYBIND_ACTIONS` in `editor-prefs.ts`; implement in `runAction()` in
  `editor-keybinds.ts`; add a button to the floating panel.
- **New HTTP endpoint** → add a branch in `server/index.mjs`, gate with
  `authFromHeader`/`requireAdmin`, parse with `readJsonBody`, reply with
  `sendJson`.
- **New export format** → add `src/export/<fmt>.ts`, export from `export/index.ts`,
  and include it in the workspace ZIP if appropriate.

---

## Repository layout

```
src/                       Client (see "Key files map" above for detail)
server/
  index.mjs                HTTP + WS entry
  auth.mjs                 PBKDF2 + HMAC token helpers
  db.mjs                   bun:sqlite users + settings
Dockerfile                 Multi-stage build (client → server-deps → runtime)
docker-compose.yml         Single-container deployment
Start-BTCT.ps1             One-click launcher (Docker + browser; popup if running)
Install-BTCTShortcut.ps1   Drops a Desktop shortcut to the launcher
Backup-BTCT.ps1            Tar the btct-data volume to a timestamped .tgz
Restore-BTCT.ps1           Restore a .tgz back into the volume
Publish-BTCT.ps1           Windows release script (auto-bumps patch tag)
```

---

## Run locally on Windows with Docker Desktop

The simplest path: one container, one command, persistent data.

### Prerequisites
- **Docker Desktop for Windows** (WSL2 backend) — installed and running
- **Git for Windows**
- **PowerShell 5.1** (bundled) or **PowerShell 7+**

### First-time setup

```powershell
# 1. Clone
git clone https://github.com/<you>/BeenThereConqueredThat.git
cd BeenThereConqueredThat

# 2. Install the Desktop shortcut (also generates .env on first launch).
.\Install-BTCTShortcut.ps1

# 3. Double-click the new "Been There, Conquered That" shortcut on your Desktop.
#    First launch builds the image (a couple of minutes).
```

Default bootstrap admin — **`admin` / `changeme!`** — change it immediately from
the in-app admin panel. (Override by setting `ADMIN_USERNAME` / `ADMIN_PASSWORD`
in `.env` *before* the very first start.)

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
Compose binds `8080` on all interfaces, so any machine on the LAN can hit
`http://<your-windows-ip>:8080`. Allow it through Windows Defender Firewall
(TCP 8080 inbound) the first time someone connects.

### Dev mode (hot reload, without Docker)

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

## One-click launcher (Windows)

After setup, the app launches via a Desktop shortcut:

```powershell
.\Install-BTCTShortcut.ps1
```

Double-clicking the shortcut runs [`Start-BTCT.ps1`](Start-BTCT.ps1), which:

1. Starts Docker Desktop if it isn't already running (waits up to 120 s).
2. **If the `btct` container is already running, pops up "already started" and
   exits** (pass `-Update` to force a rebuild anyway).
3. Generates a `.env` with a fresh `AUTH_SECRET` on first launch.
4. `docker compose up -d`.
5. Polls `/healthz` until the server answers.
6. Opens http://localhost:8080 in your default browser.

Pass `-Update` to also `git pull` and rebuild before starting:

```powershell
.\Start-BTCT.ps1 -Update
.\Install-BTCTShortcut.ps1 -Update   # makes every click an updating click
```

---

## What persists (and what doesn't)

All data lives in a single named Docker volume, `btct-data`, mounted at `/data`:

| Data | Path | Survives `up -d --build` |
| --- | --- | --- |
| User accounts + per-account prefs + settings | `/data/data.sqlite` | yes |
| Notes, pages, graphs, chains, nmap scans (Yjs LevelDB) | `/data/yjs/` | yes |
| Activity log (every change, author + timestamp) | `/data/yjs/` | yes |
| Page-body version history (point-in-time snapshots) | `/data/yjs/` | yes |

So **every code update, image rebuild, or container restart preserves all your
data.** The only commands that destroy it are `docker compose down -v` or manually
`docker volume rm beenthereconqueredthat_btct-data`. No launcher/update flow ever
runs those.

> Yjs persistence is provided by y-leveldb (enabled via `YPERSISTENCE=/data/yjs`).
> Without it, rooms live only in memory and rely on clients to re-seed from
> IndexedDB — fragile across restarts. With it, the server is the source of truth
> on disk.

---

## Backups & restore

Full-volume backup capturing every byte in `/data` (users, notes, snapshots,
everything):

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

The restore script stops the container, replaces the volume contents with the
archive's, and brings the container back up. Pass `-Force` to skip the
"type `restore` to continue" prompt. Schedule periodic backups with Windows Task
Scheduler pointing at `pwsh.exe -File C:\path\to\Backup-BTCT.ps1` (nightly is a
sensible default during active engagements).

For *per-workspace* portability (no users/SQLite) use the in-app
[Lossless workspace ZIP](#export--import) instead.

<a id="edit-history--versioning-detail"></a>
### Edit history & rollback (mechanics)

BTCT records who did what to every entity and lets you roll back specific actions.

**Activity log** — every create/update/delete/restore on a workspace, page,
graph, node, edge, or attack chain writes a `changeLogs` entry into the shared
doc with the author (captured at write time so it survives a user being
renamed/removed), a millisecond timestamp, a **field-level delta** (prev + new
for single-field updates — what makes it reversible), and a **full entity
snapshot** for deletes. It surfaces as the right-sidebar **History** feed and as
per-entity *Last edited by …* badges. Reversible entries get a **Restore** button:
updates re-apply the previous value; deletes re-create the entity from the
snapshot (reusing the original ID so references resolve). Restores are themselves
logged.

**Page version history** — page bodies live in their own per-page Yjs doc, so the
right sidebar has a dedicated **Page Versions** panel for them. It shows
**auto-saved** snapshots (captured ~2 minutes after the last keystroke; 20
most-recent kept per page) and **named** versions (never pruned). Each snapshot
stores the full `Y.encodeStateAsUpdate(pageDoc)` bytes (base64). Restoring decodes
the bytes, clones the `prosemirror` fragment, and swaps it into the live doc in a
single Yjs transaction — so every connected collaborator sees the same rollback in
real time, non-destructively (prior state stays in the CRDT update log).

---

## Releases & production deploy

### Push a release to GitHub (Windows)

`Publish-BTCT.ps1` auto-bumps the patch of the latest `vMAJOR.MINOR.PATCH` tag;
pass `-Tag` to override (minor/major bump).

```powershell
.\Publish-BTCT.ps1 -Message "Add foo and fix bar"        # auto-bump patch
.\Publish-BTCT.ps1 -Message "Big rewrite" -Tag v0.4.0    # explicit
```

It `git fetch --tags`, bumps from the real latest tag (or starts at `v0.1.0`),
commits staged changes, pushes `main`, force-tags, pushes the tag, and prints the
matching `update-btct <tag>` command for the Linux host.

### Deploy / update on a Linux production host

Production runs the same `Dockerfile` + `docker-compose.yml`, on a Linux server,
behind a TLS reverse proxy (nginx / Caddy / Traefik) for HTTPS.

One-time setup:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git curl
sudo systemctl enable --now docker
sudo usermod -aG docker $USER

sudo mkdir -p /opt/btct && sudo chown $USER:$USER /opt/btct
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
    echo "[update-btct] healthy ($(curl -s http://127.0.0.1:8080/healthz))"
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

Each release: `Publish-BTCT.ps1 -Message "…"` on Windows → `update-btct v0.3.6` on
Linux. SQLite + Yjs data live in the `btct-data` volume, not the image, so they
survive every redeploy.

---

## Tests

```powershell
bun install        # one-time
bun run test       # vitest run
```

Unit suites live in [src/test/](src/test/) (pure logic: pane layout, pathfinding,
auto-layout, nmap parser, markdown/graphml export, editor-prefs shortcut parsing,
etc.). The full build is `bun run build` (`tsc -b && vite build`).

---

## Security posture

This is a LAN tool for trusted operators. It is **not** hardened for hostile
internet exposure. Known gaps:

- **Tokens in `localStorage`** — XSS in the editor would leak them.
- **No CSRF protection** on `/api/*` beyond the bearer-token convention.
- **No rate limiting** on `/api/login` (PBKDF2 is the only brute-force cost).
- **No account lockout, MFA, or self-service password reset.**
- **Yjs WS auth is checked once at upgrade** — a revoked account keeps editing
  until the socket drops.
- **No per-workspace authorization** — every authenticated user sees every
  workspace.
- **`AUTH_SECRET` defaults to a random ephemeral value** when unset; tokens are
  silently invalidated on restart. Always set it in `.env`.
- **HTTPS / WSS is not built in** — terminate TLS in nginx/Caddy.
- **No CSP / Trusted Types.** Treat untrusted markdown as untrusted.

Threat model: trusted teammates on a LAN segment during an engagement. Anything
beyond that needs additional work.

---

## License

Internal tooling — not licensed for redistribution.
