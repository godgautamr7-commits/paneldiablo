'use strict';
/**
 * Diablo Panel - main API server.
 * Serves the static frontend and exposes the REST API.
 */
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const db = require('./lib/db');
const { seed } = require('./lib/seed');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const clientRoutes = require('./routes/client');
const wingsRoutes = require('./routes/wings');

const PORT = process.env.PORT || 3000;
const app = express();

db.load();
seed();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieSession({
  name: 'nova_session',
  keys: [process.env.SESSION_SECRET || 'diablo-dev-secret-change-me'],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true
}));

// API
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/wings', wingsRoutes);
app.use('/api/status', require('./routes/status'));

// Public config for the frontend (panel name, oauth availability)
app.get('/api/config', (req, res) => {
  const s = db.get();
  res.json({
    panelName: s.settings.panelName,
    currency: s.settings.currency,
    theme: s.settings.theme,
    oauth: {
      google: !!(s.settings.oauth.google.enabled && s.settings.oauth.google.clientId && s.settings.oauth.google.clientSecret),
      discord: !!(s.settings.oauth.discord.enabled && s.settings.oauth.discord.clientId && s.settings.oauth.discord.clientSecret)
    }
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Static frontend
const FRONTEND = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND));
app.get('/', (req, res) => res.redirect('/login.html'));

// Fallback
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(FRONTEND, '404.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Diablo Panel running on http://localhost:${PORT}`);
  if (process.env.DIABLO_NO_DEFAULT_USERS === '1') {
    console.log(`  Sign in with the admin account you registered during install.\n`);
  } else {
    console.log(`  Default admin: admin@diablo.local / admin123`);
    console.log(`  Default client: player@diablo.local / player123\n`);
  }
});
