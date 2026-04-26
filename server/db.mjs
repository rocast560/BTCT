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
    created_at  INTEGER NOT NULL
  );
`);

const insertUser = db.prepare(
  `INSERT INTO users (username, salt, hash, iter, color, created_at)
   VALUES ($username, $salt, $hash, $iter, $color, $created_at)`,
);
const findByUsername = db.prepare(
  `SELECT * FROM users WHERE username = ? COLLATE NOCASE`,
);
const findFullById = db.prepare(`SELECT * FROM users WHERE id = ?`);

const PRESENCE_COLORS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
];

export function createUser({ username, salt, hash, iter }) {
  const color = PRESENCE_COLORS[Math.floor(Math.random() * PRESENCE_COLORS.length)];
  const info = insertUser.run({
    $username: username,
    $salt: salt,
    $hash: hash,
    $iter: iter,
    $color: color,
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

export function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, color: row.color };
}
