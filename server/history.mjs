// ─────────────────────────────────────────────────────────────────────────
// Page version history (Google Docs style).
//
// The live page docs are garbage-collected: once text is deleted and every
// client has seen the deletion, the bytes are gone, so nothing in the relay
// can say who wrote what. This module keeps a GC-off "twin" of every open
// page room, fed by the relay doc's `update` events, and persisted as one
// file per page under HISTORY_DIR. Versions are cheap Yjs snapshots (a
// state vector plus a delete set) stored in SQLite; rendering a version, or
// the difference between two versions coloured per user, needs only the
// twin plus the snapshot bytes, which is exactly what y-prosemirror's
// snapshot renderer consumes on the client.
//
// Policy (no thinning; every version is kept until someone deletes it):
//   • auto: 2 minutes after the last edit, or every 10 minutes during
//     continuous editing, and when the room closes with unsaved changes;
//     skipped when the body did not change
//   • named: POST /api/pages/:id/versions { name }
//   • restore: the client rewrites the live doc as a normal edit, then
//     records a version so the rollback itself shows up in the timeline
//   • import: the pre-history `pageSnapshots` CRDT rows, converted on first
//     read into full-state versions (renderable, not diffable)
//
// The server still knows nothing about what a page says (invariant #4): it
// moves bytes, reads the workspace id off the page record for the index,
// and maps clientIDs to accounts.
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  getUserById,
  insertPageVersion,
  listPageVersions,
  getPageVersion,
  latestDiffableVersion,
  deletePageVersion,
  renamePageVersion,
} from './db.mjs';
import { changedUsersBetween } from './history-diff.mjs';

// Same CJS instance as y-websocket (invariant #6).
const require = createRequire(import.meta.url);
const Y = require('yjs');
const { docs, getYDoc } = require('y-websocket/bin/utils');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HISTORY_DIR = process.env.HISTORY_DIR
  ? path.resolve(process.env.HISTORY_DIR)
  : path.join(
      process.env.DB_PATH ? path.dirname(path.resolve(process.env.DB_PATH)) : __dirname,
      'history',
    );
fs.mkdirSync(HISTORY_DIR, { recursive: true });

const SHARED_ROOM = 'btct-shared';
const FRAGMENT = 'prosemirror';
const IDLE_MS = 2 * 60_000;
const CONTINUOUS_MS = 10 * 60_000;
const TICK_MS = 30_000;
const FLUSH_MS = 5_000;
const ROOM_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** pageId -> { twin, pud, relayDoc, lastUpdateAt, lastVersionAt, dirty, flushTimer, onUpdate } */
const tracked = new Map();

function twinPath(pageId) {
  return path.join(HISTORY_DIR, `${pageId}.ydoc`);
}

function loadTwin(pageId) {
  const twin = new Y.Doc({ gc: false });
  try {
    const bytes = fs.readFileSync(twinPath(pageId));
    if (bytes.length) Y.applyUpdate(twin, new Uint8Array(bytes));
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`[history] twin for ${pageId} unreadable, starting fresh:`, err?.message || err);
  }
  return twin;
}

function flushTwin(pageId, t) {
  if (t.flushTimer) { clearTimeout(t.flushTimer); t.flushTimer = null; }
  const bytes = Y.encodeStateAsUpdate(t.twin);
  const target = twinPath(pageId);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
  } catch (err) {
    console.warn(`[history] flush failed for ${pageId}:`, err?.message || err);
  }
}

function scheduleFlush(pageId, t) {
  if (t.flushTimer) return;
  t.flushTimer = setTimeout(() => { t.flushTimer = null; flushTwin(pageId, t); }, FLUSH_MS);
}

/**
 * Start (or keep) following a relay doc. Idempotent; called for every room
 * the websocket layer opens. The shared metadata doc is not a page.
 */
export function trackPageDoc(pageId, relayDoc) {
  if (pageId === SHARED_ROOM || !ROOM_RE.test(pageId) || tracked.has(pageId)) return;
  const twin = loadTwin(pageId);
  Y.applyUpdate(twin, Y.encodeStateAsUpdate(relayDoc));
  const t = {
    twin,
    pud: new Y.PermanentUserData(twin),
    relayDoc,
    lastUpdateAt: 0,
    lastVersionAt: Date.now(),
    dirty: false,
    flushTimer: null,
    onUpdate: null,
  };
  t.onUpdate = (update) => {
    try {
      Y.applyUpdate(twin, update);
    } catch (err) {
      console.warn(`[history] twin update failed for ${pageId}:`, err?.message || err);
      return;
    }
    t.lastUpdateAt = Date.now();
    t.dirty = true;
    scheduleFlush(pageId, t);
  };
  relayDoc.on('update', t.onUpdate);
  relayDoc.on('destroy', () => untrack(pageId));
  tracked.set(pageId, t);
}

function untrack(pageId) {
  const t = tracked.get(pageId);
  if (!t) return;
  tracked.delete(pageId);
  try { t.relayDoc.off('update', t.onUpdate); } catch { /* already gone */ }
  if (t.dirty) {
    try { createVersion(pageId, t, { trigger: 'auto' }); } catch (err) {
      console.warn(`[history] close version failed for ${pageId}:`, err?.message || err);
    }
  }
  flushTwin(pageId, t);
  t.twin.destroy();
}

