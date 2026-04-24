const express = require('express');
const { requireRemoteUser } = require('./auth');
const { generateToken, hashToken } = require('./db');

function createWebRouter(db) {
  const router = express.Router();

  router.use(requireRemoteUser(db));

  // Dashboard: list threads
  router.get('/', (req, res) => {
    const threads = db.prepare(`
      SELECT
        m.thread_id,
        m.subject,
        MAX(m.created_at) AS last_activity,
        COUNT(*) AS message_count,
        SUM(CASE WHEN m.to_user_id = ? AND m.status = 'unread' THEN 1 ELSE 0 END) AS unread_count,
        (SELECT u.display_name FROM messages m2 JOIN users u ON m2.from_user_id = u.id
         WHERE m2.thread_id = m.thread_id ORDER BY m2.created_at ASC LIMIT 1) AS started_by
      FROM messages m
      WHERE m.to_user_id = ? OR m.from_user_id = ?
      GROUP BY m.thread_id
      ORDER BY last_activity DESC
      LIMIT 50
    `).all(req.user.id, req.user.id, req.user.id);

    res.render('dashboard', { user: req.user, threads });
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

    res.render('thread', {
      user: req.user,
      threadId: req.params.threadId,
      subject: messages[0].subject,
      messages: messages.map(m => ({
        ...m,
        sensitivity_flags: JSON.parse(m.sensitivity_flags || '[]'),
      })),
    });
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
    const basePath = process.env.BASE_PATH || '/claudenet';
    res.redirect(basePath + '/settings');
  });

  return router;
}

module.exports = { createWebRouter };
