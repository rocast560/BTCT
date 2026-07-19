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

## Commands

Client (repo root; run scripts with `bun run`):
- `bun install` — install client deps.
- `bun run dev` — Vite dev server (hot reload). Needs the server running separately (below).
- `bun run build` — **typecheck + build**: `tsc -b && vite build`. This is the canonical "does it compile" check.
- `bun run lint` — ESLint.
- `bun run test` — Vitest (all suites, in `src/test/`).
  - Single file: `bun run test -- src/test/pane-layout.test.ts`
  - By name: `bun run test -- -t "moveTab"`
- `bun run seed` — seed a demo workspace (`vite-node src/db/seed.ts`).

Server (in `server/`, plain `.mjs`, no build step — Bun runs it directly):
- `cd server && bun install`
- `cd server && bun run dev` — server with `--watch`. Requires env: `AUTH_SECRET`, and set `YPERSISTENCE=./data/yjs` or Yjs rooms are memory-only. For a full local dev pair, run this + `bun run dev` in two terminals (client falls back to same-origin; set `VITE_API_URL`/`VITE_WS_URL` only for a split host).

Deploy / run the real app (single container, serves client + API + Yjs on one port):
- `docker compose up -d --build` — build image and (re)launch. Requires `AUTH_SECRET` in `.env`. Health: `curl localhost:8080/healthz`.
- After editing a `server/*.mjs` file, note the **Dockerfile copies server files individually** — a new server file must be added to the `COPY server/...` lines or it won't be in the image.

> The `.mjs` server is not covered by `tsc`. Sanity-check syntax with `bun build ./server/<file>.mjs --target=bun --external '<npm deps>' --outfile /tmp/x.js`.

## Architecture — the big picture

### There is no traditional database. Data lives in Yjs CRDT documents.

The "DB" is a set of **Yjs documents** synced over WebSockets and cached in IndexedDB. Every data change flows:

```
UI → repo/store action → write a Y.Map / Y.Text (inside doc.transact)
   → y-websocket broadcasts to server + peers → each client's Y observer fires
   → shared-bindings re-derives Zustand state (debounced) → React re-renders
```

`src/db/database.ts` looks like Dexie (`get/add/put/update/where().equals()`) but is a shim over the shared Y.Maps — **not** a local database. A write there propagates to *every connected user*.

### Two-tier Yjs design

| | Shared doc (`src/realtime/shared-doc.ts`) | Per-page doc (`src/realtime/yjs-providers.ts`) |
|---|---|---|
| Room | `btct-shared` | the page's `id` |
| Holds | all entity records (one `Y.Map` per table) + one `texts` `Y.Map` of `Y.Text`s | one page body as a `prosemirror` `Y.XmlFragment` |
| Edited by | repos/stores | Milkdown collab plugin |

- **Records** = plain JSON in a per-table `Y.Map` keyed by `id` (last-writer-wins). Tables: `workspaces, pages, graphs, graphNodes, graphEdges, attackChains, changeLogs, pageSnapshots, nmapScans, nmapMachines`.
- **Collaborative text fields** (page title/slug, node/edge label, workspace/graph/nmap-scan name, nmap hostname, chain name) are authoritative as a `Y.Text` in the `texts` map, keyed `<entity>:<id>:<field>`. A `mirrorTextsToRecords` observer copies each `Y.Text` back into the JSON record so everything else reads plain JSON.
- **Page bodies never go in the shared doc** — they're per-page docs, checkpointed via `pageSnapshots` (`src/realtime/page-snapshots.ts`).

### Client layers
- `src/db/*-repo.ts` — one repo per entity: CRUD + queries, pre-seeds `Y.Text`s on create, cascades deletes.
- `src/stores/app-store.ts` — the Zustand store (workspaces, pages, graphs, tabs, split-pane layout, selection, nmap, chains, change log). Mutating actions call repos **and** `log()` a change-log entry.
- `src/stores/shared-bindings.ts` — `bindSharedSubscriptions()` maps each table's `Y.Map.observe` to a microtask-debounced store reload.
- Tabs/panes: `src/lib/pane-layout.ts` (pure tree ops) + `app-store` (`openTab`, `moveTabToPane`, …); rendered by `src/components/ui/SplitContainer.tsx` (the live one — `MainContent.tsx` is dead). Adding a `TabKind` means: `types/index.ts`, a render branch in `SplitContainer`, and icons in `TabBar.tsx` + the pane chip.

