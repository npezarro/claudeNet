const express = require('express');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { initDb } = require('./lib/db');
const { createApiRouter } = require('./lib/routes-api');
const { createWebRouter } = require('./lib/routes-web');
const { createShareRouter } = require('./lib/routes-share');

const app = express();
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '/claudenet';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Global HTML escaping helper available in all EJS templates
app.locals.escapeHtml = function(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ClaudeNet] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[ClaudeNet] Uncaught Exception:', err);
  process.exit(1);
});

const db = initDb();
console.log('[ClaudeNet] Database initialized');

// Inject basePath into all views
app.use((req, res, next) => {
  res.locals.basePath = BASE_PATH;
  next();
});

// Health check (no auth, top-level for /claudenet/health)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'claudenet', uptime: Math.floor(process.uptime()) });
});

// API routes (Bearer token auth)
app.use('/api', createApiRouter(db));

// Public read-only share route (no auth) — mounted before the web router
// so it bypasses OIDC. Only allowlisted threads are exposed.
app.use('/', createShareRouter(db));

// Web dashboard routes (Apache REMOTE_USER auth)
app.use('/', createWebRouter(db));

function startServer(retries = 10) {
  const srv = http.createServer(app);

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`[ClaudeNet] Port ${PORT} in use, retrying in 2s... (${retries} retries left)`);
      setTimeout(() => {
        try { srv.close(); } catch (e) { /* ignore */ }
        server = startServer(retries - 1);
      }, 2000);
    } else {
      console.error(`[ClaudeNet] Server error (port ${PORT}):`, err);
      process.exit(1);
    }
  });

  srv.listen(PORT, () => {
    console.log(`[ClaudeNet] Listening on port ${PORT}`);
    if (process.send) {
      process.send('ready');
    }
  });

  return srv;
}

let server = startServer();

// Graceful shutdown
function shutdown() {
  console.log('[ClaudeNet] Shutting down...');
  
  // Forcefully close existing connections if they don't close gracefully quickly
  if (typeof server.closeAllConnections === 'function') {
    setTimeout(() => {
      console.log('[ClaudeNet] Forcefully closing remaining connections...');
      server.closeAllConnections();
    }, 2000);
  }

  server.close(() => {
    console.log('[ClaudeNet] Server closed');
    if (db && typeof db.close === 'function') {
      db.close();
      console.log('[ClaudeNet] Database closed');
    }
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error('[ClaudeNet] Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
