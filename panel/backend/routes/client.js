'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const sfs = require('../lib/serverfs');
const inst = require('../lib/installers');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

function serverView(s, sv) {
  const node = s.nodes.find(n => n.id === sv.nodeId);
  const product = s.products.find(p => p.id === sv.productId);
  return {
    ...sv,
    nodeName: node ? node.name : 'unassigned',
    productName: product ? product.name : 'custom',
    ownerName: (s.users.find(u => u.id === sv.ownerId) || {}).username || 'Owner',
    expired: !!(sv.expiresAt && new Date(sv.expiresAt).getTime() < Date.now()),
    databases: sv.databases || [], schedules: sv.schedules || [], subusers: sv.subusers || [], backups: sv.backups || [],
    players: sv.players || { whitelist: [], ops: [], banned: [] }, consoleLog: undefined, activity: undefined,
    address: sv.allocation ? `${sv.allocation.alias || sv.allocation.ip}:${sv.allocation.port}` : '—'
  };
}

// ---------- Nodes (for server placement selection) ----------
router.get('/nodes', (req, res) => {
  const s = db.get();
  res.json({
    nodes: s.nodes.map(n => ({
      id: n.id, name: n.name, ip: n.ip, fqdn: n.fqdn, location: n.location,
      status: n.status,
      freeAllocations: n.allocations.filter(a => !a.assignedTo).length
    }))
  });
});

// ---------- My servers ----------
router.get('/servers', (req, res) => {
  const s = db.get();
  const servers = s.servers.filter(sv => sv.ownerId === req.user.id || (sv.subusers || []).some(u => u.userId === req.user.id)).map(sv => serverView(s, sv));
  res.json({ servers });
});

router.get('/servers/:id', (req, res) => {
  const s = db.get();
  const sv = s.servers.find(x => x.id === req.params.id && (x.ownerId === req.user.id || (x.subusers || []).some(u => u.userId === req.user.id)));
  if (!sv) return res.status(404).json({ error: 'Server not found' });
  res.json({ server: { ...serverView(s, sv), isOwner: sv.ownerId === req.user.id, diskUsedBytes: sfs.usage(sfs.ensure(sv)) } });
});

