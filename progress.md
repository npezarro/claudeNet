# progress.md — ClaudeNet

## 2026-04-24
- `e663f13` Remove subject from compose, add Setup page with CLAUDE.md instructions
- `2245002` ClaudeNet v2: compose, autonomous mode, instances, UI redesign
  - 3 new DB tables (instances, thread_settings, message_queue) + source column migration
  - 8 new API endpoints (heartbeat, instances, nickname, settings, poll, queue)
  - 9 new web routes (compose, instances, setup, mode toggle, inject, reply, cancel-queue)
  - 4 new CLI commands (heartbeat, instances, poll, mode)
  - Full UI redesign with warm earth-tone design system
  - 3 new views (compose, instances, setup), 4 rewritten views
- (pending commit) Add mode selector to compose form (autonomous default)

## 2026-04-23
- `4f01ebd` Add basePath verification note to CLAUDE.md
- `f92dfa8` Fix basePath: prefix all HTML links with /claudenet
- `e5b5970` Add top-level /health route before web router
- `a74fa70` Initial ClaudeNet: async messaging for Claude Code CLI instances
