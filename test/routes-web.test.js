const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { createWebRouter } = require('../lib/routes-web');
const { hashToken, generateThreadId } = require('../lib/db');

const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';
const testDataDir = path.join(__dirname, '..', 'data-test-web-' + process.pid);

let db, app, server, baseUrl;

/**
 * HTTP request helper for web routes.
 * Uses X-Forwarded-User for auth and form-encoded POST bodies.
 * Does NOT follow redirects (returns 302 status + location header).
 */
function request(method, urlPath, { email, formBody } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlPath, baseUrl);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: {},
    };
    if (email) opts.headers['x-forwarded-user'] = email;
    let payload;
    if (formBody) {
      payload = new URLSearchParams(formBody).toString();
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function setupDb() {
  if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
  fs.mkdirSync(testDataDir, { recursive: true });

  db = new Database(path.join(testDataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
  const match = src.match(/const SCHEMA = `([\s\S]*?)`;/);
  db.exec(match[1]);
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");

  // Seed users
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'alice@example.com', 'alice', 'admin')").run();
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'bob@example.com', 'bob', 'user')").run();

  // Seed approved bidirectional connection between alice and bob
  db.prepare("INSERT INTO connections (requester_id, target_id, direction, status, resolved_at, resolved_by) VALUES (1, 2, 'bidirectional', 'approved', datetime('now'), 1)").run();
}

before((_, done) => {
  setupDb();

  app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));

  // escapeHtml helper used in templates
  app.locals.escapeHtml = function(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // basePath middleware (same as server.js)
  app.use((req, res, next) => {
    res.locals.basePath = '';
    next();
  });

  app.use('/', createWebRouter(db));

  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

after((_, done) => {
  server.close(() => {
    if (db) db.close();
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true });
    done();
  });
});

// ── Auth ──

describe('web auth (X-Forwarded-User)', () => {
  it('returns 401 without X-Forwarded-User header', async () => {
    const res = await request('GET', '/');
    assert.strictEqual(res.status, 401);
  });

  it('auto-creates user on first OIDC login', async () => {
    const res = await request('GET', '/', { email: 'newuser@example.com' });
    assert.strictEqual(res.status, 200);

    const user = db.prepare("SELECT * FROM users WHERE email = 'newuser@example.com'").get();
    assert.ok(user);
    assert.strictEqual(user.display_name, 'newuser');
  });
});

// ── Dashboard ──

describe('GET / (dashboard)', () => {
  it('returns 200 with thread list', async () => {
    const res = await request('GET', '/', { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('alice'));
  });

  it('shows threads the user participates in', async () => {
    // Create a thread alice -> bob
    const tid = generateThreadId();
    db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 1, 2, 'Dashboard test', 'hello', '[]', 'web')"
    ).run(tid);

    const res = await request('GET', '/', { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('Dashboard test'));
  });
});

// ── Compose ──

