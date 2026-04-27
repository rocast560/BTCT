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
    is_admin    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
`);

// Best-effort migration for databases predating the is_admin column.
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!cols.some((c) => c.name === 'is_admin')) {
    db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  }
} catch (err) {
  console.warn('[db] is_admin migration check failed:', err?.message || err);
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
  `SELECT id, username, color, is_admin, created_at FROM users ORDER BY id ASC`,
);
const deleteUserById = db.prepare(`DELETE FROM users WHERE id = ?`);
const setAdminById = db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`);
const updatePasswordById = db.prepare(
  `UPDATE users SET salt = $salt, hash = $hash, iter = $iter WHERE id = $id`,
);
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

export function adminCount() {
  return Number(countAdmins.get()?.n || 0);
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    color: row.color,
    isAdmin: !!row.is_admin,
  };
}
