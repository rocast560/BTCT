// ─────────────────────────────────────────────────────────────────────────
// Restore a backup directory written by backup.mjs into /data.
//
//   bun server/restore.mjs <backup-dir> [--yes] [--partial]
//
// Run it with the server STOPPED, with the same DB_PATH / YPERSISTENCE /
// ASSETS_DIR the server uses. In Docker:
//
//   docker compose stop btct
//   docker compose run --rm btct bun server/restore.mjs /backups/btct-backup-YYYYMMDD-HHMMSS --yes
//   docker compose start btct
//
// What it does, in order:
//   1. Re-hashes every file against the manifest; refuses on any mismatch.
//   2. Refuses if LevelDB is locked (the server is still running).
//   3. Moves the current data aside into <data>/pre-restore-<stamp>/ (never
//      deletes it), then writes the SQLite snapshot (no -wal/-shm: a stale
//      journal next to a restored file corrupts it), rebuilds the Yjs rooms
//      through y-leveldb from the per-room updates, and copies the assets.
//   --partial accepts a backup that does not cover every category and keeps
//   the current data for the categories it lacks.
//
// Deliberately does NOT import db.mjs: that would open (and migrate) the live
// database through the server's connection.
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { verifyBackupDir, formatBytes, INCLUDE_KEYS } from './backup-format.mjs';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');
const level = require('level');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, 'data.sqlite'));
const DATA_DIR = path.dirname(DB_PATH);
const YPERSISTENCE = process.env.YPERSISTENCE ? path.resolve(process.env.YPERSISTENCE) : null;
const ASSETS_DIR = process.env.ASSETS_DIR ? path.resolve(process.env.ASSETS_DIR) : path.join(DATA_DIR, 'assets');
const HISTORY_DIR = process.env.HISTORY_DIR ? path.resolve(process.env.HISTORY_DIR) : path.join(DATA_DIR, 'history');

const SHARED_ROOM = 'btct-shared';

function usage(code = 1) {
  console.error('usage: bun server/restore.mjs <backup-dir> [--yes] [--partial]');
  process.exit(code);
}

function parseArgs(argv) {
  const out = { dir: null, yes: false, partial: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--partial') out.partial = true;
    else if (a.startsWith('-')) usage();
    else if (!out.dir) out.dir = a;
    else usage();
  }
  if (!out.dir) usage();
  return out;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === 'restore';
}

function moveAside(src, asideDir, label) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(asideDir, { recursive: true });
  fs.renameSync(src, path.join(asideDir, label));
  return true;
}

async function gunzipTo(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest));
}