// ---------- Create server from a product ----------
router.post('/servers', (req, res) => {
  const s = db.get();
  const { name, productId, nodeId, upgradeRam } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const product = s.products.find(p => p.id === productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // pick node
  const { liveStatus } = require('./status');
  const hasFree = (n) => n.allocations.some(a => !a.assignedTo);
  const node = nodeId ? s.nodes.find(n => n.id === nodeId)
    : s.nodes.find(n => liveStatus(n) === 'online' && hasFree(n)) || s.nodes.find(hasFree) || s.nodes[0];
  if (!node) return res.status(400).json({ error: 'No nodes available. Ask an admin to set up a node.' });

  // pick a free allocation
  const alloc = node.allocations.find(a => !a.assignedTo);
  if (!alloc) return res.status(400).json({ error: 'No free allocations on the selected node.' });

  // charge coins for paid products
  if (!product.free && product.price > 0) {
    if ((req.user.coins || 0) < product.price) return res.status(402).json({ error: 'Not enough coins' });
    req.user.coins -= product.price;
    s.transactions.push({
      id: db.id('tx'), userId: req.user.id, type: 'debit', amount: -product.price,
      note: `Purchase: ${product.name}`, balanceAfter: req.user.coins, createdAt: new Date().toISOString()
    });
  }

  if (product.free) {
    const lim = Number((s.settings || {}).freeServerLimit || 2);
    if (s.servers.filter(x => x.ownerId === req.user.id && x.productId && (s.products.find(p => p.id === x.productId) || {}).free).length >= lim) return res.status(403).json({ error: `Free server limit reached (${lim}). Delete one or buy a paid plan.` });
  }
  const ramUpgrade = Number(upgradeRam) || 0;
  const memory = product.memory + ramUpgrade * 1024;
  const expiresAt = product.expiryDays > 0 ? new Date(Date.now() + product.expiryDays * 86400000).toISOString() : null;

  const server = {
    id: db.id('srv'),
    name,
    ownerId: req.user.id,
    nodeId: node.id,
    productId: product.id,
    memory,
    cpu: product.cpu,
    disk: product.disk,
    allocation: { ip: alloc.ip, alias: alloc.alias || '', port: alloc.port, id: alloc.id },
    status: 'offline',
    version: '1.20.4',
    software: 'Paper',
    backups: [],
    modpack: null,
    plugins: [],
    createdAt: new Date().toISOString(),
    expiresAt
  };
  alloc.assignedTo = server.id;
  s.servers.push(server);
  db.save();
  res.json({ server: serverView(s, server) });
});

// ---------- Server power / control ----------
router.post('/servers/:id/power', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const action = (req.body || {}).action;
  if (!['start', 'stop', 'restart', 'kill'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (sv.expiresAt && new Date(sv.expiresAt).getTime() < Date.now()) return res.status(403).json({ error: 'This server has expired' });
  sv.status = action === 'stop' || action === 'kill' ? 'offline' : 'running';
  sv.lastAction = action; sv.lastActionAt = new Date().toISOString();
  db.save(); res.json({ server: serverView(s, sv) });
});

// ---------- One-click plugin install ----------
router.get('/plugins', (req, res) => {
  res.json({ plugins: db.get().plugins });
});

router.post('/servers/:id/plugins', (req, res, next) => pluginInstallRoute(req, res).catch(next));
const pluginInstallRoute = async (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const plugin = s.plugins.find(p => p.id === (req.body || {}).pluginId);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
  const r = await inst.installPlugin(s, sv, plugin);
  if (!r.ok) return res.status(r.lines[0].t.includes('already') ? 409 : 400).json({ error: r.lines[r.lines.length - 1].t.replace(/^[✗•] /, '') });
  act(sv, req.user.username, `installed plugin ${plugin.name}`); db.save();
  res.json({ server: serverView(s, sv), lines: r.lines });
};

router.delete('/servers/:id/plugins/:pluginId', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const rec = sv.plugins.find(p => p.id === req.params.pluginId);
  if (!rec) return res.status(404).json({ error: 'Plugin is not installed' });
  inst.removePlugin(sv, rec); act(sv, req.user.username, `removed plugin ${rec.name}`); db.save();
  res.json({ server: serverView(s, sv) });
});

// ---------- One-click modpack install ----------
router.get('/modpacks', (req, res) => {
  res.json({ modpacks: db.get().modpacks });
});

router.post('/servers/:id/modpack', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const mp = s.modpacks.find(m => m.id === (req.body || {}).modpackId);
  if (!mp) return res.status(404).json({ error: 'Modpack not found' });
  const r = inst.installModpack(s, sv, mp); act(sv, req.user.username, `installed modpack ${mp.name}`); db.save();
  res.json({ server: serverView(s, sv), lines: r.lines });
});
router.delete('/servers/:id/modpack', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const r = inst.removeModpack(sv); if (!r.ok) return res.status(404).json({ error: 'No modpack installed' });
  db.save(); res.json({ server: serverView(s, sv) });
});

router.get('/versions', (req, res) => {
  const vs = db.get().versions.slice().sort((x, y) => inst.cmp(y.version, x.version));
  res.json({ versions: vs, min: inst.MIN_VERSION });
});

router.post('/servers/:id/version', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const { version } = req.body || {};
  if (!version) return res.status(400).json({ error: 'version is required' });
  const r = inst.setVersion(s, sv, version);
  if (!r.ok) return res.status(400).json({ error: r.lines[0].t.replace(/^✗ /, '') });
  act(sv, req.user.username, `changed version to ${version}`); db.save();
  res.json({ server: serverView(s, sv), lines: r.lines });
});

router.get('/store', (req, res) => {
  const s = db.get();
  res.json({
    products: s.products,
    coins: req.user.coins || 0,
    currency: s.settings.currency
  });
});

// ---------- Coins & AFK ----------
router.get('/coins', (req, res) => {
  const s = db.get();
  const txs = s.transactions.filter(t => t.userId === req.user.id).slice(-50).reverse();
  res.json({ coins: req.user.coins || 0, transactions: txs, afkRatePerMinute: s.settings.afkRatePerMinute });
});

