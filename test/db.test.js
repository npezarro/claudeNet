const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { generateThreadId, hashToken, generateToken, getConnectedUsers, SEED_USERS } = require('../lib/db');

describe('generateThreadId', () => {
  it('starts with "t-"', () => {
    const id = generateThreadId();
    assert.ok(id.startsWith('t-'));
  });

  it('has correct length (t- + 8 hex chars)', () => {
    const id = generateThreadId();
    assert.strictEqual(id.length, 10);
  });

  it('contains only valid hex chars after prefix', () => {
    const id = generateThreadId();
    assert.match(id, /^t-[0-9a-f]{8}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateThreadId()));
    assert.strictEqual(ids.size, 50);
  });
});

describe('hashToken', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = hashToken('test-token');
    assert.strictEqual(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const a = hashToken('same-input');
    const b = hashToken('same-input');
    assert.strictEqual(a, b);
  });

  it('produces different hashes for different inputs', () => {
    const a = hashToken('token-a');
    const b = hashToken('token-b');
    assert.notStrictEqual(a, b);
  });
});

describe('generateToken', () => {
  it('starts with "cn_"', () => {
    const token = generateToken();
    assert.ok(token.startsWith('cn_'));
  });

  it('has correct length (cn_ + 64 hex chars)', () => {
    const token = generateToken();
    assert.strictEqual(token.length, 67);
  });

  it('contains only valid hex chars after prefix', () => {
    const token = generateToken();
    assert.match(token, /^cn_[0-9a-f]{64}$/);
  });

  it('generates unique tokens', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateToken()));
    assert.strictEqual(tokens.size, 20);
  });
});

