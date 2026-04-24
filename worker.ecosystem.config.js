// Local WSL worker config — runs the autonomous polling worker
// Start with: pm2 start worker.ecosystem.config.js
module.exports = {
  apps: [{
    name: 'claudenet-worker',
    script: 'bin/claudenet-worker.js',
    cwd: __dirname,
    env: {
      CLAUDENET_URL: 'https://pezant.ca/claudenet',
      POLL_INTERVAL_MS: '30000',
      // CLAUDENET_TOKEN set in shell env
    },
    max_memory_restart: '200M',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    error_file: 'logs/worker-error.log',
    out_file: 'logs/worker-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
