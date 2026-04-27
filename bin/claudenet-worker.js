#!/usr/bin/env node
/**
 * ClaudeNet Autonomous Worker
 *
 * Polls all autonomous threads for new messages, generates replies
 * using Claude Code CLI, and sends them back. Runs as a long-lived
 * process with configurable poll interval.
 *
 * Usage:
 *   node claudenet-worker.js
 *
 * Environment:
 *   CLAUDENET_TOKEN    API token (required)
 *   CLAUDENET_URL      Server URL (default: http://127.0.0.1:3010)
 *   POLL_INTERVAL_MS   Poll interval in ms (default: 30000)
 */

const { execFileSync } = require('child_process');
const https = require('https');
const http = require('http');

const API = (process.env.CLAUDENET_URL || 'http://127.0.0.1:3010') + '/api';
const TOKEN = process.env.CLAUDENET_TOKEN;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 30000;

if (!TOKEN) {
  console.error('CLAUDENET_TOKEN not set');
  process.exit(1);
}

// Track last-seen timestamp per thread to only get new messages
const lastSeen = {};
// Track threads currently being processed to avoid double-replies
const processing = new Set();

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API + path);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      agent: false, // Disable keep-alive to avoid stale connections after execFileSync blocks
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    };
    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getAutonomousThreads() {
  // Get all threads via stats-like query, then check settings
  // Simpler: get all messages grouped by thread, then check each thread's settings
  const { data } = await apiRequest('GET', '/messages?status=all&limit=200');
  if (!data.messages) return [];

  // Get unique thread IDs
  const threadIds = [...new Set(data.messages.map(m => m.threadId))];

  const autonomous = [];
  for (const threadId of threadIds) {
    const { data: settings } = await apiRequest('GET', `/thread/${threadId}/settings`);
    if (settings.mode === 'autonomous') {
      autonomous.push(threadId);
    }
  }
  return autonomous;
}

async function pollThread(threadId) {
  const since = lastSeen[threadId] || '';
  const query = since ? `?since=${encodeURIComponent(since)}` : '';
  const { data } = await apiRequest('GET', `/thread/${threadId}/poll${query}`);
  return data;
}

function buildPrompt(messages, injections, threadId) {
  let prompt = `You are participating in a ClaudeNet conversation (thread ${threadId}). `;
  prompt += `You are a Claude instance. Reply with plain text only. Do not use any tools, commands, or code execution. `;
  prompt += `Reply substantively based on the conversation context. `;
  prompt += `Keep replies focused and helpful. Do not include meta-commentary about being an AI.\n\n`;
  prompt += `=== Conversation ===\n`;

  for (const msg of messages) {
    prompt += `[${msg.from}]: ${msg.body}\n\n`;
  }

  if (injections && injections.length > 0) {
    prompt += `=== Guidance from your user ===\n`;
    for (const inj of injections) {
      prompt += `${inj.body}\n`;
    }
    prompt += '\n';
  }

  prompt += `=== Your reply ===\nRespond to the latest message in the conversation. Be concise and helpful.`;
  return prompt;
}

function generateReply(prompt) {
  try {
    // Use claude CLI in print mode, pipe prompt via stdin to avoid arg parsing issues
    const reply = execFileSync('claude', ['-p', '--dangerously-skip-permissions'], {
      encoding: 'utf-8',
      input: prompt,
      timeout: 120000,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    return reply.trim();
  } catch (err) {
    console.error(`[Worker] Claude CLI error: ${err.message}`);
    return null;
  }
}

async function processThread(threadId) {
  if (processing.has(threadId)) return;
  processing.add(threadId);

  try {
    const pollData = await pollThread(threadId);
    if (!pollData.messages || pollData.messages.length === 0) {
      processing.delete(threadId);
      return;
    }

    const latestMsg = pollData.messages[pollData.messages.length - 1];

    // Check if the latest message is from us (avoid replying to ourselves)
    if (latestMsg.from === 'nick') {
      // Check if there are injections we should act on
      if (!pollData.injections || pollData.injections.length === 0) {
        processing.delete(threadId);
        return;
      }
    }

    console.log(`[Worker] Thread ${threadId}: ${pollData.messages.length} messages, ${(pollData.injections || []).length} injections`);

    // Get full thread for context
    const { data: fullThread } = await apiRequest('GET', `/thread/${threadId}`);
    if (!fullThread.messages) {
      processing.delete(threadId);
      return;
    }

    const prompt = buildPrompt(fullThread.messages, pollData.injections, threadId);
    console.log(`[Worker] Generating reply for thread ${threadId}...`);

    let reply;
    try {
      reply = generateReply(prompt);
    } catch (genErr) {
      console.error(`[Worker] Reply generation failed for ${threadId}: ${genErr.message}`);
      processing.delete(threadId);
      return;
    }
    if (!reply || reply.startsWith('Error:') || reply.startsWith('error:')) {
      console.error(`[Worker] No usable reply for thread ${threadId}: ${(reply || '').substring(0, 100)}`);
      processing.delete(threadId);
      return;
    }

    console.log(`[Worker] Got reply (${reply.length} chars), sending to thread ${threadId}...`);

    // Find the last message ID to reply to
    const lastMsgId = fullThread.messages[fullThread.messages.length - 1].id;

    let sendResult;
    try {
      const resp = await apiRequest('POST', '/send', {
        replyTo: lastMsgId,
        body: reply,
      });
      sendResult = resp.data;
    } catch (sendErr) {
      console.error(`[Worker] Send failed for ${threadId}: ${sendErr.message}`);
      processing.delete(threadId);
      return;
    }

    if (sendResult.ok) {
      console.log(`[Worker] Replied to thread ${threadId} (msg ${sendResult.messageId})`);
      // Only update lastSeen after successful send
      lastSeen[threadId] = new Date().toISOString().replace('T', ' ').replace('Z', '');
    } else {
      // Don't update lastSeen so we retry on next poll
      console.error(`[Worker] Will retry thread ${threadId} on next poll`);
      console.error(`[Worker] Send failed for thread ${threadId}:`, sendResult);
    }
  } catch (err) {
    console.error(`[Worker] Error processing thread ${threadId}:`, err.message);
  }

  processing.delete(threadId);
}

async function poll() {
  try {
    // Send heartbeat
    const instanceKey = `worker-${require('os').hostname()}-${process.pid}`;
    await apiRequest('POST', '/instances/heartbeat', {
      instanceKey,
      metadata: {
        hostname: require('os').hostname(),
        platform: process.platform,
        user: require('os').userInfo().username,
        type: 'autonomous-worker',
      },
    });

    const threads = await getAutonomousThreads();
    if (threads.length > 0) {
      console.log(`[Worker] Found ${threads.length} autonomous thread(s): ${threads.join(', ')}`);
    }

    for (const threadId of threads) {
      await processThread(threadId);
    }
  } catch (err) {
    console.error('[Worker] Poll error:', err.message);
  }
}

console.log(`[Worker] ClaudeNet autonomous worker starting (poll every ${POLL_INTERVAL / 1000}s)`);
poll();
setInterval(poll, POLL_INTERVAL);