describe('GET /compose', () => {
  it('returns 200 with compose form', async () => {
    const res = await request('GET', '/compose', { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 200);
    // Should show connected users (bob)
    assert.ok(res.body.includes('bob'));
  });
});

describe('POST /compose', () => {
  it('creates a new thread and redirects', async () => {
    const res = await request('POST', '/compose', {
      email: ALICE_EMAIL,
      formBody: { to: 'bob', body: 'Compose test message' },
    });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('/thread/'));

    // Verify message was created
    const msg = db.prepare("SELECT * FROM messages WHERE body = 'Compose test message'").get();
    assert.ok(msg);
    assert.strictEqual(msg.from_user_id, 1);
    assert.strictEqual(msg.to_user_id, 2);
    assert.strictEqual(msg.source, 'web');
  });

  it('auto-generates subject from first line', async () => {
    const res = await request('POST', '/compose', {
      email: ALICE_EMAIL,
      formBody: { to: 'bob', body: 'My subject line\nBody content here' },
    });
    assert.strictEqual(res.status, 302);

    const msg = db.prepare("SELECT * FROM messages WHERE body = 'My subject line\nBody content here'").get();
    assert.strictEqual(msg.subject, 'My subject line');
  });

  it('sets thread mode to autonomous by default', async () => {
    const res = await request('POST', '/compose', {
      email: ALICE_EMAIL,
      formBody: { to: 'bob', body: 'Mode test default' },
    });
    assert.strictEqual(res.status, 302);

    const msg = db.prepare("SELECT * FROM messages WHERE body = 'Mode test default'").get();
    const settings = db.prepare('SELECT mode FROM thread_settings WHERE thread_id = ? AND user_id = 1').get(msg.thread_id);
    assert.strictEqual(settings.mode, 'autonomous');
  });

  it('sets thread mode to manual when specified', async () => {
    const res = await request('POST', '/compose', {
      email: ALICE_EMAIL,
      formBody: { to: 'bob', body: 'Mode test manual', mode: 'manual' },
    });
    assert.strictEqual(res.status, 302);

    const msg = db.prepare("SELECT * FROM messages WHERE body = 'Mode test manual'").get();
    const settings = db.prepare('SELECT mode FROM thread_settings WHERE thread_id = ? AND user_id = 1').get(msg.thread_id);
    assert.strictEqual(settings.mode, 'manual');
  });

  it('returns 400 when recipient is missing', async () => {
    const res = await request('POST', '/compose', {
      email: ALICE_EMAIL,
      formBody: { body: 'No recipient' },
    });
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when body is missing', async () => {
    const res = await request('POST', '/compose', {
      email: ALICE_EMAIL,
      formBody: { to: 'bob' },
    });
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for unknown recipient', async () => {
    const res = await request('POST', '/compose', {
      email: ALICE_EMAIL,
      formBody: { to: 'nobody', body: 'Hello nobody' },
    });
    assert.strictEqual(res.status, 404);
  });

  it('returns 403 for unconnected recipient', async () => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (10, 'stranger@example.com', 'stranger', 'user')").run();
    const res = await request('POST', '/compose', {
      email: ALICE_EMAIL,
      formBody: { to: 'stranger', body: 'Hello stranger' },
    });
    assert.strictEqual(res.status, 403);
  });
});

// ── Instances ──

describe('GET /instances', () => {
  before(() => {
    db.prepare(
      "INSERT INTO instances (user_id, instance_key, nickname, metadata) VALUES (1, 'inst-test-1', 'dev-box', '{}')"
    ).run();
  });

  it('returns 200 with instance list', async () => {
    const res = await request('GET', '/instances', { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 200);
    // Template shows nickname when set, falls back to instance_key
    assert.ok(res.body.includes('dev-box'));
  });
});

describe('POST /instances/:id/nickname', () => {
  it('updates nickname for owned instance', async () => {
    const inst = db.prepare("SELECT id FROM instances WHERE instance_key = 'inst-test-1'").get();
    const res = await request('POST', `/instances/${inst.id}/nickname`, {
      email: ALICE_EMAIL,
      formBody: { nickname: 'renamed-box' },
    });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('/instances'));

    const updated = db.prepare('SELECT nickname FROM instances WHERE id = ?').get(inst.id);
    assert.strictEqual(updated.nickname, 'renamed-box');
  });

  it('does not update nickname for unowned instance', async () => {
    const inst = db.prepare("SELECT id FROM instances WHERE instance_key = 'inst-test-1'").get();
    // Bob tries to rename alice's instance
    await request('POST', `/instances/${inst.id}/nickname`, {
      email: BOB_EMAIL,
      formBody: { nickname: 'hacked' },
    });
    // Nickname should not change (UPDATE WHERE user_id = bob's id won't match)
    const check = db.prepare('SELECT nickname FROM instances WHERE id = ?').get(inst.id);
    assert.strictEqual(check.nickname, 'renamed-box');
  });

  it('clears nickname when empty', async () => {
    const inst = db.prepare("SELECT id FROM instances WHERE instance_key = 'inst-test-1'").get();
    await request('POST', `/instances/${inst.id}/nickname`, {
      email: ALICE_EMAIL,
      formBody: { nickname: '' },
    });
    const check = db.prepare('SELECT nickname FROM instances WHERE id = ?').get(inst.id);
    assert.strictEqual(check.nickname, null);
  });
});

// ── Thread view ──

