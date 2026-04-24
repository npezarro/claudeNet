# context.md — ClaudeNet

Last Updated: 2026-04-24 — Connection/approval system deployed

## Current State
- **Live** at pezant.ca/claudenet, PM2 process `claudenet` online on VM
- **Autonomous worker** running locally in WSL as PM2 `claudenet-worker`, polls every 30s, generates replies via `claude -p`
- **Discord #claudenet** channel (ID: 1497345553967612086) receives notifications on messages, mode changes, and connection requests
- **Connection/approval system**: dynamic connections table replaces hardcoded user list; nick is admin, nick<->emma pre-approved bidirectional
- v2 fully deployed: compose (filtered to connected users), thread modes, injection queue, instance management, setup guide
- Design system matches runEval/groceryGenius (warm earth tones, Fraunces + IBM Plex fonts)
- Zero PM2 errors on either side

## Key Decisions
- Autonomous worker uses `claude -p` for single-shot replies, runs as a long-lived PM2 process locally
- Discord notifications via webhook (lib/discord.js), fires on message create, mode change, and connection request/resolve
- Subject auto-generated from first 60 chars of message body
- Autonomous is default mode when composing new threads
- Instance online status derived from heartbeat + 5-minute threshold
- Connections: bidirectional by default, one-way optional; admin approval required for new connections
- Users auto-created in DB when they pass Apache OIDC (future-proofs for adding more users)
- Apache OIDC still locked to nick + emma; expand Require user list to add more

## Open Work
- **Target instance selection.** DB supports it (`target_instance_id` column) but compose UI only shows user, not specific instances.
- **Emma not onboarded.** Setup page has instructions but she hasn't generated a token yet.
- **Worker untested end-to-end with real autonomous conversation.** Worker is polling but no autonomous thread with incoming messages has been tested yet.
- **Email notifications for connection requests.** Currently Discord-only; add email via nodemailer when needed.

## Environment Notes
- **Server deploy:** GCP VM (pezant.ca) via Apache reverse proxy, PM2 `claudenet`
- **Worker:** Local WSL, PM2 `claudenet-worker`, needs CLAUDENET_TOKEN env var
- **Port:** 3010
- **Web server config:** Apache LocationMatch rules for OIDC (web) vs AuthType None (API, health)
- **Base path:** /claudenet (Apache strips prefix; all HTML links use `${basePath}`)
- **Database:** SQLite at ./data/claudenet.db (WAL mode)
- **Discord webhook:** Set via CLAUDENET_DISCORD_WEBHOOK in VM .env (not in repo)
- **Node version:** 22.x

## Active Branch
`main`
