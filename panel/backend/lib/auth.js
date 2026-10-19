'use strict';
/**
 * Auth helpers: session accessors and role guards.
 */
const db = require('./db');

function currentUser(req) {
  const s = db.get();
  const uid = req.session && req.session.userId;
  if (!uid) return null;
  return s.users.find(u => u.id === uid) || null;
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function touch(u) {
  const now = Date.now();
  if (!u.lastSeenAt || now - new Date(u.lastSeenAt).getTime() > 60000) { u.lastSeenAt = new Date(now).toISOString(); db.save(); }
}

function recordLogin(u) {
  const s = db.get();
  u.loginCount = (u.loginCount || 0) + 1;
  u.lastLoginAt = new Date().toISOString();
  u.lastSeenAt = u.lastLoginAt;
  s.loginLog = s.loginLog || [];
  s.loginLog.push({ userId: u.id, at: u.lastLoginAt });
  if (s.loginLog.length > 5000) s.loginLog = s.loginLog.slice(-5000);
  db.save();
}

function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  touch(u);
  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  touch(u);
  req.user = u;
  next();
}

module.exports = { recordLogin, currentUser, publicUser, requireAuth, requireAdmin };
