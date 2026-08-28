// ─────────────────────────────────────────────────────────────────────────
// Backup engine: scheduled, consistent snapshots of the whole instance into
// a host folder (BACKUP_DIR, bind-mounted from the Docker host).
//
// One run = one directory `btct-backup-YYYYMMDD-HHMMSS/` (layout and manifest
// in backup-format.mjs), built under a `.tmp` name and renamed into place
// only after the manifest is written, so a half-finished run is never
// mistaken for a backup. Data is read through data-export.mjs (VACUUM INTO,
// per-room Yjs updates, asset copies), never by copying live files.
//
// Config lives in the SQLite settings table (admin UI), the scheduler in
// scheduler.mjs. Nothing is deleted automatically: retention is the admin's
// call (list / delete / disk usage), by decision.
//
// This module is a deliberate exception to "the server is dumb about domain
// data" (invariant #4): it moves bytes and knows room names, never meaning.
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { getSetting, setSetting } from './db.mjs';
import { createJob } from './scheduler.mjs';
import {
  MANIFEST_FILE,
  normalizeBackupConfig,
  backupName,
  backupNameTime,
  isBackupName,
  buildManifest,
  readManifest,
  sha256File,
  formatBytes,
} from './backup-format.mjs';
import {
  SHARED_ROOM,
  sqliteDataVersion,
  exportSqliteTo,
  listDocNames,
  exportDocUpdate,
  stateVectorOf,
  listAssetRows,
  assetPath,
} from './data-export.mjs';
import { HISTORY_DIR, flushAllTwins } from './history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const T = {
  ENABLED: 'backup_enabled',
  INTERVAL: 'backup_full_interval_min',
  INCLUDES: 'backup_includes',
  TOKEN: 'backup_token',
  INSTANCE: 'backup_instance_id',
  LAST_RUN: 'backup_last_run_at',
  LAST_RESULT: 'backup_last_result',
};

// Where backups land. In Docker this is /backups (compose bind-mounts
// ./backups there); in dev it defaults to a `backups/` folder beside the DB.
export const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(path.dirname(path.resolve(process.env.DB_PATH || path.join(__dirname, 'data.sqlite'))), 'backups');

