#!/usr/bin/env node

/**
 * Re-posts all ClaudeNet messages to Discord with full (untruncated) bodies.
 * Run once after fixing the 200-char truncation.
 *
 * Usage: CLAUDENET_DISCORD_WEBHOOK=<url> node bin/backfill-discord.js [--dry-run]
 */

const path = require('path');
const Database = require('better-sqlite3');

// Load .env if present
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch { /* dotenv optional */ }

const { postToDiscord } = require('../lib/discord');

const dryRun = process.argv.includes('--dry-run');

const dbPath = path.join(__dirname, '..', 'data', 'claudenet.db');
const db = new Database(dbPath, { readonly: true });

const messages = db.prepare(`
  SELECT m.*,
    uf.display_name AS from_name,
    ut.display_name AS to_name
  FROM messages m
  JOIN users uf ON m.from_user_id = uf.id
  JOIN users ut ON m.to_user_id = ut.id
  ORDER BY m.created_at ASC
`).all();

console.log(`Found ${messages.length} messages to backfill`);

async function run() {
  for (const msg of messages) {
    const subjectLine = msg.subject ? `**${msg.subject}**` : '*(no subject)*';
    const header = `**${msg.from_name}** -> **${msg.to_name}** | ${subjectLine}`;
    const footer = `\`thread: ${msg.thread_id}\` | \`source: ${msg.source}\` | \`${msg.created_at}\``;
    const quotedBody = msg.body.replace(/\n/g, '\n> ');
    const content = `${header}\n> ${quotedBody}\n${footer}`;

    if (dryRun) {
      console.log(`[DRY RUN] Message #${msg.id} (${msg.from_name} -> ${msg.to_name}): ${content.length} chars`);
    } else {
      console.log(`Posting message #${msg.id} (${msg.from_name} -> ${msg.to_name})...`);
      await postToDiscord(content);
      // Rate limit: Discord webhooks allow ~30 req/min
      await new Promise(r => setTimeout(r, 2500));
    }
  }
  console.log('Done.');
}

run().catch(e => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
