'use strict';
/**
 * OAuth 2.0 helpers for Google and Discord.
 * If a provider is not configured (no client id/secret) the routes
 * return a clear "not configured" message instead of crashing.
 */
const db = require('./db');

function cfg() {
  return db.get().settings.oauth;
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

const PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scope: 'openid email profile'
  },
  discord: {
    authorize: 'https://discord.com/api/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me',
    scope: 'identify email'
  }
};

function isEnabled(name) {
  const c = cfg()[name];
  return !!(c && c.enabled && c.clientId && c.clientSecret);
}

function redirectUri(req, name) {
  return `${baseUrl(req)}/api/auth/oauth/${name}/callback`;
}

function authorizeUrl(req, name) {
  const p = PROVIDERS[name];
  const c = cfg()[name];
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri(req, name),
    response_type: 'code',
    scope: p.scope
  });
  if (name === 'google') params.set('access_type', 'online');
  return `${p.authorize}?${params.toString()}`;
}

async function exchangeCode(req, name, code) {
  const p = PROVIDERS[name];
  const c = cfg()[name];
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(req, name)
  });
  const res = await fetch(p.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  });
  if (!res.ok) throw new Error('Token exchange failed: ' + res.status);
  return res.json();
}

async function fetchProfile(name, accessToken) {
  const p = PROVIDERS[name];
  const res = await fetch(p.userinfo, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error('Userinfo failed: ' + res.status);
  const data = await res.json();
  if (name === 'google') {
    return { providerId: data.sub, email: data.email, username: data.email ? data.email.split('@')[0] : 'google_user', avatar: data.picture };
  }
  return { providerId: data.id, email: data.email, username: data.username, avatar: data.avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png` : null };
}

module.exports = { isEnabled, authorizeUrl, exchangeCode, fetchProfile, PROVIDERS };
