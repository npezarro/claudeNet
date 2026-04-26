const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { requireToken, requireRemoteUser } = require('../lib/auth');
const { hashToken } = require('../lib/db');

// Minimal mock for Express req/res/next
function mockReq(overrides = {}) {
  return { headers: {}, ...overrides };
}

function mockRes() {
  const res = {
    _status: null,
    _body: null,
    _sent: null,
    status(code) { res._status = code; return res; },
    json(obj) { res._body = obj; },
    send(text) { res._sent = text; },
  };
  return res;
}

describe('requireToken', () => {
  let db;
  let middleware;
  const testDataDir = path.join(__dirname, '..', 'data-test-auth-' + process.pid);
  const TEST_TOKEN = 'cn_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  before(() => {
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
    fs.mkdirSync(testDataDir, { recursive: true });

    db = new Database(path.join(testDataDir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
    const match = src.match(/const SCHEMA = `([\s\S]*?)`;/);
    db.exec(match[1]);

    // Apply migrations (role column added post-schema, same as initDb)
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");

    // Insert test user and token
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'test@example.com', 'tester', 'user')").run();
    db.prepare(
      "INSERT INTO api_tokens (id, user_id, token_hash, label) VALUES (1, 1, ?, 'test')"
    ).run(hashToken(TEST_TOKEN));

    // Insert revoked token
    db.prepare(
      "INSERT INTO api_tokens (id, user_id, token_hash, label, revoked) VALUES (2, 1, ?, 'revoked', 1)"
    ).run(hashToken('cn_revoked_token_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijkl'));

    middleware = requireToken(db);
  });

  after(() => {
    if (db) db.close();
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
  });

  it('returns 401 when no Authorization header', () => {
    const req = mockReq();
    const res = mockRes();
    middleware(req, res, () => {});
    assert.strictEqual(res._status, 401);
    assert.strictEqual(res._body.error, 'Bearer token required');
  });

  it('returns 401 when Authorization is not Bearer', () => {
    const req = mockReq({ headers: { authorization: 'Basic abc123' } });
    const res = mockRes();
    middleware(req, res, () => {});
    assert.strictEqual(res._status, 401);
    assert.strictEqual(res._body.error, 'Bearer token required');
  });

  it('returns 401 for invalid token', () => {
    const req = mockReq({ headers: { authorization: 'Bearer invalid_token_here' } });
    const res = mockRes();
    middleware(req, res, () => {});
    assert.strictEqual(res._status, 401);
    assert.strictEqual(res._body.error, 'Invalid or revoked token');
  });

  it('returns 401 for revoked token', () => {
    const req = mockReq({ headers: { authorization: 'Bearer cn_revoked_token_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijkl' } });
    const res = mockRes();
    middleware(req, res, () => {});
    assert.strictEqual(res._status, 401);
    assert.strictEqual(res._body.error, 'Invalid or revoked token');
  });

  it('calls next and sets req.user for valid token', () => {
    const req = mockReq({ headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.strictEqual(req.user.id, 1);
    assert.strictEqual(req.user.email, 'test@example.com');
    assert.strictEqual(req.user.name, 'tester');
    assert.strictEqual(req.user.role, 'user');
  });

  it('updates last_used_at on valid token', () => {
    const req = mockReq({ headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    const res = mockRes();
    middleware(req, res, () => {});
    const row = db.prepare('SELECT last_used_at FROM api_tokens WHERE id = 1').get();
    assert.ok(row.last_used_at !== null);
  });
});

describe('requireRemoteUser', () => {
  let db;
  let middleware;
  const testDataDir = path.join(__dirname, '..', 'data-test-remote-' + process.pid);

  before(() => {
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
    fs.mkdirSync(testDataDir, { recursive: true });

    db = new Database(path.join(testDataDir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
    const match = src.match(/const SCHEMA = `([\s\S]*?)`;/);
    db.exec(match[1]);

    // Apply migrations (role column added post-schema, same as initDb)
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");

    // Insert existing user
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'existing@example.com', 'existing', 'admin')").run();

    middleware = requireRemoteUser(db);
  });

  after(() => {
    if (db) db.close();
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
  });

  it('returns 401 when X-Forwarded-User header is missing', () => {
    const req = mockReq();
    const res = mockRes();
    middleware(req, res, () => {});
    assert.strictEqual(res._status, 401);
    assert.strictEqual(res._sent, 'Authentication required');
  });

  it('calls next and sets req.user for existing user', () => {
    const req = mockReq({ headers: { 'x-forwarded-user': 'existing@example.com' } });
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.strictEqual(req.user.id, 1);
    assert.strictEqual(req.user.email, 'existing@example.com');
    assert.strictEqual(req.user.name, 'existing');
    assert.strictEqual(req.user.role, 'admin');
  });

  it('auto-creates user who passes OIDC but is not in DB', () => {
    const req = mockReq({ headers: { 'x-forwarded-user': 'new.person@example.com' } });
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.strictEqual(req.user.email, 'new.person@example.com');
    // Display name derived from email: first part before @, split by . or _, take first word, lowercase
    assert.strictEqual(req.user.name, 'new');
    assert.strictEqual(req.user.role, 'user');
  });

  it('persists auto-created user to database', () => {
    // User was created in previous test
    const user = db.prepare("SELECT * FROM users WHERE email = 'new.person@example.com'").get();
    assert.ok(user);
    assert.strictEqual(user.display_name, 'new');
    assert.strictEqual(user.role, 'user');
  });
});