router.post('/coins/afk', (req, res) => {
  const s = db.get();
  const rate = s.settings.afkRatePerMinute || 5;
  const now = Date.now();
  const last = req.user.lastAfkAt ? new Date(req.user.lastAfkAt).getTime() : now;
  const minutes = Math.max(0, Math.floor((now - last) / 60000));
  const earned = minutes * rate;
  if (earned > 0) {
    req.user.coins = (req.user.coins || 0) + earned;
    req.user.lastAfkAt = new Date().toISOString();
    s.transactions.push({
      id: db.id('tx'), userId: req.user.id, type: 'credit', amount: earned,
      note: `AFK reward (${minutes} min)`, balanceAfter: req.user.coins, createdAt: new Date().toISOString()
    });
    db.save();
  }
  res.json({ earned, coins: req.user.coins || 0 });
});


// ============================================================
// Pterodactyl-style server management: console, files, backups,
// startup and settings. Plugins install straight from the console.
// ============================================================
const SOFTWARE = ['Paper', 'Purpur', 'Spigot', 'Fabric', 'Forge', 'Vanilla'];
const own = (req, res) => {
  const s = db.get();
  const sv = s.servers.find(x => x.id === req.params.id && (x.ownerId === req.user.id || (x.subusers || []).some(u => u.userId === req.user.id)));
  if (!sv) { res.status(404).json({ error: 'Server not found' }); return {}; }
  sv.software = sv.software || 'Paper'; sv.backups = sv.backups || []; sv.consoleLog = sv.consoleLog || [];
  sv.databases = sv.databases || []; sv.schedules = sv.schedules || []; sv.subusers = sv.subusers || []; sv.activity = sv.activity || [];
  sv.players = sv.players || { whitelist: [], ops: [], banned: [] };
  return { s, sv, isOwner: sv.ownerId === req.user.id };
};
const L = (t, c) => ({ t, c: c || '' });
const stamp = () => new Date().toTimeString().slice(0, 8);
const info = (m) => L(`[${stamp()} INFO]: ${m}`, 't-dim');

router.get('/software', (req, res) => res.json({ software: SOFTWARE }));

router.get('/servers/:id/console', (req, res) => {
  const { sv } = own(req, res); if (!sv) return;
  res.json({ log: sv.consoleLog.slice(-150), status: sv.status });
});

const act = (sv, who, text) => { sv.activity = sv.activity || []; sv.activity.unshift({ at: new Date().toISOString(), who, text }); sv.activity = sv.activity.slice(0, 100); };

