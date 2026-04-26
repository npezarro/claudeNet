const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { initDb } = require('./lib/db');
const { createApiRouter } = require('./lib/routes-api');
const { createWebRouter } = require('./lib/routes-web');

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

// Web dashboard routes (Apache REMOTE_USER auth)
app.use('/', createWebRouter(db));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[ClaudeNet] Listening on 127.0.0.1:${PORT}`);
});
