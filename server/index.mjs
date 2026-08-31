import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';

import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.mjs';
import {
  createUser,
  getUserByUsername,
  getUserById,
  publicUser,
  listUsers,
  deleteUser,
  setUserAdmin,
  updateUserPassword,
  updateUserColor,
  updateUserPrefs,
  adminCount,
  getSetting,
  setSetting,
  listChatSessions,
  getChatSession,
  saveChatSession,
  deleteChatSession,
} from './db.mjs';
import { getAiConfig, setAiConfig, testAiConnection, handleAiChat } from './ai.mjs';
import { getMcpConfig, setMcpConfig, regenerateMcpToken, handleMcp } from './mcp.mjs';
import { publishPublicBlur, publishPublicSettings } from './yjs-data.mjs';
import {
  getBackupConfig, setBackupConfig, regenerateBackupToken, runBackupNow,
  listBackups, deleteBackup, backupStatus, matchesBackupToken, startBackupScheduler,
} from './backup.mjs';
import {
  getCmdlogConfig,
  setCmdlogConfig,
  regenerateCmdlogToken,
  handleCmdlogEvents,
  handleCmdlogWhitelist,
  handleCmdlogQuery,
  handleCmdlogManual,
  handleCmdlogClear,
} from './cmdlog.mjs';
import {
  handleAssetUpload,
  handleAssetGet,
  handleAssetList,
  handleAssetDelete,
} from './assets.mjs';
import {
  getRetentionConfig, setRetentionConfig, retentionStatus, pruneNow, pruneHistoryRange, startRetentionScheduler,
} from './retention.mjs';
import {
  trackPageDoc,
  handleVersionList,
  handleVersionCreate,
  handleVersionGet,
  handleVersionDelete,
  handleVersionRename,
  handleTwinGet,
} from './history.mjs';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_THEME_COLOR = '#f59e0b'; // yellow-orange (amber-500)

// ── Theme policy (note heading colours + hard-lock) ─────────────────────
// Same shape the client's resolveThemePrefs() accepts:
//   { headingColor: '#RRGGBB' | null, headings: { h1..h6: '#RRGGBB' } }
// Stored as JSON in settings.theme_headings; settings.theme_lock ('1'/'0')
// forces it on every account; settings.theme_updated_at lets clients drop a
// stale copy of the live mirror (see publishPublicSettings in yjs-data.mjs).
const HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

function validateThemePrefs(t) {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return 'must be an object';
  if (t.headingColor !== undefined && t.headingColor !== null &&
      !(typeof t.headingColor === 'string' && HEX_COLOR_RE.test(t.headingColor))) {
    return 'headingColor must be null or a #RRGGBB hex value';
  }
  if (t.headings !== undefined) {
    const h = t.headings;
    if (typeof h !== 'object' || h === null || Array.isArray(h)) return 'headings must be an object';
    for (const [k, v] of Object.entries(h)) {
      if (!HEADING_LEVELS.includes(k)) return `headings.${k} is not a heading level`;
      if (!(typeof v === 'string' && HEX_COLOR_RE.test(v))) return `headings.${k} must be a #RRGGBB hex value`;
    }
  }
  return null;
}

function normalizeThemePrefs(t) {
  const out = { headingColor: null, headings: {} };
  if (validateThemePrefs(t)) return out;
  if (typeof t.headingColor === 'string') out.headingColor = t.headingColor;
  for (const k of HEADING_LEVELS) {
    if (t.headings && typeof t.headings[k] === 'string') out.headings[k] = t.headings[k];
  }
  return out;
}

// The public (unauthenticated) view of the theme: what GET /api/settings
// returns and what the live mirror carries.
const BLUR_STRENGTH_MIN = 0.25;
const BLUR_STRENGTH_MAX = 3;

function clampBlurStrength(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(Math.max(v, BLUR_STRENGTH_MIN), BLUR_STRENGTH_MAX)
    : fallback;
}

