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
const fs = require('fs');
const path = require('path');

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Worker] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught Exception:', err);
  process.exit(1);
});

const API = (process.env.CLAUDENET_URL || 'http://127.0.0.1:3010') + '/api';
const TOKEN = process.env.CLAUDENET_TOKEN;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 30000;
const CONTEXT_FILE = process.env.WORKER_CONTEXT_FILE
  || path.join(process.env.HOME || '', 'worker-context.md');

// Load worker context (re-read each poll cycle so daily updates are picked up)
function loadWorkerContext() {
  try {
    if (fs.existsSync(CONTEXT_FILE)) {
      return fs.readFileSync(CONTEXT_FILE, 'utf-8');
    }
  } catch (err) {
    console.error('[Worker] Failed to read context file:', err.message);
  }
  return '';
}

if (!TOKEN) {
  console.error('CLAUDENET_TOKEN not set');
  process.exit(1);
}

// Track last-seen timestamp per thread to only get new messages
const lastSeen = {};
// Track threads currently being processed to avoid double-replies
const processing = new Set();
// Own identity (resolved at startup via /api/stats)
let selfName = null;

function apiRequest(method, path, body, retries = 10) {
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
        let parsedData;
        try {
          parsedData = JSON.parse(data);
        } catch {
          parsedData = data;
        }
        if (res.statusCode >= 400) {
          console.error(`[Worker] API error: ${method} ${path} returned ${res.statusCode}:`, parsedData);
        }
        resolve({ status: res.statusCode, data: parsedData });
      });
    });

    req.on('error', (err) => {
      if (retries > 0 && (err.code === 'EAI_AGAIN' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED')) {
        console.warn(`[Worker] API request failed (${err.code}), retrying in 2s... (${retries} retries left)`);
        setTimeout(() => {
          apiRequest(method, path, body, retries - 1).then(resolve).catch(reject);
        }, 2000);
      } else {
        reject(err);
      }
    });

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
    try {
      const { status, data: settings } = await apiRequest('GET', `/thread/${threadId}/settings`);
      if (status === 200 && settings && settings.mode === 'autonomous') {
        autonomous.push(threadId);
      }
    } catch (err) {
      console.warn(`[Worker] Failed to get settings for thread ${threadId}:`, err.message);
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
  const context = loadWorkerContext();

  let prompt = `You are participating in a ClaudeNet conversation (thread ${threadId}). `;
  prompt += `You are a Claude instance with deep knowledge of this environment's architecture and patterns. `;
  prompt += `Reply with plain text only. Do not use any tools, commands, or code execution. `;
  prompt += `Draw on the environment context below to give specific, informed answers rather than generic advice. `;
  prompt += `Reference actual stack choices, patterns, and design decisions when relevant. `;
  prompt += `Keep replies focused and helpful. Do not include meta-commentary about being an AI.\n\n`;

  if (context) {
    // Truncate context to avoid overwhelming the prompt (keep under 8k chars)
    const trimmedContext = context.length > 8000 ? context.substring(0, 8000) + '\n...(truncated)' : context;
    prompt += `=== Environment Context ===\n${trimmedContext}\n\n`;
  }

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

  prompt += `=== Your reply ===\nRespond to the latest message in the conversation. Be specific and informed based on the environment context. Be concise.`;
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
    console.log(`[Worker] pollData for ${threadId}:`, JSON.stringify(pollData).substring(0, 500));
    if (!pollData.messages || pollData.messages.length === 0) {
      if (pollData.injections && pollData.injections.length > 0) {
        console.log(`[Worker] Thread ${threadId}: No new messages, but has ${pollData.injections.length} injection(s)`);
      } else {
        processing.delete(threadId);
        return;
      }
    }

    const latestMsg = pollData.messages && pollData.messages.length > 0
      ? pollData.messages[pollData.messages.length - 1]
      : null;

    // Check if the latest message is from us (avoid replying to ourselves)
    if (selfName && latestMsg && latestMsg.from === selfName) {
      // Check if there are injections we should act on
      if (!pollData.injections || pollData.injections.length === 0) {
        processing.delete(threadId);
        return;
      }
      console.log(`[Worker] Thread ${threadId}: Latest message is from us, but has ${pollData.injections.length} injection(s)`);
    }

    const messageCount = pollData.messages ? pollData.messages.length : 0;
    const injectionCount = pollData.injections ? pollData.injections.length : 0;
    console.log(`[Worker] Thread ${threadId}: ${messageCount} messages, ${injectionCount} injections`);

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
    // Resolve own identity on first poll
    if (!selfName) {
      const { data: stats } = await apiRequest('GET', '/stats');
      if (stats.user) {
        selfName = stats.user;
        console.log(`[Worker] Identified as "${selfName}"`);
      }
    }

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
