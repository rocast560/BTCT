# Been There, Conquered That (BTCT)

A LAN-hosted, multi-user, **real-time collaborative** note-taking and attack-path
graphing app for penetration-testing engagements. It combines Notion-style
pages, an attack-narrative graph canvas, nmap import, findings/timeline
reporting, and Google-Docs-style live co-editing across every machine on the LAN,
all from a single Docker container.

![BTCT demo: typing a highlighted code block, a second operator editing the same page live, nmap import linked to the graph, a highlighted attack path, structured finding data, the live command log, Typst figure placement, and the split-screen report](blog/images/btct-demo.gif)

*One continuous take against a small demo workspace. If the GIF looks fuzzy, the
crisp version is [`blog/media/btct-demo.mp4`](blog/media/btct-demo.mp4) at
1920x1080.*

> **New here?** Jump to the [Feature tour](#feature-tour) for what it does, the
> [Keyboard shortcuts](#keyboard-shortcuts--gestures) for how to drive it fast,
> or [Run locally](#run-locally-on-windows-with-docker-desktop) to get it up.
>
> **AI agent / new contributor working on the code?** Start at
> [Architecture & internals](#architecture--internals-for-developers--llms):
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
  - [Command log (team shell-command capture)](#command-log-team-shell-command-capture)
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
+ Crepe, Obsidian-style): you type markdown and it renders inline as you go.

- **Block syntax**: `# ` … `###### ` headings, `- ` / `1. ` lists, `- [ ]`
  task lists (click to toggle), `> ` quotes, `|` tables, `---` rules, `![](url)`
  images, `[text](url)` links.
- **Slash menu**: type `/` to open the block-insert menu (Heading, lists,
  quote, **Code**, table, image, …); filtering uses Notion's vocabulary, so
  `/bullet`, `/num`, and `/todo` match the bulleted / numbered / to-do list
  entries. Inserting **Code** defaults the new block to the `shell` language.
- **Typing conversions**: the usual markdown (`**bold**`, `*italic*`,
  `~~strike~~`, `` `code` ``, `#`/`##`/`###` headings, `-`/`1.` lists), plus
  two Notion shortcuts: **`[]`** turns into a to-do checkbox the moment you
  type the `]` (no space, `[ ]`/`[x]` + space work too), and **`"` + space**
  starts a quote. Select text and press **`` ` ``** to wrap the selection as
  inline code.
- **Floating format toolbar**: a Notion-style horizontal bar that appears above
  the selection. A **Turn into** dropdown (left) shows the selection's current
  block type and converts it to text / H1–H3 / to-do / bulleted / numbered /
  quote / code, lifting it out of any list or quote first. Then the inline marks
  (bold / italic / strikethrough / inline code) with **live active states**, an
  inline **link** editor, a **7-color highlighter** dropdown (yellow, green,
  blue, pink, orange, purple, red + clear), and a keyboard icon that opens the
  **Keybinds** dialog. *Highlight marks are session-only*: they're an annotation
  aid and are intentionally stripped when the page is saved (CommonMark has no
  highlight syntax), so the saved markdown stays portable.
- **Turn-into shortcuts**: `Ctrl/⌘+Shift+0..8` convert the current block the
  way Notion's digit family does: `0` text, `1`/`2`/`3` headings, `4` to-do,
  `5` bulleted list, `6` numbered list, `8` code.
- **Links**: `Ctrl/⌘+K` (or the toolbar link button) opens Crepe's inline
  "Paste link…" input on the selection instead of a browser prompt; run it on
  an already-linked selection to unlink it.
- **Code blocks**: full syntax highlighting via CodeMirror using the **GitHub
  Dark** palette. Click the language button to pick a language; or press
  **Ctrl+Shift+L** inside a block to jump to the picker and **arrow-key** through
  it (Enter selects, Esc closes). New code blocks default to `shell`, whether
  they come from `/code` or from typing ``` and pressing Enter; type a language
  after the fence (```py) to keep it.
- **Notion-style block selection**: tap **Esc** to leave text editing and
  select the block the caret is in. Then **↑/↓** to move the selection,
  **Shift+↑/↓** to multi-select, **Ctrl/⌘+Shift+↑/↓** to move the selected
  block(s) up/down, **Ctrl/⌘+D** to duplicate them, **Backspace/Delete** to
  delete them, **Ctrl/⌘+A** to select all, **Enter** to edit the focused block,
  **Esc/click** to exit. While still editing text, **Ctrl/⌘+A** ladders the
  Notion way (select the block's text, then the block, then every block), and
  **Ctrl/⌘+Shift+↑/↓** moves the current block without selecting it first.
- **Per-account personalization**: each account can rebind the editor shortcuts
  (Keybinds dialog, which also lists the built-in block shortcuts) and choose a
  **code accent** color that retints code-block keywords. Both follow your
  account (stored server-side) and apply live.
- **Backlinks**: for a graph-linked page, the right sidebar lists the graph
  nodes and edges that reference it. (Note: there's no `[[wikilink]]` syntax;
  use standard markdown links.)
- **Graph-linked pages**: pages auto-created for graph nodes show structured
  property editors inline (host/service/finding/pivot fields, see below) plus a
  "Connected nodes" list and a "Narrative" button back to the canvas.

### Typst documents (local typesetting)

The Pages section has a dedicated **Typst** tab, a [typst.app](https://typst.app)-style
split view for the [Typst](https://typst.app) typesetting language, **compiled and
rendered entirely in the browser** (no calls to typst.app or any remote service):

- **Three resizable panes**: the raw Typst source in a collaborative
  CodeMirror editor on the left, the live-rendered document (SVG) in the
  middle, and the assets rail on the right. Drag either divider to resize
  (double-click one to reset it), or use the **Code** / **Assets** toggles to
  hide a pane entirely. Widths and visibility persist per browser, and both
  rails re-fit themselves if the window gets too narrow to hold them. Zoom the
  preview in/out.
- **Local WebAssembly compiler**: bundled [`typst.ts`](https://github.com/Myriad-Dreamin/typst.ts)
  (compiler + renderer wasm) ships with the app, and the default Typst font set
  is embedded in the compiler, so it renders **fully offline / air-gapped**, with no
  internet needed during an engagement.
- **Live errors**: Typst compile diagnostics (with `file:line` ranges) surface
  in a banner while the last good render stays on screen, so a transient typo
  doesn't blank the preview.
- **Collaborative source**: the Typst source is a per-workspace `Y.Text` in the
  shared doc, so it's character-by-character co-edited (with remote carets) and
  persisted exactly like every other field in BTCT. One Typst scratchpad per
  workspace; open it from the **Pages** sidebar, the command palette
  (*Open Typst Document*), or `Ctrl/⌘+K`.
- **Find & replace across the whole document**: `Ctrl/⌘+F` (or the header
  **Find** button) opens a search panel that scans the *entire* Typst source,
  not just the part on screen, and lists every match with its line number and a
  context snippet. Click any result to jump to it. Filter with **case-sensitive**,
  **whole-word**, and **regular-expression** toggles; `Enter` / `Shift+Enter`
  step through matches; the expandable replace row does one-at-a-time or
  **replace-all** (regex `$1`/`$&` captures supported). This replaces
  CodeMirror's built-in find, whose highlighting only covered the visible
  viewport.
- **Screenshots go into declared figure slots, not wherever the caret is**:
  drag image files onto the **Assets** rail (or use *Add*) and a window opens
  with the crop editor on the left and the document's **figure locations** on
  the right. Pick a slot, hit *Place in figure*, done.

  A slot is a call to the `image-placeholder` helper:

  ```typst
  #image-placeholder("Authentication bypass on /admin")
  ```

  which renders a captioned grey "insert screenshot here" box until an image
  is assigned. Once one is, **the image is placed inside that same
  bordered frame**, scaled to fit, rather than replacing it. The figure keeps
  a consistent size and border whether or not it has been filled in, so a
  *missing* screenshot is
  obvious in the rendered PDF rather than silently absent, and captions and
  figure numbering stay consistent no matter who fills the report in. Placing
  is reversible (*Unplace* empties the slot but keeps it), and you can create
  a new slot from inside the same window. Documents that already define their
  own `image-placeholder` are upgraded in place on first use, but **only if
  the definition is one BTCT generated**. If you've customized the styling,
  it's left alone.
- **Rename after import**: click the filename in the crop window to rename an
  image. Every `#image-placeholder(…, path: …)` and hand-written
  `#image("/assets/…")` reference in the document is repointed automatically.
  The extension isn't editable: Typst picks its decoder from it and the stored
  bytes are normalized to match, so letting it drift would break the render.
- **Click the preview to jump to the source**: clicking anywhere on the
  rendered page selects the matching text in the code (and opens the code pane
  if it's hidden), so you can start editing the words immediately. It lands on
  the **editable prose, not the styling that formats it**: text that also
  appears inside a `#set`/`#show`/`#let` (e.g. a title repeated in a running
  header) resolves to the body occurrence you clicked. Clicking a heading's
  auto-generated number lands on the heading itself; clicking blank space does
  nothing rather than jumping somewhere arbitrary.
- **Framing is WYSIWYG**: the crop window is a *viewport*, not a free
  selection. The frame is drawn to the figure box's real proportions,
  computed from the document's own `#set page(...)` and the slot's height, and
  the image pans and scales behind it. What sits inside the frame is exactly
  what the PDF shows: scale past the border and it's clipped there, scale
  smaller and the placeholder grey shows through. Drag to reposition, scroll
  to zoom, or use **Fill** / **Fit all** / **Auto** (which trims uniform
  borders first, then re-frames).

  Because the stored crop carries the box's aspect ratio, the bytes drop into
  the figure with no letterboxing and no distortion. That's a change from earlier
  builds, where a 16:9 screenshot in the default 2.9:1 box used only ~61% of
  the width.
- **Per-figure size**: each figure's height is adjustable from the crop
  window (presets plus a slider). The frame reshapes live and the ratio is
  shown, so you can make one figure a wide banner and the next a tall
  portrait; placing writes `height:` onto that one slot.

  The crop is stored as a *normalized rectangle on the asset record*, never
  baked into the file: the upload is immutable, so framing can always be
  redone and re-cropping never degrades the image.
- **Blur sensitive content**: hit **Blur** in the same window and drag
  rectangles over anything the report shouldn't show (credentials, session
  tokens, client hostnames). Regions render blurred in the viewport, the
  thumbnail, the preview, and the exported PDF. The redaction is deliberately
  aggressive: the region is downscaled hard before the gaussian pass, so the
  text underneath is destroyed rather than merely softened (a plain blur of
  readable text can sometimes be reversed). Like the crop, blurs are stored
  as normalized rectangles on the asset record and applied at render time;
  the upload is untouched, so a mis-drawn region can always be removed (in
  blur mode, hit the × on a region, or *Clear* for all of them). Regions are
  anchored to the image, not the frame, so re-cropping never slides a blur
  off its secret. GIF and SVG images can't be blurred, since re-encoding
  them through a canvas isn't possible.

  Each region has its own **style** and **strength**: pick *Blur* (smooth
  gaussian) or *Pixels* (hard mosaic blocks) and set the strength slider
  before drawing, or click an existing region to select it and adjust it
  with the same controls. 100% is the original aggressive default; lighter
  settings still halve the detail, and pixel blocks are floored at 8px so
  they stay out of mosaic-reversal territory.
- **Custom fonts**: drop `.ttf` / `.otf` / `.woff` / `.woff2` / `.ttc` files
  onto the same rail. BTCT reads the family name straight out of the font with
  the compiler's own parser (so the name shown is the one Typst will match),
  and the *+* button inserts `#set text(font: "…")` at your cursor. Custom
  fonts are added *alongside* the built-in Typst faces, so installing your
  client's brand font never costs you New Computer Modern.
- **Shared assets**: image and font *metadata* (name, crop rect, family) lives
  in the shared Yjs doc, so a crop you make appears on every teammate's preview
  live. The bytes themselves are stored server-side on the `/data` volume
  rather than in the CRDT. A report with thirty multi-MB screenshots would
  otherwise be broadcast to and permanently cached by every connected client.
- **Export**: one-click **PDF** and **SVG** export of the compiled document.
  Both compile the same virtual file at the same filesystem root, so an
  `#image(…)` that renders in the preview renders identically in the PDF.

### Attack-narrative graph

Each **Attack Narrative** is a graph canvas ([React Flow](https://reactflow.dev))
for modeling an engagement's attack path.

- **Node types**: Host, Credential, Service, Finding, Pivot. Drag from the
  palette (top) or right-click the canvas → *Add Node*. Each carries structured
  data:
  - **Host**: hostname, IP, OS, open ports
  - **Credential**: username, secret, source
  - **Service**: name, version, port, CVEs
  - **Finding**: title, severity (critical→info), CVSS + vector, likelihood,
    impact, description, business impact, exploit steps, MITRE ATT&CK / mitigation,
    remediation, affected hosts, references
  - **Pivot**: description
- **Edges**: drag handle-to-handle to connect; typed as AdminTo, HasSession,
  MemberOf, Exploits, PivotsTo, or Custom. Double-click an edge label to rename;
  changing the type resets the label to match.
- **Every node has a page**: double-click a node to open its linked write-up
  page; node properties and the page's inline editors stay in sync.
- **Node search**: **Ctrl/⌘+F** fuzzy-searches across all node fields; **↑/↓**
  to navigate, **Enter** to zoom to the node.
- **Pathfinding**: select two nodes and **Highlight Path** (BFS shortest path),
  or right-click → *Set as Path Start* / *Set as Path End*. Highlighted edges get
  gold marching-ants; nodes pulse.
- **Attack chains**: select 2+ nodes → right-click → *Add to Attack Chain*
  (new or existing). Chains are ordered by canvas position, listed in the
  sidebar, get an auto-created write-up page, and can be highlighted (red) on the
  canvas.
- **Auto-layout**: dagre hierarchical layout with adjustable node/rank/edge
  spacing.
- **Export**: high-resolution **PNG** of the canvas, plus GraphML/JSON (see
  [Export & import](#export--import)). Viewport (pan/zoom) is cached per graph so
  switching tabs preserves position.
- **Nmap link**: Host nodes can bind to an imported nmap machine; hostname and
  open ports sync between them, and a *Go to Nmap* action jumps across.

### Recon & reporting (nmap, findings, timeline)

- **Nmap import**: create a scan group in the sidebar, then drag-drop (or pick)
  one or more nmap **XML** files. The parser extracts host IP, hostname, OS
  (osmatch/osclass with a port-signature fallback), and per-port service/version/
  script output, skipping hosts that are down. Re-importing the same IP merges
  ports. Each machine has an editable, collaboratively-synced hostname and an OS
  dropdown; machines can be linked to Host nodes (with port sync).
- **Findings Collector**: aggregates every Finding node across all narratives in
  the workspace, grouped by severity and sorted by CVSS, with a summary bar.
  Click to open the finding's page; **Shift+click** to focus it on its graph.
- **Attack Timeline**: every node across the workspace ordered by its
  `discoveredAt` time, grouped by day, with type/narrative filters and each
  node's incoming edges shown as lineage. **Copy as Markdown** exports the whole
  timeline as a hierarchical outline.

### AI assistant (Claude)

A built-in Claude assistant that can read (and, when allowed, edit) your live
workspace, so you can explore a network and have it document findings as you go.

- **Admin-configured, key stays server-side.** An admin opens **Admin panel →
  Claude AI Assistant** to paste an **Anthropic API key** (write-only: the server
  never returns it, you only see *Connected ✓ / Not configured*), pick a
  **mode**, set the **model** (default `claude-opus-4-8`), toggle **Enabled**, and
  **Test** the connection. The key is stored in the SQLite `settings` table and
  never reaches the browser or the JS bundle.
- **View vs Edit mode** (global, admin-set). **View** = read/analyze only.
  **Edit** = also create/update pages, attack-narrative graphs, nodes, edges,
  findings, and link nmap hosts to nodes. Write tools are only exposed (and re-checked
  server-side) in Edit mode. There are no delete tools.
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
  token-by-token and render as markdown (headings, lists, tables, code), batched
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
  POST is admin-only) and `POST /api/ai/chat` (SSE stream). See the
  [API reference](#server--http-api-reference).

### MCP server (connect an external client)

BTCT can expose itself as a **hosted MCP (Model Context Protocol) server** so an
external MCP client, for example the **Claude Code CLI**, can read (and, if allowed,
write) all your workspace context: pages, attack-narrative graphs, attack chains,
findings, the attack timeline, nmap scans/hosts, users, and the change log.

- **Admin-configured, like the API key.** **Admin panel → MCP Server**: enable it,
  toggle **Edit permissions** (Read-only vs Edit), and copy the generated **access
  token** (Reveal / Copy / Regenerate). The token is stored server-side and is the
  bearer the client authenticates with.
- **Streamable HTTP at `POST /mcp`.** Stateless MCP over HTTP; auth is the bearer
  token, checked with a constant-time compare. Read tools are always exposed; write
  tools (create/update pages, graphs, nodes, edges, findings; nmap→node linking)
  appear only in **Edit** mode. Reconnect the client after toggling to pick up the
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

Then just ask in plain language. Claude calls the tools automatically, e.g.
*"Using the btct server, list my workspaces and their findings"* or *"show the hosts
in the latest nmap scan."* Tools appear namespaced as `mcp__btct__list_workspaces`,
`mcp__btct__get_graph`, etc. **Read** tools always work; **write** tools require
**Edit** mode. After toggling Read↔Edit in the admin panel, reconnect
(`claude mcp remove btct` + re-add, or restart the session) so the CLI re-fetches
the tool list.

**Troubleshooting:** if `claude mcp list` shows the server failed to connect, check
that MCP is **Enabled** in the admin panel, that the **token** matches
(Regenerate invalidates old ones), and that the **URL/port** is reachable
(`curl -s -o /dev/null -w "%{http_code}" -X POST <origin>/mcp` → `401` means the
endpoint is up and rejecting an unauthenticated request, which is expected).

### Command log (team shell-command capture)

A running record of the commands the team actually executed on their own boxes,
so the report's evidence trail writes itself instead of being reconstructed from
memory. Open it from the sidebar (**Command Log**) or the command palette.

- **How it's fed.** Each operator runs a small standalone Python agent
  (`cmdlog-agent/`) on their Kali box. A shell hook (bash/zsh) captures each
  whitelisted command as it's typed and the agent ships it to BTCT with the
  operator name, hostname, working directory, start time, **exit code, and
  duration**. A long scan appears the moment it starts and its result fills in
  when it finishes. Nothing changes about how operators type commands.
- **Whitelist-driven.** Only tools on the whitelist are logged (nmap, gobuster,
  hydra, sqlmap, crackmapexec, impacket, …); everything else you type is ignored
  and never leaves the box. Admins edit the whitelist in **Admin → Command Log**,
  and every agent picks up the change within ~60s.
- **Secrets are redacted** before they leave the operator's box: passwords, hashes,
  auth headers, and URL credentials become `«REDACTED»`; the unredacted line stays
  in a local log on that box. Redaction is tool-aware (`nmap -p 1-65535` keeps its
  ports; `mysql -pSECRET` is scrubbed).
- **Live + filterable.** The viewer filters by operator, tool, host, status
  (running / success / failed), time window, and free-text command search, and
  **exports the filtered set as CSV or JSON** for the report. New commands push in
  live with no reload.
- **Manual entries.** Not everything is captured by the agent: an **Add entry**
  button lets you hand-enter a command as any operator (command, tool, host, cwd,
  start time, exit code, duration). Manual entries go through the same durable
  path (SQLite + CRDT) and are never redacted.
- **Setup.** Turn it on in **Admin → Command Log** (mints a shared ingest token),
  then on each box: `python3 -m btct_agent install --server http://<host>:8080
  --token <token> --operator <you>` and `python3 -m btct_agent run`. See
  [`cmdlog-agent/README.md`](cmdlog-agent/README.md).

Storage is split on purpose: the server keeps a **durable SQLite archive** of every
command (unbounded, queried over REST with filters) and mirrors only the most recent
~500 per workspace into the shared CRDT for the live view, so the collaborative doc
stays bounded while no history is ever lost.

### Real-time collaboration

Everything is live and multi-user over the LAN:

- **Character-by-character merge** on every text field (page title/slug, node &
  edge labels, workspace/graph/scan names, nmap hostnames, chain names). Two
  people typing in the same field never clobber each other (Yjs `Y.Text` CRDTs).
- **Live page co-editing** with remote carets and name tags (Google-Docs style),
  backed by a per-page CRDT document and Milkdown's collab plugin.
- **Presence & follow**: each user broadcasts `{ id, name, color }` plus their
  current view. Press **`Mod+Shift+U`** (or the command palette → *Active Users /
  Follow*) to open the active-users window and **follow** a teammate: your view
  live-mirrors theirs, jumping to the graph node they select, scrolling to their
  text caret, or opening the nmap host they're inspecting. If you have split panes
  the first follow asks whether to drop the view into a pane or take over; per-
  teammate **precision** (jump to their exact spot vs. just open their view) is set
  in **Profile → Following**. Press **Stop** or navigate away to detach.
- **Offline-first**: IndexedDB caches every doc so the UI renders instantly and
  reconciles when the connection returns.

### Workspaces, navigation & layout

- **Workspaces**: create/switch/delete from the sidebar footer; the active
  workspace is remembered across reloads. All pages/graphs/scans/findings are
  scoped to it.
- **Tabs**: open pages, narratives, nmap groups/machines, Findings, Timeline,
  the Typst editor, and the Claude assistant as tabs. Cycle with **←/→**, close
  with **Alt+W**, and the **browser back/forward** buttons walk your tab history.
  **Drag a tab left or right** along its strip to reorder it (a bar shows where
  it lands; dropping on the empty end of the strip moves it last). The
  Properties panel's **Open version history** button turns into **Close
  version history** while that page's History tab is open, and the tab has its
  own close button in its header.
- **Split panes**: drag a tab to a pane edge (left/right/top/bottom) to split;
  drag the divider to resize; emptying a pane collapses the split automatically.
- **Command palette**: **Ctrl/⌘+K** to create pages/narratives, toggle dark
  mode, or jump to any page/graph by name. (If text is selected in the editor,
  Ctrl/⌘+K instead inserts a link.)
- **Search**: the sidebar search box does live title/tag search over pages.
- **Sidebars**: left = navigation tree (Pages, Attack Narratives, Attack Chains,
  Nmap Scans, plus Findings/Timeline shortcuts); right = context properties
  (node/edge editors, backlinks, "last edited by" badge, change log, page
  versions, export/import).

### Edit history & versioning

Two complementary systems. See [Edit history & rollback](#edit-history--versioning-detail)
below for the full mechanics:

- **Activity log**: every create/update/delete/restore on a workspace, page,
  graph, node, edge, or attack chain, with author + timestamp + a reversible
  field delta (or a full entity snapshot for deletes). Surfaced as the
  right-sidebar **History** feed and as per-entity "Last edited by …" badges;
  reversible entries get an **Undo** button.
- **Page version history (Google Docs style)**: the server keeps a version
  timeline per page. Versions are recorded automatically about two minutes
  after editing stops (and every ten minutes during a long session, and when
  the last editor leaves), on demand as **named** versions from the Properties
  panel or the History tab, and after every restore. Nothing is thinned; a
  named version is deleted by its author or an admin, an automatic one by an
  admin. **Open version history** opens a tab with the rendered version on the
  left and a day-grouped timeline on the right; **Show changes** colours every
  insertion and deletion since the previous version in the colour of the
  account that made it, and the timeline filters by person or by named
  versions only. **Restore this version** rewrites the live page as a normal
  edit (everyone sees it, later versions are kept) and records a "Restored …"
  version. Versions written by older builds appear as *imported* (restorable,
  without per-user colours).

### Export & import

- **Markdown**: per page (single `.md` or a `.zip`).
- **GraphML / JSON**: per attack narrative.
- **Lossless workspace ZIP**: the full workspace (every entity as JSON, plus
  per-page raw CRDT state and human-readable `.md`/`.graphml` companions), with
  *import-as-new* (re-IDed) or *replace-existing* modes.
- **Attack-path bundle**: an XML document combining path metadata, a filtered
  GraphML, and the linked write-up pages as markdown.

### Accounts, roles & settings

- **Auth**: username/password login (no self-signup; admins create accounts). A
  bootstrap `admin` account is created on first launch.
- **Admin panel** (admins only): create/delete users, reset passwords, toggle
  admin (the server blocks deleting yourself or the last admin), configure the
  **Claude AI Assistant** (API key, View/Edit mode, model, enable; see
  [AI assistant](#ai-assistant-claude)), and the **MCP Server** (enable, edit
  permissions, access token; see [MCP server](#mcp-server-connect-an-external-client)),
  and **Backups** (consistent scheduled snapshots to a host folder; see
  [Backups & restore](#backups--restore)).
- **Profile**: your presence **color**, your per-account **code accent**, and
  your **note heading colours** (one colour for every level, or per-level
  overrides; "Auto" inherits the body text). Changes preview live in open
  editors. **Export / Import** turns your settings into a JSON file
  (`btct-prefs-<username>.json`) you can keep and re-apply on another machine;
  an imported file is validated field by field and only applied when you Save.
- **Theme** (admins only): the workspace-wide accent color, the **default
  heading colours** for every account, and a **hardlock** that forces those
  heading colours on everyone (users' own choices are kept but ignored until
  unlocked). Saved server-side and pushed to every connected client live. Plus
  a per-client **dark/light** toggle.
- **Interface**: one look, **Glass**: floating translucent rails in the style
  of Apple's Liquid Glass on a dark-grey palette (one platform UI font for
  chrome, notes and form controls, semibold rather than bold, title-case
  section headers, flat sidebar rows with the coloured icon carrying the
  category, capsule chips, opaque menus and dialogs, a flat tinted primary
  button and no gloss gradients; it honours Reduce Transparency, Increase
  Contrast and Reduce Motion, and falls back to solid panels where
  `backdrop-filter` is missing). The earlier flat "Classic" theme and the
  per-account switcher were removed on 2026-08-28. See
  [Interface themes](#interface-themes) for how the look is layered. Dark and
  light mode remain a per-client toggle in the sidebar header.

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
| Editor | `Mod+K` / `Mod+Shift+K` ⚙ | Inline link editor (unlink if already a link) |
| Editor | `Mod+Shift+H` ⚙ | Highlight (re-applies the last color used) |
| Editor | `Mod+Shift+0..8` | Turn block into text / H1–H3 / to-do / lists / code |
| Editor | `` ` `` around a selection | Wrap selection as inline code |
| Editor | `[]` · `"` + space | To-do checkbox · quote block |
| Editor | `/` | Slash block-insert menu (`/bullet`, `/num`, `/todo`, …) |
| Editor | ``````````` + `Enter` | Code block (Shell unless a language follows the fence) |
| Editor | `Esc` | Select the current block (enter block mode) |
| Editor / Block mode | `Mod+A` | Ladder: block text → the block → all blocks |
| Editor / Block mode | `Mod+Shift+↑`/`↓` | Move the current / selected block up / down |
| Block mode | `↑`/`↓`, `Shift+↑`/`↓` | Move / extend the block selection |
| Block mode | `Mod+D`, `Backspace`/`Delete`, `Enter`, `Esc`/click | Duplicate / delete / edit / exit |
| Code block | `Mod+Shift+L` ⚙ | Focus language picker |
| Language picker | `↑`/`↓`, `Enter`, `Esc` | Navigate / select / close |
| Typst preview | click | Select the matching editable text in the source |
| Typst editor | `Mod+F` | Whole-document find & replace (`Enter`/`Shift+Enter` = next/previous match) |
| Typst editor | `Esc` | Close the search panel |
| Place-screenshot window | `Enter` / `Esc` | Place into the selected figure / cancel |
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
     `/api/settings`); see the [API reference](#server--http-api-reference).
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
> before you touch the data layer. Several non-obvious rules keep collaboration
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
findings. Those only exist inside the CRDT documents the clients share.

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
| **TypstAsset** | `id` (= server blob id), `workspaceId`, `kind` (`image`\|`font`), `filename` (also the `/assets/<name>` path in the Typst VFS), `mime`, `size`, `width?`/`height?`, `crop?` (`CropRect`, normalized 0..1; `null` = full image), `blurs?` (`BlurRegion[]`, normalized redaction rectangles; `null` = none), `fontFamily?`, timestamps. **Metadata only; the bytes live server-side.** |
| **CommandLogEntry** | `id` (agent-generated, the idempotency key), `workspaceId`, `operator`, `command` (redacted), `tool`, `cwd?`, `host?`, `localUser?`, `shellPid?`, `startedAt`, `receivedAt`, `exitCode?` (`null` = still running), `durationMs?`, `redacted?`. **No Y.Text fields**, all LWW JSON. Written **only by the server ingest endpoint**; the shared-doc copy is a bounded live window over the SQLite archive. |

Node `data` is polymorphic: `HostData` / `CredentialData` / `ServiceData` /
`FindingData` / `PivotData` (fields listed in the [graph feature
tour](#attack-narrative-graph)). Cast explicitly when reading.

### Data layer: database, repos, stores

- **[src/db/database.ts](src/db/database.ts)**: a Dexie-*shaped* API
  (`get`/`add`/`put`/`update`/`delete`/`where().equals()`) backed by the shared
  Y.Maps instead of IndexedDB tables. Every write is wrapped in a Yjs transaction.
- **`src/db/*-repo.ts`**: one repo per entity (`pageRepo`, `graphRepo`,
  `graphNodeRepo`, `graphEdgeRepo`, `attackChainRepo`, `workspaceRepo`,
  `changelogRepo`, `pageSnapshotRepo`, `nmapScanRepo`/`nmapMachineRepo`). Repos do
  CRUD + queries, **pre-seed `Y.Text`s on create**, and cascade deletes (deleting
  a node removes its edges, unlinks nmap, drops it from chains, and deletes its
  hidden page).
- **[src/stores/app-store.ts](src/stores/app-store.ts)**: the Zustand store:
  workspaces, pages, graphs, tabs, pane layout, selection, search, change log,
  nmap, attack chains. Mutating actions call the repos **and** the `log()` helper
  to write a change-log entry.
- **[src/stores/shared-bindings.ts](src/stores/shared-bindings.ts)**:
  `bindSharedSubscriptions()` wires each table's `Y.Map.observe` to a debounced
  store reload (`queueMicrotask`), so a burst of CRDT changes coalesces into one
  re-render.
- **[src/realtime/use-y-text.ts](src/realtime/use-y-text.ts)**:
  `useYTextInput(key, initial)` binds an `<input>` to a `Y.Text` with diff-based
  deltas and caret-preservation on remote edits.

### Editor internals

The page editor ([src/components/editor/PageEditor.tsx](src/components/editor/PageEditor.tsx))
mounts one Crepe instance per page, with the Toolbar feature disabled and these
custom plugins layered on:

- [src/lib/highlight-plugin.ts](src/lib/highlight-plugin.ts): the 7-color
  `highlight` mark + `ToggleHighlight` command. **Session-only**: its
  `parseMarkdown` is a no-op and `toMarkdown` drops the mark (keeps the text).
- [src/lib/code-theme.ts](src/lib/code-theme.ts): CodeMirror language list +
  a class-based `HighlightStyle` (`Prec.highest`) whose colors come from
  `--code-*` CSS vars; `applyCodeAccent(hex)` live-retints `--code-keyword`.
- [src/lib/theme.ts](src/lib/theme.ts): the accent (`applyThemeColor` writes
  `--primary`/`--ring`) and note heading colours (`applyHeadingColors` writes
  `--heading-color` and `--heading-1..6`). `resolveEffectiveHeadings` is the
  precedence rule: admin hardlock → the user's own prefs (as a whole, once
  customised) → admin defaults → inherit. Pure; tested in
  `src/test/theme-prefs.test.ts`. `src/stores/theme-store.ts` holds the admin
  policy, seeded by `GET /api/settings` and then followed live through the
  server-written `settingsPublic.theme` map.
- [src/themes/registry.ts](src/themes/registry.ts) + [src/themes/glass.css](src/themes/glass.css):
  the Glass look (see [Interface themes](#interface-themes)).
- [src/lib/editor-keybinds.ts](src/lib/editor-keybinds.ts):
  `codeBlockShellDefault` (schema default language = shell), `codeFenceInputRule`
  (replaces commonmark's ``` rule, which stores the captured language verbatim
  and so bypassed that default for a bare fence; `PageEditor` `remove()`s the
  preset's rule because input rules are first-match-wins), `userKeybindsPlugin`
  (runs *before* commonmark's keymap so rebinds win; also implements
  backtick-wrap), and `focusLanguageKeymap` + `installLanguagePickerNav()` for the
  language picker.
- [src/lib/editor-prefs.ts](src/lib/editor-prefs.ts): `EditorPrefs` shape,
  defaults, and the `parseShortcut`/`matchShortcut`/`shortcutFromEvent` helpers.
- [src/lib/block-select.ts](src/lib/block-select.ts): the Notion-style block
  selection plugin (its own selection state + node decorations).
- [src/lib/active-editor.ts](src/lib/active-editor.ts): module-level handle to
  the focused editor so `App.tsx` can hijack `Mod+K` for link insertion.

Live settings (keybinds, code accent) are applied through **module-level refs**
updated by an effect in `App.tsx`, never by rebuilding the editor, which would
tear down the Yjs collab binding.

### Interface themes

BTCT ships one look, **Glass**, declared in
[src/themes/registry.ts](src/themes/registry.ts) (`UI_THEME`, `applyUiTheme`).
The base stylesheet (`src/index.css` plus the Tailwind utilities in the
components) is what the skin restyles; it is never shown on its own. The
Classic theme, the layers switcher and the Profile "Interface" section were
removed on 2026-08-28; a `prefs.uiTheme` still stored on an account is ignored.

- **Glass** is [src/themes/glass.css](src/themes/glass.css), imported once in
  `src/main.tsx`, with every rule scoped under `html[data-ui-theme="glass"]`
  (`index.html` carries the attribute so the first paint is already Glass,
  and `main.tsx` stamps it again at boot).
  It restyles the surfaces the components already render and adds no
  components and no JavaScript. Two mechanics make that possible: Tailwind v4
  emits utilities inside `@layer utilities`, and an unlayered stylesheet beats
  layered rules by cascade-layer order, so the skin can override
  `bg-[hsl(var(--card))]`-style recipes without specificity games (every
  restyled surface therefore carries its own `:hover`, because the utility's
  hover loses too); and selectors match class tokens (`[class~="…"]`), never
  substrings, so `hover:` and `/10` variants are not caught by accident. Five
  `data-ui` hooks (`shell`, `main`, `sidebar`, `tabbar`, `toolbar`) mark the
  only places where the layout itself changes (floating rails with gaps).
- The design follows Apple's Liquid Glass rules. The material is a tint plus
  `blur(24px) saturate(150%)`, a 1px rim that is brighter along the top edge
  and one soft shadow; it sits only on the rails, the tab strip and the
  toolbars, while every pop-up (dialogs, menus, popovers), the content
  column, cards and graph nodes are opaque, and glass never stacks on glass. Radii are concentric: an 8px
  shell gap, 18px rails, 10px groups, 8px controls, capsules for chips.
  Type is one platform face (SF Pro on a Mac, Segoe UI Variable on Windows)
  applied to the body, the note editor and form controls, on a 600/500/400
  weight scale: `font-bold` renders as 600, and the classic theme's
  uppercase micro-labels become title-case 11px semibold headers on the
  secondary label colour (0.86 / 0.55 / 0.30 white in dark mode). Sidebar
  rows lose their tinted frames (the coloured icon carries the category),
  are 28px tall with 2px gaps, and every icon in the rail sits at the same
  x, page rows reserving a 16px disclosure gutter. Nested page trees draw
  FolderPalette-style tree lines: a 1px grey L with a 5px rounded corner from
  the parent's chevron into each child row, a vertical run to the next
  sibling only, no tail after the last child (per-child `::before` and
  `::after`, the container itself has no border). The row whose entity is
  the active tab carries `data-active` and a rounded grey fill, the
  disclosure chevrons are one arrow that rotates (right closed, down open),
  and every dialog is opaque. Motion is 160ms ease-out
  for colour, 120ms for the press scale, a short fade or scale on menus and
  sheets, and nothing under Reduce Motion. The wallpaper is one flat colour
  with a single soft glow so the blur has something to reveal; the primary
  button is a flat tint with no gloss.
- The rails and the content column never create stacking contexts or
  containing blocks (no `backdrop-filter`, `filter`, `transform`,
  `isolation` or `z-index` on them): dialogs render inside those elements
  with `position: fixed` and would be trapped behind later siblings. The
  blurred material lives on a `::before` with `z-index: -1` instead, and the
  rails' mount animation ends at `transform: none` and full opacity.
- A skin never resets `transform` on `*`, not even under Reduce Motion. The
  Typst preview is an SVG positioned entirely by `transform` attributes, and
  a CSS transform overrides the attribute: every glyph collapses onto the
  page origin at font-unit scale and the page renders as a black blob. React
  Flow places its viewport and nodes with inline transforms the same way.
  Reduce Motion turns off transitions and animations and resets only the
  transforms the skin itself sets (the press scale);
  `src/test/glass-theme.test.ts` guards the rule.
**Bringing a second look back.** Give the new sheet its own
`html[data-ui-theme="…"]` scope, turn `UI_THEME` back into a registry list
with a default, and reintroduce a per-account pref (the server's profile
route still accepts a short `prefs.uiTheme` slug). The base stylesheet is
not a usable look by itself any more: the sidebar, tab strip and dialogs
were laid out for the skin.

### Server & HTTP API reference

Base URL defaults to the same origin. Bearer token from `/api/login`
(`Authorization: Bearer <jwt>`, 7-day TTL). Implemented in
[server/index.mjs](server/index.mjs); auth crypto in
[server/auth.mjs](server/auth.mjs); SQLite in [server/db.mjs](server/db.mjs).

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | Liveness probe (`{ ok: true }`) |
| `GET` | `/api/settings` | none | Public theme: `themeColor`, `themeHeadings`, `themeLock`, `themeUpdatedAt` (so login paints correctly) |
| `POST` | `/api/settings/theme` | admin | Set any of `color`, `headings`, `lock`; the result is mirrored into the shared doc (`settingsPublic.theme`) |
| `POST` | `/api/login` | none | Authenticate → `{ token, user }` |
| `GET` | `/api/me` | yes | Current user |
| `POST` | `/api/me/profile` | yes | Update own `color` and/or `prefs` (`codeAccent`, `keybinds`, `follow`, `theme`; a legacy `uiTheme` slug is accepted and ignored) |
| `GET` | `/api/admin/users` | admin | List users |
| `POST` | `/api/admin/users` | admin | Create user (username 3–32, password ≥8) |
| `DELETE` | `/api/admin/users/:id` | admin | Delete user (not self / not last admin) |
| `POST` | `/api/admin/users/:id/password` | admin | Reset a user's password |
| `GET` | `/api/ai/config` | yes | Claude assistant config: `{ enabled, mode, model, configured }` (never the key) |
| `POST` | `/api/ai/config` | admin | Set the API key / mode (`view`\|`edit`) / model / enabled |
| `POST` | `/api/ai/config/test` | admin | Live connection test with the stored key (no key returned) |
| `POST` | `/api/ai/chat` | yes | Agentic chat over workspace data; **SSE** stream. Tool loop runs server-side against the live CRDT; write tools gated to `edit` mode |
| `GET` | `/api/ai/sessions` | yes | List the caller's saved chat sessions (metadata, newest first) |
| `GET` | `/api/ai/sessions/:id` | yes | Get one session incl. messages (404 if not the caller's) |
| `POST` | `/api/ai/sessions/:id` | yes | Create/update a session (`{ title, messages }`); upsert, scoped to caller |
| `DELETE` | `/api/ai/sessions/:id` | yes | Delete one of the caller's sessions |
| `POST` | `/api/assets?workspaceId&kind&filename` | yes | Upload one Typst asset. Body is **raw bytes** (not multipart/JSON). `kind` = `image`\|`font`; max 25 MB; extension must be allowed. An image's extension is corrected to match its actual magic number → `{ asset }` |
| `GET` | `/api/assets?workspaceId=…` | yes | Metadata inventory of a workspace's assets |
| `GET` | `/api/assets/:id` | yes | The raw asset bytes (`Cache-Control: immutable`, since bytes never change for an id) |
| `DELETE` | `/api/assets/:id` | uploader/admin | Delete the row **and** the file on disk |
| `GET` | `/api/pages/:id/versions` | yes | Version timeline of a page, newest first: `{ versions, users, tracked, dirty, twinExists }`. Imports the page's legacy `pageSnapshots` rows on first read |
| `POST` | `/api/pages/:id/versions` | yes | Record a version of the open page now (`{ name?, trigger: 'named' \| 'restore' }`); 409 when the page room is not open on the server |
| `GET` | `/api/pages/:id/versions/:vid` | yes | One version with its twin `snapshot` and full `state` (both base64; the state is derived from the twin when the row has none) |
| `POST` | `/api/pages/:id/versions/:vid/name` | yes (author/admin to rename a named one) | Name or rename a version (`{ name }`, empty clears) |
| `DELETE` | `/api/pages/:id/versions/:vid` | author (named) / admin | Delete one version |
| `GET` | `/api/pages/:id/history/twin` | yes | The page's GC-off history twin as one Yjs update (`application/octet-stream`, gzipped when accepted) |
| `GET` | `/api/mcp/config` | admin | MCP server config incl. the bearer token (so it can be copied) |
| `POST` | `/api/mcp/config` | admin | Enable/disable + set mode (`read`/`edit`); mints a token on first enable |
| `POST` | `/api/mcp/token` | admin | Regenerate (rotate) the MCP bearer token |
| `POST` | `/mcp` | MCP token | Streamable-HTTP MCP endpoint (own bearer auth). Read tools always; write tools in `edit` mode |
| `POST` | `/api/cmdlog/events` | ingest token | Batch ingest from a capture agent (`{ workspace?, events[] }`); upserts by id into SQLite + the CRDT live window |
| `GET` | `/api/cmdlog/whitelist` | ingest token | Tool whitelist the agent fetches + refreshes |
| `GET` | `/api/cmdlog/query` | yes | Filtered read of the durable archive (`workspaceId, operator, tool, host, from, to, q, status, limit`) |
| `POST` | `/api/cmdlog/manual` | yes | Hand-enter one command-log record (as any operator); writes to SQLite + the CRDT live window, never redacted |
| `GET` | `/api/cmdlog/config` | admin | Command-log config incl. token, whitelist, default workspace |
| `POST` | `/api/cmdlog/config` | admin | Enable/disable, set whitelist + default workspace (mints a token on first enable) |
| `POST` | `/api/cmdlog/token` | admin | Regenerate (rotate) the ingest token |
| `DELETE` | `/api/cmdlog/logs?workspaceId=…` | admin | Purge a workspace's command-log archive |
| `GET` | `/api/backup/config` | admin | Backup settings: `enabled`, `fullIntervalMin`, `includes`, folder, host token |
| `POST` | `/api/backup/config` | admin | Update any of `enabled`, `fullIntervalMin`, `includes` |
| `POST` | `/api/backup/token` | admin | Regenerate the host-scheduler token |
| `GET` | `/api/backup/status` | admin or backup token | Last/next run, last error, folder writability, disk usage |
| `POST` | `/api/backup/run` | admin or backup token | Run a backup now (409 while one is already running) |
| `GET` | `/api/backup/list` | admin | Inventory of backup folders |
| `DELETE` | `/api/backup/archives/:name` | admin | Delete one backup folder |
| WS | `/yjs/<room>?token=<jwt>` | yes (at upgrade) | Yjs CRDT relay; rooms = `btct-shared` + one per page id |

The `users` table is `(id, username [NOCASE unique], salt, hash, iter, color,
avatar, is_admin, prefs [JSON], created_at)`. The `prefs` column is added by an
idempotent migration. Per-account editor prefs (`codeAccent`, `keybinds`,
`follow`, `theme`) are validated at the REST edge and stored as a JSON blob.
The `settings` table is a simple key/value store: the theme policy
(`theme_color`, `theme_headings`, `theme_lock`, `theme_updated_at`), the Claude
assistant config
(`anthropic_api_key`, `ai_mode`, `ai_model`, `ai_enabled`, where the key is
write-only and never returned to clients), and the MCP server config
(`mcp_enabled`, `mcp_mode`, `mcp_token`; the token is admin-readable so it can be
copied into a client). The `chat_sessions` table
(`id, user_id, title, messages [JSON], created_at, updated_at`) holds each
account's durable Claude conversations, scoped and pruned per user. The
`assets` table (`id, workspace_id, kind, filename, mime, size, uploaded_by,
created_at`) is the server's inventory of the Typst blobs it stores; the bytes
live as files under `ASSETS_DIR` named by the row's uuid. This is the **only**
place the server holds workspace content on disk, and it stays deliberately
dumb about meaning. The crop rectangle and display name are CRDT records, not
columns here. See [server/assets.mjs](server/assets.mjs). The `command_logs`
table (`id, workspace_id, operator, command, tool, cwd, host, local_user,
shell_pid, started_at, received_at, exit_code, duration_ms, redacted`) is the
**durable, unbounded archive** of every command captured by the cmdlog agents;
rows are upserted by the agent-generated `id` (so a start event and its later
exit/duration completion merge, and a replayed batch is a no-op), and the shared
Yjs doc mirrors only the most recent ~500 per workspace for the live view. Ingest
uses a static bearer token (`cmdlog_enabled`/`cmdlog_token`/`cmdlog_whitelist`/
`cmdlog_workspace` in `settings`, token admin-readable). See
[server/cmdlog.mjs](server/cmdlog.mjs).

**Environment variables:** `AUTH_SECRET` (required in prod; HMAC key, random &
ephemeral if unset, which silently invalidates tokens on restart), `HOST`,
`PORT`, `STATIC_DIR`, `DB_PATH`, `ASSETS_DIR` (Typst image/font blobs; defaults
to `assets/` beside `DB_PATH`, i.e. `/data/assets` in Docker), `HISTORY_DIR`
(per-page GC-off history twins behind version diffs; defaults to `history/`
beside `DB_PATH`, i.e. `/data/history` in Docker), `YPERSISTENCE`
(LevelDB dir; **set it or Yjs rooms are memory-only**), `BACKUP_DIR` (where
scheduled backups are written; `/backups` in Docker, bind-mounted from
`./backups`, else `backups/` beside `DB_PATH`),
`ALLOWED_ORIGIN` (CORS; unset = same-origin),
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
    ai/                       AiAssistant (chat pane), ThinkingIndicator
                              (agent activity), markdown.tsx (shiki renderer)
    typst/                    TypstView (3-pane editor+preview+assets tab,
                              resizable) TypstEditor (collab CodeMirror),
                              TypstSearchPanel (whole-doc find/replace overlay),
                              TypstPreview (local SVG render), TypstAssetsPanel
                              (image/font drop zone), PlaceScreenshotDialog
                              (viewport editor + figure-slot picker),
                              FigureViewport (the framing surface)
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
                              typst-compiler (local WASM compile→SVG/PDF, shadow
                              FS + custom fonts) + typst-language (CodeMirror
                              Typst highlighting) + typst-assets (upload/fetch/
                              crop/blur/border-detect) + crop-math (pure crop
                              geometry) + blur-math (pure blur-region geometry
                              + strength heuristics) + typst-placeholders (figure-slot
                              scanning + source rewriting) + pane-resize (pane
                              width clamping + layout persistence) +
                              image-format (magic-number sniffing) +
                              typst-source-map (preview click → source offset,
                              prefers editable body over design regions) +
                              typst-search (whole-document find/replace engine)
                              + typst-geometry (page/figure box sizing) + utils
  realtime/                   shared-doc.ts (shared Y.Doc + Y.Text registry),
                              yjs-providers.ts (per-page docs), page-snapshots.ts,
                              use-y-text.ts, PresenceAvatars.tsx
  stores/                     app-store.ts, shared-bindings.ts, theme-store.ts
  test/                       Vitest suites + fixtures
  types/index.ts              All shared types + default factories
server/
  index.mjs                   HTTP + WS entry, all REST routes, static serving
  auth.mjs                    PBKDF2 hashing + HMAC token sign/verify
  db.mjs                      bun:sqlite users + settings + assets + command_logs + page_versions, migrations
  assets.mjs                  Typst image/font blob store (disk + metadata rows)
  history.mjs                 Page version history: GC-off twin per room, auto/named/restore versions, twin + version routes
  history-diff.mjs            Who changed a page body between two snapshots (pure, Yjs injected, unit-tested)
  cmdlog.mjs                  Command-log ingest + config (SQLite archive + CRDT live window)
  scheduler.mjs               Single-timeout job scheduler: no overlap, no drift, persisted last run
  backup-format.mjs           Backup folder layout, manifest build/verify, config normalisation (pure)
  data-export.mjs             Consistent reads: VACUUM INTO, per-room Yjs updates, asset inventory
  backup.mjs                  Backup engine: config, scheduled + manual runs, inventory, host token
  restore.mjs                 Restore CLI (run with the server stopped)
cmdlog-agent/                 Standalone Python 3 shell-capture agent (own README + tests)
  btct_agent/                 matcher, redactor, spool, shipper, daemon, installer, hooks/
```

> Adding a file under `server/` means adding a `COPY server/<file>.mjs` line to
> the [Dockerfile](Dockerfile). Server files are copied individually, so a new
> one is silently missing from the image otherwise.

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
   server; it only relays Yjs, serves static files, does auth/settings, and
   stores opaque asset blobs. The three deliberate exceptions are the AI
   assistant (which reads/writes the CRDT in-process),
   [assets.mjs](server/assets.mjs), which is only *storage* (it knows a blob's size
   and mime, never what it means), and [cmdlog.mjs](server/cmdlog.mjs), which ingests
   externally-produced command records into SQLite + the CRDT (it validates and
   stores, and knows nothing about what a command means). Server-side CRDT writes
   must honour the Y.Text rule; command logs sidestep it by having **no** Y.Text
   fields (all LWW JSON, like typst assets).
8. **Binary content never goes in the CRDT.** Images and fonts are uploaded to
   the server and referenced from the shared doc by id; only small metadata
   records sync. Base64 blobs in the shared doc get broadcast to *and
   permanently cached by* every connected client. The one exception is page
   snapshots, which are intentionally-bounded Yjs update bytes.
9. **Crops and blurs are render-time transforms, never destructive edits.** A
   `CropRect` and any `BlurRegion[]` are stored on the asset record and applied
   when the bytes are handed to the compiler. Never re-upload transformed
   pixels over the original. It would make the edit irreversible and (for
   crops) degrade the image on each pass. Blur regions are normalized against
   the *original* image, not the crop, so re-framing never moves a redaction;
   the blur itself is downscale-then-gaussian (see
   [blur-math.ts](src/lib/blur-math.ts)) because a plain gaussian of readable
   text can sometimes be reversed.
10. **Typst assets have no `Y.Text` fields, deliberately.** Filenames, crop
   rects, and blur regions are last-writer-wins JSON: concurrent
   character-by-character editing of a filename isn't a workflow worth
   supporting, so invariant 1 doesn't apply to `typstAssets`.
11. **Preview and PDF must compile the same virtual path.** Both go through
   `/main.typ` in [typst-compiler.ts](src/lib/typst-compiler.ts). If they
   diverge, relative `#image(…)` paths resolve differently and PDF export
   breaks *only for documents that use assets*, a nasty, late-surfacing bug.
12. **Programmatic source edits go through `replaceYTextContent`**, which
   splices a minimal delta. Never clear-and-reinsert a Y.Text: it deletes
   every character and re-adds it, destroying collaborators' cursors and
   making the change unmergeable with a concurrent edit.
13. **Re-scan slots after any other source rewrite.** `ScreenshotSlot` carries
   raw character offsets, so upgrading the helper (which shifts everything
   below it) invalidates every offset measured beforehand. `ensureHelper()`
   first, *then* `findScreenshotSlots()`, then `setSlotPath()`, matching
   slots across the rewrite by their `index`, not their offsets.
14. **Pane drags write to the DOM, not to React state.** `TypstView` sets the
   pane's `style.width` directly per animation frame and commits to state
   once on pointer-up. A re-render mid-drag would reconcile the whole tab
   every frame and (the real hazard) risk remounting the CodeMirror host,
   dropping the Yjs collab binding and every remote cursor with it.
15. **Mounted bytes must match the extension they're mounted at.** Typst
   selects its image decoder from the file extension, so PNG bytes at a
   `.jpg` path fail with `Illegal start bytes: 8950`. `resolveAssetBytes()`
   encodes crops to the format the *filename* claims (not always PNG) and
   re-encodes uncropped bytes that disagree with their extension, so a
   mislabelled upload self-heals. GIF and SVG are passed through untouched;
   a canvas can't produce them. See [image-format.ts](src/lib/image-format.ts).
16. **Only the preview may coalesce compiles.** `compileTypstSvg(src, {
   coalesce: true })` skips a queued compile that a newer one has superseded.
   Exports must never pass it: an export queued behind a preview would be
   silently dropped and reported as a failure.
17. **DB migrations must be idempotent.** Guard every `ALTER TABLE` with a column
   check (see the `prefs`/`avatar`/`is_admin` migration in `db.mjs`).
18. **Set `AUTH_SECRET` and `YPERSISTENCE`** in any real deployment, or tokens and
   rooms evaporate on restart.
19. **Theme precedence lives in one function.** Every heading-colour write goes
   through `resolveEffectiveHeadings` + `applyHeadingColors` from `App.tsx`.
   The admin policy reaches clients by REST seed (`GET /api/settings`) and then
   the server-written `settingsPublic.theme` map in the shared doc, stamped with
   `themeUpdatedAt` so a stale IndexedDB replay never beats a newer value. Never
   put anything secret in `settingsPublic`: the whole doc reaches every user.
20. **Never copy the live SQLite file or the LevelDB directory.** A WAL-mode
   database copied mid-transaction and an open LevelDB copied mid-compaction
   are both corrupt. Read through `server/data-export.mjs` (`VACUUM INTO`,
   per-room Yjs updates) as the backup engine does, or stop the container first.
21. **Interface skins stay in their own scoped stylesheet.** A theme is a
   registry entry plus one file scoped under `html[data-ui-theme="…"]`; never
   branch component code on the theme. In that file, never give the rails or
   the content column a stacking context (dialogs render inside them with
   `position: fixed`), match class tokens with `[class~=]`, and pair every
   restyled surface with its own `:hover` (unlayered rules beat Tailwind's
   hover utilities too).
22. **No native browser dialogs, and native controls follow the theme.**
   `window.confirm`, `window.prompt` and `window.alert` paint outside the
   skin; use `src/components/ui/ConfirmDialog.tsx` (a portal sheet with an
   optional input) or an inline notice. `index.css` declares `color-scheme`
   on `:root` and `.dark` so select popups, date and colour pickers and
   spinners render in the right scheme, gives `select` its own chevron and
   the range/checkbox/date inputs the accent colour. The audit that
   introduced this is [docs/ui-audit-2026-08-28.md](docs/ui-audit-2026-08-28.md).
23. **Tabs reconcile against the shared doc, and the active pane is always a
   live leaf.** `reconcileTabs()` (app-store) prunes tabs whose page, graph
   or scan no longer exists; it runs after the pages/graphs/nmapScans
   reloads and after local deletes, and is a no-op until the shared doc has
   synced. Every layout change goes through `reconcileActive()` so
   `activePaneId`/`activeTabId` never point at a collapsed pane, and
   `moveTab` (pane-layout) removes, adds, then collapses, in that order. When
   you add a way to change the layout, keep both.
24. **Bulk record creation outside the repos seeds its `Y.Text`s.** The demo
   seed and the zip import write records directly, so they call
   `seedMissingYTexts(getSharedDoc())` afterwards; a record without its
   `Y.Text` silently drops inline title edits until a reload. Deleting a
   record through `database.ts` drops its texts (`deleteTextsFor`).
25. **First paint stays small.** Heavy tab views (graph, nmap, findings,
   timeline, Typst, assistant, command log, history) are `React.lazy`
   imports behind one `Suspense` in `SplitContainer`; a new `TabKind` view
   should be too. No external font requests (the skin uses the system
   stack) and no multi-megabyte images in `public/` (the logo ships as
   `new-logo-64.png`, `apple-touch-icon.png` and `new-logo.ico`). The server
   marks only `/assets/*` (hashed) `immutable`; everything else is
   `no-cache` with an ETag. Audit record:
   [docs/perf-bug-audit-2026-08-28.md](docs/perf-bug-audit-2026-08-28.md).

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
  `editor-keybinds.ts`; add a button to the floating toolbar in `PageEditor.tsx`.
- **New "turn into" target / block shortcut** → add to `TurnIntoTarget`,
  `TURN_INTO_ITEMS`, and `digitToTarget` in `lib/turn-into.ts`; the toolbar
  dropdown and the `Ctrl/⌘+Shift+digit` handler both read from there.
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
  cmdlog.mjs               Command-log ingest + config
  backup.mjs, restore.mjs  Backup engine + restore CLI (with scheduler, backup-format, data-export)
cmdlog-agent/              Standalone Python 3 command-capture agent (stdlib only)
blog/                      Short illustrated write-up (why it exists + feature tour)
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
- **Docker Desktop for Windows** (WSL2 backend): installed and running
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

The default bootstrap admin is **`admin` / `changeme!`**. Change it immediately from
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

**On the Docker host itself, open `http://127.0.0.1:8080`, not `localhost`.**
Browsers and curl resolve `localhost` to `::1` first. With Docker Desktop on
WSL2, Windows' localhost relay (`wslrelay.exe`) listens on `[::1]:8080` as well
as `127.0.0.1:8080`, but only the IPv4 side is forwarded into the Docker VM: the
IPv6 connection is accepted and then never answered, and because the TCP
connect succeeded the browser does not fall back to IPv4, so the page spins
forever. `netstat -ano | findstr :8080` shows the relay owning `[::1]:8080`.
Other machines on the LAN are unaffected (they use the IPv4 address).

### Dev mode (hot reload, without Docker)

```powershell
bun install
bun install --cwd server

# Terminal 1: server
cd server
$env:AUTH_SECRET = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
$env:ALLOWED_ORIGIN = 'http://127.0.0.1:5173'
$env:YPERSISTENCE = '../data/yjs'   # local dev persistence; safe to delete
bun run start

# Terminal 2: client
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
| Page version timeline (who changed what, named versions) | `/data/data.sqlite` + `/data/history/` | yes |
| Typst screenshots + custom fonts (raw bytes) | `/data/assets/` | yes |
| Typst asset metadata (names, crop rects, blur regions, font families) | `/data/yjs/` | yes |

So **every code update, image rebuild, or container restart preserves all your
data.** The only commands that destroy it are `docker compose down -v` or manually
`docker volume rm beenthereconqueredthat_btct-data`. No launcher/update flow ever
runs those.

> Yjs persistence is provided by y-leveldb (enabled via `YPERSISTENCE=/data/yjs`).
> Without it, rooms live only in memory and rely on clients to re-seed from
> IndexedDB, which is fragile across restarts. With it, the server is the source of truth
> on disk.

---

## Backups & restore

BTCT backs itself up from inside the container, so a snapshot is **consistent**
even while people are editing: SQLite is exported with `VACUUM INTO` (never a
raw copy of a WAL-mode file), every Yjs room is written out as one update
(never a copy of the open LevelDB directory), and uploaded assets are copied
by id. Configure it in **Admin panel → Backups**.

**Where backups go.** One folder per run under the host folder bind-mounted at
`/backups` (`./backups` next to `docker-compose.yml`; change the left side of
the `./backups:/backups` line to put them elsewhere, e.g. `C:/btct/backups` or
`/srv/btct/backups`). Docker Desktop must have file sharing enabled for that
drive; on Linux add `user:` to the service so the files are not root-owned.

```
backups/btct-backup-20260823-101500/
  manifest.json                 what is inside + sha256 of every file
  sqlite/data.sqlite.gz         accounts, settings, chat sessions, asset index
  yjs/btct-shared.yupdate.gz    workspace metadata (pages list, graphs, findings, ...)
  yjs/<pageId>.yupdate.gz       one per page body
  assets/<id>                   uploaded screenshots and fonts
  history/<pageId>.ydoc         GC-off history twin per page (what version diffs render from)
```

A run is built under a `.tmp` name and renamed into place only after the
manifest is written, so an interrupted run never passes for a backup.

**Schedule and selection.** Turn on *Scheduled backups* and pick the interval
in minutes (minimum 1; the last run is remembered, so an overdue backup fires
right after a restart). The four checkboxes choose what a run covers; leaving
out accounts or workspace metadata makes the run restorable only with
`--partial`. *Back up now* runs one immediately. Nothing is deleted
automatically: the panel lists every run with its size and a bin icon removes
one.

**Host scheduler (optional).** To drive it from the host instead, the panel
shows a token and a ready-made command:

```bash
curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:8080/api/backup/run
```

Windows: create a Task Scheduler task that runs that `curl.exe` command every
N minutes *as your user* (Docker Desktop needs a logged-in session, so not as
SYSTEM), or point it at `Backup-BTCT.ps1`, which wraps the call. Linux: a cron
line or a systemd timer with `Persistent=true` running the same command.

**Restore.** With the container stopped, run the restore CLI inside the same
image, pointing at a backup folder:

```powershell
docker compose stop btct
docker compose run --rm btct bun server/restore.mjs /backups/btct-backup-20260823-101500 --yes
docker compose start btct
```

It re-hashes every file against the manifest first, refuses to run while the
server still holds the LevelDB lock, moves the current data into
`/data/pre-restore-<stamp>/` (kept, not deleted), then writes the SQLite file
(without any stale `-wal`/`-shm`), rebuilds the Yjs rooms through y-leveldb,
and copies the assets. `--partial` restores a backup that lacks a category on
top of the existing data. `Restore-BTCT.ps1` wraps the three commands.

A cold, byte-for-byte copy of the volume (for migrations) is still possible
with `docker run --rm -v beenthereconqueredthat_btct-data:/data:ro -v ${PWD}/backups:/backup alpine tar czf /backup/volume.tgz -C /data .`,
but only with the container stopped; a copy of the live files can be corrupt.

For *per-workspace* portability (no users/SQLite) use the in-app
[Lossless workspace ZIP](#export--import) instead.

<a id="edit-history--versioning-detail"></a>
### Edit history & rollback (mechanics)

BTCT records who did what to every entity and lets you roll back specific actions.

**Activity log**: every create/update/delete/restore on a workspace, page,
graph, node, edge, or attack chain writes a `changeLogs` entry into the shared
doc with the author (captured at write time so it survives a user being
renamed/removed), a millisecond timestamp, a **field-level delta** (prev + new
for single-field updates, which is what makes it reversible), and a **full entity
snapshot** for deletes. It surfaces as the right-sidebar **History** feed and as
per-entity *Last edited by …* badges. Reversible entries get a **Restore** button:
updates re-apply the previous value; deletes re-create the entity from the
snapshot (reusing the original ID so references resolve). Restores are themselves
logged.

**Page version history**: page bodies live in their own per-page Yjs doc, and
the live docs are garbage-collected, so once a deletion has reached every
client the bytes are gone and nothing can say who wrote what. The server
therefore keeps a **GC-off twin** of every open page room
([server/history.mjs](server/history.mjs)): the relay doc's `update` events are
applied to the twin, which is flushed to `HISTORY_DIR/<pageId>.ydoc` (5 s
debounce, on every version, and when the room closes). A **version** is a Yjs
snapshot of the twin (a state vector plus a delete set, a few hundred bytes)
in the `page_versions` SQLite table with `trigger` (`auto`, `named`,
`restore`, `import`), an optional name, the creator, and `changed_by`: the
accounts whose edits landed since the previous version. Attribution comes from
`Y.PermanentUserData`: every client maps its clientID to its account id in the
page doc's `users` map when the doc has synced (`attachUserMapping` in
[src/realtime/page-history-api.ts](src/realtime/page-history-api.ts)) and records
the delete sets of its own transactions there, so insertions are credited to
the writer and deletions to the deleter. `server/history-diff.mjs` (pure,
unit-tested) walks the twin between two snapshots and only counts items inside
the `prosemirror` fragment, so opening a page (which writes the mapping) is
not an edit. Policy: an automatic version two minutes after the last update,
or every ten minutes of continuous editing, or on room close, skipped when the
body did not change; named and restore versions on request; no thinning.

The **History tab** (`kind: 'history'`,
[src/components/history/HistoryView.tsx](src/components/history/HistoryView.tsx))
downloads the twin once (`GET /api/pages/:id/history/twin`, gzipped) and each
selected version's snapshot, builds a local GC-off doc, and renders it in its
own read-only ProseMirror view with the editor's schema extended by a
`ychange` attribute and mark ([src/lib/history-schema.ts](src/lib/history-schema.ts)).
"Show changes" hands y-prosemirror's snapshot renderer the version and the
previous diffable version; it tags every added or removed node and text run
with `data-ychange-type` and the author's colour, which `index.css` paints.
The viewer never touches a live editor (invariant #3). **Restore** fetches the
version's full state (derived on the server with `Y.createDocFromSnapshot`),
and, when the page is open in a tab, applies it as one ProseMirror transaction
through that editor so the collab binding emits a minimal Yjs delta and remote
cursors survive; otherwise it clones the fragment into the live doc in one Yjs
transaction. Either way a `restore` version is recorded afterwards. The
pre-history `pageSnapshots` CRDT rows are imported into `page_versions` as
`import` versions (full state, restorable, not diffable) the first time a
page's history is listed, and removed from the shared doc.

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

- **Tokens in `localStorage`**: XSS in the editor would leak them.
- **No CSRF protection** on `/api/*` beyond the bearer-token convention.
- **No rate limiting** on `/api/login` (PBKDF2 is the only brute-force cost).
- **No account lockout, MFA, or self-service password reset.**
- **Yjs WS auth is checked once at upgrade**: a revoked account keeps editing
  until the socket drops.
- **No per-workspace authorization**: every authenticated user sees every
  workspace.
- **`AUTH_SECRET` defaults to a random ephemeral value** when unset; tokens are
  silently invalidated on restart. Always set it in `.env`.
- **HTTPS / WSS is not built in**: terminate TLS in nginx/Caddy.
- **No CSP / Trusted Types.** Treat untrusted markdown as untrusted.

Threat model: trusted teammates on a LAN segment during an engagement. Anything
beyond that needs additional work.

---

## License

Internal tooling. Not licensed for redistribution.