// Workspace default strength for new blur (redaction) regions, per style.
// A user's own prefs.blurDefaults wins over this; it is only the fallback.
function publicBlurSettings() {
  let blurDefaults = { gaussian: 1, pixelate: 1 };
  try {
    const raw = getSetting('blur_defaults');
    if (raw) {
      const parsed = JSON.parse(raw);
      blurDefaults = {
        gaussian: clampBlurStrength(parsed?.gaussian, 1),
        pixelate: clampBlurStrength(parsed?.pixelate, 1),
      };
    }
  } catch { /* malformed row: fall back to 1x */ }
  return { blurDefaults, blurUpdatedAt: Number(getSetting('blur_updated_at') || 0) };
}

function publicThemeSettings() {
  let themeHeadings = { headingColor: null, headings: {} };
  try {
    const raw = getSetting('theme_headings');
    if (raw) themeHeadings = normalizeThemePrefs(JSON.parse(raw));
  } catch { /* malformed row: fall back to inherit */ }
  return {
    themeColor: getSetting('theme_color') || DEFAULT_THEME_COLOR,
    themeHeadings,
    themeLock: getSetting('theme_lock') === '1',
    themeUpdatedAt: Number(getSetting('theme_updated_at') || 0),
    ...publicBlurSettings(),
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// y-websocket ships its server helpers as CJS: load via createRequire.
const require = createRequire(import.meta.url);
const { setupWSConnection, docs: relayDocs } = require('y-websocket/bin/utils');

const PORT = Number(process.env.PORT || 1234);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // empty = same-origin only
const STATIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : null;

// ─────────────────────────────────────────────────────────────────────────
// Admin bootstrap. On first launch (or whenever no admin exists) ensure a
// default admin account is present. Credentials come from environment
// variables when set, falling back to a documented default so a fresh
// deployment is immediately usable. The default credentials MUST be
// changed on first login in any non-trivial deployment.
// ─────────────────────────────────────────────────────────────────────────
const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme!';

// Failed-login throttle (see the /api/login route). Window resets on
// success or expiry; the map is pruned so it can't grow unbounded.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 60_000;
const loginFailures = new Map(); // key -> { count, resetAt }

function loginThrottled(key) {
  const e = loginFailures.get(key);
  if (!e) return false;
  if (Date.now() > e.resetAt) { loginFailures.delete(key); return false; }
  return e.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key) {
  const now = Date.now();
  if (loginFailures.size > 1000) {
    for (const [k, e] of loginFailures) if (now > e.resetAt) loginFailures.delete(k);
  }
  const e = loginFailures.get(key);
  if (!e || now > e.resetAt) loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else e.count++;
}

async function ensureBootstrapAdmin() {
  if (adminCount() > 0) return;
  const existing = getUserByUsername(DEFAULT_ADMIN_USERNAME);
  if (existing) {
    // Account exists but isn't admin: promote it rather than failing.
    setUserAdmin(existing.id, true);
    console.warn(
      `[btct-server] promoted existing user '${DEFAULT_ADMIN_USERNAME}' to admin`,
    );
    return;
  }
  const hashRecord = await hashPassword(DEFAULT_ADMIN_PASSWORD);
  createUser({
    username: DEFAULT_ADMIN_USERNAME,
    salt: hashRecord.salt,
    hash: hashRecord.hash,
    iter: hashRecord.iter,
    isAdmin: true,
  });
  console.warn(
    `[btct-server] created bootstrap admin '${DEFAULT_ADMIN_USERNAME}' / '${DEFAULT_ADMIN_PASSWORD}': change this password immediately`,
  );
}
await ensureBootstrapAdmin();

// ─────────────────────────────────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────────────────────────────────
function setCors(res) {
  if (!ALLOWED_ORIGIN) return; // same-origin deployment: no CORS headers needed
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res, status, body) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        const err = new Error('payload too large');
        err.status = 413;
        reject(err);
        // Stop reading but keep the socket, so the 413 can actually be sent;
        // the error handler closes the connection once the response is out.
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function authFromHeader(req) {
  const h = req.headers.authorization;
  if (!h || !h.toLowerCase().startsWith('bearer ')) return null;
  return verifyToken(h.slice(7).trim());
}

function requireAdmin(req) {
  const claims = authFromHeader(req);
  if (!claims) return { error: 'unauthorized', status: 401 };
  const user = getUserById(claims.uid);
  if (!user) return { error: 'unauthorized', status: 401 };
  if (!user.is_admin) return { error: 'forbidden', status: 403 };
  return { user };
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP routes
// ─────────────────────────────────────────────────────────────────────────
const VALID_USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/;

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      return sendJson(res, 200, { ok: true });
    }

    // User creation is admin-only. The bootstrap admin is the seed account;
    // every subsequent account must be created from an authenticated admin
    // session via POST /api/admin/users.
    if (req.method === 'POST' && req.url === '/api/admin/users') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const isAdmin = !!body.isAdmin;
      if (!VALID_USERNAME.test(username)) {
        return sendJson(res, 400, { error: 'invalid username (3-32 chars: letters, numbers, . _ -)' });
      }
      if (password.length < 8) {
        return sendJson(res, 400, { error: 'password must be at least 8 characters' });
      }
      if (getUserByUsername(username)) {
        return sendJson(res, 409, { error: 'username already taken' });
      }
      const hashRecord = await hashPassword(password);
      const user = createUser({
        username,
        salt: hashRecord.salt,
        hash: hashRecord.hash,
        iter: hashRecord.iter,
        isAdmin,
      });
      return sendJson(res, 201, { user: publicUser(user) });
    }

    if (req.method === 'GET' && req.url === '/api/admin/users') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, { users: listUsers() });
    }

    if (req.method === 'DELETE' && req.url?.startsWith('/api/admin/users/')) {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const idStr = req.url.slice('/api/admin/users/'.length);
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0) {
        return sendJson(res, 400, { error: 'invalid user id' });
      }
      if (id === gate.user.id) {
        return sendJson(res, 400, { error: 'cannot delete your own account' });
      }
      const target = getUserById(id);
      if (!target) return sendJson(res, 404, { error: 'user not found' });
      // Prevent removing the last admin so the system never locks itself out.
      if (target.is_admin && adminCount() <= 1) {
        return sendJson(res, 400, { error: 'cannot delete the last admin' });
      }
      deleteUser(id);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url?.startsWith('/api/admin/users/') && req.url.endsWith('/password')) {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const idStr = req.url.slice('/api/admin/users/'.length, req.url.length - '/password'.length);
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0) {
        return sendJson(res, 400, { error: 'invalid user id' });
      }
      const target = getUserById(id);
      if (!target) return sendJson(res, 404, { error: 'user not found' });
      const body = await readJsonBody(req);
      const password = String(body.password || '');
      if (password.length < 8) {
        return sendJson(res, 400, { error: 'password must be at least 8 characters' });
      }
      const hashRecord = await hashPassword(password);
      updateUserPassword(id, hashRecord);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/api/login') {
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      // Throttle FAILED attempts per username+IP: each verification costs
      // ~100ms of PBKDF2 CPU, so an unauthenticated retry loop would starve
      // the Yjs relay this process also runs.
      const throttleKey = `${username.toLowerCase()}|${req.socket.remoteAddress || ''}`;
      if (loginThrottled(throttleKey)) {
        return sendJson(res, 429, { error: 'too many attempts, try again shortly' });
      }
      const row = getUserByUsername(username);
      if (!row || !(await verifyPassword(password, row.salt, row.hash, row.iter))) {
        recordLoginFailure(throttleKey);
        // Same response for both cases to avoid username enumeration.
        return sendJson(res, 401, { error: 'invalid username or password' });
      }
      loginFailures.delete(throttleKey);
      const token = signToken({ uid: row.id, username: row.username, admin: !!row.is_admin });
      return sendJson(res, 200, { token, user: publicUser(row) });
    }

    if (req.method === 'GET' && req.url === '/api/me') {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      const user = getUserById(claims.uid);
      if (!user) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, { user: publicUser(user) });
    }

    // Self-service profile update: any authenticated user can change
    // their own display color.
    if (req.method === 'POST' && req.url === '/api/me/profile') {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      const user = getUserById(claims.uid);
      if (!user) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readJsonBody(req, 4 * 1024);
      if (typeof body.color === 'string') {
        const color = body.color.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
          return sendJson(res, 400, { error: 'color must be a #RRGGBB hex value' });
        }
        updateUserColor(user.id, color);
      }
      // Optional per-account editor preferences (code-block accent + keybinds).
      // Validate the shape so a malformed client can't poison the JSON blob.
      if (body.prefs !== undefined) {
        const prefs = body.prefs;
        if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) {
          return sendJson(res, 400, { error: 'prefs must be an object' });
        }
        if (prefs.codeAccent !== undefined &&
            !(typeof prefs.codeAccent === 'string' && HEX_COLOR_RE.test(prefs.codeAccent))) {
          return sendJson(res, 400, { error: 'prefs.codeAccent must be a #RRGGBB hex value' });
        }
        if (prefs.keybinds !== undefined) {
          const kb = prefs.keybinds;
          if (typeof kb !== 'object' || kb === null || Array.isArray(kb) ||
              !Object.values(kb).every((v) => typeof v === 'string')) {
            return sendJson(res, 400, { error: 'prefs.keybinds must be a map of strings' });
          }
        }
        // Live-follow preferences (presence / spectate feature).
        if (prefs.follow !== undefined) {
          const f = prefs.follow;
          if (typeof f !== 'object' || f === null || Array.isArray(f)) {
            return sendJson(res, 400, { error: 'prefs.follow must be an object' });
          }
          if (f.defaultPrecision !== undefined &&
              f.defaultPrecision !== 'precise' && f.defaultPrecision !== 'view') {
            return sendJson(res, 400, { error: 'prefs.follow.defaultPrecision must be "precise" or "view"' });
          }
          if (f.panePlacement !== undefined && f.panePlacement !== null &&
              f.panePlacement !== 'split' && f.panePlacement !== 'takeover') {
            return sendJson(res, 400, { error: 'prefs.follow.panePlacement invalid' });
          }
          if (f.precisionByUserId !== undefined) {
            const m = f.precisionByUserId;
            if (typeof m !== 'object' || m === null || Array.isArray(m) ||
                !Object.values(m).every((v) => v === 'precise' || v === 'view')) {
              return sendJson(res, 400, { error: 'prefs.follow.precisionByUserId must map user ids to "precise"/"view"' });
            }
          }
        }
        // Note heading colours (per-account theme). Same validator the admin
        // policy uses; a bad blob is rejected rather than stored.
        if (prefs.theme !== undefined) {
          const themeErr = validateThemePrefs(prefs.theme);
          if (themeErr) return sendJson(res, 400, { error: `prefs.theme ${themeErr}` });
        }
        // Interface theme id. The client registry (src/themes/registry.ts)
        // decides what ids exist; the server only keeps it a short slug, and
        // an unknown id falls back to the default on the client.
        if (prefs.uiTheme !== undefined &&
            !(typeof prefs.uiTheme === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(prefs.uiTheme))) {
          return sendJson(res, 400, { error: 'prefs.uiTheme must be a short lowercase slug' });
        }
        // Per-account default strength for new blur regions: {gaussian, pixelate},
        // each null (inherit the workspace default) or a number in 0.25..3.
        if (prefs.blurDefaults !== undefined) {
          const b = prefs.blurDefaults;
          if (typeof b !== 'object' || b === null || Array.isArray(b)) {
            return sendJson(res, 400, { error: 'prefs.blurDefaults must be an object' });
          }
          for (const key of ['gaussian', 'pixelate']) {
            const v = b[key];
            if (v !== undefined && v !== null &&
                !(typeof v === 'number' && Number.isFinite(v) && v >= 0.25 && v <= 3)) {
              return sendJson(res, 400, { error: `prefs.blurDefaults.${key} must be null or a number between 0.25 and 3` });
            }
          }
        }
        updateUserPrefs(user.id, JSON.stringify(prefs));
      }
      const fresh = getUserById(user.id);
      return sendJson(res, 200, { user: publicUser(fresh) });
    }

    // Public settings (no auth): needed on the login screen so the
    // primary theme color matches the rest of the app from first paint.
    // Also carries the admin heading-colour policy (defaults + hard-lock).
    if (req.method === 'GET' && req.url === '/api/settings') {
      return sendJson(res, 200, publicThemeSettings());
    }

    // Admin-only: update the workspace theme policy. `color` is the accent
    // every client paints with; `headings` are the default note heading
    // colours for every account; `lock` forces them on everyone. Stored in
    // the SQLite settings table, then mirrored into the shared doc so
    // connected clients re-theme without a reload.
    if (req.method === 'POST' && req.url === '/api/settings/theme') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req, 8 * 1024);
      if (body.color !== undefined) {
        const color = typeof body.color === 'string' ? body.color.trim() : '';
        if (!HEX_COLOR_RE.test(color)) {
          return sendJson(res, 400, { error: 'color must be a #RRGGBB hex value' });
        }
        setSetting('theme_color', color);
      }
      if (body.headings !== undefined) {
        const headingsErr = validateThemePrefs(body.headings);
        if (headingsErr) return sendJson(res, 400, { error: `headings ${headingsErr}` });
        setSetting('theme_headings', JSON.stringify(normalizeThemePrefs(body.headings)));
      }
      if (body.lock !== undefined) {
        if (typeof body.lock !== 'boolean') return sendJson(res, 400, { error: 'lock must be a boolean' });
        setSetting('theme_lock', body.lock ? '1' : '0');
      }
      setSetting('theme_updated_at', String(Date.now()));
      const pub = publicThemeSettings();
      publishPublicSettings(pub).catch((e) => console.warn('[theme] live mirror failed:', e?.message || e));
      return sendJson(res, 200, pub);
    }

    // Admin-only: workspace default strength for new blur regions
    // ({gaussian?, pixelate?}, each 0.25..3). Mirrored into the shared doc
    // (settingsPublic.blur) so connected clients follow without a reload.
    if (req.method === 'POST' && req.url === '/api/settings/blur') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req, 4 * 1024);
      const next = { ...publicBlurSettings().blurDefaults };
      for (const key of ['gaussian', 'pixelate']) {
        if (body[key] === undefined) continue;
        if (!(typeof body[key] === 'number' && Number.isFinite(body[key]) &&
              body[key] >= BLUR_STRENGTH_MIN && body[key] <= BLUR_STRENGTH_MAX)) {
          return sendJson(res, 400, { error: `${key} must be a number between 0.25 and 3` });
        }
        next[key] = body[key];
      }
      setSetting('blur_defaults', JSON.stringify(next));
      setSetting('blur_updated_at', String(Date.now()));
      const pubBlur = publicBlurSettings();
      publishPublicBlur(pubBlur).catch((e) => console.warn('[blur] live mirror failed:', e?.message || e));
      return sendJson(res, 200, pubBlur);
    }

    // ── AI assistant (Claude) ──────────────────────────────────────────
    // Config is admin-only and the API key is never returned to clients.
    if (req.method === 'GET' && req.url === '/api/ai/config') {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, getAiConfig());
    }
    if (req.method === 'POST' && req.url === '/api/ai/config') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req, 64 * 1024);
      try {
        return sendJson(res, 200, setAiConfig(body));
      } catch (e) {
        return sendJson(res, 400, { error: String(e?.message || e) });
      }
    }
    if (req.method === 'POST' && req.url === '/api/ai/config/test') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      try {
        return sendJson(res, 200, await testAiConnection());
      } catch (e) {
        return sendJson(res, 400, { error: String(e?.message || e) });
      }
    }
    // Chat: any authenticated user. Streams SSE; handler writes its own head.
    if (req.method === 'POST' && req.url === '/api/ai/chat') {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      const user = getUserById(claims.uid);
      if (!user) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readJsonBody(req, 512 * 1024);
      return handleAiChat(req, res, { user, body, setCors });
    }

    // Chat history: durable per-account Claude conversations. Every query is
    // scoped to the authenticated user's id, so users can't see each other's.
    if (req.method === 'GET' && req.url === '/api/ai/sessions') {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, { sessions: listChatSessions(claims.uid) });
    }
    if (req.url?.startsWith('/api/ai/sessions/')) {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      const id = decodeURIComponent(req.url.slice('/api/ai/sessions/'.length));
      if (!id) return sendJson(res, 400, { error: 'missing session id' });
      if (req.method === 'GET') {
        const session = getChatSession(claims.uid, id);
        if (!session) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, { session });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        if (!Array.isArray(body.messages)) {
          return sendJson(res, 400, { error: 'messages must be an array' });
        }
        const messages = body.messages
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({ role: m.role, content: m.content }));
        const meta = saveChatSession(claims.uid, {
          id,
          title: typeof body.title === 'string' ? body.title : 'New chat',
          messages,
          createdAt: body.createdAt,
          updatedAt: body.updatedAt ?? Date.now(),
        });
        return sendJson(res, 200, { session: meta });
      }
      if (req.method === 'DELETE') {
        deleteChatSession(claims.uid, id);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── Binary assets (Typst screenshots + custom fonts) ───────────────
    // Any authenticated user can upload/read; deletes are restricted to the
    // uploader or an admin (enforced in the handler). Bodies are raw bytes,
    // so these routes bypass readJsonBody entirely.
    if (req.url?.split('?')[0] === '/api/assets') {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      const user = getUserById(claims.uid);
      if (!user) return sendJson(res, 401, { error: 'unauthorized' });
      if (req.method === 'POST') {
        return handleAssetUpload(req, res, { user, sendJson });
      }
      if (req.method === 'GET') {
        return handleAssetList(req, res, { sendJson });
      }
    }
    // ── Page version history (server/history.mjs). Any account may read
    // and create versions; deleting follows the author-or-admin rule. ──
    if (req.url?.startsWith('/api/pages/')) {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      const user = getUserById(claims.uid);
      if (!user) return sendJson(res, 401, { error: 'unauthorized' });
      const parts = req.url.slice('/api/pages/'.length).split('?')[0].split('/').map((p) => decodeURIComponent(p));
      const pageId = parts[0] || '';
      if (parts[1] === 'versions') {
        const versionId = parts[2] || '';
        if (!versionId && req.method === 'GET') return handleVersionList(req, res, pageId, { sendJson });
        if (!versionId && req.method === 'POST') return handleVersionCreate(req, res, pageId, { user, sendJson, readJsonBody });
        if (versionId && parts[3] === 'name' && req.method === 'POST') {
          return handleVersionRename(req, res, pageId, versionId, { user, sendJson, readJsonBody });
        }
        if (versionId && !parts[3] && req.method === 'GET') return handleVersionGet(req, res, pageId, versionId, { sendJson });
        if (versionId && !parts[3] && req.method === 'DELETE') return handleVersionDelete(req, res, pageId, versionId, { user, sendJson });
      }
      if (parts[1] === 'history' && parts[2] === 'twin' && req.method === 'GET') {
        return handleTwinGet(req, res, pageId, { sendJson });
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    if (req.url?.startsWith('/api/assets/')) {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      const user = getUserById(claims.uid);
      if (!user) return sendJson(res, 401, { error: 'unauthorized' });
      const id = decodeURIComponent(req.url.slice('/api/assets/'.length).split('?')[0]);
      if (!id) return sendJson(res, 400, { error: 'missing asset id' });
      if (req.method === 'GET' || req.method === 'HEAD') {
        return handleAssetGet(req, res, id, { sendJson });
      }
      if (req.method === 'DELETE') {
        return handleAssetDelete(req, res, id, { user, sendJson });
      }
    }

    // ── Command log (team pentest command activity from btct-cmdlog agents) ──
    // Ingest + whitelist authenticate with the static ingest token (checked in
    // the handlers). Query is any-authenticated-user. Config is admin-only.
    if (req.method === 'POST' && req.url === '/api/cmdlog/events') {
      return handleCmdlogEvents(req, res, { sendJson, readJsonBody });
    }
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/cmdlog/whitelist') {
      return handleCmdlogWhitelist(req, res, { sendJson });
    }
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/cmdlog/query') {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      if (!getUserById(claims.uid)) return sendJson(res, 401, { error: 'unauthorized' });
      return handleCmdlogQuery(req, res, { sendJson });
    }
    if (req.method === 'POST' && req.url === '/api/cmdlog/manual') {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      if (!getUserById(claims.uid)) return sendJson(res, 401, { error: 'unauthorized' });
      return handleCmdlogManual(req, res, { sendJson, readJsonBody });
    }
    if (req.method === 'GET' && req.url === '/api/cmdlog/config') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, getCmdlogConfig());
    }
    if (req.method === 'POST' && req.url === '/api/cmdlog/config') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req, 32 * 1024);
      try { return sendJson(res, 200, setCmdlogConfig(body)); }
      catch (e) { return sendJson(res, 400, { error: String(e?.message || e) }); }
    }
    if (req.method === 'POST' && req.url === '/api/cmdlog/token') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, { token: regenerateCmdlogToken() });
    }
    if (req.method === 'DELETE' && req.url?.split('?')[0] === '/api/cmdlog/logs') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return handleCmdlogClear(req, res, { sendJson });
    }

    // ── Backups (host folder target; see server/backup.mjs) ───────────
    // Config and the inventory are admin-only. Status and "run now" also
    // accept the static backup token so a host scheduler (Task Scheduler,
    // cron, systemd) can drive them without an admin session.
    // ── Data retention (admin only) ─────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/retention/config') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, retentionStatus());
    }
    if (req.method === 'POST' && req.url === '/api/retention/config') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req, 4 * 1024);
      if (body.days !== undefined && !(Number.isFinite(Number(body.days)) && Number(body.days) >= 0)) {
        return sendJson(res, 400, { error: 'days must be a non-negative number (0 = off)' });
      }
      setRetentionConfig({ days: body.days });
      return sendJson(res, 200, retentionStatus());
    }
    if (req.method === 'POST' && req.url === '/api/retention/run') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, await pruneNow());
    }
    if (req.method === 'POST' && req.url === '/api/retention/history-range') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req, 4 * 1024);
      const after = Number(body.after) || 0;
      const before = Number(body.before) || Date.now();
      return sendJson(res, 200, pruneHistoryRange(after, before));
    }

    if (req.method === 'GET' && req.url === '/api/backup/config') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, getBackupConfig());
    }
    if (req.method === 'POST' && req.url === '/api/backup/config') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req, 8 * 1024);
      try { return sendJson(res, 200, setBackupConfig(body)); }
      catch (e) { return sendJson(res, 400, { error: String(e?.message || e) }); }
    }
    if (req.method === 'POST' && req.url === '/api/backup/token') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, { token: regenerateBackupToken() });
    }
    if (req.method === 'GET' && req.url === '/api/backup/status') {
      if (!authFromHeader(req)?.admin && !matchesBackupToken(req)) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, backupStatus());
    }
    if (req.method === 'POST' && req.url === '/api/backup/run') {
      if (!authFromHeader(req)?.admin && !matchesBackupToken(req)) return sendJson(res, 401, { error: 'unauthorized' });
      try {
        const r = await runBackupNow('manual');
        if (!r.ran) return sendJson(res, 409, { ...r, error: 'a backup is already running' });
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { error: String(e?.message || e) });
      }
    }
    if (req.method === 'GET' && req.url === '/api/backup/list') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, { backups: listBackups() });
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/api/backup/archives/')) {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const name = decodeURIComponent(req.url.slice('/api/backup/archives/'.length).split('?')[0]);
      try { deleteBackup(name); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, e?.code === 'NOT_FOUND' ? 404 : 400, { error: String(e?.message || e) }); }
    }

    // ── MCP server (connect an external MCP client, e.g. Claude Code CLI) ──
    // Config is admin-only; the /mcp endpoint authenticates with its own token.
    if (req.method === 'GET' && req.url === '/api/mcp/config') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, getMcpConfig());
    }
    if (req.method === 'POST' && req.url === '/api/mcp/config') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req, 8 * 1024);
      try { return sendJson(res, 200, setMcpConfig(body)); }
      catch (e) { return sendJson(res, 400, { error: String(e?.message || e) }); }
    }
    if (req.method === 'POST' && req.url === '/api/mcp/token') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      return sendJson(res, 200, { token: regenerateMcpToken() });
    }
    // The Streamable-HTTP MCP endpoint: handles its own bearer auth + methods.
    if (req.url?.split('?')[0] === '/mcp') {
      return handleMcp(req, res);
    }

    if (tryServeStatic(req, res)) return;

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    // Validation errors thrown by handlers stay 400 with their message; a
    // programming error (TypeError, ReferenceError, ...) is a 500 with a
    // generic body and a server-side log, never its internals.
    const status = err && Number.isInteger(err.status) ? err.status
      : err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError ? 500 : 400;
    if (status === 500) console.error('[btct-server] unhandled error:', err);
    const msg = status === 500 ? 'internal error' : (err && err.message ? err.message : 'request failed');
    if (status === 413) {
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.socket?.destroy());
    }
    return sendJson(res, status, { error: msg });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Static client (optional). When STATIC_DIR is set, serve the built Vite
