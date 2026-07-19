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

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_THEME_COLOR = '#f59e0b'; // yellow-orange (amber-500)

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
      `[btct-server] promoted existing user '${DEFAULT_ADMIN_USERNAME}' to admin`,
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
    `[btct-server] created bootstrap admin '${DEFAULT_ADMIN_USERNAME}' / '${DEFAULT_ADMIN_PASSWORD}' — change this password immediately`,
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
        updateUserPrefs(user.id, JSON.stringify(prefs));
      }
      const fresh = getUserById(user.id);
      return sendJson(res, 200, { user: publicUser(fresh) });
    }

    // Public settings (no auth) — needed on the login screen so the
    // primary theme color matches the rest of the app from first paint.
    if (req.method === 'GET' && req.url === '/api/settings') {
      const themeColor = getSetting('theme_color') || DEFAULT_THEME_COLOR;
      return sendJson(res, 200, { themeColor });
    }

    // Admin-only: update the global primary theme color. Stored in the
    // SQLite settings table so it persists across container restarts.
    if (req.method === 'POST' && req.url === '/api/settings/theme') {
      const gate = requireAdmin(req);
      if (gate.error) return sendJson(res, gate.status, { error: gate.error });
      const body = await readJsonBody(req, 4 * 1024);
      const color = typeof body.color === 'string' ? body.color.trim() : '';
      if (!HEX_COLOR_RE.test(color)) {
        return sendJson(res, 400, { error: 'color must be a #RRGGBB hex value' });
      }
      setSetting('theme_color', color);
      return sendJson(res, 200, { themeColor: color });
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

    // Chat history — durable per-account Claude conversations. Every query is
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
    // The Streamable-HTTP MCP endpoint — handles its own bearer auth + methods.
    if (req.url?.split('?')[0] === '/mcp') {
      return handleMcp(req, res);
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
  console.log(`[btct-server] HTTP/WS listening on http://${HOST}:${PORT}`);
  if (STATIC_DIR) console.log(`[btct-server] serving static client from ${STATIC_DIR}`);
  console.log(`[btct-server] CORS allowed origin: ${ALLOWED_ORIGIN || '(same-origin only)'}`);
});
