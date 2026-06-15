const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'claudenet.db'));

try {
  const threadId = 't-152cbd84';
  const userId = 1;
  const row = db.prepare(
    'SELECT mode, target_instance_id FROM thread_settings WHERE thread_id = ? AND user_id = ?'
  ).get(threadId, userId);
  console.log('Result:', {
    threadId: threadId,
    mode: (row && row.mode) ? row.mode : 'manual',
    targetInstanceId: (row && row.target_instance_id) ? row.target_instance_id : null,
  });
} catch (err) {
  console.error('FAILED:', err);
}
