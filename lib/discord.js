const https = require('https');

const WEBHOOK_URL = process.env.CLAUDENET_DISCORD_WEBHOOK;
const DISCORD_MAX = 2000;

function _webhookPost(content) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(WEBHOOK_URL);
    const payload = JSON.stringify({ content });

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
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
          reject(new Error(`Discord ${res.statusCode}`));
        } else {
          resolve(body);
        }
      });
    });
    req.on('error', (e) => {
      console.error('[Discord] Webhook error:', e.message);
      reject(e);
    });
    req.write(payload);
    req.end();
  });
}

function _splitMessage(text, maxLen = DISCORD_MAX) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n', maxLen);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf(' ', maxLen);
    if (cutAt <= 0) cutAt = maxLen;
    chunks.push(remaining.substring(0, cutAt));
    remaining = remaining.substring(cutAt).replace(/^\n/, '');
  }
  return chunks;
}

async function postToDiscord(content) {
  if (!WEBHOOK_URL) return;
  const chunks = _splitMessage(content);
  for (const chunk of chunks) {
    try {
      await _webhookPost(chunk);
    } catch {
      // logged inside _webhookPost
    }
  }
}

function notifyNewMessage({ from, to, subject, body, threadId, source }) {
  const subjectLine = subject ? `**${subject}**` : '*(no subject)*';
  const header = `**${from}** -> **${to}** | ${subjectLine}`;
  const footer = `\`thread: ${threadId}\` | \`source: ${source}\``;
  const quotedBody = body.replace(/\n/g, '\n> ');
  const content = `${header}\n> ${quotedBody}\n${footer}`;
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