// client from disk so the whole app runs on a single port. Path traversal
// is blocked by resolving requests under STATIC_DIR and rejecting any
// resolved path that escapes that root. Unknown paths fall back to
// index.html so client-side routing keeps working.
// ────────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

function tryServeStatic(req, res) {
  if (!STATIC_DIR) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { return false; }
  if (urlPath.startsWith('/api/') || urlPath === '/healthz' || urlPath.startsWith('/yjs/') || urlPath === '/mcp') {
    return false;
  }

  let filePath = path.join(STATIC_DIR, urlPath === '/' ? '/index.html' : urlPath);
  filePath = path.resolve(filePath);
  if (!filePath.startsWith(STATIC_DIR + path.sep) && filePath !== STATIC_DIR) {
    res.writeHead(403);
    res.end();
    return true;
  }

  let stat;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    // SPA fallback to index.html for unknown paths.
    filePath = path.join(STATIC_DIR, 'index.html');
    try { stat = fs.statSync(filePath); } catch { return false; }
  }

  const ext = path.extname(filePath).toLowerCase();

  // Conditional GET: non-hashed files (index.html) get an mtime+size ETag
  // so navigations revalidate with a 304 instead of a re-download.
  const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  // Serve a build-time precompressed sibling when the client accepts gzip.
  // The main bundle is ~2.4 MB raw vs ~730 KB gzipped (the wasm compiler
  // 28 MB vs 11 MB); compressing per request would spend that CPU on the
  // event loop the Yjs relay shares, so the Dockerfile compresses ahead of
  // time and plain local runs just fall through to the raw file.
  let encoding = null;
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    try {
      const gzStat = fs.statSync(filePath + '.gz');
      if (gzStat.isFile()) {
        filePath += '.gz';
        stat = gzStat;
        encoding = 'gzip';
      }
    } catch { /* no precompressed sibling */ }
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    Vary: 'Accept-Encoding',
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
    // Only Vite's content-hashed files under /assets/ are immutable; index.html
    // and the unhashed public/ files (logo, favicon) revalidate via the ETag.
    'Cache-Control': /[\\/]assets[\\/]/.test(filePath)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// WebSocket: /yjs/<roomname>?token=<jwt>