const consoleHandler = async (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const raw = String((req.body || {}).command || '').trim().replace(/^\//, '');
  if (!raw) return res.json({ lines: [] });
  const [cmd, sub, ...rest] = raw.split(/\s+/);
  const arg = rest.join(' ');
  const out = [L(`> ${raw}`, 't-cmd')];
  const running = sv.status === 'running';
  const findPlugin = (q) => { q = (q || '').toLowerCase(); return s.plugins.find(p => p.name.toLowerCase() === q) || s.plugins.find(p => p.name.toLowerCase().includes(q)); };
  const c = cmd.toLowerCase(), sb = (sub || '').toLowerCase();

  if (c === 'help') {
    out.push(L('Diablo console commands:', 't-info'),
      L('  start | stop | restart | kill        power actions'),
      L('  plugin search <text>                 search the plugin catalog'),
      L('  plugin install <name> [name2 ...]    install plugins (jars go to /plugins)'),
      L('  plugin remove <name>                 remove an installed plugin'),
      L('  plugin list | plugin info <name>     installed plugins / details'),
      L('  plugin installall <category>         install a whole category'),
      L('  modpack list|install <name>|remove   one-click modpack / mod installer'),
      L('  version [list|set <ver>]             show or change Minecraft version'),
      L('  software [set <Paper|Purpur|...>]    show or change server software'),
      L('  backup create|list                   manage backups'),
      L('  list | say <msg> | status | ip       in-game helpers'),
      L('  clear                                clear this screen'));
  } else if (['start', 'stop', 'restart', 'kill'].includes(c)) {
    if ((c === 'start' || c === 'restart') && sv.expiresAt && new Date(sv.expiresAt).getTime() < Date.now()) out.push(L('✗ This server has expired and cannot be started.', 't-err'));
    else if (c === 'start' && running) out.push(L('Server is already running.', 't-warn'));
    else if (c === 'stop' && !running) out.push(L('Server is already offline.', 't-warn'));
    else {
      if (c !== 'start') out.push(info('Stopping the server...'), info('Saving worlds'), L('Server stopped.', 't-ok'));
      if (c === 'start' || c === 'restart') out.push(info(`Starting Minecraft ${sv.software} ${sv.version}`), info(`Loading ${sv.plugins.length} plugin(s)`), info(`Done! Listening on ${sv.allocation ? (sv.allocation.alias || sv.allocation.ip) + ':' + sv.allocation.port : 'unassigned'}`), L('Server is online.', 't-ok'));
      sv.status = c === 'stop' || c === 'kill' ? 'offline' : 'running';
    }
  } else if (c === 'plugin' || c === 'plugins' || c === 'pl') {
    if (!sub || sb === 'list') {
      out.push(sv.plugins.length ? L(`Installed plugins (${sv.plugins.length}): ` + sv.plugins.map(p => `${p.name} ${p.version}`).join(', '), 't-info') : L('No plugins installed. Try: plugin install EssentialsX', 't-warn'));
    } else if (sb === 'search') {
      const q = arg.toLowerCase();
      const hits = s.plugins.filter(p => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)).slice(0, 15);
      out.push(hits.length ? L(`${hits.length} result(s):`, 't-info') : L('No plugins found.', 't-warn'));
      hits.forEach(p => out.push(L(`  ${p.name.padEnd(18)} ${p.version.padEnd(9)} [${p.category}] ${p.description}`)));
    } else if (sb === 'info') {
      const p = findPlugin(arg);
      out.push(p ? L(`${p.name} ${p.version} — ${p.category}\n${p.description}`, 't-info') : L(`Plugin "${arg}" not found.`, 't-err'));
    } else if (sb === 'install' || sb === 'add' || sb === 'installall') {
      let targets = rest;
      if (sb === 'installall') targets = s.plugins.filter(p => p.category.toLowerCase() === arg.toLowerCase()).map(p => p.name);
      if (!targets.length) out.push(L('Usage: plugin install <name> [name2 ...]', 't-err'));
      let okCount = 0;
      for (const q of targets) {
        const p = findPlugin(q);
        if (!p) { out.push(L(`✗ ${q}: not found in catalog (try "plugin search ${q}")`, 't-err')); continue; }
        const r = await inst.installPlugin(s, sv, p); out.push(...r.lines); if (r.ok) okCount++;
      }
      if (okCount && running) out.push(L('Restart the server to load new plugins.', 't-warn'));
    } else if (sb === 'remove' || sb === 'uninstall' || sb === 'delete') {
      const p = sv.plugins.find(x => x.name.toLowerCase() === arg.toLowerCase());
      if (!p) out.push(L(`"${arg}" is not installed.`, 't-err'));
      else { inst.removePlugin(sv, p); out.push(L(`✓ Removed ${p.name}`, 't-ok')); }
    } else out.push(L('Unknown plugin command. Type "help".', 't-err'));
  } else if (c === 'modpack' || c === 'modpacks' || c === 'mod' || c === 'mods') {
    const findMp = (q) => { q = (q || '').toLowerCase(); return s.modpacks.find(m => m.name.toLowerCase() === q) || s.modpacks.find(m => m.name.toLowerCase().includes(q)); };
    if (!sub || sb === 'list' || sb === 'search') {
      const q = sb === 'search' ? arg.toLowerCase() : '';
      const hits = s.modpacks.filter(m => !q || m.name.toLowerCase().includes(q));
      out.push(L(`Modpacks (${hits.length}):`, 't-info'));
      hits.forEach(m => out.push(L(`  ${m.name.padEnd(24)} ${String(m.loader).padEnd(8)} MC ${m.mcVersion}`)));
      out.push(L(sv.modpack ? `Installed: ${sv.modpack.name}` : 'Installed: none', 't-dim'));
    } else if (sb === 'install' || sb === 'add') {
      const m = findMp(arg);
      if (!m) out.push(L(`✗ Modpack "${arg}" not found (try "modpack list")`, 't-err'));
      else { out.push(...inst.installModpack(s, sv, m).lines); if (running) out.push(L('Restart the server to load the modpack.', 't-warn')); }
    } else if (sb === 'remove' || sb === 'uninstall') {
      out.push(...inst.removeModpack(sv).lines);
    } else out.push(L('Usage: modpack list | install <name> | remove', 't-err'));
  } else if (c === 'version') {
    if (sb === 'list') out.push(L(`Versions (${s.versions.length}): ` + s.versions.map(v => v.version).sort((a, b) => inst.cmp(b, a)).join(', '), 't-info'));
    else if (sb === 'set') out.push(...inst.setVersion(s, sv, arg).lines); else out.push(L(`Running Minecraft ${sv.version} (${sv.software})`, 't-info'));
  } else if (c === 'software') {
    if (sb === 'set') {
      const m = SOFTWARE.find(x => x.toLowerCase() === arg.toLowerCase());
      if (!m) out.push(L('Choose one of: ' + SOFTWARE.join(', '), 't-err')); else out.push(...inst.setSoftware(sv, m).lines);
    } else out.push(L(`Software: ${sv.software}. Available: ${SOFTWARE.join(', ')}`, 't-info'));
  } else if (c === 'backup') {
    if (sb === 'create') { sv.backups.unshift({ id: db.id('bak'), name: `backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`, size: Math.round(40 + Math.random() * 400), createdAt: new Date().toISOString() }); out.push(L('✓ Backup created.', 't-ok')); }
    else out.push(L(sv.backups.length ? sv.backups.map(b => `  ${b.name}  ${b.size} MB`).join('\n') : 'No backups yet.', 't-info'));
  } else if (['op', 'deop', 'ban', 'pardon', 'whitelist'].includes(c)) {
    const P = sv.players, name = (c === 'whitelist' ? rest.join(' ') : sub) || '';
    const map = { op: ['ops', 1], deop: ['ops', 0], ban: ['banned', 1], pardon: ['banned', 0] };
    let key, add;
    if (c === 'whitelist') { key = 'whitelist'; add = sb === 'add'; if (!['add', 'remove'].includes(sb)) { out.push(L('Usage: whitelist add|remove <player>', 't-err')); key = null; } }
    else [key, add] = map[c];
    if (key) {
      if (!name) out.push(L(`Usage: ${c} <player>`, 't-err'));
      else if (add) { if (!P[key].includes(name)) P[key].push(name); out.push(L(`✓ ${name} added to ${key}`, 't-ok')); }
      else { P[key] = P[key].filter(x => x !== name); out.push(L(`✓ ${name} removed from ${key}`, 't-ok')); }
    }
  } else if (c === 'list') out.push(L(running ? 'There are 0 of a max of 20 players online.' : 'Server is offline.', running ? 't-info' : 't-warn'));
  else if (c === 'say') out.push(L(running ? `[Server] ${[sub, ...rest].join(' ')}` : 'Server is offline.', running ? '' : 't-warn'));
  else if (c === 'status') out.push(L(`Status: ${sv.status}  •  ${sv.software} ${sv.version}  •  ${sv.memory} MB RAM  •  ${sv.plugins.length} plugins`, 't-info'));
  else if (c === 'ip') out.push(L(`Connect with: ${sv.allocation ? (sv.allocation.alias || sv.allocation.ip) + ':' + sv.allocation.port : 'unassigned'}`, 't-info'));
  else out.push(running ? L(`Sent to server: ${raw}`, 't-dim') : L(`Unknown command "${cmd}". Type "help".`, 't-err'));

  sv.consoleLog = sv.consoleLog.concat(out).slice(-300);
  act(sv, req.user.username, `ran command: ${raw}`);
  db.save();
  res.json({ lines: out, status: sv.status, server: serverView(s, sv) });
};
router.post('/servers/:id/console', (req, res) => consoleHandler(req, res).catch(e => { console.error('console error', e); if (!res.headersSent) res.status(500).json({ error: 'Console error: ' + e.message }); }));