describe('GET /thread/:threadId', () => {
  let threadId;

  before(() => {
    threadId = generateThreadId();
    db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 1, 2, 'Thread view test', 'First message', '[]', 'cli')"
    ).run(threadId);
    db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source, status) VALUES (?, 2, 1, 'Thread view test', 'Reply from bob', '[]', 'cli', 'unread')"
    ).run(threadId);
  });

  it('returns 200 with thread messages', async () => {
    const res = await request('GET', `/thread/${threadId}`, { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('First message'));
    assert.ok(res.body.includes('Reply from bob'));
  });

  it('marks unread messages as read', async () => {
    // Verify the unread message was marked read
    const msg = db.prepare(
      "SELECT status FROM messages WHERE thread_id = ? AND to_user_id = 1"
    ).get(threadId);
    assert.strictEqual(msg.status, 'read');
  });

  it('returns 404 for non-existent thread', async () => {
    const res = await request('GET', '/thread/t-nonexistent', { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 for thread user is not part of', async () => {
    const tid = generateThreadId();
    // Thread between users 10 and 11 (not alice or bob)
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (11, 'charlie@example.com', 'charlie', 'user')").run();
    db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 10, 11, 'Private', 'Secret', '[]', 'cli')"
    ).run(tid);
    const res = await request('GET', `/thread/${tid}`, { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 404);
  });

  it('shows default autonomous mode when no settings exist', async () => {
    const tid = generateThreadId();
    db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 1, 2, 'No settings', 'Test', '[]', 'cli')"
    ).run(tid);
    const res = await request('GET', `/thread/${tid}`, { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 200);
    // Template shows "Autonomous" button text when in autonomous mode
    assert.ok(res.body.includes('Autonomous'));
  });
});

// ── Thread mode ──

describe('POST /thread/:threadId/mode', () => {
  let threadId;

  before(() => {
    threadId = generateThreadId();
    db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 1, 2, 'Mode test', 'Msg', '[]', 'cli')"
    ).run(threadId);
  });

  it('sets mode and redirects', async () => {
    const res = await request('POST', `/thread/${threadId}/mode`, {
      email: ALICE_EMAIL,
      formBody: { mode: 'autonomous' },
    });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes(`/thread/${threadId}`));

    const settings = db.prepare('SELECT mode FROM thread_settings WHERE thread_id = ? AND user_id = 1').get(threadId);
    assert.strictEqual(settings.mode, 'autonomous');
  });

  it('upserts mode on subsequent calls', async () => {
    await request('POST', `/thread/${threadId}/mode`, {
      email: ALICE_EMAIL,
      formBody: { mode: 'manual' },
    });
    const settings = db.prepare('SELECT mode FROM thread_settings WHERE thread_id = ? AND user_id = 1').get(threadId);
    assert.strictEqual(settings.mode, 'manual');
  });

  it('defaults to manual when no mode given', async () => {
    await request('POST', `/thread/${threadId}/mode`, {
      email: ALICE_EMAIL,
      formBody: {},
    });
    const settings = db.prepare('SELECT mode FROM thread_settings WHERE thread_id = ? AND user_id = 1').get(threadId);
    assert.strictEqual(settings.mode, 'manual');
  });
});

// ── Thread reply ──

describe('POST /thread/:threadId/reply', () => {
  let threadId;

  before(() => {
    threadId = generateThreadId();
    db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 2, 1, 'Reply test', 'Original message', '[]', 'cli')"
    ).run(threadId);
  });

  it('creates a reply and redirects', async () => {
    const res = await request('POST', `/thread/${threadId}/reply`, {
      email: ALICE_EMAIL,
      formBody: { body: 'Alice replies' },
    });
    assert.strictEqual(res.status, 302);

    const reply = db.prepare("SELECT * FROM messages WHERE body = 'Alice replies'").get();
    assert.ok(reply);
    assert.strictEqual(reply.thread_id, threadId);
    assert.strictEqual(reply.from_user_id, 1); // alice
    assert.strictEqual(reply.to_user_id, 2);   // bob (last sender)
    assert.strictEqual(reply.source, 'web');
  });

  it('redirects without creating message when body is empty', async () => {
    const countBefore = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?').get(threadId).c;
    const res = await request('POST', `/thread/${threadId}/reply`, {
      email: ALICE_EMAIL,
      formBody: { body: '' },
    });
    assert.strictEqual(res.status, 302);
    const countAfter = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?').get(threadId).c;
    assert.strictEqual(countAfter, countBefore);
  });

  it('redirects without creating message when body is whitespace only', async () => {
    const countBefore = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?').get(threadId).c;
    await request('POST', `/thread/${threadId}/reply`, {
      email: ALICE_EMAIL,
      formBody: { body: '   ' },
    });
    const countAfter = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?').get(threadId).c;
    assert.strictEqual(countAfter, countBefore);
  });

  it('returns 404 for non-existent thread', async () => {
    const res = await request('POST', '/thread/t-ghost/reply', {
      email: ALICE_EMAIL,
      formBody: { body: 'Into the void' },
    });
    assert.strictEqual(res.status, 404);
  });

  it('sets correct recipient when replying to own message', async () => {
    // Alice sent the last message in the thread, so replying should target bob
    const res = await request('POST', `/thread/${threadId}/reply`, {
      email: ALICE_EMAIL,
      formBody: { body: 'Follow up from alice' },
    });
    assert.strictEqual(res.status, 302);

    const reply = db.prepare("SELECT * FROM messages WHERE body = 'Follow up from alice'").get();
    assert.strictEqual(reply.to_user_id, 2); // bob
  });
});

