# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

BTCT ("Been There, Conquered That") is a real-time, multi-user pentest note-taking / reporting app: collaborative markdown pages, attack-narrative graphs, nmap import, findings/timeline, Typst reports, and an embedded Claude assistant. Runtime is **Bun** everywhere; the whole thing ships as one Docker image.

## Keep the docs in sync (do this on every change)

Whenever you modify the codebase, update **both this `CLAUDE.md` and `README.md`** in the same change so they never drift from the code:
- New/changed **feature** → update the README feature tour (and its Table of Contents anchor) and, if it introduces a new architectural concept/invariant/module, update the relevant section here.
- New/changed **command, script, env var, or run/deploy step** → update the Commands section in both files.
- New/changed **HTTP route, DB table/column, or keyboard shortcut** → update the README API table / DB notes / shortcuts table, and this file's architecture/invariants if the behavior is non-obvious.
- New **invariant or convention** a future contributor could break → add it to the "Critical invariants" list here and the README "Conventions & invariants".

Prefer editing existing sections over appending duplicates; keep `CLAUDE.md` concise (commands + big picture + non-obvious rules) and let `README.md` hold the exhaustive detail.

## Writing style for generated prose

**Never use em dashes (`—`) in anything you write.** Not in docs, not in commit messages, not in code comments, not in PR descriptions, not in the blog. An em dash is almost always a decision that got skipped, so make the decision instead:

| Instead of | Use |
|---|---|
| `Notes went in Word — five operators, five documents` | a full stop: `Notes went in Word. Five operators, five documents` |
| `- **Term** — definition` | a colon: `- **Term**: definition` |
| `read — and, when allowed, edit — the workspace` | parentheses: `read (and, when allowed, edit) the workspace` |
| `it renders offline — no network calls` | a comma: `it renders offline, with no network calls` |
| a table cell containing only `—` | `none` |

En dashes are fine in real ranges (`H1–H3`, `3–32`) and inside literal UI strings you are quoting. Run `grep -c '—' <file>` before you call a doc change done. It should be `0` everywhere; the table just above is the only deliberate exception in this repo, because it has to quote the character to name it.

Related habits worth keeping: skip the ban-list words (seamless, leverage, robust, comprehensive, delve, unlock, supercharge), do not bold every feature noun, and vary sentence length instead of writing everything at 20 words.

### Writing for `blog/`

