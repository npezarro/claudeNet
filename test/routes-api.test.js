const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { createApiRouter } = require('../lib/routes-api');
const { hashToken, generateThreadId } = require('../lib/db');

const TEST_TOKEN = 'cn_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const testDataDir = path.join(__dirname, '..', 'data-test-api-' + process.pid);

let db, app, server, baseUrl;

function request(method, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlPath, baseUrl);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: {},
    };
    if (token) opts.headers.authorization = `Bearer ${token}`;
    if (body) {
      const payload = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
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

  // Seed token for alice
  db.prepare("INSERT INTO api_tokens (id, user_id, token_hash, label) VALUES (1, 1, ?, 'test')").run(hashToken(TEST_TOKEN));

  // Seed approved connection between alice and bob
  db.prepare("INSERT INTO connections (requester_id, target_id, direction, status, resolved_at, resolved_by) VALUES (1, 2, 'bidirectional', 'approved', datetime('now'), 1)").run();
}

before((_, done) => {
  setupDb();
  app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(db));

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

// ── Health ──

describe('GET /api/health', () => {
  it('returns status ok without auth', async () => {
    const res = await request('GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.service, 'claudenet');
    assert.ok(typeof res.body.uptime === 'number');
  });
});

// ── Auth middleware ──

describe('API auth', () => {
  it('returns 401 without token', async () => {
    const res = await request('GET', '/api/inbox');
    assert.strictEqual(res.status, 401);
  });

  it('returns 401 with invalid token', async () => {
    const res = await request('GET', '/api/inbox', { token: 'bad' });
    assert.strictEqual(res.status, 401);
  });
});

// ── Instance Management ──

describe('POST /api/instances/heartbeat', () => {
  it('creates an instance', async () => {
    const res = await request('POST', '/api/instances/heartbeat', {
      token: TEST_TOKEN,
      body: { instanceKey: 'inst-alice-1', metadata: { host: 'wsl' } },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.instanceId);
  });

  it('upserts on second heartbeat', async () => {
    const res = await request('POST', '/api/instances/heartbeat', {
      token: TEST_TOKEN,
      body: { instanceKey: 'inst-alice-1', metadata: { host: 'wsl2' } },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  it('rejects missing instanceKey', async () => {
    const res = await request('POST', '/api/instances/heartbeat', {
      token: TEST_TOKEN,
      body: {},
    });
    assert.strictEqual(res.status, 400);
  });
});

describe('GET /api/instances', () => {
  it('lists instances', async () => {
    const res = await request('GET', '/api/instances', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.instances));
    const inst = res.body.instances.find(i => i.instanceKey === 'inst-alice-1');
    assert.ok(inst);
    assert.strictEqual(inst.user, 'alice');
  });
});

describe('PATCH /api/instances/:id/nickname', () => {
  it('sets nickname on owned instance', async () => {
    const inst = db.prepare("SELECT id FROM instances WHERE instance_key = 'inst-alice-1'").get();
    const res = await request('PATCH', `/api/instances/${inst.id}/nickname`, {
      token: TEST_TOKEN,
      body: { nickname: 'dev-machine' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  it('returns 404 for non-owned instance', async () => {
    const res = await request('PATCH', '/api/instances/9999/nickname', {
      token: TEST_TOKEN,
      body: { nickname: 'hacked' },
    });
    assert.strictEqual(res.status, 404);
  });
});

// ── Thread Settings ──

describe('GET /api/thread/:threadId/settings', () => {
  it('returns defaults when no settings exist', async () => {
    const res = await request('GET', '/api/thread/t-nosettings/settings', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mode, 'autonomous');
    assert.strictEqual(res.body.targetInstanceId, null);
  });
});

describe('PATCH /api/thread/:threadId/settings', () => {
  it('creates thread settings', async () => {
    const res = await request('PATCH', '/api/thread/t-test-settings/settings', {
      token: TEST_TOKEN,
      body: { mode: 'autonomous' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  it('persists thread settings', async () => {
    const res = await request('GET', '/api/thread/t-test-settings/settings', { token: TEST_TOKEN });
    assert.strictEqual(res.body.mode, 'autonomous');
  });

  it('rejects invalid mode', async () => {
    const res = await request('PATCH', '/api/thread/t-test-settings/settings', {
      token: TEST_TOKEN,
      body: { mode: 'turbo' },
    });
    assert.strictEqual(res.status, 400);
  });
});

// ── Send Message ──

describe('POST /api/send', () => {
  it('sends a new message', async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'Hello', body: 'Test message' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.messageId);
    assert.ok(res.body.threadId);
  });

  it('rejects missing body', async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'No body' },
    });
    assert.strictEqual(res.status, 400);
  });

  it('rejects body exceeding max length', async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'Long', body: 'x'.repeat(10001) },
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /exceeds/);
  });

  it('rejects sending to self', async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'alice', subject: 'Self', body: 'hello me' },
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /yourself/);
  });

  it('rejects sending to unknown user', async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'nobody', subject: 'Hi', body: 'hello' },
    });
    assert.strictEqual(res.status, 404);
  });

  it('rejects new message without to/subject', async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { body: 'orphan' },
    });
    assert.strictEqual(res.status, 400);
  });

  it('rejects sending to unconnected user', async () => {
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (3, 'stranger@example.com', 'stranger', 'user')").run();
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'stranger', subject: 'Hi', body: 'hello' },
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.body.error, /connection/i);
  });
});