// ── Inject message ──

describe('POST /thread/:threadId/inject', () => {
  let threadId;

  before(() => {
    threadId = generateThreadId();
    db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 1, 2, 'Inject test', 'Base msg', '[]', 'cli')"
    ).run(threadId);
  });

  it('queues an injection and redirects', async () => {
    const res = await request('POST', `/thread/${threadId}/inject`, {
      email: ALICE_EMAIL,
      formBody: { body: 'Injected guidance' },
    });
    assert.strictEqual(res.status, 302);

    const queued = db.prepare("SELECT * FROM message_queue WHERE body = 'Injected guidance'").get();
    assert.ok(queued);
    assert.strictEqual(queued.thread_id, threadId);
    assert.strictEqual(queued.user_id, 1);
    assert.strictEqual(queued.status, 'pending');
  });

  it('redirects without queueing when body is empty', async () => {
    const countBefore = db.prepare('SELECT COUNT(*) AS c FROM message_queue WHERE thread_id = ?').get(threadId).c;
    const res = await request('POST', `/thread/${threadId}/inject`, {
      email: ALICE_EMAIL,
      formBody: { body: '' },
    });
    assert.strictEqual(res.status, 302);
    const countAfter = db.prepare('SELECT COUNT(*) AS c FROM message_queue WHERE thread_id = ?').get(threadId).c;
    assert.strictEqual(countAfter, countBefore);
  });

  it('returns 403 for non-participant', async () => {
    const res = await request('POST', `/thread/${threadId}/inject`, {
      email: 'charlie@example.com',
      formBody: { body: 'Sneak in' },
    });
    assert.strictEqual(res.status, 403);
  });
});

// ── Cancel queue ──

describe('POST /thread/:threadId/cancel-queue/:queueId', () => {
  let threadId, queueId;

  before(() => {
    threadId = generateThreadId();
    db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 1, 2, 'Cancel test', 'Msg', '[]', 'cli')"
    ).run(threadId);
    const result = db.prepare(
      "INSERT INTO message_queue (thread_id, user_id, body) VALUES (?, 1, 'To be cancelled')"
    ).run(threadId);
    queueId = result.lastInsertRowid;
  });

  it('cancels a pending queue item and redirects', async () => {
    const res = await request('POST', `/thread/${threadId}/cancel-queue/${queueId}`, {
      email: ALICE_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 302);

    const row = db.prepare('SELECT status FROM message_queue WHERE id = ?').get(queueId);
    assert.strictEqual(row.status, 'cancelled');
  });

  it('does not cancel item owned by another user', async () => {
    const result = db.prepare(
      "INSERT INTO message_queue (thread_id, user_id, body) VALUES (?, 1, 'Alice only')"
    ).run(threadId);
    const id = result.lastInsertRowid;

    // Bob tries to cancel alice's queue item
    await request('POST', `/thread/${threadId}/cancel-queue/${id}`, {
      email: BOB_EMAIL,
      formBody: {},
    });

    const row = db.prepare('SELECT status FROM message_queue WHERE id = ?').get(id);
    assert.strictEqual(row.status, 'pending'); // unchanged
  });
});

// ── Connections page ──

