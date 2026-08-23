// ─────────────────────────────────────────────────────────────────────────
// Backup format: pure helpers shared by the engine (backup.mjs), the restore
// CLI (restore.mjs) and the unit tests. No Bun-only imports in here so the
// file loads under Node/vitest too.
//
// A backup is a DIRECTORY, not an archive:
//
//   <BACKUP_DIR>/btct-backup-YYYYMMDD-HHMMSS/
//     manifest.json                 what is inside + sha256 of every file
//     sqlite/data.sqlite.gz         VACUUM INTO snapshot, gzipped
//     yjs/btct-shared.yupdate.gz    the shared metadata doc as one Yjs update
//     yjs/<pageId>.yupdate.gz       one per page body
//     assets/<id>                   uploaded blobs, copied as-is
//
// A directory per run keeps restore trivial (read files back), is easy to
// inspect by hand, and is exactly the per-object layout the OneDrive target
// uploads later, so the same manifest serves both. Members that compress
// well are gzipped individually; images are already compressed.
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_NAME_PREFIX = 'btct-backup-';
export const MANIFEST_FILE = 'manifest.json';

// Full-archive cadence, in minutes. Floor 1 (local disk can take it), ceiling
// a week so a typo like 100000 cannot silently disable backups.
export const FULL_INTERVAL_MIN_FLOOR = 1;
export const FULL_INTERVAL_MIN_CEIL = 7 * 24 * 60;
export const FULL_INTERVAL_MIN_DEFAULT = 60;

export const INCLUDE_KEYS = ['sqlite', 'yjsShared', 'yjsPages', 'assets'];

export const DEFAULT_BACKUP_CONFIG = Object.freeze({
  enabled: false,
  fullIntervalMin: FULL_INTERVAL_MIN_DEFAULT,
  includes: Object.freeze({ sqlite: true, yjsShared: true, yjsPages: true, assets: true }),
});

/** Which categories a backup covers. Anything missing or non-boolean means "include it". */
export function normalizeIncludes(raw) {
  let src = raw;
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch { src = null; }
  }
  const out = {};
  for (const k of INCLUDE_KEYS) {
    const v = src && typeof src === 'object' && !Array.isArray(src) ? src[k] : undefined;
    out[k] = typeof v === 'boolean' ? v : true;
  }
  return out;
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined;
}

/**
 * Validate a config from anywhere (the settings table stores strings, the
 * admin API sends JSON). Always returns a complete config.
 */
export function normalizeBackupConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = toBool(src.enabled);
  let interval = Number(src.fullIntervalMin);
  if (!Number.isFinite(interval)) interval = FULL_INTERVAL_MIN_DEFAULT;
  interval = Math.floor(interval);
  if (interval < FULL_INTERVAL_MIN_FLOOR) interval = FULL_INTERVAL_MIN_FLOOR;
  if (interval > FULL_INTERVAL_MIN_CEIL) interval = FULL_INTERVAL_MIN_CEIL;
  return {
    enabled: enabled === undefined ? DEFAULT_BACKUP_CONFIG.enabled : enabled,
    fullIntervalMin: interval,
    includes: normalizeIncludes(src.includes),
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** `btct-backup-YYYYMMDD-HHMMSS`, UTC, so names sort chronologically everywhere. */
export function backupName(date = new Date()) {
  const d = date;
  return (
    BACKUP_NAME_PREFIX +
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

const NAME_RE = /^btct-backup-\d{8}-\d{6}(-[a-z0-9]+)?$/;

/** Only plain backup directory names may reach the filesystem layer (no paths, no `.tmp`). */
export function isBackupName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/** Timestamp encoded in a backup name, as ms since epoch (UTC), or null. */
export function backupNameTime(name) {
  const m = /^btct-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(absPath)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * The manifest written last into every backup directory. `files` is the
 * authoritative inventory: restore refuses anything not listed, and verify
 * re-hashes every entry.
 */
export function buildManifest({ instanceId, createdAt, trigger, includes, files, docs, sqlite, assets, app }) {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    format: 'btct-backup',
    instanceId: String(instanceId || ''),
    createdAt: createdAt || new Date().toISOString(),
    trigger: trigger || 'manual',
    app: app || {},
    includes: normalizeIncludes(includes),
    sqlite: sqlite || null,
    docs: Array.isArray(docs) ? docs : [],
    assets: Array.isArray(assets) ? assets : [],
    files: (files || []).map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    totalBytes: (files || []).reduce((n, f) => n + (f.bytes || 0), 0),
  };
}

/** Read + sanity-check a manifest; returns { manifest } or { error }. */
export function readManifest(dir) {
  const p = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(p)) return { error: `no ${MANIFEST_FILE} in ${dir}` };
  let m;
  try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { error: `unreadable manifest: ${e?.message || e}` }; }
  if (!m || m.format !== 'btct-backup' || !Array.isArray(m.files)) return { error: 'manifest is not a BTCT backup' };
  if (m.schemaVersion !== BACKUP_SCHEMA_VERSION) return { error: `unsupported backup schema ${m.schemaVersion}` };
  for (const f of m.files) {
    if (typeof f.path !== 'string' || f.path.includes('..') || path.isAbsolute(f.path)) {
      return { error: `manifest lists an unsafe path: ${String(f.path)}` };
    }
  }
  return { manifest: m };
}

/** Re-hash every listed file. Used before restore and after a backup completes. */
export async function verifyBackupDir(dir) {
  const errors = [];
  const { manifest, error } = readManifest(dir);
  if (error) return { ok: false, errors: [error], manifest: null };
  for (const f of manifest.files) {
    const abs = path.join(dir, f.path);
    if (!fs.existsSync(abs)) { errors.push(`missing: ${f.path}`); continue; }
    const size = fs.statSync(abs).size;
    if (size !== f.bytes) { errors.push(`size mismatch: ${f.path} (${size} != ${f.bytes})`); continue; }
    const sum = await sha256File(abs);
    if (sum !== f.sha256) errors.push(`checksum mismatch: ${f.path}`);
  }
  return { ok: errors.length === 0, errors, manifest };
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${units[i]}`;
}
