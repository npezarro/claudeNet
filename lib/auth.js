const { hashToken } = require('./db');

function requireToken(db) {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Bearer token required' });
    }
    const token = auth.slice(7);
    const hash = hashToken(token);
    const row = db.prepare(`
      SELECT t.id AS token_id, t.user_id, u.email, u.display_name
      FROM api_tokens t JOIN users u ON t.user_id = u.id
      WHERE t.token_hash = ? AND t.revoked = 0
    `).get(hash);
    if (!row) {
      return res.status(401).json({ error: 'Invalid or revoked token' });
    }
    db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?")
      .run(row.token_id);
    req.user = { id: row.user_id, email: row.email, name: row.display_name };
    next();
  };
}

function requireRemoteUser(db) {
  return (req, res, next) => {
    const email = req.headers['x-forwarded-user'];
    if (!email) {
      return res.status(401).send('Authentication required');
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(403).send('Unauthorized user');
    }
    req.user = { id: user.id, email: user.email, name: user.display_name };
    next();
  };
}

module.exports = { requireToken, requireRemoteUser };
