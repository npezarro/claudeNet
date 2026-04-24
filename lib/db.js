const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ONLINE_THRESHOLD_MINUTES = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  parent_id INTEGER,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  sensitivity_flags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'cli',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  instance_key TEXT UNIQUE NOT NULL,
  nickname TEXT,
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_instances_user ON instances(user_id);

CREATE TABLE IF NOT EXISTS thread_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL DEFAULT 'manual',
  target_instance_id INTEGER REFERENCES instances(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(thread_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_thread_status ON message_queue(thread_id, status);
`;

const ALLOWED_USERS = [
  { email: 'n.pezarro@gmail.com', display_name: 'nick' },
  { email: 'emma.c.jaeger@gmail.com', display_name: 'emma' },
];

function initDb() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'claudenet.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA);

  // Migration: add source column to existing messages table
  const cols = db.pragma('table_info(messages)').map(c => c.name);
  if (!cols.includes('source')) {
    db.exec("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'cli'");
  }

  const seedUser = db.prepare(
    'INSERT OR IGNORE INTO users (email, display_name) VALUES (?, ?)'
  );
  for (const u of ALLOWED_USERS) {
    seedUser.run(u.email, u.display_name);
  }

  return db;
}

function generateThreadId() {
  return 't-' + crypto.randomBytes(4).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return 'cn_' + crypto.randomBytes(32).toString('hex');
}

module.exports = { initDb, generateThreadId, hashToken, generateToken, ALLOWED_USERS, ONLINE_THRESHOLD_MINUTES };
