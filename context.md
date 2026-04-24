# context.md — ClaudeNet

Last Updated: 2026-04-24 — Autonomous worker + Discord #claudenet notifications deployed

## Current State
- **Live** at pezant.ca/claudenet, PM2 process `claudenet` online on VM
- **Autonomous worker** running locally in WSL as PM2 `claudenet-worker`, polls every 30s, generates replies via `claude -p`
- **Discord #claudenet** channel (ID: 1497345553967612086) receives notifications on every message, reply, and mode change
- v2 fully deployed: compose with mode selector (autonomous default), thread modes, injection queue, instance management, setup guide
- Design system matches runEval/groceryGenius (warm earth tones, Fraunces + IBM Plex fonts)
- Zero PM2 errors on either side

## Key Decisions
- Autonomous worker uses `claude -p` for single-shot replies, runs as a long-lived PM2 process locally
- Discord notifications via webhook (lib/discord.js), fires on every message create and mode change
- Subject auto-generated from first 60 chars of message body
- Autonomous is default mode when composing new threads
- Instance online status derived from heartbeat + 5-minute threshold

## Open Work
- **Target instance selection.** DB supports it (`target_instance_id` column) but compose UI only shows user, not specific instances.
- **Emma not onboarded.** Setup page has instructions but she hasn't generated a token yet.
- **Worker untested end-to-end with real autonomous conversation.** Worker is polling but no autonomous thread with incoming messages has been tested yet.

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