const genToken = () => crypto.randomBytes(32).toString('hex');

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function dirWritable() {
  try {
    ensureDir();
    fs.accessSync(BACKUP_DIR, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function instanceId() {
  let id = getSetting(T.INSTANCE);
  if (!id) {
    id = crypto.randomUUID();
    setSetting(T.INSTANCE, id);
  }
  return id;
}

function lastResult() {
  try { return JSON.parse(getSetting(T.LAST_RESULT) || 'null'); } catch { return null; }
}

// ── Config ─────────────────────────────────────────────────────────────

export function getBackupConfig() {
  const cfg = normalizeBackupConfig({
    enabled: getSetting(T.ENABLED),
    fullIntervalMin: getSetting(T.INTERVAL),
    includes: getSetting(T.INCLUDES),
  });
  return {
    ...cfg,
    dir: BACKUP_DIR,
    token: getSetting(T.TOKEN) || null,
    configured: !!getSetting(T.TOKEN),
    instanceId: instanceId(),
  };
}

export function setBackupConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  if (body.fullIntervalMin !== undefined && !Number.isFinite(Number(body.fullIntervalMin))) {
    throw new Error('fullIntervalMin must be a number of minutes');
  }
  if (body.includes !== undefined && (typeof body.includes !== 'object' || body.includes === null || Array.isArray(body.includes))) {
    throw new Error('includes must be an object');
  }
  const current = getBackupConfig();
  const merged = normalizeBackupConfig({
    enabled: body.enabled ?? current.enabled,
    fullIntervalMin: body.fullIntervalMin ?? current.fullIntervalMin,
    includes: body.includes ? { ...current.includes, ...body.includes } : current.includes,
  });
  setSetting(T.ENABLED, merged.enabled ? '1' : '0');
  setSetting(T.INTERVAL, String(merged.fullIntervalMin));
  setSetting(T.INCLUDES, JSON.stringify(merged.includes));
  if (merged.enabled && !getSetting(T.TOKEN)) setSetting(T.TOKEN, genToken()); // mint on first enable
  if (job) job.reschedule();
  return getBackupConfig();
}

export function regenerateBackupToken() {
  const t = genToken();
  setSetting(T.TOKEN, t);
  return t;
}

/** True when the request carries the static backup token (for host schedulers). */
export function matchesBackupToken(req) {
  const token = getSetting(T.TOKEN);
  if (!token) return false;
  const h = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Running a backup ───────────────────────────────────────────────────

async function gzipFile(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(dest));
}

let inProgress = false;

/** Write one backup directory. Throws on failure (the .tmp dir is removed). */
export async function runBackup({ trigger = 'manual' } = {}) {
  if (inProgress) {
    const e = new Error('a backup is already running');
    e.code = 'BUSY';
    throw e;
  }
  inProgress = true;
  const startedAt = Date.now();
  const cfg = getBackupConfig();
  const name = backupName(new Date(startedAt));
  const finalDir = path.join(BACKUP_DIR, name);
  const tmpDir = `${finalDir}.tmp`;
  const files = [];
  const docsMeta = [];
  const assetsMeta = [];
  const historyMeta = [];
  let sqliteMeta = null;

  const record = async (rel, abs) => {
    files.push({ path: rel, bytes: fs.statSync(abs).size, sha256: await sha256File(abs) });
  };

  try {
    ensureDir();
    if (fs.existsSync(finalDir)) throw new Error(`${name} already exists (two runs in the same second)`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    if (cfg.includes.sqlite) {
      fs.mkdirSync(path.join(tmpDir, 'sqlite'));
      const raw = path.join(tmpDir, 'sqlite', 'data.sqlite');
      const rawBytes = exportSqliteTo(raw);
      const gz = `${raw}.gz`;
      await gzipFile(raw, gz);
      fs.unlinkSync(raw);
      sqliteMeta = { dataVersion: sqliteDataVersion(), rawBytes };
      await record('sqlite/data.sqlite.gz', gz);
    }

    if (cfg.includes.yjsShared || cfg.includes.yjsPages) {
      fs.mkdirSync(path.join(tmpDir, 'yjs'));
      for (const docName of await listDocNames()) {
        const wanted = docName === SHARED_ROOM ? cfg.includes.yjsShared : cfg.includes.yjsPages;
        if (!wanted) continue;
        const update = await exportDocUpdate(docName);
        if (!update) continue;
        const rel = `yjs/${docName}.yupdate.gz`;
        const gz = path.join(tmpDir, rel);
        fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(update), { level: 6 }));
        docsMeta.push({ name: docName, bytes: update.byteLength, stateVector: stateVectorOf(update) });
        await record(rel, gz);
      }
    }

    if (cfg.includes.assets) {
      fs.mkdirSync(path.join(tmpDir, 'assets'));
      for (const row of listAssetRows()) {
        const src = assetPath(row.id);
        const present = fs.existsSync(src);
        assetsMeta.push({
          id: row.id, filename: row.filename, mime: row.mime, size: row.size,
          workspaceId: row.workspace_id, kind: row.kind, present,
        });
        if (!present) continue;
        const rel = `assets/${row.id}`;
        const dest = path.join(tmpDir, rel);
        fs.copyFileSync(src, dest);
        await record(rel, dest);
      }
    }

    if (cfg.includes.history) {
      // Version diffs need the GC-off twins; flush the open ones first so
      // the files match what the running server holds.
      flushAllTwins();
      fs.mkdirSync(path.join(tmpDir, 'history'));
      const names = fs.existsSync(HISTORY_DIR) ? fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.ydoc')) : [];
      for (const file of names) {
        const rel = `history/${file}`;
        const dest = path.join(tmpDir, rel);
        fs.copyFileSync(path.join(HISTORY_DIR, file), dest);
        historyMeta.push({ pageId: file.slice(0, -'.ydoc'.length), bytes: fs.statSync(dest).size });
        await record(rel, dest);
      }
    }

    const manifest = buildManifest({
      instanceId: cfg.instanceId,
      createdAt: new Date(startedAt).toISOString(),
      trigger,
      includes: cfg.includes,
      files,
      docs: docsMeta,
      sqlite: sqliteMeta,
      assets: assetsMeta,
      history: historyMeta,
      app: { name: 'btct', hostname: os.hostname() },
    });
    fs.writeFileSync(path.join(tmpDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    fs.renameSync(tmpDir, finalDir);

    const result = {
      ok: true,
      name,
      at: startedAt,
      trigger,
      bytes: manifest.totalBytes,
      files: files.length,
      docs: docsMeta.length,
      assets: assetsMeta.filter((a) => a.present).length,
      history: historyMeta.length,
      durationMs: Date.now() - startedAt,
    };
    setSetting(T.LAST_RESULT, JSON.stringify(result));
    console.log(`[backup] wrote ${name}: ${files.length} files, ${formatBytes(manifest.totalBytes)}, ${result.durationMs} ms (${trigger})`);
    return result;
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setSetting(T.LAST_RESULT, JSON.stringify({ ok: false, at: startedAt, trigger, error: String(e?.message || e) }));
    throw e;
  } finally {
    inProgress = false;
  }
}

// ── Inventory ──────────────────────────────────────────────────────────

function dirSize(dir) {
  let total = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += dirSize(p);
    else if (ent.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const out = [];
  for (const ent of fs.readdirSync(BACKUP_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const partial = ent.name.endsWith('.tmp');
    const base = partial ? ent.name.slice(0, -4) : ent.name;
    if (!isBackupName(base)) continue;
    const dir = path.join(BACKUP_DIR, ent.name);
    const manifest = partial ? null : readManifest(dir).manifest || null;
    out.push({
      name: ent.name,
      createdAt: manifest?.createdAt || new Date(backupNameTime(base) || 0).toISOString(),
      bytes: manifest ? manifest.totalBytes : dirSize(dir),
      files: manifest ? manifest.files.length : 0,
      includes: manifest ? manifest.includes : null,
      trigger: manifest ? manifest.trigger : null,
      partial: partial || !manifest,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

export function deleteBackup(name) {
  const base = typeof name === 'string' && name.endsWith('.tmp') ? name.slice(0, -4) : name;
  if (!isBackupName(base)) throw new Error('invalid backup name');
  const dir = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(dir)) {
    const e = new Error('backup not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function backupUsage() {
  const list = listBackups();
  return { count: list.length, totalBytes: list.reduce((n, b) => n + b.bytes, 0) };
}

// ── Scheduler + status ─────────────────────────────────────────────────

let job = null;

export function startBackupScheduler() {
  if (job) return job;
  job = createJob({
    name: 'backup.full',
    intervalMs: () => getBackupConfig().fullIntervalMin * 60_000,
    enabled: () => getBackupConfig().enabled,
    run: ({ trigger }) => runBackup({ trigger }),
    initialLastRunAt: Number(getSetting(T.LAST_RUN) || 0) || null,
    onStatus: (s) => { if (s.lastRunAt) setSetting(T.LAST_RUN, String(s.lastRunAt)); },
    log: (line) => console.warn(line),
  });
  job.start();
  const cfg = getBackupConfig();
  console.log(`[backup] folder ${BACKUP_DIR} (${dirWritable() ? 'writable' : 'NOT writable'}); schedule ${cfg.enabled ? `every ${cfg.fullIntervalMin} min` : 'off'}`);
  return job;
}

/** Run now (admin button / host scheduler). Resolves with the run's result. */
export async function runBackupNow(reason = 'manual') {
  if (!job) startBackupScheduler();
  const r = await job.trigger(reason);
  if (!r.ran) return { ran: false, reason: r.reason };
  const last = lastResult();
  if (last && !last.ok) {
    const e = new Error(last.error || 'backup failed');
    e.code = 'FAILED';
    throw e;
  }
  return { ran: true, ...(last || {}) };
}

export function backupStatus() {
  const cfg = getBackupConfig();
  const s = job ? job.status() : null;
  const last = lastResult();
  return {
    enabled: cfg.enabled,
    fullIntervalMin: cfg.fullIntervalMin,
    includes: cfg.includes,
    dir: BACKUP_DIR,
    dirWritable: dirWritable(),
    running: s ? s.running : inProgress,
    lastRunAt: s?.lastRunAt ?? last?.at ?? null,
    lastSuccessAt: s?.lastSuccessAt ?? (last?.ok ? last.at : null),
    lastDurationMs: s?.lastDurationMs ?? last?.durationMs ?? null,
    lastError: s?.lastError ?? (last && !last.ok ? last.error : null),
    nextRunAt: s?.nextRunAt ?? null,
    lastBackup: last?.ok
      ? { name: last.name, bytes: last.bytes, files: last.files, docs: last.docs, assets: last.assets, at: last.at, trigger: last.trigger, durationMs: last.durationMs }
      : null,
    usage: backupUsage(),
  };
}
