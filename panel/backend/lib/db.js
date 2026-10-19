'use strict';
/**
 * Lightweight JSON datastore with atomic writes.
 * Keeps the whole panel state in a single file so it can run anywhere
 * without native database dependencies.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_STATE = {
  meta: { version: 1, createdAt: new Date().toISOString() },
  users: [],
  nodes: [],
  products: [],
  servers: [],
  plugins: [],
  modpacks: [],
  versions: [],
  transactions: [],
  settings: {
    panelName: 'Diablo Panel',
    currency: 'coins',
    afkRatePerMinute: 5,
    oauth: {
      google: { enabled: false, clientId: '', clientSecret: '' },
      discord: { enabled: false, clientId: '', clientSecret: '' }
    },
    theme: {
      loginBackground: '/assets/img/login-bg.jpg',
      dashboardBackground: '/assets/img/dash-bg.jpg',
      panelBackground: '/assets/img/panel-bg.jpg'
    }
  }
};

let state = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    save();
    return state;
  }
  try {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  // backfill missing keys
  for (const k of Object.keys(DEFAULT_STATE)) {
    if (state[k] === undefined) state[k] = JSON.parse(JSON.stringify(DEFAULT_STATE[k]));
  }
  return state;
}

function save() {
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function get() {
  if (!state) load();
  return state;
}

function id(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(8).toString('hex');
}

module.exports = { load, save, get, id, DB_FILE, DATA_DIR };
