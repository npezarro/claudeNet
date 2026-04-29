const express = require('express');
const { requireToken } = require('./auth');
const { generateThreadId, hashToken, generateToken, getConnectedUsers, ONLINE_THRESHOLD_MINUTES } = require('./db');
const { scanMessage } = require('./sensitivity');
const { notifyNewMessage } = require('./discord');

const MAX_BODY_LENGTH = 10000;

function createApiRouter(db) {
  const router = express.Router();

  // All API routes require Bearer token (except health)
  router.use((req, res, next) => {
    if (req.path === '/health') return next();
    requireToken(db)(req, res, next);
  });

  // Health check (no auth)
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'claudenet',
      uptime: Math.floor(process.uptime()),
    });
  });

  // ── Instance Management ──

  // Heartbeat: upsert instance
  router.post('/instances/heartbeat', (req, res) => {
    const { instanceKey, metadata } = req.body;
    if (!instanceKey) {
      return res.status(400).json({ error: 'instanceKey is required' });
    }

    db.prepare(`
      INSERT INTO instances (user_id, instance_key, last_heartbeat, metadata)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(instance_key) DO UPDATE SET
        last_heartbeat = datetime('now'),
        metadata = COALESCE(excluded.metadata, instances.metadata),
        user_id = excluded.user_id
    `).run(req.user.id, instanceKey, JSON.stringify(metadata || {}));

    const instance = db.prepare('SELECT * FROM instances WHERE instance_key = ?').get(instanceKey);
    res.json({ ok: true, instanceId: instance.id });
  });

  // List instances
  router.get('/instances', (req, res) => {
    const instances = db.prepare(`
      SELECT i.*, u.display_name, u.email,
        CASE WHEN datetime(i.last_heartbeat, '+${ONLINE_THRESHOLD_MINUTES} minutes') >= datetime('now')
          THEN 1 ELSE 0 END AS is_online
      FROM instances i
      JOIN users u ON i.user_id = u.id
      ORDER BY i.last_heartbeat DESC
    `).all();

    res.json({
      instances: instances.map(i => ({
        id: i.id,
        instanceKey: i.instance_key,
        nickname: i.nickname,
        user: i.display_name,
        email: i.email,
        isOnline: !!i.is_online,
        lastHeartbeat: i.last_heartbeat,
        metadata: JSON.parse(i.metadata || '{}'),
        createdAt: i.created_at,
      })),
    });
  });

  // Set instance nickname (owner only)
  router.patch('/instances/:id/nickname', (req, res) => {
    const { nickname } = req.body;
    const result = db.prepare('UPDATE instances SET nickname = ? WHERE id = ? AND user_id = ?')
      .run(nickname || null, req.params.id, req.user.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Instance not found or not owned by you' });
    }
    res.json({ ok: true });
  });

  // ── Thread Settings ──

  // Get thread settings
  router.get('/thread/:threadId/settings', (req, res) => {
    const settings = db.prepare(
      'SELECT * FROM thread_settings WHERE thread_id = ? AND user_id = ?'
    ).get(req.params.threadId, req.user.id);

    res.json({
      threadId: req.params.threadId,
      mode: settings ? settings.mode : 'autonomous',
      targetInstanceId: settings ? settings.target_instance_id : null,
    });
  });

  // Update thread settings
  router.patch('/thread/:threadId/settings', (req, res) => {
    const { mode, instanceId } = req.body;
    if (mode && !['manual', 'autonomous'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be manual or autonomous' });
    }

    db.prepare(`
      INSERT INTO thread_settings (thread_id, user_id, mode, target_instance_id, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(thread_id, user_id) DO UPDATE SET
        mode = COALESCE(excluded.mode, thread_settings.mode),
        target_instance_id = excluded.target_instance_id,
        updated_at = excluded.updated_at
    `).run(req.params.threadId, req.user.id, mode || 'manual', instanceId || null);

    res.json({ ok: true });
  });

  // ── Autonomous Polling + Injection ──

  // Poll: get new messages + pending injections
  router.get('/thread/:threadId/poll', (req, res) => {
    const { since } = req.query;
    const threadId = req.params.threadId;

    // Get messages since timestamp
    let msgSql = `
      SELECT m.*, u.display_name AS from_name
      FROM messages m JOIN users u ON m.from_user_id = u.id
      WHERE m.thread_id = ? AND (m.to_user_id = ? OR m.from_user_id = ?)
    `;
    const msgParams = [threadId, req.user.id, req.user.id];

    if (since) {
      msgSql += ' AND m.created_at > ?';
      msgParams.push(since);
    }
    msgSql += ' ORDER BY m.created_at ASC';

    const messages = db.prepare(msgSql).all(...msgParams);

    // Get pending injections for this thread
    const injections = db.prepare(
      "SELECT * FROM message_queue WHERE thread_id = ? AND status = 'pending' ORDER BY created_at ASC"
    ).all(threadId);

    // Mark injections as delivered
    if (injections.length > 0) {
      const ids = injections.map(i => i.id);
      db.prepare(
        `UPDATE message_queue SET status = 'delivered', delivered_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`
      ).run(...ids);
    }

    // Mark unread messages as read
    db.prepare(`
      UPDATE messages SET status = 'read', read_at = datetime('now')
      WHERE thread_id = ? AND to_user_id = ? AND status = 'unread'
    `).run(threadId, req.user.id);

    // Get thread settings
    const settings = db.prepare(
      'SELECT mode FROM thread_settings WHERE thread_id = ? AND user_id = ?'
    ).get(threadId, req.user.id);

    res.json({
      threadId,
      mode: settings ? settings.mode : 'autonomous',
      messages: messages.map(formatMessage),
      injections: injections.map(i => ({
        id: i.id,
        body: i.body,
        createdAt: i.created_at,
      })),
    });
  });

  // Queue: inject message into autonomous conversation (participant only)
  router.post('/thread/:threadId/queue', (req, res) => {
    const { body } = req.body;
    if (!body || typeof body !== 'string') {
      return res.status(400).json({ error: 'body is required' });
    }

    // Verify caller is a participant in this thread
    const participant = db.prepare(
      'SELECT 1 FROM messages WHERE thread_id = ? AND (from_user_id = ? OR to_user_id = ?) LIMIT 1'
    ).get(req.params.threadId, req.user.id, req.user.id);
    if (!participant) {
      return res.status(403).json({ error: 'Not a participant in this thread' });
    }

    const result = db.prepare(`
      INSERT INTO message_queue (thread_id, user_id, body)
      VALUES (?, ?, ?)
    `).run(req.params.threadId, req.user.id, body);

    res.json({ ok: true, queueId: result.lastInsertRowid });
  });

  // Cancel queued injection
  router.delete('/queue/:id', (req, res) => {
    const result = db.prepare(
      "UPDATE message_queue SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'"
    ).run(req.params.id, req.user.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Queue item not found or already delivered' });
    }
    res.json({ ok: true });
  });

  // ── Existing Endpoints ──

  // Send a message or reply
  router.post('/send', (req, res) => {
    const { to, subject, body, replyTo } = req.body;

    if (!body || typeof body !== 'string') {
      return res.status(400).json({ error: 'body is required' });
    }
    if (body.length > MAX_BODY_LENGTH) {
      return res.status(400).json({ error: `body exceeds ${MAX_BODY_LENGTH} chars` });
    }

    const flags = scanMessage(body);
    if (subject) flags.push(...scanMessage(subject));

    // Reply to existing message
    if (replyTo) {
      const parent = db.prepare('SELECT * FROM messages WHERE id = ?').get(replyTo);
      if (!parent) {
        return res.status(404).json({ error: 'Parent message not found' });
      }
      const toUserId = parent.from_user_id === req.user.id
        ? parent.to_user_id
        : parent.from_user_id;

      const result = db.prepare(`
        INSERT INTO messages (thread_id, parent_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'cli')
      `).run(
        parent.thread_id,
        parent.id,
        req.user.id,
        toUserId,
        parent.subject,
        body,
        JSON.stringify(flags)
      );

      const toName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(toUserId)?.display_name || 'unknown';
      logAudit(db, req.user.id, 'reply', { messageId: result.lastInsertRowid, threadId: parent.thread_id });
      notifyNewMessage({ from: req.user.name, to: toName, subject: parent.subject, body, threadId: parent.thread_id, source: 'cli' });
      return res.json({ ok: true, messageId: result.lastInsertRowid, threadId: parent.thread_id });
    }

    // New message
    if (!to || !subject) {
      return res.status(400).json({ error: 'to and subject required for new messages' });
    }

    const toUser = db.prepare(
      'SELECT * FROM users WHERE display_name = ? OR email = ?'
    ).get(to, to);
    if (!toUser) {
      return res.status(404).json({ error: `User "${to}" not found` });
    }
    if (toUser.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot send message to yourself' });
    }

    // Check connection
    const connected = getConnectedUsers(db, req.user.id);
    if (!connected.some(u => u.id === toUser.id)) {
      return res.status(403).json({ error: `No approved connection with "${to}"` });
    }

    const threadId = generateThreadId();
    const result = db.prepare(`
      INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source)
      VALUES (?, ?, ?, ?, ?, ?, 'cli')
    `).run(threadId, req.user.id, toUser.id, subject, body, JSON.stringify(flags));

    logAudit(db, req.user.id, 'send', { messageId: result.lastInsertRowid, threadId, to: toUser.email });
    notifyNewMessage({ from: req.user.name, to: toUser.display_name, subject, body, threadId, source: 'cli' });
    res.json({ ok: true, messageId: result.lastInsertRowid, threadId });
  });

  // Inbox (unread messages)
  router.get('/inbox', (req, res) => {
    const messages = db.prepare(`
      SELECT m.*, u.display_name AS from_name
      FROM messages m JOIN users u ON m.from_user_id = u.id
      WHERE m.to_user_id = ? AND m.status = 'unread'
      ORDER BY m.created_at DESC
    `).all(req.user.id);

    res.json({
      messages: messages.map(formatMessage),
      count: messages.length,
    });
  });

  // All messages (with filters)
  router.get('/messages', (req, res) => {
    const { status, limit = 50, since } = req.query;
    let sql = `
      SELECT m.*, u.display_name AS from_name
      FROM messages m JOIN users u ON m.from_user_id = u.id
      WHERE (m.to_user_id = ? OR m.from_user_id = ?)
    `;
    const params = [req.user.id, req.user.id];

    if (status && status !== 'all') {
      sql += ' AND m.status = ?';
      params.push(status);
    }
    if (since) {
      sql += ' AND m.created_at > ?';
      params.push(since);
    }
    sql += ' ORDER BY m.created_at DESC LIMIT ?';
    params.push(Math.min(parseInt(limit) || 50, 200));

    const messages = db.prepare(sql).all(...params);
    res.json({ messages: messages.map(formatMessage), count: messages.length });
  });

  // Get a thread
  router.get('/thread/:threadId', (req, res) => {
    const messages = db.prepare(`
      SELECT m.*, u.display_name AS from_name
      FROM messages m JOIN users u ON m.from_user_id = u.id
      WHERE m.thread_id = ? AND (m.to_user_id = ? OR m.from_user_id = ?)
      ORDER BY m.created_at ASC
    `).all(req.params.threadId, req.user.id, req.user.id);

    if (messages.length === 0) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    // Mark all unread messages in this thread as read
    db.prepare(`
      UPDATE messages SET status = 'read', read_at = datetime('now')
      WHERE thread_id = ? AND to_user_id = ? AND status = 'unread'
    `).run(req.params.threadId, req.user.id);

    res.json({
      threadId: req.params.threadId,
      subject: messages[0].subject,
      messages: messages.map(formatMessage),
    });
  });

  // Get single message
  router.get('/message/:id', (req, res) => {
    const msg = db.prepare(`
      SELECT m.*, u.display_name AS from_name
      FROM messages m JOIN users u ON m.from_user_id = u.id
      WHERE m.id = ? AND (m.to_user_id = ? OR m.from_user_id = ?)
    `).get(req.params.id, req.user.id, req.user.id);

    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Auto-mark as read
    if (msg.to_user_id === req.user.id && msg.status === 'unread') {
      db.prepare('UPDATE messages SET status = \'read\', read_at = datetime(\'now\') WHERE id = ?')
        .run(msg.id);
    }

    res.json({ message: formatMessage(msg) });
  });

  // Archive a message
  router.post('/message/:id/archive', (req, res) => {
    const result = db.prepare(
      'UPDATE messages SET status = \'archived\' WHERE id = ? AND to_user_id = ?'
    ).run(req.params.id, req.user.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ ok: true });
  });

  // Stats
  router.get('/stats', (req, res) => {
    const unread = db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE to_user_id = ? AND status = \'unread\''
    ).get(req.user.id).count;
    const total = db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE to_user_id = ? OR from_user_id = ?'
    ).get(req.user.id, req.user.id).count;
    const threads = db.prepare(`
      SELECT COUNT(DISTINCT thread_id) AS count FROM messages
      WHERE to_user_id = ? OR from_user_id = ?
    `).get(req.user.id, req.user.id).count;

    res.json({ unread, total, threads, user: req.user.name });
  });

  // Token management
  router.post('/tokens/generate', (req, res) => {
    const { label = 'default' } = req.body || {};
    const plainToken = generateToken();
    const hash = hashToken(plainToken);

    db.prepare(
      'INSERT INTO api_tokens (user_id, token_hash, label) VALUES (?, ?, ?)'
    ).run(req.user.id, hash, label);

    logAudit(db, req.user.id, 'token_generated', { label });
    res.json({ ok: true, token: plainToken, label, note: 'Save this token now, it will not be shown again.' });
  });

  router.get('/tokens', (req, res) => {
    const tokens = db.prepare(`
      SELECT id, label, created_at, last_used_at, revoked
      FROM api_tokens WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);

    res.json({ user: req.user.email, tokens });
  });

  router.delete('/tokens/:id', (req, res) => {
    const result = db.prepare(
      'UPDATE api_tokens SET revoked = 1 WHERE id = ? AND user_id = ?'
    ).run(req.params.id, req.user.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Token not found' });
    }
    logAudit(db, req.user.id, 'token_revoked', { tokenId: req.params.id });
    res.json({ ok: true });
  });

  return router;
}

function formatMessage(msg) {
  return {
    id: msg.id,
    threadId: msg.thread_id,
    parentId: msg.parent_id,
    from: msg.from_name,
    subject: msg.subject,
    body: msg.body,
    status: msg.status,
    source: msg.source,
    sensitivityFlags: JSON.parse(msg.sensitivity_flags || '[]'),
    createdAt: msg.created_at,
    readAt: msg.read_at,
  };
}

function logAudit(db, userId, action, details) {
  db.prepare(
    'INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)'
  ).run(userId, action, JSON.stringify(details));
}

module.exports = { createApiRouter };