describe('GET /connections', () => {
  it('returns 200 for regular user', async () => {
    const res = await request('GET', '/connections', { email: BOB_EMAIL });
    assert.strictEqual(res.status, 200);
  });

  it('returns 200 for admin', async () => {
    const res = await request('GET', '/connections', { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 200);
  });
});

// ── Connection request ──

describe('POST /connections/request', () => {
  before(() => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (20, 'dave@example.com', 'dave', 'user')").run();
  });

  it('creates a pending connection request', async () => {
    const res = await request('POST', '/connections/request', {
      email: ALICE_EMAIL,
      formBody: { targetId: '20', direction: 'bidirectional', message: 'Let us connect' },
    });
    assert.strictEqual(res.status, 302);

    const conn = db.prepare("SELECT * FROM connections WHERE requester_id = 1 AND target_id = 20").get();
    assert.ok(conn);
    assert.strictEqual(conn.status, 'pending');
    assert.strictEqual(conn.direction, 'bidirectional');
    assert.strictEqual(conn.message, 'Let us connect');
  });

  it('redirects silently for duplicate connection', async () => {
    const res = await request('POST', '/connections/request', {
      email: ALICE_EMAIL,
      formBody: { targetId: '20' },
    });
    assert.strictEqual(res.status, 302);

    // Should still be exactly one connection
    const count = db.prepare('SELECT COUNT(*) AS c FROM connections WHERE requester_id = 1 AND target_id = 20').get().c;
    assert.strictEqual(count, 1);
  });

  it('returns 400 when targetId is missing', async () => {
    const res = await request('POST', '/connections/request', {
      email: ALICE_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for non-existent target', async () => {
    const res = await request('POST', '/connections/request', {
      email: ALICE_EMAIL,
      formBody: { targetId: '9999' },
    });
    assert.strictEqual(res.status, 404);
  });

  it('defaults to bidirectional direction', async () => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (21, 'eve@example.com', 'eve', 'user')").run();
    await request('POST', '/connections/request', {
      email: ALICE_EMAIL,
      formBody: { targetId: '21' },
    });
    const conn = db.prepare("SELECT direction FROM connections WHERE requester_id = 1 AND target_id = 21").get();
    assert.strictEqual(conn.direction, 'bidirectional');
  });

  it('supports one-way direction', async () => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (22, 'frank@example.com', 'frank', 'user')").run();
    await request('POST', '/connections/request', {
      email: ALICE_EMAIL,
      formBody: { targetId: '22', direction: 'one-way' },
    });
    const conn = db.prepare("SELECT direction FROM connections WHERE requester_id = 1 AND target_id = 22").get();
    assert.strictEqual(conn.direction, 'one-way');
  });
});

// ── Connection approve ──