// Open-and-close the LevelDB through level's callback form. A locked store
// (the server still running) then surfaces as a plain error here instead of
// the unhandled 'error' event levelup emits when y-leveldb opens it without
// a callback, which would crash the process mid-message.
function probeLevelDb(dir) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (err) => { if (!settled) { settled = true; resolve(err || null); } };
    try {
      const db = level(dir, { valueEncoding: 'binary' }, (err) => {
        if (err) return done(err);
        db.close(() => done(null));
      });
      db.on('error', done);
    } catch (e) {
      done(e);
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);

  console.log(`[restore] verifying ${dir}`);
  const v = await verifyBackupDir(dir);
  if (!v.ok) {
    for (const e of v.errors) console.error(`[restore]   ${e}`);
    console.error('[restore] backup failed verification; nothing was changed.');
    process.exit(2);
  }
  const m = v.manifest;
  const inc = m.includes;
  const missing = INCLUDE_KEYS.filter((k) => !inc[k]);
  console.log(`[restore] ${m.createdAt} (${m.trigger}) from instance ${m.instanceId || '?'}: ${m.files.length} files, ${formatBytes(m.totalBytes)}`);
  console.log(`[restore]   sqlite=${inc.sqlite} shared-doc=${inc.yjsShared} page-docs=${inc.yjsPages} assets=${inc.assets} history=${inc.history}`);
  if (missing.length && !args.partial) {
    console.error(`[restore] this backup does not cover: ${missing.join(', ')}. Pass --partial to restore what it has and keep the current data for the rest.`);
    process.exit(2);
  }
  const wantsDocs = inc.yjsShared || inc.yjsPages;
  if (wantsDocs && !YPERSISTENCE) {
    console.error('[restore] YPERSISTENCE is not set, so Yjs rooms cannot be restored. Set it to the server\'s value (e.g. /data/yjs).');
    process.exit(2);
  }

  // Refuse while the server holds the LevelDB lock. Opening it is the check.
  let ldb = null;
  if (wantsDocs) {
    fs.mkdirSync(YPERSISTENCE, { recursive: true });
    const lockErr = await probeLevelDb(YPERSISTENCE);
    if (lockErr) {
      console.error(`[restore] cannot open ${YPERSISTENCE}: ${lockErr?.message || lockErr}`);
      console.error('[restore] the server appears to be running. Stop it first (docker compose stop btct).');
      process.exit(3);
    }
    ldb = new LeveldbPersistence(YPERSISTENCE);
    await ldb.getAllDocNames();
  }
  if (inc.sqlite && fs.existsSync(`${DB_PATH}-wal`)) {
    console.warn(`[restore] note: ${DB_PATH}-wal exists; it is moved aside with the old database, not merged.`);
  }

  if (!args.yes) {
    console.log(`[restore] this replaces the data under ${DATA_DIR}. The current files are kept in a pre-restore folder.`);
    if (!(await confirm("Type 'restore' to continue: "))) {
      console.log('[restore] cancelled.');
      if (ldb) await ldb.destroy();
      process.exit(0);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const aside = path.join(DATA_DIR, `pre-restore-${stamp}`);
  const summary = [];

  if (inc.sqlite) {
    const src = path.join(dir, 'sqlite', 'data.sqlite.gz');
    if (!fs.existsSync(src)) { console.error('[restore] manifest says sqlite is included but sqlite/data.sqlite.gz is missing'); process.exit(2); }
    for (const suffix of ['', '-wal', '-shm', '-journal']) moveAside(`${DB_PATH}${suffix}`, aside, `${path.basename(DB_PATH)}${suffix}`);
    await gunzipTo(src, DB_PATH);
    summary.push(`sqlite: ${formatBytes(fs.statSync(DB_PATH).size)}`);
  }

  if (wantsDocs) {
    const full = inc.yjsShared && inc.yjsPages;
    if (full) {
      // Exact state: start from an empty store so rooms created after the
      // backup do not linger as orphans.
      await ldb.destroy();
      moveAside(YPERSISTENCE, aside, 'yjs');
      fs.mkdirSync(YPERSISTENCE, { recursive: true });
      ldb = new LeveldbPersistence(YPERSISTENCE);
    }
    let n = 0;
    for (const d of m.docs) {
      const wanted = d.name === SHARED_ROOM ? inc.yjsShared : inc.yjsPages;
      if (!wanted) continue;
      const src = path.join(dir, 'yjs', `${d.name}.yupdate.gz`);
      if (!fs.existsSync(src)) { console.warn(`[restore]   skipping ${d.name}: file missing`); continue; }
      const update = new Uint8Array(zlib.gunzipSync(fs.readFileSync(src)));
      if (!full) await ldb.clearDocument(d.name);
      await ldb.storeUpdate(d.name, update);
      await ldb.flushDocument(d.name);
      n += 1;
    }
    await ldb.destroy();
    summary.push(`yjs rooms: ${n}`);
  }

  if (inc.assets) {
    moveAside(ASSETS_DIR, aside, 'assets');
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    let n = 0;
    for (const a of m.assets) {
      if (!a.present) continue;
      const src = path.join(dir, 'assets', a.id);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(ASSETS_DIR, a.id));
      n += 1;
    }
    summary.push(`assets: ${n}`);
  }

  if (inc.history) {
    moveAside(HISTORY_DIR, aside, 'history');
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    let n = 0;
    for (const h of m.history || []) {
      const src = path.join(dir, 'history', `${h.pageId}.ydoc`);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(HISTORY_DIR, `${h.pageId}.ydoc`));
      n += 1;
    }
    summary.push(`history twins: ${n}`);
  }

  console.log(`[restore] done: ${summary.join(', ')}`);
  if (fs.existsSync(aside)) console.log(`[restore] previous data kept in ${aside}; delete it once you are happy.`);
  console.log('[restore] start the server again (docker compose start btct) and check /healthz.');
}

main().catch((e) => {
  console.error(`[restore] failed: ${e?.stack || e}`);
  process.exit(1);
});