function lookupWorkspaceId(pageId) {
  try {
    const shared = docs.get(SHARED_ROOM) ?? getYDoc(SHARED_ROOM);
    const page = shared.getMap('pages').get(pageId);
    return page && typeof page.workspaceId === 'string' ? page.workspaceId : null;
  } catch {
    return null;
  }
}

function userIdsFromDescriptions(descriptions) {
  const ids = [];
  for (const d of descriptions) {
    const n = Number(d);
    if (Number.isInteger(n) && n > 0) ids.push(n);
    else if (d === 'unknown' || d == null) ids.push(0);
  }
  return [...new Set(ids)];
}

/**
 * Snapshot the twin into a version row. Auto versions are dropped when the
 * body is unchanged since the last diffable version; named and restore
 * versions are always written (the user asked for a marker).
 */
export function createVersion(pageId, t, { trigger = 'auto', name = null, createdBy = null } = {}) {
  const snapshot = Y.snapshot(t.twin);
  const prev = latestDiffableVersion(pageId);
  const prevSnapshot = prev ? Y.decodeSnapshot(new Uint8Array(prev.snapshot)) : Y.emptySnapshot;
  const diff = changedUsersBetween(Y, t.twin, FRAGMENT, prevSnapshot, snapshot, t.pud);
  t.dirty = false;
  if (trigger === 'auto' && !diff.changed) return null;
  const changedBy = userIdsFromDescriptions(diff.users);
  if (trigger !== 'auto' && createdBy != null && !changedBy.length) changedBy.push(createdBy);
  const row = {
    id: randomUUID(),
    pageId,
    workspaceId: lookupWorkspaceId(pageId),
    createdAt: Date.now(),
    trigger,
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null,
    createdBy,
    changedBy: JSON.stringify(changedBy),
    snapshot: Buffer.from(Y.encodeSnapshot(snapshot)),
    state: null,
    size: Y.encodeStateVector(t.twin).length,
  };
  insertPageVersion(row);
  t.lastVersionAt = row.createdAt;
  flushTwin(pageId, t);
  return row;
}

function tick() {
  const now = Date.now();
  for (const [pageId, t] of tracked) {
    if (!t.dirty) continue;
    const idle = now - t.lastUpdateAt >= IDLE_MS;
    const longSession = now - t.lastVersionAt >= CONTINUOUS_MS;
    if (!idle && !longSession) continue;
    try {
      createVersion(pageId, t, { trigger: 'auto' });
    } catch (err) {
      console.warn(`[history] auto version failed for ${pageId}:`, err?.message || err);
    }
  }
}
const ticker = setInterval(tick, TICK_MS);
ticker.unref?.();

/** Flush every open twin (used by the backup engine before it copies files). */
export function flushAllTwins() {
  for (const [pageId, t] of tracked) flushTwin(pageId, t);
}

export function historyStatus() {
  return { dir: HISTORY_DIR, tracked: tracked.size };
}

// ── Legacy import ─────────────────────────────────────────────────────────
// Pre-history clients wrote full-state captures into the shared doc's
// `pageSnapshots` map. The first time a page's history is listed, those
// rows become `import` versions (restorable, not diffable) and leave the
// CRDT, which was never meant to carry bytes (invariant #4b).
function importLegacySnapshots(pageId) {
  let shared;
  try { shared = docs.get(SHARED_ROOM) ?? getYDoc(SHARED_ROOM); } catch { return; }
  const map = shared.getMap('pageSnapshots');
  const legacy = [];
  map.forEach((v, k) => { if (v && typeof v === 'object' && v.pageId === pageId) legacy.push([k, v]); });
  if (!legacy.length) return;
  for (const [key, v] of legacy) {
    let state = null;
    try { state = Buffer.from(String(v.updateBase64 || ''), 'base64'); } catch { state = null; }
    if (!state || !state.length) continue;
    const uid = Number.isInteger(v.userId) ? v.userId : null;
    insertPageVersion({
      id: typeof v.id === 'string' ? v.id : key,
      pageId,
      workspaceId: typeof v.workspaceId === 'string' ? v.workspaceId : null,
      createdAt: Number(v.timestamp) || Date.now(),
      trigger: 'import',
      name: typeof v.label === 'string' && v.label ? v.label : null,
      createdBy: uid,
      changedBy: JSON.stringify(uid != null ? [uid] : []),
      snapshot: null,
      state,
      size: state.length,
    });
  }
  shared.transact(() => { for (const [key] of legacy) map.delete(key); });
}

// ── HTTP handlers ─────────────────────────────────────────────────────────

function publicUserRef(id) {
  if (!id) return { id: 0, username: 'Unknown', color: '#888888' };
  const u = getUserById(id);
  return u
    ? { id: u.id, username: u.username, color: u.color || '#888888' }
    : { id, username: `user ${id}`, color: '#888888' };
}

