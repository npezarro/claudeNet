#!/usr/bin/env bash
set -euo pipefail

# Load deploy config from .env or environment
DEPLOY_HOST="${DEPLOY_HOST:?Set DEPLOY_HOST in .env or environment}"
DEPLOY_USER="${DEPLOY_USER:?Set DEPLOY_USER in .env or environment}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_rsa}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/claudenet}"

VM="$DEPLOY_USER@$DEPLOY_HOST"
SSH="ssh -i $DEPLOY_KEY $VM"

echo "=== Deploying ClaudeNet to $DEPLOY_HOST ==="

# 1. Create dirs on server
$SSH "mkdir -p $DEPLOY_PATH/{data,logs}"

# 2. Sync files
echo "Syncing files..."
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .env --exclude logs --exclude .git \
  -e "ssh -i $DEPLOY_KEY" \
  "$(dirname "$0")/" "$VM:$DEPLOY_PATH/"

# 3. Install deps and restart
echo "Installing deps and restarting PM2..."
$SSH "cd $DEPLOY_PATH && npm install --production && (pm2 delete claudenet 2>/dev/null || true) && pm2 start ecosystem.config.js && pm2 save"

# 4. Verify
echo "Verifying..."
$SSH "pm2 show claudenet | head -20"

echo ""
echo "=== Deployed ==="
echo "Health: curl -s http://127.0.0.1:${PORT:-3010}/api/health"