const fileErr = (res, e) => res.status(e.status || 500).json({ error: e.message || 'File error' });
router.get('/servers/:id/files', (req, res) => {
  const { sv } = own(req, res); if (!sv) return;
  try { const r = sfs.list(sv, req.query.dir || ''); res.json({ ...r, dir: req.query.dir || '', limitBytes: sv.disk * 1024 * 1024, maxUploadBytes: sfs.MAX_UPLOAD }); } catch (e) { fileErr(res, e); }
});
router.post('/servers/:id/files/folder', (req, res) => {
  const { sv } = own(req, res); if (!sv) return;
  try { fs.mkdirSync(path.join(sfs.resolve(sv, (req.body || {}).dir || ''), sfs.cleanName((req.body || {}).name)), { recursive: true }); res.json({ ok: true }); } catch (e) { fileErr(res, e); }
});
router.post('/servers/:id/files/rename', (req, res) => {
  const { sv } = own(req, res); if (!sv) return;
  try {
    const from = sfs.resolve(sv, (req.body || {}).path); const to = path.join(path.dirname(from), sfs.cleanName((req.body || {}).to));
    if (from === sfs.resolve(sv, '')) return res.status(400).json({ error: 'Cannot rename the root' });
    if (fs.existsSync(to)) return res.status(409).json({ error: 'A file with that name already exists' });
    fs.renameSync(from, to); res.json({ ok: true });
  } catch (e) { fileErr(res, e); }
});
router.delete('/servers/:id/files', (req, res) => {
  const { sv } = own(req, res); if (!sv) return;
  try {
    const p = sfs.resolve(sv, req.query.path || ''); if (p === sfs.resolve(sv, '')) return res.status(400).json({ error: 'Cannot delete the root' });
    fs.rmSync(p, { recursive: true, force: true }); res.json({ ok: true });
  } catch (e) { fileErr(res, e); }
});
router.get('/servers/:id/files/download', (req, res) => {
  const { sv } = own(req, res); if (!sv) return;
  try { const p = sfs.resolve(sv, req.query.path || ''); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.status(404).json({ error: 'File not found' }); res.download(p); } catch (e) { fileErr(res, e); }
});
// Raw streamed upload (no memory buffering). Max 300 MB per file, plus the plan's disk quota.
router.post('/servers/:id/files/upload', (req, res) => {
  const { sv } = own(req, res); if (!sv) return;
  const fail = (code, msg) => { res.set('Connection', 'close'); res.status(code).json({ error: msg }); };
  let dest, tmp;
  try { dest = path.join(sfs.resolve(sv, req.query.dir || ''), sfs.cleanName(req.query.name)); } catch (e) { return fail(e.status || 400, e.message); }
  const len = Number(req.headers['content-length'] || 0);
  if (!len) return fail(411, 'Empty upload');
  if (len > sfs.MAX_UPLOAD) return fail(413, 'File too large — maximum is 300 MB per file');
  const used = sfs.usage(sfs.dirOf(sv));
  if (used + len > sv.disk * 1024 * 1024) return fail(507, `Not enough disk space (${fmtMb(used)} of ${fmtMb(sv.disk * 1024 * 1024)} used)`);
  tmp = dest + '.part-' + Date.now();
  const ws = fs.createWriteStream(tmp); let n = 0, dead = false;
  const abort = (code, msg) => { if (dead) return; dead = true; ws.destroy(); fs.rm(tmp, { force: true }, () => {}); fail(code, msg); };
  req.on('data', c => { n += c.length; if (n > sfs.MAX_UPLOAD) abort(413, 'File too large — maximum is 300 MB per file'); });
  req.on('aborted', () => abort(400, 'Upload cancelled'));
  ws.on('error', () => abort(500, 'Could not write the file'));
  ws.on('finish', () => {
    if (dead) return;
    try { fs.renameSync(tmp, dest); } catch (e) { return abort(500, 'Could not save the file'); }
    act(sv, req.user.username, `uploaded ${path.basename(dest)} (${fmtMb(n)})`); db.save();
    res.json({ ok: true, name: path.basename(dest), size: n });
  });
  req.pipe(ws);
});
const fmtMb = (b) => (b / 1048576).toFixed(b >= 1048576 * 10 ? 0 : 1) + ' MB';

