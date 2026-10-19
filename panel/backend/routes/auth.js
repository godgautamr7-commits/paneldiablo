'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const oauth = require('../lib/oauth');
const { currentUser, publicUser } = require('../lib/auth');

const router = express.Router();

router.get('/me', (req, res) => {
  const u = currentUser(req);
  res.json({ user: publicUser(u) });
});

router.post('/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'username, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const s = db.get();
  if (s.users.some(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already registered' });
  if (s.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Username already taken' });
  const user = {
    id: db.id('usr'), username, email,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'client', coins: 100, provider: 'local', avatar: null,
    createdAt: new Date().toISOString(), lastAfkAt: null
  };
  s.users.push(user);
  db.save();
  req.session.userId = user.id;
  require('../lib/auth').recordLogin(user);
  res.json({ user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const s = db.get();
  const id = String(email).trim().toLowerCase();
  const user = s.users.find(u => u.email.toLowerCase() === id || (u.username || '').toLowerCase() === id);
  if (!user || !user.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.userId = user.id;
  require('../lib/auth').recordLogin(user);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ---- OAuth ----
router.get('/oauth/providers', (req, res) => {
  res.json({
    google: oauth.isEnabled('google'),
    discord: oauth.isEnabled('discord')
  });
});

router.get('/oauth/:provider', (req, res) => {
  const name = req.params.provider;
  if (!oauth.PROVIDERS[name]) return res.status(404).json({ error: 'Unknown provider' });
  if (!oauth.isEnabled(name)) return res.status(400).json({ error: `${name} OAuth is not configured. Add client id/secret in Admin > Settings.` });
  res.redirect(oauth.authorizeUrl(req, name));
});

router.get('/oauth/:provider/callback', async (req, res) => {
  const name = req.params.provider;
  if (!oauth.PROVIDERS[name]) return res.redirect('/login.html?error=unknown_provider');
  try {
    const { code } = req.query;
    if (!code) return res.redirect('/login.html?error=missing_code');
    const token = await oauth.exchangeCode(req, name, code);
    const profile = await oauth.fetchProfile(name, token.access_token);
    const s = db.get();
    let user = s.users.find(u => u.provider === name && u.providerId === profile.providerId);
    if (!user && profile.email) user = s.users.find(u => u.email.toLowerCase() === profile.email.toLowerCase());
    if (!user) {
      user = {
        id: db.id('usr'), username: profile.username || `${name}_user`,
        email: profile.email || `${profile.providerId}@${name}.oauth`,
        passwordHash: null, role: 'client', coins: 100,
        provider: name, providerId: profile.providerId, avatar: profile.avatar,
        createdAt: new Date().toISOString(), lastAfkAt: null
      };
      s.users.push(user);
    } else {
      user.provider = name;
      user.providerId = profile.providerId;
      if (profile.avatar) user.avatar = profile.avatar;
    }
    db.save();
    req.session.userId = user.id;
  require('../lib/auth').recordLogin(user);
    res.redirect('/dashboard.html');
  } catch (e) {
    res.redirect('/login.html?error=oauth_failed');
  }
});

module.exports = router;
