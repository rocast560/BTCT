// ─────────────────────────────────────────────────────────────────────────
// Server-side access to the shared Yjs workspace document ("btct-shared").
//
// The whole app state (workspaces, pages, nmap scans/hosts, command logs,
// change log) lives in ONE Yjs doc that every browser client edits
// collaboratively. y-websocket keeps that doc resident in this process
// (utils' `docs` map / `getYDoc`), so the few server features that must touch
// workspace data (command-log ingest, the public settings mirror, asset
// retention) read and write it in-process; writes broadcast to every
// connected client.
//
// Records are plain JSON keyed by id in a per-table Y.Map (last-writer-wins).
// Wrap writes in `doc.transact` so observers fire once. Nothing here writes a
// collaborative Y.Text field, so the client's Y.Text invariant does not come
// into play here; if that changes, update BOTH the Y.Text and the record.
// ─────────────────────────────────────────────────────────────────────────
import { createRequire } from 'node:module';

// Reach the live doc through the SAME CJS module instance y-websocket uses
// internally. Importing Yjs via ESM here would create a second Yjs instance
// ("Yjs was already imported"), whose classes the shared doc would not
// recognize. Nothing in this file constructs a Y type, so only y-websocket's
// helper is pulled in.
const require = createRequire(import.meta.url);
const { getYDoc } = require('y-websocket/bin/utils');

const ROOM = 'btct-shared';
const TABLE_NAMES = [
  'workspaces', 'pages', 'changeLogs', 'nmapScans', 'nmapMachines',
  'commandLogs', 'settingsPublic',
];

// The shared doc holds only a bounded live window of command logs per workspace
// (the durable archive is SQLite). Keep memory + render cost small on clients.
const CMDLOG_LIVE_CAP = 500;

// Resolve the live shared doc + its table maps. If no client is connected and
// the doc was just created, its LevelDB state loads asynchronously: poll
// briefly until it's populated (or give up so a genuinely empty app doesn't
// stall). In practice the operator's browser is connected, so this returns
// immediately with a fully-synced doc.
// Cache the resolved handles per doc instance: helpers call shared() several
// times per request, and each cold call otherwise re-pays the 2s populate
// poll. Keyed weakly by the doc so a destroyed/recreated room re-resolves.
const sharedCache = new WeakMap();

async function shared() {
  const doc = getYDoc(ROOM);
  const hit = sharedCache.get(doc);
  if (hit) return hit;
  const tables = {};
  for (const name of TABLE_NAMES) tables[name] = doc.getMap(name);
  const texts = doc.getMap('texts');
  const start = Date.now();
  while (tables.workspaces.size === 0 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const resolved = { doc, tables, texts };
  // Only memoize a doc that actually has data: an empty doc may simply not
  // have finished its async LevelDB load yet, and caching it would pin the
  // "gave up" result for the doc's lifetime.
  if (tables.workspaces.size > 0) sharedCache.set(doc, resolved);
  return resolved;
}

function values(map) {
  return [...map.values()];
}

export async function listWorkspaces() {
  const { tables } = await shared();
  return values(tables.workspaces).map((w) => ({
    id: w.id, name: w.name, description: w.description,
  }));
}

// ── Command log (team pentest command activity) ──
// Batch-upsert records into the live window. These records have NO Y.Text
// fields (like typstAssets): every field is plain LWW JSON, so invariant #1
// doesn't apply. A completion event (exitCode/durationMs) is
// merged over the existing start record by id. After each batch we prune the
// oldest entries per workspace beyond CMDLOG_LIVE_CAP so the doc stays bounded.
export async function appendCommandLogs(records) {
  if (!records || !records.length) return;
  const { doc, tables } = await shared();
  doc.transact(() => {
    for (const r of records) {
      const existing = tables.commandLogs.get(r.id);
      tables.commandLogs.set(r.id, existing ? { ...existing, ...r } : r);
    }
    pruneCommandLogs(tables.commandLogs);
  });
}

// Public settings mirror. The server writes the admin theme policy (accent,
// heading colours, hard-lock) under `settingsPublic.theme` so every connected
// client re-themes live; the REST `GET /api/settings` response is the seed on
// load, and `themeUpdatedAt` lets a client ignore a stale copy replayed from
// its IndexedDB cache. LWW JSON with no Y.Text fields, so invariant #1 does
// not apply. Never put anything secret here: the whole doc reaches every user.
export async function publishPublicSettings(theme) {
  const { doc, tables } = await shared();
  doc.transact(() => {
    tables.settingsPublic.set('theme', theme);
  });
}

/** Asset ids whose shared record was retired (soft-deleted) before `cutoffMs`. */
export async function collectRetiredAssets(cutoffMs) {
  const { doc } = await shared();
  // Read the map directly (typstAssets isn't in the server's TABLE_NAMES).
  const assets = doc.getMap('typstAssets');
  const ids = [];
  assets.forEach((rec, id) => {
    if (rec && typeof rec.deletedAt === 'number' && rec.deletedAt > 0 && rec.deletedAt < cutoffMs) ids.push(id);
  });
  return ids;
}

/** Remove asset metadata records from the shared doc (after their bytes are gone). */
export async function removeAssetRecords(ids) {
  if (!ids.length) return;
  const { doc } = await shared();
  const assets = doc.getMap('typstAssets');
  doc.transact(() => { for (const id of ids) assets.delete(id); });
}

/** Mirror the public blur-defaults policy (same pattern as the theme). */
export async function publishPublicBlur(blur) {
  const { doc, tables } = await shared();
  doc.transact(() => {
    tables.settingsPublic.set('blur', blur);
  });
}

function pruneCommandLogs(map) {
  // Under the cap in total means under the cap for every workspace; skip
  // the full materialize-and-sort on the common (bounded) path.
  if (map.size <= CMDLOG_LIVE_CAP) return;
  const byWs = new Map();
  for (const rec of map.values()) {
    const arr = byWs.get(rec.workspaceId) || [];
    arr.push(rec);
    byWs.set(rec.workspaceId, arr);
  }
  for (const arr of byWs.values()) {
    if (arr.length <= CMDLOG_LIVE_CAP) continue;
    arr.sort((a, b) => a.startedAt - b.startedAt); // oldest first
    for (const rec of arr.slice(0, arr.length - CMDLOG_LIVE_CAP)) map.delete(rec.id);
  }
}
