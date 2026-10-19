'use strict';
/** Real per-server file storage on the panel host: data/servers/<serverId>/ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'data', 'servers');
const MAX_UPLOAD = 300 * 1024 * 1024; // 300 MB per file

const dirOf = (sv) => path.join(ROOT, sv.id);

function ensure(sv) {
  const d = dirOf(sv);
  if (!fs.existsSync(d)) {
    ['plugins', 'mods', 'world', 'logs'].forEach(x => fs.mkdirSync(path.join(d, x), { recursive: true }));
    fs.writeFileSync(path.join(d, 'server.properties'), `motd=${sv.name}\nserver-port=${sv.allocation ? sv.allocation.port : 25565}\nmax-players=20\nonline-mode=true\n`);
    fs.writeFileSync(path.join(d, 'eula.txt'), 'eula=true\n');
  }
  return d;
}

function resolve(sv, rel) {
  const base = ensure(sv);
  const p = path.resolve(base, '.' + path.sep + String(rel || '').replace(/\\/g, '/'));
  if (p !== base && !p.startsWith(base + path.sep)) throw Object.assign(new Error('Invalid path'), { status: 400 });
  return p;
}

function cleanName(n) {
  const b = path.basename(String(n || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  if (!b || b === '.' || b === '..') throw Object.assign(new Error('Invalid file name'), { status: 400 });
  return b.slice(0, 120);
}

function usage(dir) {
  let total = 0;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else try { total += fs.statSync(p).size; } catch (_) {}
  });
  try { walk(dir); } catch (_) {}
  return total;
}

function list(sv, rel) {
  const dir = resolve(sv, rel);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw Object.assign(new Error('Folder not found'), { status: 404 });
  const items = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
    const st = fs.statSync(path.join(dir, e.name));
    return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? null : st.size, modified: st.mtime.toISOString() };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { items, usedBytes: usage(dirOf(sv)) };
}

function wipe(sv) { try { fs.rmSync(dirOf(sv), { recursive: true, force: true }); } catch (_) {} }

module.exports = { MAX_UPLOAD, dirOf, ensure, resolve, cleanName, usage, list, wipe };
