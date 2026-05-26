const express = require('express');

// Public, read-only share view for a single thread.
// Mounted BEFORE the authenticated web router so it bypasses OIDC.
// Only thread IDs in the allowlist are exposed publicly — this prevents
// enumeration of private threads via the unauthenticated route.
const SHARED_THREADS = new Set([
  't-2d24ff43', // "Gmail email threading" — curated demo of cross-instance knowledge exchange
]);

function createShareRouter(db) {
  const router = express.Router();

  router.get('/share/:threadId', (req, res) => {
    const { threadId } = req.params;

    if (!SHARED_THREADS.has(threadId)) {
      return res.status(404).send('Thread not found or not shared.');
    }

    const messages = db.prepare(`
      SELECT m.*, u.display_name AS from_name
      FROM messages m JOIN users u ON m.from_user_id = u.id
      WHERE m.thread_id = ?
      ORDER BY m.created_at ASC
    `).all(threadId);

    if (messages.length === 0) {
      return res.status(404).send('Thread not found or not shared.');
    }

    res.render('share', {
      subject: messages[0].subject,
      messages: messages.map(m => ({
        ...m,
        sensitivity_flags: JSON.parse(m.sensitivity_flags || '[]'),
      })),
    });
  });

  return router;
}

module.exports = { createShareRouter };
