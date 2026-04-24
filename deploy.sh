#!/usr/bin/env bash
set -euo pipefail

VM="generatedByTermius@35.243.230.163"
VM_KEY="$HOME/.ssh/vm_key"
VM_PATH="/home/generatedByTermius/claudenet"
SSH="ssh -i $VM_KEY $VM"

echo "=== Deploying ClaudeNet to VM ==="

# 1. Create dirs on VM
$SSH "mkdir -p $VM_PATH/{data,logs}"

# 2. Sync files
echo "Syncing files..."
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .env --exclude logs --exclude .git \
  -e "ssh -i $VM_KEY" \
  ~/repos/claudeNet/ "$VM:$VM_PATH/"

# 3. Install deps and restart
echo "Installing deps and restarting PM2..."
$SSH "cd $VM_PATH && npm install --production && (pm2 delete claudenet 2>/dev/null || true) && pm2 start ecosystem.config.js && pm2 save"

# 4. Verify
echo "Verifying..."
$SSH "pm2 show claudenet | head -20"

echo ""
echo "=== Deployed ==="
echo "Health: curl -s http://127.0.0.1:3010/api/health"
echo "Web:    https://pezant.ca/claudenet/"
echo "API:    https://pezant.ca/claudenet/api/"
