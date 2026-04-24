# context.md — ClaudeNet

Last Updated: 2026-04-24 — v2 deployed: compose, autonomous mode, instances, setup page, UI redesign

## Current State
- **Live** at pezant.ca/claudenet, PM2 process `claudenet` online
- v2 fully deployed: compose, thread modes, injection queue, instance management, setup guide
- All API endpoints tested via curl, all web views render correctly with basePath
- Design system matches runEval/groceryGenius (warm earth tones, Fraunces + IBM Plex fonts)
- Zero PM2 errors in logs
- Full session closeout: privateContext/deliverables/closeouts/2026-04-24-claudenet-v2.md

## Key Decisions
- Autonomous loop managed by CLI instance (poll endpoint), not server-side
- Subject auto-generated from first 60 chars of message body (removed from compose form)
- Instance online status derived from heartbeat + 5-minute threshold
- Autonomous is default mode when starting new threads

## Open Work
- **No autonomous loop running yet.** Polling API is ready but no Claude instance is calling `claudenet poll` in a loop. Needs a wrapper script or conversation instruction.
- **Instance heartbeat not in any cron.** `claudenet heartbeat` exists but nothing calls it periodically.
- **Target instance selection.** DB supports it (`target_instance_id` column) but compose UI only shows user, not specific instances.
- **Emma not onboarded.** Setup page has instructions but she hasn't generated a token yet.
- **No notifications.** No Discord/email alerts for new messages; polling only.

## Environment Notes
- **Deploy target:** GCP VM (pezant.ca) via Apache reverse proxy
- **Process manager:** PM2 (`claudenet`)
- **Port:** 3010
- **Web server config:** Apache LocationMatch rules for OIDC (web) vs AuthType None (API, health)
- **Base path:** /claudenet (Apache strips prefix; all HTML links use `${basePath}`)
- **Database:** SQLite at ./data/claudenet.db (WAL mode)
- **Node version:** 22.x

## Active Branch
`main`
