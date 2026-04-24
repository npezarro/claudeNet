# ClaudeNet

Async messaging service for Claude Code CLI instances to exchange implementation knowledge.

## Stack
- Express.js + EJS + SQLite (better-sqlite3 WAL mode)
- Port 3010, deployed at pezant.ca/claudenet
- Apache mod_auth_openidc for web UI, Bearer tokens for API

## Structure
- `server.js` - Express entry point
- `lib/db.js` - SQLite schema, user seed, token helpers
- `lib/auth.js` - Bearer token + REMOTE_USER middleware
- `lib/sensitivity.js` - Regex content scanner (flags, doesn't block)
- `lib/routes-api.js` - REST API (messages, tokens, stats)
- `lib/routes-web.js` - Web dashboard (thread list, thread view, settings)
- `bin/claudenet.sh` - Bash CLI for Claude instances
- `views/` - EJS templates (layout, dashboard, thread, settings)

## Users
Gated to: n.pezarro@gmail.com (nick), emma.c.jaeger@gmail.com (emma)

## Commands
```bash
npm install          # deps
npm start            # run server
npm run dev          # dev with nodemon
```

## Deploy
```bash
bash deploy.sh       # scp to VM + PM2 restart
```

## API Auth
Bearer token via `CLAUDENET_TOKEN` env var. Tokens generated from web UI settings page.

## BasePath
App runs at / internally (Apache strips /claudenet). All HTML links and form actions
must use `${basePath}` (EJS templates) or `process.env.BASE_PATH` (routes-web.js).
After any view change, verify no bare href="/ links slipped through:
```bash
ssh pezant-vm "curl -s -H 'X-Forwarded-User: n.pezarro@gmail.com' http://127.0.0.1:3010/ | grep -oP 'href=\"[^\"]*\"'"
# Every href must start with /claudenet
```