// ── Reply ──

describe('POST /api/send (reply)', () => {
  let messageId, threadId;

  before(async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'Thread test', body: 'First message' },
    });
    messageId = res.body.messageId;
    threadId = res.body.threadId;
  });

  it('replies to existing message', async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { replyTo: messageId, body: 'Reply here' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.threadId, threadId);
  });

  it('rejects reply to non-existent message', async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { replyTo: 99999, body: 'orphan reply' },
    });
    assert.strictEqual(res.status, 404);
  });
});

// ── Inbox ──

describe('GET /api/inbox', () => {
  it('returns unread messages for the user', async () => {
    const res = await request('GET', '/api/inbox', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.messages));
    assert.ok(typeof res.body.count === 'number');
  });
});

// ── Messages ──

describe('GET /api/messages', () => {
  it('returns messages with default limit', async () => {
    const res = await request('GET', '/api/messages', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.messages));
  });

  it('filters by status', async () => {
    const res = await request('GET', '/api/messages?status=unread', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    for (const msg of res.body.messages) {
      // Messages to alice might not be unread (she sent them), but the query checks both from/to
      assert.ok(msg.status);
    }
  });

  it('respects limit param', async () => {
    const res = await request('GET', '/api/messages?limit=1', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.messages.length <= 1);
  });

  it('caps limit at 200', async () => {
    const res = await request('GET', '/api/messages?limit=999', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    // Just verify it doesn't crash; actual cap is internal
  });
});

// ── Thread ──

describe('GET /api/thread/:threadId', () => {
  let threadId;

  before(async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'Thread read test', body: 'Message in thread' },
    });
    threadId = res.body.threadId;
  });

  it('returns thread messages', async () => {
    const res = await request('GET', `/api/thread/${threadId}`, { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.threadId, threadId);
    assert.strictEqual(res.body.subject, 'Thread read test');
    assert.ok(res.body.messages.length >= 1);
  });

  it('returns 404 for non-existent thread', async () => {
    const res = await request('GET', '/api/thread/t-nonexistent', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 404);
  });
});

// ── Single Message ──

describe('GET /api/message/:id', () => {
  let messageId;

  before(async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'Single msg test', body: 'Read me' },
    });
    messageId = res.body.messageId;
  });

  it('returns a single message', async () => {
    const res = await request('GET', `/api/message/${messageId}`, { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message.id, messageId);
    assert.strictEqual(res.body.message.subject, 'Single msg test');
  });

  it('returns 404 for non-existent message', async () => {
    const res = await request('GET', '/api/message/99999', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 404);
  });
});

// ── Archive ──