// ─────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }

  if (!url.pathname.startsWith('/yjs/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  const claims = verifyToken(token);
  if (!claims) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Stash the room name on the request so setupWSConnection picks it up.
  // y-websocket's helper reads the room from req.url's pathname after the
  // first "/", so rewrite to just "/<roomname>".
  const roomName = url.pathname.slice('/yjs/'.length);
  if (!roomName) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  req.url = '/' + roomName;
  req.userClaims = claims;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  setupWSConnection(ws, req);
  // Every page room gets a GC-off history twin (server/history.mjs). The
  // shared metadata room is skipped inside trackPageDoc.
  const room = (req.url || '').slice(1).split('?')[0];
  const relayDoc = relayDocs.get(room);
  if (relayDoc) trackPageDoc(room, relayDoc);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[btct-server] HTTP/WS listening on http://${HOST}:${PORT}`);
  if (STATIC_DIR) console.log(`[btct-server] serving static client from ${STATIC_DIR}`);
  console.log(`[btct-server] CORS allowed origin: ${ALLOWED_ORIGIN || '(same-origin only)'}`);
  // Scheduled backups (server/backup.mjs). Persisted last-run means an
  // overdue backup fires right after a restart instead of a full interval later.
  startBackupScheduler();
startRetentionScheduler();
});