router.post('/servers/:id/backups', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  if (sv.backups.length >= 5) return res.status(400).json({ error: 'Backup limit reached (5)' });
  sv.backups.unshift({ id: db.id('bak'), name: (req.body || {}).name || `backup-${Date.now()}`, size: Math.round(40 + Math.random() * 400), createdAt: new Date().toISOString() });
  db.save(); res.json({ server: serverView(s, sv) });
});
router.delete('/servers/:id/backups/:bid', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  sv.backups = sv.backups.filter(b => b.id !== req.params.bid); db.save(); res.json({ server: serverView(s, sv) });
});
router.put('/servers/:id', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const b = req.body || {};
  if (b.name) sv.name = String(b.name).slice(0, 40);
  if (b.software && SOFTWARE.includes(b.software)) { const r = inst.setSoftware(sv, b.software); if (!r.ok) return res.status(400).json({ error: r.lines[0].t.replace(/^✗ /, '') }); }
  if (b.icon !== undefined) { if (b.icon === null || b.icon === '') sv.icon = null; else if (/^data:image\/(png|jpeg|webp);base64,/.test(b.icon) && b.icon.length < 200000) sv.icon = b.icon; else return res.status(400).json({ error: 'Icon must be a PNG/JPEG/WEBP under ~150KB' }); act(sv, req.user.username, 'changed the server icon'); }
  db.save(); res.json({ server: serverView(s, sv) });
});
router.delete('/servers/:id', (req, res) => {
  const { s, sv, isOwner } = own(req, res); if (!sv) return;
  if (!isOwner) return res.status(403).json({ error: 'Only the owner can delete this server' });
  s.nodes.forEach(n => n.allocations.forEach(a => { if (a.assignedTo === sv.id) a.assignedTo = null; }));
  sfs.wipe(sv);
  s.servers = s.servers.filter(x => x.id !== sv.id); db.save(); res.json({ ok: true });
});


