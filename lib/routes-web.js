const express = require('express');
const { requireRemoteUser } = require('./auth');
const { generateThreadId, hashToken, generateToken, getConnectedUsers, ONLINE_THRESHOLD_MINUTES } = require('./db');
const { scanMessage } = require('./sensitivity');
const { notifyNewMessage, notifyModeChange, notifyConnectionRequest, notifyConnectionResolved } = require('./discord');

function createWebRouter(db) {
  const router = express.Router();

  router.use(requireRemoteUser(db));

  // Dashboard: list threads with mode badges
  router.get('/', (req, res) => {
    const threads = db.prepare(`
      SELECT
        m.thread_id,
        m.subject,
        MAX(m.created_at) AS last_activity,
        COUNT(*) AS message_count,
        SUM(CASE WHEN m.to_user_id = ? AND m.status = 'unread' THEN 1 ELSE 0 END) AS unread_count,
        (SELECT u.display_name FROM messages m2 JOIN users u ON m2.from_user_id = u.id
         WHERE m2.thread_id = m.thread_id ORDER BY m2.created_at ASC LIMIT 1) AS started_by,
        ts.mode
      FROM messages m
      LEFT JOIN thread_settings ts ON ts.thread_id = m.thread_id AND ts.user_id = ?
      WHERE m.to_user_id = ? OR m.from_user_id = ?
      GROUP BY m.thread_id
      ORDER BY last_activity DESC
      LIMIT 50
    `).all(req.user.id, req.user.id, req.user.id, req.user.id);

    res.render('dashboard', { user: req.user, threads });
  });

  // Compose: new conversation form (only show connected users)
  router.get('/compose', (req, res) => {
    const users = getConnectedUsers(db, req.user.id);
    res.render('compose', { user: req.user, users });
  });

  // Compose: send new conversation
  router.post('/compose', (req, res) => {
    const { to, body, mode } = req.body;
    const basePath = res.locals.basePath;

    if (!to || !body) {
      return res.status(400).send('Recipient and message are required');
    }

    const toUser = db.prepare(
      'SELECT * FROM users WHERE display_name = ? OR email = ?'
    ).get(to, to);
    if (!toUser) {
      return res.status(404).send('Recipient not found');
    }

    // Check connection
    const connected = getConnectedUsers(db, req.user.id);
    if (!connected.some(u => u.id === toUser.id)) {
      return res.status(403).send('No approved connection with this user');
    }

    // Auto-generate subject from first line of message
    const subject = body.split('\n')[0].substring(0, 60) || 'New thread';

    const flags = scanMessage(body);
    flags.push(...scanMessage(subject));

    const threadId = generateThreadId();
    db.prepare(`
      INSERT INTO messages (thread_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source)
      VALUES (?, ?, ?, ?, ?, ?, 'web')
    `).run(threadId, req.user.id, toUser.id, subject, body, JSON.stringify(flags));

    // Save thread mode (autonomous by default)
    const threadMode = mode === 'manual' ? 'manual' : 'autonomous';
    db.prepare(`
      INSERT INTO thread_settings (thread_id, user_id, mode, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(threadId, req.user.id, threadMode);

    notifyNewMessage({ from: req.user.name, to: toUser.display_name, subject, body, threadId, source: 'web' });

    res.redirect(basePath + '/thread/' + threadId);
  });

  // Instances page
  router.get('/instances', (req, res) => {
    const instances = db.prepare(`
      SELECT i.*, u.display_name,
        CASE WHEN datetime(i.last_heartbeat, '+${ONLINE_THRESHOLD_MINUTES} minutes') >= datetime('now')
          THEN 1 ELSE 0 END AS is_online
      FROM instances i
      JOIN users u ON i.user_id = u.id
      ORDER BY i.last_heartbeat DESC
    `).all();

    res.render('instances', { user: req.user, instances });
  });

  // Set instance nickname (owner only)
  router.post('/instances/:id/nickname', (req, res) => {
    const basePath = res.locals.basePath;
    db.prepare('UPDATE instances SET nickname = ? WHERE id = ? AND user_id = ?')
      .run(req.body.nickname || null, req.params.id, req.user.id);
    res.redirect(basePath + '/instances');
  });

  // Thread view
  router.get('/thread/:threadId', (req, res) => {
    const messages = db.prepare(`
      SELECT m.*, u.display_name AS from_name
      FROM messages m JOIN users u ON m.from_user_id = u.id
      WHERE m.thread_id = ? AND (m.to_user_id = ? OR m.from_user_id = ?)
      ORDER BY m.created_at ASC
    `).all(req.params.threadId, req.user.id, req.user.id);

    if (messages.length === 0) {
      return res.status(404).send('Thread not found');
    }

    // Mark unread as read
    db.prepare(`
      UPDATE messages SET status = 'read', read_at = datetime('now')
      WHERE thread_id = ? AND to_user_id = ? AND status = 'unread'
    `).run(req.params.threadId, req.user.id);

    // Get thread settings
    const settings = db.prepare(
      'SELECT mode FROM thread_settings WHERE thread_id = ? AND user_id = ?'
    ).get(req.params.threadId, req.user.id);
    const threadMode = settings ? settings.mode : 'manual';

    // Get queued messages
    const queuedMessages = db.prepare(
      "SELECT * FROM message_queue WHERE thread_id = ? AND status = 'pending' ORDER BY created_at ASC"
    ).all(req.params.threadId);

    res.render('thread', {
      user: req.user,
      threadId: req.params.threadId,
      subject: messages[0].subject,
      threadMode,
      queuedMessages,
      messages: messages.map(m => ({
        ...m,
        sensitivity_flags: JSON.parse(m.sensitivity_flags || '[]'),
      })),
    });
  });

  // Toggle thread mode (autonomous/manual)
  router.post('/thread/:threadId/mode', (req, res) => {
    const basePath = res.locals.basePath;
    const mode = req.body.mode || 'manual';

    db.prepare(`
      INSERT INTO thread_settings (thread_id, user_id, mode, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(thread_id, user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
    `).run(req.params.threadId, req.user.id, mode);

    notifyModeChange({ user: req.user.name, threadId: req.params.threadId, mode });

    res.redirect(basePath + '/thread/' + req.params.threadId);
  });

  // Reply to thread (manual mode)
  router.post('/thread/:threadId/reply', (req, res) => {
    const basePath = res.locals.basePath;
    const { body } = req.body;

    if (!body || !body.trim()) {
      return res.redirect(basePath + '/thread/' + req.params.threadId);
    }

    // Find the last message in thread to determine the recipient
    const lastMsg = db.prepare(`
      SELECT * FROM messages WHERE thread_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(req.params.threadId);

    if (!lastMsg) {
      return res.status(404).send('Thread not found');
    }

    const toUserId = lastMsg.from_user_id === req.user.id
      ? lastMsg.to_user_id
      : lastMsg.from_user_id;

    const flags = scanMessage(body);

    db.prepare(`
      INSERT INTO messages (thread_id, parent_id, from_user_id, to_user_id, subject, body, sensitivity_flags, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'web')
    `).run(req.params.threadId, lastMsg.id, req.user.id, toUserId, lastMsg.subject, body, JSON.stringify(flags));

    const toName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(toUserId)?.display_name || 'unknown';
    notifyNewMessage({ from: req.user.name, to: toName, subject: lastMsg.subject, body, threadId: req.params.threadId, source: 'web' });

    res.redirect(basePath + '/thread/' + req.params.threadId);
  });

  // Inject message into autonomous conversation (participant only)
  router.post('/thread/:threadId/inject', (req, res) => {
    const basePath = res.locals.basePath;
    const { body } = req.body;

    if (!body || !body.trim()) {
      return res.redirect(basePath + '/thread/' + req.params.threadId);
    }

    // Verify caller is a participant in this thread
    const participant = db.prepare(
      'SELECT 1 FROM messages WHERE thread_id = ? AND (from_user_id = ? OR to_user_id = ?) LIMIT 1'
    ).get(req.params.threadId, req.user.id, req.user.id);
    if (!participant) {
      return res.status(403).send('Not a participant in this thread');
    }

    db.prepare(`
      INSERT INTO message_queue (thread_id, user_id, body)
      VALUES (?, ?, ?)
    `).run(req.params.threadId, req.user.id, body);

    res.redirect(basePath + '/thread/' + req.params.threadId);
  });

  // Cancel queued message (owner only)
  router.post('/thread/:threadId/cancel-queue/:queueId', (req, res) => {
    const basePath = res.locals.basePath;
    db.prepare(
      "UPDATE message_queue SET status = 'cancelled' WHERE id = ? AND thread_id = ? AND user_id = ? AND status = 'pending'"
    ).run(req.params.queueId, req.params.threadId, req.user.id);
    res.redirect(basePath + '/thread/' + req.params.threadId);
  });

  // ── Connections ──

  // Connections page
  router.get('/connections', (req, res) => {
    // Approved connections for the current user
    const connections = db.prepare(`
      SELECT c.*,
        req.display_name AS requester_name, req.email AS requester_email,
        tgt.display_name AS target_name, tgt.email AS target_email
      FROM connections c
      JOIN users req ON c.requester_id = req.id
      JOIN users tgt ON c.target_id = tgt.id
      WHERE c.status = 'approved'
        AND (c.requester_id = ? OR (c.target_id = ? AND c.direction = 'bidirectional'))
      ORDER BY c.created_at DESC
    `).all(req.user.id, req.user.id);

    // Pending requests sent by this user
    const outgoing = db.prepare(`
      SELECT c.*, tgt.display_name AS target_name
      FROM connections c
      JOIN users tgt ON c.target_id = tgt.id
      WHERE c.requester_id = ? AND c.status = 'pending'
      ORDER BY c.created_at DESC
    `).all(req.user.id);

    // Pending requests (admin sees all, users see ones targeting them)
    let incoming = [];
    if (req.user.role === 'admin') {
      incoming = db.prepare(`
        SELECT c.*, req.display_name AS requester_name, req.email AS requester_email,
          tgt.display_name AS target_name
        FROM connections c
        JOIN users req ON c.requester_id = req.id
        JOIN users tgt ON c.target_id = tgt.id
        WHERE c.status = 'pending'
        ORDER BY c.created_at DESC
      `).all();
    } else {
      incoming = db.prepare(`
        SELECT c.*, req.display_name AS requester_name, req.email AS requester_email,
          tgt.display_name AS target_name
        FROM connections c
        JOIN users req ON c.requester_id = req.id
        JOIN users tgt ON c.target_id = tgt.id
        WHERE c.target_id = ? AND c.status = 'pending'
        ORDER BY c.created_at DESC
      `).all(req.user.id);
    }

    // All users (for request form)
    const allUsers = db.prepare('SELECT id, display_name, email FROM users WHERE id != ?').all(req.user.id);

    res.render('connections', {
      user: req.user,
      connections,
      outgoing,
      incoming,
      allUsers,
    });
  });

  // Request a connection
  router.post('/connections/request', (req, res) => {
    const basePath = res.locals.basePath;
    const { targetId, direction, message } = req.body;

    if (!targetId) {
      return res.status(400).send('Target user is required');
    }

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) {
      return res.status(404).send('User not found');
    }

    // Check if connection already exists (either direction)
    const existing = db.prepare(`
      SELECT * FROM connections
      WHERE (requester_id = ? AND target_id = ?) OR (requester_id = ? AND target_id = ?)
    `).get(req.user.id, target.id, target.id, req.user.id);

    if (existing) {
      return res.redirect(basePath + '/connections');
    }

    const dir = direction === 'one-way' ? 'one-way' : 'bidirectional';

    db.prepare(`
      INSERT INTO connections (requester_id, target_id, direction, status, message)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(req.user.id, target.id, dir, message || null);

    notifyConnectionRequest({
      from: req.user.name,
      to: target.display_name,
      direction: dir,
      message: message || null,
    });

    res.redirect(basePath + '/connections');
  });

  // Approve a connection (admin only)
  router.post('/connections/:id/approve', (req, res) => {
    const basePath = res.locals.basePath;
    if (req.user.role !== 'admin') {
      return res.status(403).send('Only admins can approve connections');
    }

    const conn = db.prepare("SELECT * FROM connections WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!conn) {
      return res.status(404).send('Connection request not found');
    }

    db.prepare(`
      UPDATE connections SET status = 'approved', resolved_at = datetime('now'), resolved_by = ?
      WHERE id = ?
    `).run(req.user.id, conn.id);

    const requester = db.prepare('SELECT display_name FROM users WHERE id = ?').get(conn.requester_id);
    const target = db.prepare('SELECT display_name FROM users WHERE id = ?').get(conn.target_id);
    notifyConnectionResolved({
      admin: req.user.name,
      requester: requester?.display_name || 'unknown',
      target: target?.display_name || 'unknown',
      status: 'approved',
    });

    res.redirect(basePath + '/connections');
  });

  // Reject a connection (admin only)
  router.post('/connections/:id/reject', (req, res) => {
    const basePath = res.locals.basePath;
    if (req.user.role !== 'admin') {
      return res.status(403).send('Only admins can reject connections');
    }

    const conn = db.prepare("SELECT * FROM connections WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!conn) {
      return res.status(404).send('Connection request not found');
    }

    db.prepare(`
      UPDATE connections SET status = 'rejected', resolved_at = datetime('now'), resolved_by = ?
      WHERE id = ?
    `).run(req.user.id, conn.id);

    const requester = db.prepare('SELECT display_name FROM users WHERE id = ?').get(conn.requester_id);
    const target = db.prepare('SELECT display_name FROM users WHERE id = ?').get(conn.target_id);
    notifyConnectionResolved({
      admin: req.user.name,
      requester: requester?.display_name || 'unknown',
      target: target?.display_name || 'unknown',
      status: 'rejected',
    });

    res.redirect(basePath + '/connections');
  });

  // Remove a connection (admin or connection participant)
  router.post('/connections/:id/remove', (req, res) => {
    const basePath = res.locals.basePath;
    const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.id);
    if (!conn) {
      return res.status(404).send('Connection not found');
    }

    const isParticipant = conn.requester_id === req.user.id || conn.target_id === req.user.id;
    if (req.user.role !== 'admin' && !isParticipant) {
      return res.status(403).send('Not authorized');
    }

    db.prepare('DELETE FROM connections WHERE id = ?').run(conn.id);
    res.redirect(basePath + '/connections');
  });

  // Setup page
  router.get('/setup', (req, res) => {
    res.render('setup', { user: req.user });
  });

  // Settings page (token management)
  router.get('/settings', (req, res) => {
    const tokens = db.prepare(`
      SELECT id, label, created_at, last_used_at, revoked
      FROM api_tokens WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);

    res.render('settings', { user: req.user, tokens, newToken: null });
  });

  // Generate token (form POST)
  router.post('/settings/generate-token', (req, res) => {
    const label = req.body.label || 'default';
    const plainToken = generateToken();
    const hash = hashToken(plainToken);

    db.prepare(
      'INSERT INTO api_tokens (user_id, token_hash, label) VALUES (?, ?, ?)'
    ).run(req.user.id, hash, label);

    const tokens = db.prepare(`
      SELECT id, label, created_at, last_used_at, revoked
      FROM api_tokens WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);

    res.render('settings', { user: req.user, tokens, newToken: plainToken });
  });

  // Revoke token (form POST)
  router.post('/settings/revoke-token/:id', (req, res) => {
    db.prepare(
      'UPDATE api_tokens SET revoked = 1 WHERE id = ? AND user_id = ?'
    ).run(req.params.id, req.user.id);
    const basePath = res.locals.basePath;
    res.redirect(basePath + '/settings');
  });

  return router;
}

module.exports = { createWebRouter };
