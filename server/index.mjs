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
  updateUserAvatar,
  adminCount,
} from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// y-websocket ships its server helpers as CJS — load via createRequire.
const require = createRequire(import.meta.url);
const { setupWSConnection } = require('y-websocket/bin/utils');

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

function ensureBootstrapAdmin() {
  if (adminCount() > 0) return;
  const existing = getUserByUsername(DEFAULT_ADMIN_USERNAME);
  if (existing) {
    // Account exists but isn't admin — promote it rather than failing.
    setUserAdmin(existing.id, true);
    console.warn(
      `[alysa-server] promoted existing user '${DEFAULT_ADMIN_USERNAME}' to admin`,
    );
    return;
  }
  const hashRecord = hashPassword(DEFAULT_ADMIN_PASSWORD);
  createUser({
    username: DEFAULT_ADMIN_USERNAME,
    salt: hashRecord.salt,
    hash: hashRecord.hash,
    iter: hashRecord.iter,
    isAdmin: true,
  });
  console.warn(
    `[alysa-server] created bootstrap admin '${DEFAULT_ADMIN_USERNAME}' / '${DEFAULT_ADMIN_PASSWORD}' — change this password immediately`,
  );
}
ensureBootstrapAdmin();

// ─────────────────────────────────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────────────────────────────────
function setCors(res) {
  if (!ALLOWED_ORIGIN) return; // same-origin deployment: no CORS headers needed
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
        reject(new Error('payload too large'));
        req.destroy();
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
      const hashRecord = hashPassword(password);
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
      const hashRecord = hashPassword(password);
      updateUserPassword(id, hashRecord);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/api/login') {
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const row = getUserByUsername(username);
      if (!row || !verifyPassword(password, row.salt, row.hash, row.iter)) {
        // Same response for both cases to avoid username enumeration.
        return sendJson(res, 401, { error: 'invalid username or password' });
      }
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
    // their own display color and avatar. Avatar is a small data URL
    // (PNG / JPEG / WebP / GIF) capped at ~96 KB encoded so a couple of
    // hundred users in the DB don't bloat it. Pass `avatar: null` to
    // clear an existing avatar.
    if (req.method === 'POST' && req.url === '/api/me/profile') {
      const claims = authFromHeader(req);
      if (!claims) return sendJson(res, 401, { error: 'unauthorized' });
      const user = getUserById(claims.uid);
      if (!user) return sendJson(res, 401, { error: 'unauthorized' });
      // 128 KB ceiling — base64 of a 32x32 PNG is well under 4 KB, but
      // we leave headroom for slightly larger custom uploads.
      const body = await readJsonBody(req, 128 * 1024);
      if (typeof body.color === 'string') {
        const color = body.color.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
          return sendJson(res, 400, { error: 'color must be a #RRGGBB hex value' });
        }
        updateUserColor(user.id, color);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'avatar')) {
        const avatar = body.avatar;
        if (avatar === null || avatar === '') {
          updateUserAvatar(user.id, null);
        } else if (typeof avatar === 'string') {
          if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
            return sendJson(res, 400, { error: 'avatar must be a base64 image data URL' });
          }
          if (avatar.length > 96 * 1024) {
            return sendJson(res, 413, { error: 'avatar too large (max ~96 KB encoded)' });
          }
          updateUserAvatar(user.id, avatar);
        } else {
          return sendJson(res, 400, { error: 'avatar must be a string or null' });
        }
      }
      const fresh = getUserById(user.id);
      return sendJson(res, 200, { user: publicUser(fresh) });
    }

    if (tryServeStatic(req, res)) return;

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const msg = err && err.message ? err.message : 'internal error';
    return sendJson(res, 400, { error: msg });
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
  if (urlPath.startsWith('/api/') || urlPath === '/healthz' || urlPath.startsWith('/yjs/')) {
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
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // index.html should never be cached; hashed assets can be.
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
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
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[alysa-server] HTTP/WS listening on http://${HOST}:${PORT}`);
  if (STATIC_DIR) console.log(`[alysa-server] serving static client from ${STATIC_DIR}`);
  console.log(`[alysa-server] CORS allowed origin: ${ALLOWED_ORIGIN || '(same-origin only)'}`);
});
