import { Database } from 'bun:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');

export const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE NOT NULL COLLATE NOCASE,
    salt        TEXT NOT NULL,
    hash        TEXT NOT NULL,
    iter        INTEGER NOT NULL,
    color       TEXT NOT NULL,
    avatar      TEXT,
    is_admin    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    title      TEXT NOT NULL,
    messages   TEXT NOT NULL,          -- JSON array of { role, content }
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_sessions(user_id, updated_at DESC);
`);

// Best-effort migration for databases predating the is_admin column.
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!cols.some((c) => c.name === 'is_admin')) {
    db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.some((c) => c.name === 'avatar')) {
    db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT`);
  }
  if (!cols.some((c) => c.name === 'prefs')) {
    db.exec(`ALTER TABLE users ADD COLUMN prefs TEXT`);
  }
} catch (err) {
  console.warn('[db] migration check failed:', err?.message || err);
}

const insertUser = db.prepare(
  `INSERT INTO users (username, salt, hash, iter, color, is_admin, created_at)
   VALUES ($username, $salt, $hash, $iter, $color, $is_admin, $created_at)`,
);
const findByUsername = db.prepare(
  `SELECT * FROM users WHERE username = ? COLLATE NOCASE`,
);
const findFullById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const listAllUsers = db.prepare(
  `SELECT id, username, color, avatar, is_admin, created_at FROM users ORDER BY id ASC`,
);
const deleteUserById = db.prepare(`DELETE FROM users WHERE id = ?`);
const setAdminById = db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`);
const updatePasswordById = db.prepare(
  `UPDATE users SET salt = $salt, hash = $hash, iter = $iter WHERE id = $id`,
);
const setColorById = db.prepare(`UPDATE users SET color = ? WHERE id = ?`);
const setPrefsById = db.prepare(`UPDATE users SET prefs = ? WHERE id = ?`);
const countAdmins = db.prepare(
  `SELECT COUNT(*) AS n FROM users WHERE is_admin = 1`,
);

const PRESENCE_COLORS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
];

export function createUser({ username, salt, hash, iter, isAdmin = false }) {
  const color = PRESENCE_COLORS[Math.floor(Math.random() * PRESENCE_COLORS.length)];
  const info = insertUser.run({
    $username: username,
    $salt: salt,
    $hash: hash,
    $iter: iter,
    $color: color,
    $is_admin: isAdmin ? 1 : 0,
    $created_at: Date.now(),
  });
  return findFullById.get(Number(info.lastInsertRowid));
}

export function getUserByUsername(username) {
  return findByUsername.get(username) || null;
}

export function getUserById(id) {
  return findFullById.get(id) || null;
}

export function listUsers() {
  return listAllUsers.all().map((row) => ({
    id: row.id,
    username: row.username,
    color: row.color,
    isAdmin: !!row.is_admin,
    createdAt: row.created_at,
  }));
}

export function deleteUser(id) {
  deleteUserById.run(id);
}

export function setUserAdmin(id, isAdmin) {
  setAdminById.run(isAdmin ? 1 : 0, id);
}

export function updateUserPassword(id, { salt, hash, iter }) {
  updatePasswordById.run({ $id: id, $salt: salt, $hash: hash, $iter: iter });
}

export function updateUserColor(id, color) {
  setColorById.run(color, id);
}

// Per-account editor preferences (code-block accent color + custom keybinds),
// stored as a JSON blob. The shape is validated/normalized client-side and at
// the REST edge; here we just persist the serialized string.
export function updateUserPrefs(id, prefsJson) {
  setPrefsById.run(prefsJson, id);
}

export function adminCount() {
  return Number(countAdmins.get()?.n || 0);
}

// ── settings (key/value) ──
const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const upsertSettingStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES ($key, $value)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);

export function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  upsertSettingStmt.run({ $key: key, $value: value });
}

// ── Claude chat sessions (per-account, durable conversation history) ──
const listChatStmt = db.prepare(
  `SELECT id, title, created_at, updated_at FROM chat_sessions
   WHERE user_id = ? ORDER BY updated_at DESC`,
);
const getChatStmt = db.prepare(
  `SELECT id, title, messages, created_at, updated_at FROM chat_sessions
   WHERE id = ? AND user_id = ?`,
);
const upsertChatStmt = db.prepare(
  `INSERT INTO chat_sessions (id, user_id, title, messages, created_at, updated_at)
   VALUES ($id, $user_id, $title, $messages, $created_at, $updated_at)
   ON CONFLICT(id) DO UPDATE SET
     title = excluded.title,
     messages = excluded.messages,
     updated_at = excluded.updated_at
   WHERE chat_sessions.user_id = excluded.user_id`,
);
const deleteChatStmt = db.prepare(
  `DELETE FROM chat_sessions WHERE id = ? AND user_id = ?`,
);
// Keep only the newest N sessions per user.
const pruneChatStmt = db.prepare(
  `DELETE FROM chat_sessions WHERE user_id = ? AND id NOT IN (
     SELECT id FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
   )`,
);
const CHAT_KEEP = 100;

export function listChatSessions(userId) {
  return listChatStmt.all(userId).map((r) => ({
    id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export function getChatSession(userId, id) {
  const r = getChatStmt.get(id, userId);
  if (!r) return null;
  let messages = [];
  try { const p = JSON.parse(r.messages); if (Array.isArray(p)) messages = p; } catch { /* corrupt → empty */ }
  return { id: r.id, title: r.title, messages, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function saveChatSession(userId, { id, title, messages, createdAt, updatedAt }) {
  const now = Date.now();
  upsertChatStmt.run({
    $id: id,
    $user_id: userId,
    $title: String(title || 'New chat').slice(0, 200),
    $messages: JSON.stringify(messages ?? []),
    $created_at: Number(createdAt) || now,
    $updated_at: Number(updatedAt) || now,
  });
  pruneChatStmt.run(userId, userId, CHAT_KEEP);
  return { id, title, createdAt: Number(createdAt) || now, updatedAt: Number(updatedAt) || now };
}

export function deleteChatSession(userId, id) {
  deleteChatStmt.run(id, userId);
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    color: row.color,
    isAdmin: !!row.is_admin,
    prefs: parsePrefs(row.prefs),
  };
}

// Defensive JSON parse for the stored prefs blob. Older rows (and rows that
// have never saved prefs) have NULL here; return an empty object so clients
// can merge their own defaults over it.
function parsePrefs(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
