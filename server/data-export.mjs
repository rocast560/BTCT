// ─────────────────────────────────────────────────────────────────────────
// Consistent read access to everything under /data, for backups.
//
// The rules this module exists to enforce (see README "Backups"):
//   • Never copy the live SQLite file. In WAL mode the newest commits live in
//     `-wal`; a bare copy can be torn. `VACUUM INTO` writes a consistent
//     snapshot without blocking writers.
//   • Never copy the live LevelDB directory. It is held open (LOCK) and has
//     no checkpoint API; a copy can capture a torn log or manifest. Export
//     each room as one Yjs update instead, from the in-memory doc when the
//     room is open (y-websocket persists every update immediately, so the
//     two are equivalent) or from y-leveldb when it is cold.
//   • Assets are immutable uuid-named blobs: copy by id.
//
// Yjs and y-websocket's utils are loaded through the SAME CJS require the
// relay uses (invariant #6), so `docs` is the relay's live map.
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { db } from './db.mjs';
import { ASSETS_DIR } from './assets.mjs';

const require = createRequire(import.meta.url);
const { docs, getPersistence } = require('y-websocket/bin/utils');
const Y = require('yjs');

export const SHARED_ROOM = 'btct-shared';

// Room names are 'btct-shared' or page uuids. Anything else is refused so a
// room name can never become a path.
const ROOM_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Changes whenever another connection commits; cheap change detection. */
export function sqliteDataVersion() {
  const row = db.query('PRAGMA data_version').get();
  return row ? Number(row.data_version) : 0;
}

/** Consistent snapshot of the live database at `dest` (must not exist). Returns its size. */
export function exportSqliteTo(dest) {
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  db.run('VACUUM INTO ?', [dest]);
  return fs.statSync(dest).size;
}

/** Every room the relay knows about: open in memory or stored in LevelDB. */
export async function listDocNames() {
  const names = new Set();
  for (const n of docs.keys()) names.add(n);
  const p = getPersistence();
  if (p?.provider?.getAllDocNames) {
    for (const n of await p.provider.getAllDocNames()) names.add(n);
  }
  return [...names].filter((n) => ROOM_RE.test(n)).sort();
}

/** One room as a full Yjs update (Uint8Array), or null when it does not exist. */
export async function exportDocUpdate(name) {
  if (!ROOM_RE.test(name)) return null;
  const live = docs.get(name);
  if (live) return Y.encodeStateAsUpdate(live);
  const p = getPersistence();
  if (p?.provider?.getYDoc) {
    const ydoc = await p.provider.getYDoc(name);
    try { return Y.encodeStateAsUpdate(ydoc); } finally { ydoc.destroy(); }
  }
  return null;
}

/** Base64 state vector of an update, recorded in the manifest for later incremental logic. */
export function stateVectorOf(update) {
  return Buffer.from(Y.encodeStateVectorFromUpdate(update)).toString('base64');
}

export function listAssetRows() {
  return db
    .query('SELECT id, workspace_id, kind, filename, mime, size, uploaded_by, created_at FROM assets ORDER BY created_at')
    .all();
}

export function assetPath(id) {
  return path.join(ASSETS_DIR, id);
}

export { ASSETS_DIR };