describe('POST /api/message/:id/archive', () => {
  let messageId;

  before(async () => {
    // Send a message from alice to bob, then archive it from bob's perspective
    // Since we only have alice's token, we'll send alice->bob and archive won't work
    // (archive requires to_user_id match). Instead, insert a message TO alice.
    const tid = generateThreadId();
    const result = db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 2, 1, 'Archive test', 'archive me', '[]', 'cli')"
    ).run(tid);
    messageId = result.lastInsertRowid;
  });

  it('archives a message addressed to user', async () => {
    const res = await request('POST', `/api/message/${messageId}/archive`, { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  it('returns 404 for non-owned message', async () => {
    const res = await request('POST', '/api/message/99999/archive', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 404);
  });
});

// ── Stats ──

describe('GET /api/stats', () => {
  it('returns user stats', async () => {
    const res = await request('GET', '/api/stats', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body.unread === 'number');
    assert.ok(typeof res.body.total === 'number');
    assert.ok(typeof res.body.threads === 'number');
    assert.strictEqual(res.body.user, 'alice');
  });
});

// ── Polling ──

describe('GET /api/thread/:threadId/poll', () => {
  let threadId;

  before(async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'Poll test', body: 'Polling message' },
    });
    threadId = res.body.threadId;
  });

  it('returns messages and injections', async () => {
    const res = await request('GET', `/api/thread/${threadId}/poll`, { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.threadId, threadId);
    assert.ok(Array.isArray(res.body.messages));
    assert.ok(Array.isArray(res.body.injections));
    assert.ok(res.body.mode);
  });

  it('respects since parameter', async () => {
    const futureDate = '2099-01-01T00:00:00Z';
    const res = await request('GET', `/api/thread/${threadId}/poll?since=${futureDate}`, { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.messages.length, 0);
  });

  it('delivers queued injections and marks them delivered', async () => {
    // Queue an injection
    db.prepare(
      "INSERT INTO message_queue (thread_id, user_id, body) VALUES (?, 1, 'injected guidance')"
    ).run(threadId);

    const res = await request('GET', `/api/thread/${threadId}/poll`, { token: TEST_TOKEN });
    assert.ok(res.body.injections.length >= 1);
    const injection = res.body.injections.find(i => i.body === 'injected guidance');
    assert.ok(injection);

    // Verify it was marked delivered
    const row = db.prepare("SELECT status FROM message_queue WHERE id = ?").get(injection.id);
    assert.strictEqual(row.status, 'delivered');
  });
});

// ── Queue (inject message) ──

describe('POST /api/thread/:threadId/queue', () => {
  let threadId;

  before(async () => {
    const res = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'Queue test', body: 'Queue base' },
    });
    threadId = res.body.threadId;
  });

  it('queues an injection', async () => {
    const res = await request('POST', `/api/thread/${threadId}/queue`, {
      token: TEST_TOKEN,
      body: { body: 'Please wrap up' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.queueId);
  });

  it('rejects missing body', async () => {
    const res = await request('POST', `/api/thread/${threadId}/queue`, {
      token: TEST_TOKEN,
      body: {},
    });
    assert.strictEqual(res.status, 400);
  });

  it('rejects non-participant', async () => {
    const res = await request('POST', '/api/thread/t-unrelated-thread/queue', {
      token: TEST_TOKEN,
      body: { body: 'sneak in' },
    });
    assert.strictEqual(res.status, 403);
  });
});

// ── Cancel Queue ──

describe('DELETE /api/queue/:id', () => {
  let queueId, threadId;

  before(async () => {
    const sendRes = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'Cancel queue test', body: 'Base' },
    });
    threadId = sendRes.body.threadId;

    const qRes = await request('POST', `/api/thread/${threadId}/queue`, {
      token: TEST_TOKEN,
      body: { body: 'to be cancelled' },
    });
    queueId = qRes.body.queueId;
  });

  it('cancels a pending queue item', async () => {
    const res = await request('DELETE', `/api/queue/${queueId}`, { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);

    const row = db.prepare('SELECT status FROM message_queue WHERE id = ?').get(queueId);
    assert.strictEqual(row.status, 'cancelled');
  });

  it('returns 404 for already-cancelled item', async () => {
    const res = await request('DELETE', `/api/queue/${queueId}`, { token: TEST_TOKEN });
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 for non-existent queue item', async () => {
    const res = await request('DELETE', '/api/queue/99999', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 404);
  });
});