// ---------- Redeem coupon ----------
router.post('/coupons/redeem', (req, res) => {
  const s = db.get(); s.coupons = s.coupons || [];
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  const c = s.coupons.find(x => x.code === code);
  if (!c || !c.active) return res.status(404).json({ error: 'Invalid coupon code' });
  if (c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()) return res.status(410).json({ error: 'This coupon has expired' });
  if (c.redemptions.some(r => r.userId === req.user.id)) return res.status(409).json({ error: 'You already used this coupon' });
  if (c.redemptions.length >= c.maxUses) return res.status(410).json({ error: 'This coupon has reached its user limit' });
  c.redemptions.push({ userId: req.user.id, username: req.user.username, at: new Date().toISOString() });
  req.user.coins = (req.user.coins || 0) + c.coins;
  s.transactions.push({ id: db.id('tx'), userId: req.user.id, type: 'credit', amount: c.coins,
    note: `Coupon ${c.code}`, balanceAfter: req.user.coins, createdAt: new Date().toISOString() });
  db.save();
  res.json({ coins: c.coins, balance: req.user.coins });
});


// ---------- Databases ----------
const rnd = (n) => require('crypto').randomBytes(n).toString('hex').slice(0, n);
router.post('/servers/:id/databases', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  if (sv.databases.length >= 2) return res.status(400).json({ error: 'Database limit reached (2)' });
  const nm = String((req.body || {}).name || 'mc').replace(/[^a-z0-9_]/gi, '').slice(0, 16) || 'mc';
  const n = s.nodes.find(x => x.id === sv.nodeId);
  sv.databases.push({ id: db.id('db'), name: `s${sv.id.slice(-4)}_${nm}`, username: `u${rnd(7)}`, password: rnd(20), host: n ? (n.fqdn || n.ip) : '127.0.0.1', port: 3306, createdAt: new Date().toISOString() });
  act(sv, req.user.username, `created database ${nm}`); db.save(); res.json({ server: serverView(s, sv) });
});
router.post('/servers/:id/databases/:did/rotate', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const d = sv.databases.find(x => x.id === req.params.did); if (!d) return res.status(404).json({ error: 'Not found' });
  d.password = rnd(20); db.save(); res.json({ server: serverView(s, sv) });
});
router.delete('/servers/:id/databases/:did', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  sv.databases = sv.databases.filter(x => x.id !== req.params.did); db.save(); res.json({ server: serverView(s, sv) });
});