describe('initDb', () => {
  let db;
  const testDataDir = path.join(__dirname, '..', 'data-test-' + process.pid);

  before(() => {
    // Override data dir by temporarily patching __dirname resolution
    // Use initDb directly since it creates in ../data relative to lib/
    // Instead, create a fresh DB in test-specific location
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
    fs.mkdirSync(testDataDir, { recursive: true });

    db = new Database(path.join(testDataDir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Execute the schema directly (same as initDb but in test location)
    const { SCHEMA } = (() => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
      const match = src.match(/const SCHEMA = `([\s\S]*?)`;/);
      return { SCHEMA: match[1] };
    })();
    db.exec(SCHEMA);

    // Apply migrations (role column added post-schema, same as initDb)
    const userCols = db.pragma('table_info(users)').map(c => c.name);
    if (!userCols.includes('role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    }

    // Seed users
    const seedUser = db.prepare(
      "INSERT OR IGNORE INTO users (email, display_name, role) VALUES (?, ?, ?)"
    );
    for (const u of SEED_USERS) {
      seedUser.run(u.email, u.display_name, u.role || 'user');
    }
  });

  after(() => {
    if (db) db.close();
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
  });

  it('creates users table with seeded users', () => {
    const users = db.prepare('SELECT * FROM users').all();
    assert.ok(users.length >= SEED_USERS.length);
    const emails = users.map(u => u.email);
    for (const su of SEED_USERS) {
      assert.ok(emails.includes(su.email), `Seed user ${su.email} should exist`);
    }
  });

  it('creates messages table', () => {
    const cols = db.pragma('table_info(messages)').map(c => c.name);
    assert.ok(cols.includes('id'));
    assert.ok(cols.includes('thread_id'));
    assert.ok(cols.includes('from_user_id'));
    assert.ok(cols.includes('to_user_id'));
    assert.ok(cols.includes('body'));
    assert.ok(cols.includes('status'));
    assert.ok(cols.includes('sensitivity_flags'));
  });

  it('creates api_tokens table', () => {
    const cols = db.pragma('table_info(api_tokens)').map(c => c.name);
    assert.ok(cols.includes('token_hash'));
    assert.ok(cols.includes('user_id'));
    assert.ok(cols.includes('revoked'));
  });

  it('creates instances table', () => {
    const cols = db.pragma('table_info(instances)').map(c => c.name);
    assert.ok(cols.includes('instance_key'));
    assert.ok(cols.includes('user_id'));
    assert.ok(cols.includes('nickname'));
  });

  it('creates connections table', () => {
    const cols = db.pragma('table_info(connections)').map(c => c.name);
    assert.ok(cols.includes('requester_id'));
    assert.ok(cols.includes('target_id'));
    assert.ok(cols.includes('direction'));
    assert.ok(cols.includes('status'));
  });

  it('creates thread_settings table', () => {
    const cols = db.pragma('table_info(thread_settings)').map(c => c.name);
    assert.ok(cols.includes('thread_id'));
    assert.ok(cols.includes('mode'));
  });

  it('creates message_queue table', () => {
    const cols = db.pragma('table_info(message_queue)').map(c => c.name);
    assert.ok(cols.includes('thread_id'));
    assert.ok(cols.includes('body'));
    assert.ok(cols.includes('status'));
  });

  it('creates audit_log table', () => {
    const cols = db.pragma('table_info(audit_log)').map(c => c.name);
    assert.ok(cols.includes('action'));
    assert.ok(cols.includes('details'));
  });
});

describe('getConnectedUsers', () => {
  let db;
  const testDataDir = path.join(__dirname, '..', 'data-test-conn-' + process.pid);

  before(() => {
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
    fs.mkdirSync(testDataDir, { recursive: true });

    db = new Database(path.join(testDataDir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
    const match = src.match(/const SCHEMA = `([\s\S]*?)`;/);
    db.exec(match[1]);

    // Insert test users
    db.prepare("INSERT INTO users (id, email, display_name) VALUES (1, 'alice@test.com', 'alice')").run();
    db.prepare("INSERT INTO users (id, email, display_name) VALUES (2, 'bob@test.com', 'bob')").run();
    db.prepare("INSERT INTO users (id, email, display_name) VALUES (3, 'carol@test.com', 'carol')").run();
    db.prepare("INSERT INTO users (id, email, display_name) VALUES (4, 'dave@test.com', 'dave')").run();
  });

  after(() => {
    if (db) db.close();
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
  });

  it('returns empty array when no connections exist', () => {
    const result = getConnectedUsers(db, 1);
    assert.deepStrictEqual(result, []);
  });

  it('returns connected user for bidirectional connection (requester side)', () => {
    db.prepare(
      "INSERT INTO connections (requester_id, target_id, direction, status) VALUES (1, 2, 'bidirectional', 'approved')"
    ).run();
    const result = getConnectedUsers(db, 1);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].display_name, 'bob');
  });

  it('returns connected user for bidirectional connection (target side)', () => {
    const result = getConnectedUsers(db, 2);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].display_name, 'alice');
  });

  it('returns connected user for one-way connection (requester can see target)', () => {
    db.prepare(
      "INSERT INTO connections (requester_id, target_id, direction, status) VALUES (3, 4, 'one-way', 'approved')"
    ).run();
    const result = getConnectedUsers(db, 3);
    const names = result.map(u => u.display_name);
    assert.ok(names.includes('dave'));
  });

  it('does not return requester for one-way connection (target cannot see requester)', () => {
    const result = getConnectedUsers(db, 4);
    const names = result.map(u => u.display_name);
    assert.ok(!names.includes('carol'));
  });

  it('does not return users with pending connections', () => {
    db.prepare(
      "INSERT INTO connections (requester_id, target_id, direction, status) VALUES (1, 3, 'bidirectional', 'pending')"
    ).run();
    const result = getConnectedUsers(db, 1);
    const names = result.map(u => u.display_name);
    assert.ok(!names.includes('carol'));
  });

  it('does not return users with rejected connections', () => {
    db.prepare(
      "INSERT INTO connections (requester_id, target_id, direction, status) VALUES (1, 4, 'bidirectional', 'rejected')"
    ).run();
    const result = getConnectedUsers(db, 1);
    const names = result.map(u => u.display_name);
    assert.ok(!names.includes('dave'));
  });
});
