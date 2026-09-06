# Lightweight Operations redesign

Branch: `codex/lightweight-gotham-redesign`

The interface uses compact slate panels, clear borders, system fonts and native CSS. The overview shows the current workspace's notes, narratives, scan groups and attack chains, with links to findings, timeline and reports. The Glass skin, backdrop blur, continuous decorative animations and hover-only tab close controls are removed.

Web recon is retired across the client, server, agent and Docker image. Its routes return 404. Legacy recon records remain available in lossless ZIP exports and full server backups as archive data. Nmap, command capture, graph narratives, notes, history, collaboration, reports and account controls remain.

## Implementation choices

- Keep the existing React, Yjs and editor integrations to preserve collaboration and document compatibility. TypeScript compiles to browser JavaScript; no replacement application framework was added.
- Load note editors, reports, exports, image tools and account panels when opened. Keep preference updates in small modules so setting an accent or shortcut does not load or rebuild the editor.
- Reuse CodeMirror's lazy language grammars for chat syntax highlighting. Remove Shiki and unused direct Mantine, Radix, Dexie and class-variance-authority dependencies. Some Radix packages remain transitively required by the command palette.
- Keep open page and history documents connected, including background app tabs. After the last owner closes, commit an offline snapshot before releasing the connection, IndexedDB provider and Y.Doc. Operation leases protect exports and editor cleanup; failed storage keeps the document in memory.
- Reuse editor decorations on selection-only transactions. Pause history polling and the minute-aligned UTC clock while the browser is hidden. Load AI and MCP SDKs only when those features need them.
- Stop tracking generated `dist/` files. Both the local production build and Docker regenerate the client from source, without stale recon bundles.

## Measurements

Baseline and final client builds were measured on the same Windows device. Startup assets are JavaScript and CSS referenced directly by the generated HTML, including module preloads; gzip sizes use level 9. These are bundle measurements, not a claim about page-load time on every device.

| Measure | Before | After |
| --- | ---: | ---: |
| Startup JS/CSS, gzip | 719,532 bytes | 190,594 bytes |
| Startup JS/CSS, raw | 2,452,609 bytes | 677,861 bytes |
| Startup asset references | 47 | 23 |
| Total generated JavaScript | 13,588,482 bytes | 4,039,212 bytes |
| JavaScript chunks | 493 | 184 |
| Total CSS | 206,208 bytes | 177,645 bytes |

Startup assets are approximately 73% smaller; total JavaScript is approximately 70% smaller. The running Docker image served 191,550 bytes for its 23 startup assets. Its precompression, platform and build context produce slightly different totals from the local build.

The preview container was healthy and used 38.81 MiB with 0.34% CPU in a single post-verification sample, under a 1 GiB memory limit and two-CPU limit. This excludes Docker Desktop's own memory and is not a multi-user load test.

## Verification

- `bun run test`: 392 tests passed across 41 files. New coverage exercises real Yjs and y-indexeddb with fake IndexedDB for offline close/reopen, operation leases, rapid reopen and failed-storage preservation; it also covers grammar highlighting, visibility polling and retired archive remapping.
- `bun run build`: typecheck and production build passed. The Docker production build passed too. The existing large optional editor/report chunks still produce Vite's size advisory.
- HTTP checks passed for health, authenticated login, rejection of unauthenticated profile requests, remaining feature settings and retired recon routes.
- Browser checks passed for login, note editing, close/reopen persistence, persistence after container replacement, diagram zoom/fit, workspace ZIP export (49 page documents), report rendering, report PDF action, named page version creation and the history viewer.
- No browser errors occurred during these checks. Existing ProseMirror virtual-cursor warnings about non-inclusive marks remain.

The preview is available at `http://127.0.0.1:8081` as container `btct-lightweight-preview`, with separate named data and backup volumes. Preview-only credentials are in ignored `.env.preview`. The existing `btct` container and its data were left unchanged.

Start or rebuild:

```sh
docker compose --env-file .env.preview -f docker-compose.preview.yml up -d --build
```

Stop while keeping preview data:

```sh
docker compose --env-file .env.preview -f docker-compose.preview.yml stop
```

## Remaining limits

The optional Typst compiler and renderer still total about 29.3 MB of WebAssembly and load only with reports. Report compilation remains in the browser, and default report fonts are fetched from jsDelivr on first use. AI requests and external MCP client operations were not exercised because the isolated preview has no API key or enabled MCP token. No cloud instance was deployed; the branch and Docker configuration are ready for subsequent deployment.
