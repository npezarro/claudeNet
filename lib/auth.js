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
      SELECT t.id AS token_id, t.user_id, u.email, u.display_name, u.role
      FROM api_tokens t JOIN users u ON t.user_id = u.id
      WHERE t.token_hash = ? AND t.revoked = 0
    `).get(hash);
    if (!row) {
      return res.status(401).json({ error: 'Invalid or revoked token' });
    }
    db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?")
      .run(row.token_id);
    req.user = { id: row.user_id, email: row.email, name: row.display_name, role: row.role };
    next();
  };
}

function requireRemoteUser(db) {
  return (req, res, next) => {
    const email = req.headers['x-forwarded-user'];
    if (!email) {
      return res.status(401).send('Authentication required');
    }
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      // Auto-create user who passed Apache OIDC (derive display name from email)
      const displayName = email.split('@')[0].replace(/[._]/g, ' ').split(' ')[0].toLowerCase();
      db.prepare(
        "INSERT INTO users (email, display_name, role) VALUES (?, ?, 'user')"
      ).run(email, displayName);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    }
    req.user = { id: user.id, email: user.email, name: user.display_name, role: user.role || 'user' };
    next();
  };
}

module.exports = { requireToken, requireRemoteUser };