// ---------- Schedules (really executed by the timer below) ----------
router.post('/servers/:id/schedules', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const b = req.body || {}; const every = Math.floor(Number(b.everyMin));
  if (!b.command || !(every >= 1)) return res.status(400).json({ error: 'Command and interval (minutes) are required' });
  if (sv.schedules.length >= 10) return res.status(400).json({ error: 'Schedule limit reached (10)' });
  sv.schedules.push({ id: db.id('sch'), name: String(b.name || b.command).slice(0, 40), command: String(b.command).slice(0, 200), everyMin: every, enabled: true, lastRun: null, createdAt: new Date().toISOString() });
  act(sv, req.user.username, `created schedule "${b.command}" every ${every}m`); db.save(); res.json({ server: serverView(s, sv) });
});
router.put('/servers/:id/schedules/:sid', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const x = sv.schedules.find(y => y.id === req.params.sid); if (!x) return res.status(404).json({ error: 'Not found' });
  x.enabled = !!(req.body || {}).enabled; db.save(); res.json({ server: serverView(s, sv) });
});
router.delete('/servers/:id/schedules/:sid', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  sv.schedules = sv.schedules.filter(x => x.id !== req.params.sid); db.save(); res.json({ server: serverView(s, sv) });
});
setInterval(() => {
  const s0 = db.get(); let ch = false;
  s0.servers.forEach(sv => { if (sv.expiresAt && new Date(sv.expiresAt).getTime() < Date.now() && sv.status === 'running') { sv.status = 'offline'; ch = true; } });
  if (ch) db.save();
}, 30 * 1000).unref();
setInterval(() => {
  const s = db.get(); const now = Date.now();
  s.servers.forEach(sv => (sv.schedules || []).forEach(sc => {
    if (!sc.enabled) return;
    const last = sc.lastRun ? new Date(sc.lastRun).getTime() : new Date(sc.createdAt).getTime();
    if (now - last < sc.everyMin * 60000) return;
    sc.lastRun = new Date(now).toISOString();
    const owner = s.users.find(u => u.id === sv.ownerId); if (!owner) return;
    consoleHandler({ params: { id: sv.id }, body: { command: sc.command }, user: owner }, { status() { return this; }, json() {} }).catch(e => console.error('schedule error', e.message));
  }));
}, 30 * 1000).unref();

// ---------- Server users (sub-users) ----------
router.post('/servers/:id/subusers', (req, res) => {
  const { s, sv, isOwner } = own(req, res); if (!sv) return;
  if (!isOwner) return res.status(403).json({ error: 'Only the owner can add users' });
  const q = String((req.body || {}).username || '').trim().toLowerCase();
  const u = s.users.find(x => x.username.toLowerCase() === q || (x.email || '').toLowerCase() === q);
  if (!u) return res.status(404).json({ error: 'No panel user with that username or email' });
  if (u.id === sv.ownerId) return res.status(400).json({ error: 'That is the owner' });
  if (sv.subusers.some(x => x.userId === u.id)) return res.status(409).json({ error: 'Already added' });
  sv.subusers.push({ userId: u.id, username: u.username, addedAt: new Date().toISOString() });
  act(sv, req.user.username, `added user ${u.username}`); db.save(); res.json({ server: serverView(s, sv) });
});
router.delete('/servers/:id/subusers/:uid', (req, res) => {
  const { s, sv, isOwner } = own(req, res); if (!sv) return;
  if (!isOwner) return res.status(403).json({ error: 'Only the owner can remove users' });
  sv.subusers = sv.subusers.filter(x => x.userId !== req.params.uid); db.save(); res.json({ server: serverView(s, sv) });
});

// ---------- Players (whitelist / ops / bans) ----------
router.post('/servers/:id/players', (req, res) => {
  const { s, sv } = own(req, res); if (!sv) return;
  const { list, name, remove } = req.body || {};
  if (!['whitelist', 'ops', 'banned'].includes(list) || !String(name || '').trim()) return res.status(400).json({ error: 'list and name required' });
  const n = String(name).trim().slice(0, 16);
  sv.players[list] = remove ? sv.players[list].filter(x => x !== n) : (sv.players[list].includes(n) ? sv.players[list] : sv.players[list].concat(n));
  act(sv, req.user.username, `${remove ? 'removed' : 'added'} ${n} ${remove ? 'from' : 'to'} ${list}`); db.save(); res.json({ server: serverView(s, sv) });
});

router.get('/servers/:id/activity', (req, res) => { const { sv } = own(req, res); if (!sv) return; res.json({ activity: sv.activity }); });
module.exports = router;
