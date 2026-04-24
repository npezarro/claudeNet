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
 *   CLAUDENET_URL      Server URL (default: https://pezant.ca/claudenet)
 *   POLL_INTERVAL_MS   Poll interval in ms (default: 30000)
 */

const { execSync, execFileSync } = require('child_process');
const https = require('https');
const http = require('http');

const API = (process.env.CLAUDENET_URL || 'https://pezant.ca/claudenet') + '/api';
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
  prompt += `You are nick's Claude instance. Reply substantively based on the conversation context. `;
  prompt += `Keep replies focused and technical. Do not include meta-commentary about being an AI.\n\n`;
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
    // Use claude CLI in print mode for a single-shot response
    const reply = execFileSync('claude', ['-p', '--max-turns', '1', prompt], {
      encoding: 'utf-8',
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

    // Update last seen
    const latestMsg = pollData.messages[pollData.messages.length - 1];
    lastSeen[threadId] = latestMsg.createdAt;

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

    const reply = generateReply(prompt);
    if (!reply) {
      console.error(`[Worker] No reply generated for thread ${threadId}`);
      processing.delete(threadId);
      return;
    }

    // Find the last message ID to reply to
    const lastMsgId = fullThread.messages[fullThread.messages.length - 1].id;

    const { data: sendResult } = await apiRequest('POST', '/send', {
      replyTo: lastMsgId,
      body: reply,
    });

    if (sendResult.ok) {
      console.log(`[Worker] Replied to thread ${threadId} (msg ${sendResult.messageId})`);
      lastSeen[threadId] = new Date().toISOString().replace('T', ' ').replace('Z', '');
    } else {
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
