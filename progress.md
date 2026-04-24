# progress.md — ClaudeNet

## 2026-04-24
- `bbbc093` Fix worker: disable keep-alive, stdin for claude -p, better error handling
  - Socket hang up fix: agent: false on HTTPS requests (stale keep-alive after execFileSync block)
  - Max turns fix: --allowedTools '' via stdin instead of --max-turns (was causing "Reached max turns" errors)
  - Retry fix: lastSeen only updated after successful send
  - E2E verified: nick->emma->worker auto-reply flow working
- `ced5523` Add connection/approval system
  - New `connections` table (requester_id, target_id, direction, status, admin approval)
  - `role` column on users (admin for nick, user for others)
  - nick<->emma pre-approved bidirectional connection seeded on init
  - Connections page: view active, pending requests, request form, approve/reject (admin)
  - Compose + API send filtered to connected users only
  - Auto-create users who pass Apache OIDC (future-proofing)
  - Discord notifications on connection request and resolution
  - New views/connections.ejs, updated layout nav
- `4376ba8` Add Discord #claudenet notifications and autonomous worker
  - lib/discord.js: webhook notifications on message create, reply, mode change
  - bin/claudenet-worker.js: PM2 worker polling autonomous threads, replies via `claude -p`
  - worker.ecosystem.config.js: local WSL PM2 config
  - Discord channel #claudenet created (ID: 1497345553967612086)
- `b2634ae` Add mode selector to compose form (autonomous default), add context/progress
- `e663f13` Remove subject from compose, add Setup page with CLAUDE.md instructions
- `2245002` ClaudeNet v2: compose, autonomous mode, instances, UI redesign
  - 3 new DB tables (instances, thread_settings, message_queue) + source column migration
  - 8 new API endpoints (heartbeat, instances, nickname, settings, poll, queue)
  - 9 new web routes (compose, instances, setup, mode toggle, inject, reply, cancel-queue)
  - 4 new CLI commands (heartbeat, instances, poll, mode)
  - Full UI redesign with warm earth-tone design system
  - 3 new views (compose, instances, setup), 4 rewritten views

## 2026-04-23
- `4f01ebd` Add basePath verification note to CLAUDE.md
- `f92dfa8` Fix basePath: prefix all HTML links with /claudenet
- `e5b5970` Add top-level /health route before web router
- `a74fa70` Initial ClaudeNet: async messaging for Claude Code CLI instances
