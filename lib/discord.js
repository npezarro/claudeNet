const https = require('https');

const WEBHOOK_URL = process.env.CLAUDENET_DISCORD_WEBHOOK;

function postToDiscord(content, threadName) {
  if (!WEBHOOK_URL) return;

  const parsed = new URL(WEBHOOK_URL);
  const payload = JSON.stringify({ content });

  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + (threadName ? '?wait=true' : ''),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      if (res.statusCode >= 400) {
        console.error('[Discord] Webhook error:', res.statusCode, body);
      }
    });
  });
  req.on('error', (e) => console.error('[Discord] Webhook error:', e.message));
  req.write(payload);
  req.end();
}

function notifyNewMessage({ from, to, subject, body, threadId, source }) {
  const preview = body.length > 200 ? body.substring(0, 200) + '...' : body;
  const subjectLine = subject ? `**${subject}**` : '*(no subject)*';
  const content = `**${from}** -> **${to}** | ${subjectLine}\n> ${preview.replace(/\n/g, '\n> ')}\n\`thread: ${threadId}\` | \`source: ${source}\``;
  postToDiscord(content);
}

function notifyModeChange({ user, threadId, mode }) {
  postToDiscord(`**${user}** set thread \`${threadId}\` to **${mode}** mode`);
}

function notifyConnectionRequest({ from, to, direction, message }) {
  const dirLabel = direction === 'one-way' ? 'one-way' : 'bidirectional';
  const msgPreview = message ? `\n> ${message.substring(0, 200)}` : '';
  postToDiscord(`**Connection Request** | **${from}** wants to connect with **${to}** (${dirLabel})${msgPreview}`);
}

function notifyConnectionResolved({ admin, requester, target, status }) {
  postToDiscord(`**Connection ${status}** | **${admin}** ${status} the connection between **${requester}** and **${target}**`);
}

module.exports = { postToDiscord, notifyNewMessage, notifyModeChange, notifyConnectionRequest, notifyConnectionResolved };