Before generating or editing prose in [`blog/`](blog/), read the style corpus at `C:\Users\rober\Desktop\ai-context\human-text-context\`. It holds attributed excerpts from Julia Evans, Dan Luu, Paul Graham, Simon Willison and the Fly.io blog, each with a "what to steal" note, plus `../skills.md` with the full checklist. The blog is written in first person as the author of BTCT, so it should read like an engineer explaining a tool they built, not like a product page. Ground claims in specific numbers and name the things that did not work.

## Commands

Client (repo root; run scripts with `bun run`):
- `bun install`: install client deps.
- `bun run dev`: Vite dev server (hot reload). Needs the server running separately (below).
- `bun run build`: **typecheck + build**: `tsc -b && vite build`. This is the canonical "does it compile" check.
- `bun run lint`: ESLint.
- `bun run test`: Vitest (all suites, in `src/test/`).
  - Single file: `bun run test -- src/test/pane-layout.test.ts`
  - By name: `bun run test -- -t "moveTab"`
- `bun run seed`: seed a demo workspace (`vite-node src/db/seed.ts`).

Server (in `server/`, plain `.mjs`, no build step; Bun runs it directly):
- `cd server && bun install`
- `cd server && bun run dev`: server with `--watch`. Requires env: `AUTH_SECRET`, and set `YPERSISTENCE=./data/yjs` or Yjs rooms are memory-only. For a full local dev pair, run this + `bun run dev` in two terminals (client falls back to same-origin; set `VITE_API_URL`/`VITE_WS_URL` only for a split host).

Deploy / run the real app (single container, serves client + API + Yjs on one port):
- `docker compose up -d --build`: build image and (re)launch. Requires `AUTH_SECRET` in `.env`. Health: `curl 127.0.0.1:8080/healthz` (use `127.0.0.1`, not `localhost`, on a Windows/WSL2 Docker host: `wslrelay.exe` accepts `[::1]:8080` but cannot forward IPv6, so `localhost` hangs; see README "Running on Windows").
- Typst asset blobs land in `ASSETS_DIR` (default: `assets/` beside `DB_PATH` → `/data/assets`), on the same `btct-data` volume as SQLite + Yjs, so existing backups cover them.
- After editing a `server/*.mjs` file, note the **Dockerfile copies server files individually**. A new server file must be added to the `COPY server/...` lines or it won't be in the image.

> The `.mjs` server is not covered by `tsc`. Sanity-check syntax with `bun build ./server/<file>.mjs --target=bun --external '<npm deps>' --outfile /tmp/x.js`.

## Architecture: the big picture

### There is no traditional database. Data lives in Yjs CRDT documents.

The "DB" is a set of **Yjs documents** synced over WebSockets and cached in IndexedDB. Every data change flows:

```
UI → repo/store action → write a Y.Map / Y.Text (inside doc.transact)
   → y-websocket broadcasts to server + peers → each client's Y observer fires
   → shared-bindings re-derives Zustand state (debounced) → React re-renders
```

`src/db/database.ts` looks like Dexie (`get/add/put/update/where().equals()`) but is a shim over the shared Y.Maps, **not** a local database. A write there propagates to *every connected user*.

### Two-tier Yjs design

| | Shared doc (`src/realtime/shared-doc.ts`) | Per-page doc (`src/realtime/yjs-providers.ts`) |
|---|---|---|
| Room | `btct-shared` | the page's `id` |
| Holds | all entity records (one `Y.Map` per table) + one `texts` `Y.Map` of `Y.Text`s | one page body as a `prosemirror` `Y.XmlFragment` |
| Edited by | repos/stores | Milkdown collab plugin |

- **Records** = plain JSON in a per-table `Y.Map` keyed by `id` (last-writer-wins). Tables: `workspaces, pages, graphs, graphNodes, graphEdges, attackChains, changeLogs, pageSnapshots, nmapScans, nmapMachines, typstAssets, commandLogs`. One more map, `settingsPublic`, is a **server-written** mirror of the public settings (the admin theme policy under key `theme`, stamped `themeUpdatedAt`); clients only read it.
- **Collaborative text fields** (page title/slug, node/edge label, workspace/graph/nmap-scan name, nmap hostname, chain name) are authoritative as a `Y.Text` in the `texts` map, keyed `<entity>:<id>:<field>`. A `mirrorTextsToRecords` observer copies each `Y.Text` back into the JSON record so everything else reads plain JSON.
- **Page bodies never go in the shared doc**: they're per-page docs, checkpointed via `pageSnapshots` (`src/realtime/page-snapshots.ts`).

### Client layers
- `src/db/*-repo.ts`: one repo per entity: CRUD + queries, pre-seeds `Y.Text`s on create, cascades deletes.
- `src/stores/app-store.ts`: the Zustand store (workspaces, pages, graphs, tabs, split-pane layout, selection, nmap, chains, change log). Mutating actions call repos **and** `log()` a change-log entry.
- `src/stores/shared-bindings.ts`: `bindSharedSubscriptions()` maps each table's `Y.Map.observe` to a microtask-debounced store reload.
- `src/lib/theme.ts` + `src/stores/theme-store.ts`: accent and note-heading theming by CSS-variable rewrite (never an editor rebuild). Precedence is one pure function, `resolveEffectiveHeadings` (admin hardlock → the user's own prefs, as a whole once customised → admin defaults → inherit), applied from `App.tsx`. The admin policy is seeded by `GET /api/settings` and then followed live through `settingsPublic.theme`; the store drops payloads older than the `themeUpdatedAt` it already holds. Per-user prefs (`theme` next to `codeAccent`/`keybinds`/`follow`) are validated by `resolveThemePrefs` on the client and the matching validator in `server/index.mjs`.
- `src/lib/editor-keybinds.ts`: editor plugins that apply settings without a rebuild (invariant #3) plus the code-block language defaults: `codeBlockShellDefault` (schema default) **and** `codeFenceInputRule`, which replaces commonmark's own ``` input rule (`PageEditor` calls `crepe.editor.remove(createCodeBlockInputRule)` before `.use()`-ing ours) because that rule stores the captured language verbatim and ProseMirror input rules are first-match-wins. Re-adding the preset rule silently turns bare fences back into plain-text blocks.
- Tabs/panes: `src/lib/pane-layout.ts` (pure tree ops) + `app-store` (`openTab`, `moveTabToPane`, …); rendered by `src/components/ui/SplitContainer.tsx` (the live one; `MainContent.tsx` is dead). Adding a `TabKind` means: `types/index.ts`, a render branch in `SplitContainer`, and icons in `TabBar.tsx` + the pane chip.

### Typst figure slots (how screenshots get placed)
Images are **not** inserted at the caret. They're assigned to a declared slot, a call to the `image-placeholder` helper, so captions and figure numbering stay consistent and an unfilled figure is visible in the rendered PDF:

```typst
#image-placeholder("Auth bypass")                              // empty → grey placeholder box
#image-placeholder("Auth bypass", path: "/assets/shot.png")    // filled → the real figure
```

- `src/lib/typst-placeholders.ts` is a **pure string→string** module (no DOM, no Yjs): `findScreenshotSlots()` scans for call sites with a small brace/string-aware parser, `setSlotPath()` rewrites one call's arguments, `ensureHelper()` inserts or upgrades the `#let` definition. Tested in `src/test/typst-placeholders.test.ts`.
- **Order matters when rewriting.** Slots carry raw character offsets, so `ensureHelper()` (which can shift the whole document) must run *first*, then re-scan, then `setSlotPath()`. Match slots across the rewrite by `index`, never by stale offsets.
- The filled state draws the image **inside** the bordered block (`clip: true` + `fit: "contain"`), not in place of it, so a figure keeps the same frame and footprint whether or not it's been filled.
- Documents predating this feature define a 2-arg helper that would error on `path:`. `ensureHelper()` upgrades it, but **only when the existing body matches a version this app generated** (`SUPERSEDED_HELPERS`, compared whitespace-insensitively). A customized helper is never overwritten.
- Renaming an asset must repoint the document: `retargetAssetPath()` rewrites the quoted path literal, which covers both slots and hand-written `#image(...)` calls. The **extension is not renameable**. It drives Typst's decoder choice and the byte normalization (see below).

### Click-to-source (preview → editor)
`src/lib/typst-source-map.ts` maps a click on the rendered page back to a source offset by **text matching**, not span metadata: typst.ts emits a hidden selection layer (`<foreignObject><div class="tsel">`) containing each run's literal characters.

- The "proper" route (`session.getSourceLoc()`) is unusable here: spans are only embedded when the compiler has debug info attached, which typst.ts exposes only on its incremental-server API. A normal compile yields one `data-span` for the whole page.
- `normalizeForMatch()` folds smart quotes / exotic spaces / dashes and **must stay 1:1 per character**, because offsets are reported into the original string. That's why `--` → en dash isn't handled there; the progressive fallbacks (longest fragment → first clause → longest word) cover it.
- **A click lands on editable prose, not the styling that formats it.** `designRegions()` scans out the character ranges of design statements: any line that (at bracket depth 0) opens `#set`/`#show`/`#let`/`#import`/`#include`, extended until its brackets/braces all close, so it covers one-liners, multi-line `#set page(header: [...])`, and brace-bodied helpers alike. `chooseMatch()` prefers a body-content occurrence over one inside a design region (e.g. a title that appears in both a running header and the body resolves to the body). This filtering also **realigns the occurrence index**: the rendered runs we count against are body content, so skipping design occurrences makes the Nth click select the Nth body instance. It only falls back to a design match when no body occurrence exists, so a click never dead-ends.
- `TypstPreview` hit-tests `foreignObject` rects geometrically rather than using `event.target`: the `.tsel` divs are `position: fixed`, so the reported target isn't reliably the run under the cursor. It returns *ordered candidates* (neighbours included) so a click on an auto-generated heading number resolves to the heading.
- Source edits are applied with `replaceYTextContent()` (`src/realtime/use-y-text.ts`): a **minimal CRDT delta**, never a clear-and-reinsert, which would nuke collaborators' cursors.

### Whole-document search (`src/lib/typst-search.ts` + `TypstSearchPanel.tsx`)
The Typst editor's Ctrl/⌘+F is BTCT's own panel, **not** CodeMirror's built-in. The built-in only decorates matches inside the rendered viewport, so in a long report it looks like search sees only what's on screen. `src/lib/typst-search.ts` is a **pure** engine (`searchAll` scans the entire source string once and returns every match with line/column/context; `replaceOne`/`replaceAll`/`activeMatchIndex`; `compileMatcher` returns `null` for an empty *or invalid* query so a half-typed regex shows "no results" instead of throwing). Filters: case-sensitive, whole-word, regex (`$1`/`$&` honored on replace; literal `$` kept in non-regex mode). Tested in `src/test/typst-search.test.ts`.
- The panel (`TypstSearchPanel.tsx`) is an **absolute overlay** inside the editor pane: it must never cause the CodeMirror host to remount (invariant #3), so it's a sibling of `TypstEditor`, not a wrapper. Replacements apply through `applySource` (→ `replaceYTextContent`, minimal delta).
- The editor→panel wiring is a module-level bridge: `TypstEditor` binds `Mod-f` to `onSearchRequest` (registered by `TypstView` via `setTypstSearchRequest`); `getTypstCaret()` lets "find next" start from the caret. CodeMirror's `search()`/`searchKeymap` are intentionally removed (only `highlightSelectionMatches` stays).

### Typst assets (report screenshots + custom fonts)
The Typst tab can mount images and fonts into the compiler. This is the one feature where **binary content leaves the CRDT**:

- **Bytes → server.** `POST /api/assets` (raw body, not multipart) writes a uuid-named file under `ASSETS_DIR` (`/data/assets` in Docker) with a metadata row in the `assets` SQLite table. See `server/assets.mjs`. Base64 in the shared doc was rejected on purpose: every screenshot would be broadcast to and permanently cached by every client.
- **Metadata → CRDT.** A `typstAssets` record (filename, mime, dims, `crop`, `fontFamily`) syncs normally, so a crop propagates live. These records have **no `Y.Text` fields**: filenames/crop rects are LWW JSON, so invariant #1 does not apply here.
- **Framing is a fixed viewport, not a free crop.** The editor frames the image with the figure box's real proportions and pans/scales the image behind it. The stored `CropRect` therefore has two rules the old free-crop model lacked: its aspect ratio always equals the box's, and **it may extend outside 0..1** (an image scaled smaller than the frame). Nothing clamps it to the unit square, and `lib/crop-math.ts` is built around that. Gaps are baked in as `luma(245)` by the canvas so the editor and the PDF are byte-identical.
- **Crop is a render-time transform.** `lib/typst-assets.ts` re-encodes the region *before* the bytes reach the compiler. The upload is immutable. Never overwrite it with cropped pixels.
- **Blur (redaction) regions follow the crop model.** `blurs` on the record is LWW JSON (`BlurRegion[]`, normalized against the *original* image, always inside the unit square), applied in `resolveAssetBytes()` before the crop. The blur is downscale-then-gaussian (`bakeBlurs`) because a plain gaussian of readable text can sometimes be reversed; the strength numbers come from `blurParams` in `lib/blur-math.ts` (pure, tested) so the place dialog's baked preview and the PDF are identical. Regions anchor to the image, not the crop, so re-framing never moves a redaction. GIF/SVG can't be blurred (a canvas can't re-encode them). Each region optionally carries `style` (`'gaussian' | 'pixelate'`) and `strength` (0.25..3, default 1): absent fields mean the original gaussian-at-1 behavior, so pre-existing records need no migration, and `blursKey` keys by *effective* values, so a record without the fields caches identically to one with explicit defaults.
- **`lib/typst-geometry.ts` derives the box.** Box width = (page width − margins) × 0.9, parsed from the document's `#set page(...)`; height comes from the slot's `height:` argument. Verified against the compiler to <0.01pt across A4/letter/A5/explicit sizes and every `margin:` shape. `src/test/typst-geometry.test.ts` carries those measured values, so re-measure with `#layout(s => …)` before changing the parser.
- **Bytes must match the extension they're mounted at.** Typst picks its decoder from the file extension, so PNG bytes at a `.jpg` path fail with `Illegal start bytes: 8950`. `resolveAssetBytes()` therefore encodes to the format `formatFromFilename()` reports (*not* always PNG), and also re-encodes uncropped bytes that disagree with their extension, which self-heals mislabelled uploads. `lib/image-format.ts` holds the magic-number sniffing (pure, tested). GIF/SVG are passed through untouched: a canvas can't produce them, and rasterizing SVG would throw away resolution independence.
- `server/assets.mjs` corrects an image's extension at upload (`reconcileImageName`) so a mislabelled file never gets referenced by a document in the first place. Its sniffer is duplicated from the client module because the server is plain `.mjs` with no build step.
- **`lib/crop-math.ts`** holds the pure geometry (clamping, min size, edge-swap on over-drag) split out from the canvas/network code so it's directly testable; see `src/test/crop-math.test.ts`.
- **Compiler plumbing** (`lib/typst-compiler.ts`): `setTypstShadowFiles()` → `mapShadow` into the virtual FS under `/assets`; `setTypstFonts()` → rebuilds the compiler with `loadFonts(custom, { assets: ['text'] })`, which merges uploads with the built-in faces (fonts can only be installed at init, hence the rebuild). We own the compiler/renderer rather than using the `$typst` singleton for exactly these two reasons.
- **Both outputs compile `/main.typ`.** `$typst.pdf({mainContent})` would compile at `/tmp/<rand>.typ`, resolving relative asset paths differently from the preview, so `compileTypstPdf` drives the compiler directly instead.

### Command log ingest (`server/cmdlog.mjs` + `cmdlog-agent/`)
A standalone Python 3 agent (`cmdlog-agent/`, stdlib-only) runs on each operator's Kali box: a bash/zsh shell hook captures whitelisted commands to a per-PID spool file, and a daemon correlates start/exit, redacts secrets, and batch-POSTs them to `POST /api/cmdlog/events` (static bearer ingest token, MCP-token pattern). Storage is **split on purpose**:
- **SQLite `command_logs`** (`db.mjs`) is the durable, unbounded archive; rows are **upserted by the agent-generated `id`** so a start event and its later exit/duration completion merge, and a replayed batch is idempotent. Read with filters over `GET /api/cmdlog/query`.
- **The shared doc's `commandLogs` map** (written via `appendCommandLogs` in `yjs-data.mjs`) is a **bounded live window** (~500/workspace, pruned oldest-first) so the Command Log tab updates live without polling. It has **no Y.Text fields**, all LWW JSON (like `typstAssets`), so invariant #1 doesn't apply.
- The client view (`src/components/cmdlog/CommandLogView.tsx`, a `cmdlog` TabKind) **seeds from REST on mount, then follows the CRDT**, sidestepping the cold-doc problem where server CRDT writes are lost if `YPERSISTENCE` is unset and no browser is connected. Pure filter/CSV logic is in `src/lib/cmdlog-filter.ts` (tested).

### Server (`server/`): intentionally thin
Bun `node:http` + `ws`. It does **auth + static hosting + a Yjs relay** and knows nothing about pages/graphs/findings. `bun:sqlite` (`db.mjs`) stores only `users`, `settings`, `chat_sessions`, `assets` (blob inventory: size/mime, never meaning). Routing is a flat `if (method && url)` chain in `index.mjs` using `authFromHeader`/`requireAdmin`/`readJsonBody`/`sendJson`. Auth = PBKDF2 passwords + HMAC-signed tokens (`auth.mjs`), 7-day TTL.

### AI assistant (Claude): the one place server code touches domain data
- Admin sets an Anthropic API key + mode (`view`/`edit`) in `settings`; the key never leaves the server.
- `server/ai.mjs` runs a streaming (SSE) tool-use loop; tools execute **in-process against the live shared Yjs doc** via `getYDoc('btct-shared')` in `server/yjs-data.mjs` (read tools always; write tools only in `edit` mode). Writes broadcast to all clients live.
- **Server-side writes must honor the same Y.Text invariant** as the client repos (set the `Y.Text`, not just the JSON record); see `server/yjs-data.mjs`.
- Client: `src/components/ai/AiAssistant.tsx` (a tab/pane view of `kind: 'ai'`), `src/stores/chat-store.ts` (durable per-account chat history), `src/components/ai/markdown.tsx` (shiki-highlighted markdown renderer), `src/components/ai/ThinkingIndicator.tsx` (agent activity).
- **SSE event protocol** (`ai.mjs` → `AiAssistant`): `text` (delta), `tool` (call started), `tool_done`, `round` (another tool pass beginning), `done`, `error`. The last three exist purely so the UI can distinguish "thinking", "running <tool>", "reading results" and "researching, N steps". The loop can run up to 12 rounds with no text at all, which without a signal looks like a hang. Adding a phase means emitting an event here *and* handling it in the client's stream reader.

### Hosted MCP server (`server/mcp.mjs`): the reverse of the assistant
BTCT also exposes itself as an **MCP server** (`@modelcontextprotocol/sdk`, Streamable HTTP, stateless) at `POST /mcp`, so an external MCP client (Claude Code CLI) can read/write the workspace. It **reuses `ai.mjs`'s exported `READ_TOOLS`/`WRITE_TOOLS` + `dispatch()`** (a `toZodShape` shim converts the Anthropic JSON-Schema tool defs to zod), so the MCP tool set stays in sync with the assistant. Auth is an admin-generated static bearer token in `settings` (`mcp_enabled`/`mcp_mode`/`mcp_token`), checked at the HTTP layer with `timingSafeEqual` before the transport runs; write tools are only registered in `edit` mode. Config routes `/api/mcp/*` are admin-only; the token is admin-readable (so it can be pasted into the client). If you add/rename an assistant tool, the MCP server picks it up automatically.

## Critical invariants (read before touching the data layer)

These are non-obvious and easy to break; full list in README "Conventions & invariants".

1. **Pre-seed `Y.Text`s in every repo `create()`** (`getOrInitYText(textKey(...))`) or two clients race and orphan the text. A *new* collaborative field means touching all four: `TEXT_FIELDS_BY_ENTITY` + `TEXT_FIELD_TO_TABLE` (`shared-doc.ts`), the repo `create()`, and the UI (`useYTextInput`).
2. **Read the JSON record, not the `Y.Text`.** The mirror keeps them in sync; only the editor/input layer touches `texts`.
3. **Never rebuild the editor to apply settings.** Keybinds and code accent flow through module-level refs + CSS vars specifically so the Yjs collab binding survives; remounting drops live cursors/edits.
3b. **Programmatic Y.Text rewrites use `replaceYTextContent`** (minimal delta). A clear-and-reinsert destroys remote cursors and can't merge with a concurrent edit.
3c. **Pane resizing in the Typst tab writes `style.width` directly** (one mutation per rAF) and commits to React state only on pointer-up, for the same reason as #3: a mid-drag re-render can remount the editor and drop the collab binding. Width math + persistence live in `src/lib/pane-resize.ts` (pure, tested).
4. **Keep the server dumb about domain data.** Three deliberate exceptions: the AI assistant (reads/writes the CRDT via `getYDoc`, must respect the Y.Text rule), `assets.mjs` (stores opaque blobs; knows size + mime, never meaning), and `cmdlog.mjs` (ingests externally-produced command records into SQLite + the CRDT; validates and stores, knows nothing about what a command means; has no Y.Text fields so the Y.Text rule doesn't apply).
4b. **Never put binary content in the shared doc.** Upload it and reference it by id (see the Typst assets section). The lone exception is page snapshots, which are intentionally-bounded Yjs update bytes.
5. **DB migrations must be idempotent.** Guard every `ALTER TABLE` with a `PRAGMA table_info` column check (see `db.mjs`).
6. **Load `yjs` on the server via the same CJS require as y-websocket** (`require('yjs')`, not `import`), or you get two Yjs instances and `Y.Text` writes silently fail to integrate.
7. Deletes cascade and are logged with a full snapshot (restorable). Highlight marks and page bodies are intentionally not in the change log.
8. **Subscribe to the store with a selector, never bare `useAppStore()`.** A selectorless call re-renders on every `set()` (each sync event, each debounced save). Use per-field selectors or `useShallow` for multi-field reads.
9. **Password hashing is async and must stay off the event loop.** `hashPassword`/`verifyPassword` (`server/auth.mjs`) use `crypto.pbkdf2` on the libuv threadpool because the process also runs the Yjs relay; a synchronous hash freezes every editor. Login is throttled per username+IP (`server/index.mjs`).
11. **Never put secrets in `settingsPublic`.** It is mirrored to every connected client; only the public theme policy belongs there.
10. **Batch CRDT/SQLite writes.** Wrap multi-record Yjs writes in one `sharedTransact` and SQLite batches in one `db.transaction` (`upsertCommandLogBatch`); `PRAGMA synchronous = NORMAL` pairs with WAL so a batch is one commit, not one fsync per row.

## Performance
Full CPU/memory audit and the fixes applied: [docs/perf-audit-2026-08-19.md](docs/perf-audit-2026-08-19.md). Static assets are precompressed at build time (the Dockerfile gzips `dist/`) and `tryServeStatic` serves the `.gz` sibling plus an mtime+size ETag; keep both when touching static serving.

## Planned work
Backups (OneDrive + local host folder), Google Docs-style per-user page history, per-user heading colours and the admin theme hardlock are broken down into tasks, with the research behind the design, in [docs/backups-history-theming-plan-2026-08-22.md](docs/backups-history-theming-plan-2026-08-22.md). Epics E and G (heading colours, theme hardlock) shipped on 2026-08-22; backups and history are not implemented yet.

## Extending: see README "Recipes" and "Key files map"
The README (bottom half) is the detailed orientation guide with a full file map, the REST API table, entity/type reference, and step-by-step recipes (new entity, new node/edge type, new editor shortcut, new endpoint, new export). All shared types + default factories live in `src/types/index.ts`; the `@/` import alias maps to `src/`.