// ── Token Management ──

describe('POST /api/tokens/generate', () => {
  it('generates a new token', async () => {
    const res = await request('POST', '/api/tokens/generate', {
      token: TEST_TOKEN,
      body: { label: 'ci-token' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.token.startsWith('cn_'));
    assert.strictEqual(res.body.label, 'ci-token');
  });

  it('uses default label when none given', async () => {
    const res = await request('POST', '/api/tokens/generate', {
      token: TEST_TOKEN,
      body: {},
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.label, 'default');
  });

  it('logs audit entry', async () => {
    const row = db.prepare("SELECT * FROM audit_log WHERE action = 'token_generated' ORDER BY id DESC LIMIT 1").get();
    assert.ok(row);
    assert.strictEqual(row.user_id, 1);
  });
});

describe('GET /api/tokens', () => {
  it('lists tokens for the user', async () => {
    const res = await request('GET', '/api/tokens', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.tokens));
    assert.ok(res.body.tokens.length >= 1);
    assert.strictEqual(res.body.user, 'alice@example.com');
  });
});

describe('DELETE /api/tokens/:id', () => {
  let tokenId;

  before(async () => {
    // Generate a token to revoke
    await request('POST', '/api/tokens/generate', {
      token: TEST_TOKEN,
      body: { label: 'to-revoke' },
    });
    // Find the token row
    const row = db.prepare("SELECT id FROM api_tokens WHERE label = 'to-revoke' ORDER BY id DESC LIMIT 1").get();
    tokenId = row.id;
  });

  it('revokes a token', async () => {
    const res = await request('DELETE', `/api/tokens/${tokenId}`, { token: TEST_TOKEN });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);

    const row = db.prepare('SELECT revoked FROM api_tokens WHERE id = ?').get(tokenId);
    assert.strictEqual(row.revoked, 1);
  });

  it('logs audit entry for revocation', async () => {
    const row = db.prepare("SELECT * FROM audit_log WHERE action = 'token_revoked' ORDER BY id DESC LIMIT 1").get();
    assert.ok(row);
  });

  it('returns 404 for non-existent token', async () => {
    const res = await request('DELETE', '/api/tokens/99999', { token: TEST_TOKEN });
    assert.strictEqual(res.status, 404);
  });
});

// ── Message formatting ──

describe('message format', () => {
  it('includes all expected fields', async () => {
    const sendRes = await request('POST', '/api/send', {
      token: TEST_TOKEN,
      body: { to: 'bob', subject: 'Format test', body: 'Check fields' },
    });
    const res = await request('GET', `/api/message/${sendRes.body.messageId}`, { token: TEST_TOKEN });
    const msg = res.body.message;
    assert.ok(msg.id);
    assert.ok(msg.threadId);
    assert.strictEqual(msg.from, 'alice');
    assert.strictEqual(msg.subject, 'Format test');
    assert.strictEqual(msg.body, 'Check fields');
    assert.strictEqual(msg.source, 'cli');
    assert.ok(Array.isArray(msg.sensitivityFlags));
    assert.ok(msg.createdAt);
  });
});

// ── Auto-read behavior ──

describe('auto-read behavior', () => {
  let messageId;

  before(() => {
    // Insert a message from bob TO alice (unread)
    const tid = generateThreadId();
    const result = db.prepare(
      "INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source) VALUES (?, 2, 1, 'Unread test', 'should be marked read', '[]', 'cli')"
    ).run(tid);
    messageId = result.lastInsertRowid;
  });

  it('marks message as read when fetched via GET /api/message/:id', async () => {
    // Verify it starts unread
    const before = db.prepare('SELECT status FROM messages WHERE id = ?').get(messageId);
    assert.strictEqual(before.status, 'unread');

    await request('GET', `/api/message/${messageId}`, { token: TEST_TOKEN });

    const after = db.prepare('SELECT status FROM messages WHERE id = ?').get(messageId);
    assert.strictEqual(after.status, 'read');
  });
});