### Server (`server/`) — intentionally thin
Bun `node:http` + `ws`. It does **auth + static hosting + a Yjs relay** and knows nothing about pages/graphs/findings. `bun:sqlite` (`db.mjs`) stores only `users`, `settings`, `chat_sessions`. Routing is a flat `if (method && url)` chain in `index.mjs` using `authFromHeader`/`requireAdmin`/`readJsonBody`/`sendJson`. Auth = PBKDF2 passwords + HMAC-signed tokens (`auth.mjs`), 7-day TTL.

### AI assistant (Claude) — the one place server code touches domain data
- Admin sets an Anthropic API key + mode (`view`/`edit`) in `settings`; the key never leaves the server.
- `server/ai.mjs` runs a streaming (SSE) tool-use loop; tools execute **in-process against the live shared Yjs doc** via `getYDoc('btct-shared')` in `server/yjs-data.mjs` (read tools always; write tools only in `edit` mode). Writes broadcast to all clients live.
- **Server-side writes must honor the same Y.Text invariant** as the client repos (set the `Y.Text`, not just the JSON record) — see `server/yjs-data.mjs`.
- Client: `src/components/ai/AiAssistant.tsx` (a tab/pane view of `kind: 'ai'`), `src/stores/chat-store.ts` (durable per-account chat history), `src/components/ai/markdown.tsx` (shiki-highlighted markdown renderer).

### Hosted MCP server (`server/mcp.mjs`) — the reverse of the assistant
BTCT also exposes itself as an **MCP server** (`@modelcontextprotocol/sdk`, Streamable HTTP, stateless) at `POST /mcp`, so an external MCP client (Claude Code CLI) can read/write the workspace. It **reuses `ai.mjs`'s exported `READ_TOOLS`/`WRITE_TOOLS` + `dispatch()`** (a `toZodShape` shim converts the Anthropic JSON-Schema tool defs to zod), so the MCP tool set stays in sync with the assistant. Auth is an admin-generated static bearer token in `settings` (`mcp_enabled`/`mcp_mode`/`mcp_token`), checked at the HTTP layer with `timingSafeEqual` before the transport runs; write tools are only registered in `edit` mode. Config routes `/api/mcp/*` are admin-only; the token is admin-readable (so it can be pasted into the client). If you add/rename an assistant tool, the MCP server picks it up automatically.

## Critical invariants (read before touching the data layer)

These are non-obvious and easy to break; full list in README "Conventions & invariants".

1. **Pre-seed `Y.Text`s in every repo `create()`** (`getOrInitYText(textKey(...))`) or two clients race and orphan the text. A *new* collaborative field means touching all four: `TEXT_FIELDS_BY_ENTITY` + `TEXT_FIELD_TO_TABLE` (`shared-doc.ts`), the repo `create()`, and the UI (`useYTextInput`).
2. **Read the JSON record, not the `Y.Text`** — the mirror keeps them in sync; only the editor/input layer touches `texts`.
3. **Never rebuild the editor to apply settings.** Keybinds and code accent flow through module-level refs + CSS vars specifically so the Yjs collab binding survives; remounting drops live cursors/edits.
4. **Keep the server dumb about domain data** — the only exception is the AI assistant, which reads/writes the CRDT via `getYDoc` and must respect the Y.Text rule.
5. **DB migrations must be idempotent** — guard every `ALTER TABLE` with a `PRAGMA table_info` column check (see `db.mjs`).
6. **Load `yjs` on the server via the same CJS require as y-websocket** (`require('yjs')`, not `import`), or you get two Yjs instances and `Y.Text` writes silently fail to integrate.
7. Deletes cascade and are logged with a full snapshot (restorable). Highlight marks and page bodies are intentionally not in the change log.

## Extending — see README "Recipes" and "Key files map"
The README (bottom half) is the detailed orientation guide with a full file map, the REST API table, entity/type reference, and step-by-step recipes (new entity, new node/edge type, new editor shortcut, new endpoint, new export). All shared types + default factories live in `src/types/index.ts`; the `@/` import alias maps to `src/`.