function publicVersion(row) {
  let changedBy = [];
  try { changedBy = JSON.parse(row.changed_by || '[]'); } catch { changedBy = []; }
  return {
    id: row.id,
    pageId: row.page_id,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    trigger: row.trigger,
    name: row.name,
    createdBy: row.created_by,
    changedBy,
    diffable: !!row.has_snapshot,
    size: row.size,
  };
}

export function handleVersionList(req, res, pageId, { sendJson }) {
  if (!ROOM_RE.test(pageId)) return sendJson(res, 400, { error: 'bad page id' });
  try { importLegacySnapshots(pageId); } catch (err) {
    console.warn(`[history] legacy import failed for ${pageId}:`, err?.message || err);
  }
  const rows = listPageVersions(pageId).map(publicVersion);
  const ids = new Set();
  for (const v of rows) {
    if (v.createdBy) ids.add(v.createdBy);
    for (const id of v.changedBy) ids.add(id);
  }
  const users = {};
  for (const id of ids) users[id] = publicUserRef(id);
  const t = tracked.get(pageId);
  return sendJson(res, 200, {
    versions: rows,
    users,
    tracked: !!t,
    dirty: !!t?.dirty,
    twinExists: !!t || fs.existsSync(twinPath(pageId)),
  });
}

export async function handleVersionCreate(req, res, pageId, { user, sendJson, readJsonBody }) {
  if (!ROOM_RE.test(pageId)) return sendJson(res, 400, { error: 'bad page id' });
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const trigger = body?.trigger === 'restore' ? 'restore' : 'named';
  const name = typeof body?.name === 'string' ? body.name : null;
  const t = tracked.get(pageId);
  if (!t) return sendJson(res, 409, { error: 'page is not open on the server; open it in a tab and try again' });
  const row = createVersion(pageId, t, { trigger, name, createdBy: user.id });
  const stored = getPageVersion(pageId, row.id);
  return sendJson(res, 201, { version: publicVersion({ ...stored, has_snapshot: stored.snapshot ? 1 : 0 }) });
}

export function handleVersionGet(req, res, pageId, versionId, { sendJson }) {
  if (!ROOM_RE.test(pageId)) return sendJson(res, 400, { error: 'bad page id' });
  const row = getPageVersion(pageId, versionId);
  if (!row) return sendJson(res, 404, { error: 'version not found' });
  let state = row.state ? Buffer.from(row.state) : null;
  if (!state && row.snapshot) {
    const twin = tracked.get(pageId)?.twin ?? loadTwin(pageId);
    try {
      const doc = Y.createDocFromSnapshot(twin, Y.decodeSnapshot(new Uint8Array(row.snapshot)));
      state = Buffer.from(Y.encodeStateAsUpdate(doc));
      doc.destroy();
    } catch (err) {
      return sendJson(res, 500, { error: `could not rebuild this version: ${err?.message || err}` });
    } finally {
      if (!tracked.get(pageId)) twin.destroy();
    }
  }
  return sendJson(res, 200, {
    version: publicVersion({ ...row, has_snapshot: row.snapshot ? 1 : 0 }),
    snapshot: row.snapshot ? Buffer.from(row.snapshot).toString('base64') : null,
    state: state ? state.toString('base64') : null,
  });
}

export function handleVersionDelete(req, res, pageId, versionId, { user, sendJson }) {
  const row = getPageVersion(pageId, versionId);
  if (!row) return sendJson(res, 404, { error: 'version not found' });
  const mine = row.created_by != null && row.created_by === user.id;
  const named = !!row.name;
  if (!(user.is_admin || (named && mine))) {
    return sendJson(res, 403, { error: named ? 'only its author or an admin can delete a named version' : 'only an admin can delete automatic versions' });
  }
  deletePageVersion(pageId, versionId);
  return sendJson(res, 200, { ok: true });
}

export async function handleVersionRename(req, res, pageId, versionId, { user, sendJson, readJsonBody }) {
  const row = getPageVersion(pageId, versionId);
  if (!row) return sendJson(res, 404, { error: 'version not found' });
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (row.name && !(user.is_admin || row.created_by === user.id)) {
    return sendJson(res, 403, { error: 'only its author or an admin can rename a named version' });
  }
  renamePageVersion(pageId, versionId, name || null, name ? user.id : row.created_by);
  const updated = getPageVersion(pageId, versionId);
  return sendJson(res, 200, { version: publicVersion({ ...updated, has_snapshot: updated.snapshot ? 1 : 0 }) });
}

/** The GC-off twin as one Yjs update, gzipped when the client accepts it. */
export function handleTwinGet(req, res, pageId, { sendJson }) {
  if (!ROOM_RE.test(pageId)) return sendJson(res, 400, { error: 'bad page id' });
  const t = tracked.get(pageId);
  let bytes;
  if (t) {
    bytes = Buffer.from(Y.encodeStateAsUpdate(t.twin));
  } else {
    try { bytes = fs.readFileSync(twinPath(pageId)); } catch { return sendJson(res, 404, { error: 'no history for this page yet' }); }
  }
  const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && bytes.length > 4096;
  const out = gzip ? zlib.gzipSync(bytes) : bytes;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': out.length,
    'Cache-Control': 'no-store',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(out);
}