describe('POST /connections/:id/approve', () => {
  let connId;

  before(() => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (30, 'pending@example.com', 'pending', 'user')").run();
    const result = db.prepare(
      "INSERT INTO connections (requester_id, target_id, direction, status) VALUES (30, 2, 'bidirectional', 'pending')"
    ).run();
    connId = result.lastInsertRowid;
  });

  it('returns 403 for non-admin', async () => {
    const res = await request('POST', `/connections/${connId}/approve`, {
      email: BOB_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 403);
  });

  it('approves connection as admin', async () => {
    const res = await request('POST', `/connections/${connId}/approve`, {
      email: ALICE_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 302);

    const conn = db.prepare('SELECT status, resolved_by FROM connections WHERE id = ?').get(connId);
    assert.strictEqual(conn.status, 'approved');
    assert.strictEqual(conn.resolved_by, 1); // alice's id
  });

  it('returns 404 for already-approved connection', async () => {
    const res = await request('POST', `/connections/${connId}/approve`, {
      email: ALICE_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 404);
  });
});

// ── Connection reject ──

describe('POST /connections/:id/reject', () => {
  let connId;

  before(() => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (31, 'reject-me@example.com', 'rejectme', 'user')").run();
    const result = db.prepare(
      "INSERT INTO connections (requester_id, target_id, direction, status) VALUES (31, 2, 'bidirectional', 'pending')"
    ).run();
    connId = result.lastInsertRowid;
  });

  it('returns 403 for non-admin', async () => {
    const res = await request('POST', `/connections/${connId}/reject`, {
      email: BOB_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 403);
  });

  it('rejects connection as admin', async () => {
    const res = await request('POST', `/connections/${connId}/reject`, {
      email: ALICE_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 302);

    const conn = db.prepare('SELECT status FROM connections WHERE id = ?').get(connId);
    assert.strictEqual(conn.status, 'rejected');
  });
});

// ── Connection remove ──

describe('POST /connections/:id/remove', () => {
  let connId;

  before(() => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (32, 'removable@example.com', 'removable', 'user')").run();
    const result = db.prepare(
      "INSERT INTO connections (requester_id, target_id, direction, status) VALUES (1, 32, 'bidirectional', 'approved')"
    ).run();
    connId = result.lastInsertRowid;
  });

  it('allows participant to remove their connection', async () => {
    const res = await request('POST', `/connections/${connId}/remove`, {
      email: ALICE_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 302);

    const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(connId);
    assert.strictEqual(conn, undefined); // deleted
  });

  it('returns 404 for non-existent connection', async () => {
    const res = await request('POST', '/connections/99999/remove', {
      email: ALICE_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 404);
  });

  it('returns 403 for non-participant non-admin', async () => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (33, 'outsider@example.com', 'outsider', 'user')").run();
    const result = db.prepare(
      "INSERT INTO connections (requester_id, target_id, direction, status) VALUES (32, 33, 'bidirectional', 'approved')"
    ).run();
    const id = result.lastInsertRowid;

    const res = await request('POST', `/connections/${id}/remove`, {
      email: BOB_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 403);
  });

  it('allows admin to remove any connection', async () => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (34, 'admin-remove@example.com', 'adminremove', 'user')").run();
    const result = db.prepare(
      "INSERT INTO connections (requester_id, target_id, direction, status) VALUES (34, 33, 'bidirectional', 'approved')"
    ).run();
    const id = result.lastInsertRowid;

    const res = await request('POST', `/connections/${id}/remove`, {
      email: ALICE_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 302);

    const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
    assert.strictEqual(conn, undefined);
  });
});

// ── Setup page ──

describe('GET /setup', () => {
  it('returns 200', async () => {
    const res = await request('GET', '/setup', { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 200);
  });
});

// ── Settings & token management ──

describe('GET /settings', () => {
  it('returns 200 with token list', async () => {
    const res = await request('GET', '/settings', { email: ALICE_EMAIL });
    assert.strictEqual(res.status, 200);
  });
});

describe('POST /settings/generate-token', () => {
  it('creates a new token and renders settings page', async () => {
    const countBefore = db.prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = 1').get().c;
    const res = await request('POST', '/settings/generate-token', {
      email: ALICE_EMAIL,
      formBody: { label: 'my-new-token' },
    });
    assert.strictEqual(res.status, 200); // renders page (not redirect)

    const countAfter = db.prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = 1').get().c;
    assert.strictEqual(countAfter, countBefore + 1);

    const token = db.prepare("SELECT * FROM api_tokens WHERE label = 'my-new-token' ORDER BY id DESC LIMIT 1").get();
    assert.ok(token);
    assert.strictEqual(token.user_id, 1);

    // Response body should contain the generated token (shown once)
    assert.ok(res.body.includes('cn_'));
  });

  it('uses default label when none given', async () => {
    await request('POST', '/settings/generate-token', {
      email: ALICE_EMAIL,
      formBody: {},
    });
    const token = db.prepare("SELECT * FROM api_tokens WHERE user_id = 1 ORDER BY id DESC LIMIT 1").get();
    assert.strictEqual(token.label, 'default');
  });
});

describe('POST /settings/revoke-token/:id', () => {
  let tokenId;

  before(() => {
    const hash = hashToken('cn_test_revoke_token');
    const result = db.prepare(
      "INSERT INTO api_tokens (user_id, token_hash, label) VALUES (1, ?, 'to-revoke-web')"
    ).run(hash);
    tokenId = result.lastInsertRowid;
  });

  it('revokes token and redirects', async () => {
    const res = await request('POST', `/settings/revoke-token/${tokenId}`, {
      email: ALICE_EMAIL,
      formBody: {},
    });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('/settings'));

    const token = db.prepare('SELECT revoked FROM api_tokens WHERE id = ?').get(tokenId);
    assert.strictEqual(token.revoked, 1);
  });

  it('does not revoke another user token', async () => {
    const hash = hashToken('cn_test_bob_token');
    const result = db.prepare(
      "INSERT INTO api_tokens (user_id, token_hash, label) VALUES (2, ?, 'bob-token')"
    ).run(hash);
    const bobTokenId = result.lastInsertRowid;

    await request('POST', `/settings/revoke-token/${bobTokenId}`, {
      email: ALICE_EMAIL,
      formBody: {},
    });

    const token = db.prepare('SELECT revoked FROM api_tokens WHERE id = ?').get(bobTokenId);
    assert.strictEqual(token.revoked, 0); // unchanged
  });
});
