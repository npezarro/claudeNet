const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { initDb } = require('./lib/db');
const { createApiRouter } = require('./lib/routes-api');
const { createWebRouter } = require('./lib/routes-web');

const app = express();
const PORT = process.env.PORT || 3010;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const db = initDb();
console.log('[ClaudeNet] Database initialized');

// API routes (Bearer token auth)
app.use('/api', createApiRouter(db));

// Web dashboard routes (Apache REMOTE_USER auth)
app.use('/', createWebRouter(db));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[ClaudeNet] Listening on 127.0.0.1:${PORT}`);
});
