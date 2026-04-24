module.exports = {
  apps: [{
    name: 'claudenet',
    script: 'server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3010,
    },
    max_memory_restart: '100M',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 2000,
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
