'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();
router.use(requireAdmin);

function loginStats(s) {
  const log = s.loginLog || [];
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const today = dayKey(Date.now());
  const days = [];
  for (let i = 6; i >= 0; i--) { const k = dayKey(Date.now() - i * 86400000); days.push({ day: k, logins: log.filter(l => dayKey(l.at) === k).length }); }
  const online = s.users.filter(u => u.lastSeenAt && Date.now() - new Date(u.lastSeenAt).getTime() < 5 * 60000).length;
  return {
    totalLogins: s.users.reduce((a, u) => a + (u.loginCount || 0), 0),
    loginsToday: log.filter(l => dayKey(l.at) === today).length,
    uniqueToday: new Set(log.filter(l => dayKey(l.at) === today).map(l => l.userId)).size,
    onlineNow: online, loginDays: days
  };
}

// ---------- Dashboard stats ----------
router.get('/stats', (req, res) => {
  const s = db.get();
  res.json({
    users: s.users.length,
    clients: s.users.filter(u => u.role === 'client').length,
    nodes: s.nodes.length,
    nodesOnline: s.nodes.filter(n => n.status === 'online').length,
    servers: s.servers.length,
    serversRunning: s.servers.filter(sv => sv.status === 'running').length,
    products: s.products.length,
    coinsInCirculation: s.users.reduce((a, u) => a + (u.coins || 0), 0),
    plugins: s.plugins.length,
    modpacks: s.modpacks.length,
    ...loginStats(s)
  });
});

// ---------- Nodes ----------
router.get('/nodes', (req, res) => {
  const s = db.get();
  const { liveStatus } = require('./status');
  const nodes = s.nodes.map(n => ({
    ...n,
    status: liveStatus(n),
    allocationsUsed: n.allocations.filter(a => a.assignedTo).length,
    allocationsTotal: n.allocations.length,
    servers: s.servers.filter(sv => sv.nodeId === n.id).length
  }));
  res.json({ nodes });
});

router.post('/nodes', (req, res) => {
  const { name, fqdn, ip, daemonPort, scheme, location, memory, disk, description } = req.body || {};
  if (!name || !fqdn) return res.status(400).json({ error: 'name and fqdn are required' });
  const s = db.get();
  const node = {
    id: db.id('node'), name, fqdn,
    description: description || '',
    ip: ip || fqdn,
    daemonPort: Number(daemonPort) || 8080,
    scheme: scheme || 'https',
    location: location || 'Default',
    memory: Number(memory) || 8192,
    disk: Number(disk) || 51200,
    status: 'pending',
    history: [],
    token: db.id('tok'),
    allocations: [],
    createdAt: new Date().toISOString(),
    lastHeartbeat: null
  };
  s.nodes.push(node);
  db.save();
  res.json({ node });
});


// Single node (node page: About / Settings / Configuration / Allocation / Servers)
router.get('/nodes/:id', (req, res) => {
  const s = db.get();
  const n = s.nodes.find(x => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Node not found' });
  const { liveStatus } = require('./status');
  const svs = s.servers.filter(sv => sv.nodeId === n.id);
  res.json({
    node: {
      ...n,
      status: liveStatus(n),
      allocationsUsed: n.allocations.filter(a => a.assignedTo).length,
      allocationsTotal: n.allocations.length,
      memoryAllocated: svs.reduce((a, sv) => a + (sv.memory || 0), 0),
      diskAllocated: svs.reduce((a, sv) => a + (sv.disk || 0), 0)
    },
    servers: svs.map(sv => {
      const o = s.users.find(u => u.id === sv.ownerId);
      return { id: sv.id, name: sv.name, owner: o ? (o.username || o.email) : '—', software: sv.software, version: sv.version, status: sv.status, memory: sv.memory };
    })
  });
});

router.put('/nodes/:id', (req, res) => {
  const s = db.get();
  const node = s.nodes.find(n => n.id === req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const fields = ['name', 'description', 'fqdn', 'ip', 'daemonPort', 'scheme', 'location', 'memory', 'disk'];
  for (const f of fields) if (req.body[f] !== undefined) node[f] = req.body[f];
  if (req.body.daemonPort !== undefined) node.daemonPort = Number(node.daemonPort);
  if (req.body.resetToken) node.token = db.id('tok');
  db.save();
  res.json({ node });
});

router.delete('/nodes/:id', (req, res) => {
  const s = db.get();
  const idx = s.nodes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Node not found' });
  if (s.servers.some(sv => sv.nodeId === req.params.id)) return res.status(409).json({ error: 'Node still has servers attached' });
  s.nodes.splice(idx, 1);
  db.save();
  res.json({ ok: true });
});

// ---------- Allocations (IP + Port) ----------
router.post('/nodes/:id/allocations', (req, res) => {
  const s = db.get();
  const node = s.nodes.find(n => n.id === req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const { ip, port } = req.body || {};
  if (!ip || !port) return res.status(400).json({ error: 'ip and port are required' });
  if (node.allocations.some(a => a.ip === ip && Number(a.port) === Number(port))) {
    return res.status(409).json({ error: 'That IP:port allocation already exists' });
  }
  const alloc = { id: db.id('alloc'), ip, port: Number(port), assignedTo: null };
  node.allocations.push(alloc);
  db.save();
  res.json({ allocation: alloc });
});

router.post('/nodes/:id/allocations/bulk', (req, res) => {
  const s = db.get();
  const node = s.nodes.find(n => n.id === req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const { ip, startPort, endPort } = req.body || {};
  const start = Number(startPort), end = Number(endPort);
  if (!ip || !start || !end || end < start) return res.status(400).json({ error: 'ip, startPort and endPort are required' });
  let created = 0;
  for (let p = start; p <= end; p++) {
    if (!node.allocations.some(a => a.ip === ip && a.port === p)) {
      node.allocations.push({ id: db.id('alloc'), ip, port: p, assignedTo: null });
      created++;
    }
  }
  db.save();
  res.json({ created });
});


// Pterodactyl-style assignment: one IP (+ optional alias) and many ports.
// "ports" accepts single ports and ranges separated by commas / spaces: "25565, 25570-25575"
router.post('/nodes/:id/allocations/assign', (req, res) => {
  const s = db.get();
  const node = s.nodes.find(n => n.id === req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const ip = String((req.body || {}).ip || '').trim();
  const alias = String((req.body || {}).alias || '').trim();
  const ports = String((req.body || {}).ports || '').split(/[\s,]+/).filter(Boolean);
  if (!ip) return res.status(400).json({ error: 'IP address is required' });
  if (!/^[A-Za-z0-9._:-]+$/.test(ip) || (alias && !/^[A-Za-z0-9._-]+$/.test(alias))) return res.status(400).json({ error: 'Invalid IP address or alias' });
  if (!ports.length) return res.status(400).json({ error: 'Enter at least one port or port range' });
  const list = [];
  for (const t of ports) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(t);
    if (!m) return res.status(400).json({ error: `Invalid port or range: ${t}` });
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || b < a) return res.status(400).json({ error: `Invalid port or range: ${t}` });
    for (let p = a; p <= b; p++) list.push(p);
  }
  if (list.length > 1000) return res.status(400).json({ error: 'You can add at most 1000 ports at once' });
  let created = 0, skipped = 0;
  for (const p of list) {
    if (node.allocations.some(x => x.ip === ip && x.port === p)) { skipped++; continue; }
    node.allocations.push({ id: db.id('alloc'), ip, alias, port: p, assignedTo: null });
    created++;
  }
  db.save();
  res.json({ created, skipped });
});

// Mass action: delete the selected free allocations.
router.post('/nodes/:id/allocations/delete', (req, res) => {
  const s = db.get();
  const node = s.nodes.find(n => n.id === req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const ids = new Set(Array.isArray((req.body || {}).ids) ? req.body.ids : []);
  const before = node.allocations.length;
  node.allocations = node.allocations.filter(a => !(ids.has(a.id) && !a.assignedTo));
  db.save();
  res.json({ deleted: before - node.allocations.length });
});

// Set the IP alias of one allocation.
router.put('/nodes/:id/allocations/:allocId', (req, res) => {
  const s = db.get();
  const node = s.nodes.find(n => n.id === req.params.id);
  const a = node && node.allocations.find(x => x.id === req.params.allocId);
  if (!a) return res.status(404).json({ error: 'Allocation not found' });
  const alias = String((req.body || {}).alias || '').trim();
  if (alias && !/^[A-Za-z0-9._-]+$/.test(alias)) return res.status(400).json({ error: 'Invalid alias' });
  a.alias = alias;
  const sv = a.assignedTo && s.servers.find(x => x.id === a.assignedTo);
  if (sv && sv.allocation) sv.allocation.alias = alias;
  db.save();
  res.json({ allocation: a });
});

router.delete('/nodes/:id/allocations/:allocId', (req, res) => {
  const s = db.get();
  const node = s.nodes.find(n => n.id === req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const idx = node.allocations.findIndex(a => a.id === req.params.allocId);
  if (idx === -1) return res.status(404).json({ error: 'Allocation not found' });
  if (node.allocations[idx].assignedTo) return res.status(409).json({ error: 'Allocation is in use' });
  node.allocations.splice(idx, 1);
  db.save();
  res.json({ ok: true });
});

// ---------- Products ----------
router.get('/products', (req, res) => {
  res.json({ products: db.get().products });
});

router.post('/products', (req, res) => {
  const { name, description, memory, cpu, disk, price, free, expiryDays, upgradeOptions } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const s = db.get();
  const product = {
    id: db.id('prod'), name,
    description: description || '',
    memory: Number(memory) || 1024,
    cpu: Number(cpu) || 100,
    disk: Number(disk) || 10240,
    price: Number(price) || 0,
    free: !!free,
    expiryDays: Number(expiryDays) || 30,
    upgradeOptions: Array.isArray(upgradeOptions) ? upgradeOptions.map(Number) : [1, 2, 4, 8],
    createdAt: new Date().toISOString()
  };
  if (product.free) product.price = 0;
  s.products.push(product);
  db.save();
  res.json({ product });
});

router.put('/products/:id', (req, res) => {
  const s = db.get();
  const p = s.products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const fields = ['name', 'description', 'memory', 'cpu', 'disk', 'price', 'free', 'expiryDays', 'upgradeOptions'];
  for (const f of fields) if (req.body[f] !== undefined) p[f] = req.body[f];
  p.memory = Number(p.memory); p.cpu = Number(p.cpu); p.disk = Number(p.disk);
  p.price = Number(p.price); p.expiryDays = Number(p.expiryDays);
  if (p.free) p.price = 0;
  db.save();
  res.json({ product: p });
});

router.delete('/products/:id', (req, res) => {
  const s = db.get();
  const idx = s.products.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Product not found' });
  s.products.splice(idx, 1);
  db.save();
  res.json({ ok: true });
});

// ---------- Users ----------
router.get('/users', (req, res) => {
  const s = db.get();
  res.json({
    users: s.users.map(u => ({
      id: u.id, username: u.username, email: u.email, role: u.role,
      coins: u.coins, provider: u.provider, avatar: u.avatar, createdAt: u.createdAt,
      servers: s.servers.filter(sv => sv.ownerId === u.id).length,
      loginCount: u.loginCount || 0, lastLoginAt: u.lastLoginAt || null, lastSeenAt: u.lastSeenAt || null,
      online: !!(u.lastSeenAt && Date.now() - new Date(u.lastSeenAt).getTime() < 5 * 60000)
    }))
  });
});

router.put('/users/:id', (req, res) => {
  const s = db.get();
  const u = s.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (req.body.role !== undefined) u.role = req.body.role === 'admin' ? 'admin' : 'client';
  if (req.body.username !== undefined) u.username = req.body.username;
  if (req.body.email !== undefined) u.email = req.body.email;
  if (req.body.password) u.passwordHash = bcrypt.hashSync(req.body.password, 10);
  db.save();
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const s = db.get();
  const u = s.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  s.users = s.users.filter(x => x.id !== req.params.id);
  s.servers = s.servers.filter(sv => sv.ownerId !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Coins ----------
router.post('/coins/adjust', (req, res) => {
  const s = db.get();
  const { userId, amount, note } = req.body || {};
  const u = s.users.find(x => x.id === userId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const amt = Number(amount);
  if (!amt) return res.status(400).json({ error: 'amount is required' });
  u.coins = Math.max(0, (u.coins || 0) + amt);
  s.transactions.push({
    id: db.id('tx'), userId: u.id, type: amt > 0 ? 'credit' : 'debit',
    amount: amt, note: note || 'Admin adjustment', by: req.user.id,
    balanceAfter: u.coins, createdAt: new Date().toISOString()
  });
  db.save();
  res.json({ ok: true, coins: u.coins });
});

router.post('/coins/give-all', (req, res) => {
  const s = db.get();
  const amt = Number(req.body && req.body.amount);
  if (!amt) return res.status(400).json({ error: 'amount is required' });
  s.users.forEach(u => {
    u.coins = Math.max(0, (u.coins || 0) + amt);
    s.transactions.push({
      id: db.id('tx'), userId: u.id, type: amt > 0 ? 'credit' : 'debit',
      amount: amt, note: 'Admin give-all', by: req.user.id,
      balanceAfter: u.coins, createdAt: new Date().toISOString()
    });
  });
  db.save();
  res.json({ ok: true, users: s.users.length });
});

router.get('/transactions', (req, res) => {
  const s = db.get();
  const txs = s.transactions.slice(-200).reverse().map(t => ({
    ...t, username: (s.users.find(u => u.id === t.userId) || {}).username || 'unknown'
  }));
  res.json({ transactions: txs });
});

// ---------- Settings ----------
router.get('/settings', (req, res) => {
  const s = db.get();
  const o = s.settings.oauth;
  res.json({
    settings: {
      panelName: s.settings.panelName,
      currency: s.settings.currency,
      afkRatePerMinute: s.settings.afkRatePerMinute,
      theme: s.settings.theme,
      oauth: {
        google: { enabled: o.google.enabled, clientId: o.google.clientId, hasSecret: !!o.google.clientSecret },
        discord: { enabled: o.discord.enabled, clientId: o.discord.clientId, hasSecret: !!o.discord.clientSecret }
      }
    }
  });
});

router.put('/settings', (req, res) => {
  const s = db.get();
  const b = req.body || {};
  if (b.panelName !== undefined) s.settings.panelName = b.panelName;
  if (b.currency !== undefined) s.settings.currency = b.currency;
  if (b.afkRatePerMinute !== undefined) s.settings.afkRatePerMinute = Number(b.afkRatePerMinute);
  if (b.theme) Object.assign(s.settings.theme, b.theme);
  if (b.oauth) {
    for (const name of ['google', 'discord']) {
      if (b.oauth[name]) {
        const src = b.oauth[name];
        if (src.enabled !== undefined) s.settings.oauth[name].enabled = !!src.enabled;
        if (src.clientId !== undefined) s.settings.oauth[name].clientId = src.clientId;
        if (src.clientSecret) s.settings.oauth[name].clientSecret = src.clientSecret;
      }
    }
  }
  db.save();
  res.json({ ok: true });
});

// ---------- Servers (admin view + control) ----------
router.get('/servers', (req, res) => {
  const s = db.get();
  res.json({
    servers: s.servers.map(sv => ({
      ...sv,
      owner: (s.users.find(u => u.id === sv.ownerId) || {}).username || 'unknown',
      node: (s.nodes.find(n => n.id === sv.nodeId) || {}).name || 'unassigned'
    }))
  });
});


// ---------- Coupons (coins with expiry + max users) ----------
const couponView = (c) => ({
  ...c, uses: c.redemptions.length,
  expired: !!(c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()),
  full: c.redemptions.length >= c.maxUses
});
router.get('/coupons', (req, res) => {
  const s = db.get(); s.coupons = s.coupons || [];
  res.json({ coupons: s.coupons.slice().reverse().map(couponView) });
});
router.post('/coupons', (req, res) => {
  const s = db.get(); s.coupons = s.coupons || [];
  const b = req.body || {};
  const coins = Math.floor(Number(b.coins)), maxUses = Math.floor(Number(b.maxUses)), days = Number(b.expiryDays);
  if (!(coins > 0)) return res.status(400).json({ error: 'coins must be greater than 0' });
  if (!(maxUses > 0)) return res.status(400).json({ error: 'max users must be at least 1' });
  const code = (String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '')) ||
    'DIABLO-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  if (s.coupons.some(c => c.code === code)) return res.status(409).json({ error: 'That code already exists' });
  const c = {
    id: db.id('cpn'), code, coins, maxUses, active: true, note: String(b.note || '').slice(0, 80),
    expiresAt: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null,
    createdAt: new Date().toISOString(), redemptions: []
  };
  s.coupons.push(c); db.save();
  res.json({ coupon: couponView(c) });
});
router.put('/coupons/:id', (req, res) => {
  const s = db.get(); const c = (s.coupons || []).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Coupon not found' });
  if (req.body && req.body.active !== undefined) c.active = !!req.body.active;
  db.save(); res.json({ coupon: couponView(c) });
});
router.delete('/coupons/:id', (req, res) => {
  const s = db.get(); s.coupons = (s.coupons || []).filter(x => x.id !== req.params.id);
  db.save(); res.json({ ok: true });
});


// ---------- Catalog management (versions / plugins / modpacks) ----------
router.get('/catalog', (req, res) => { const s = db.get(); res.json({ versions: s.versions, plugins: s.plugins, modpacks: s.modpacks }); });
router.post('/catalog/versions', (req, res) => {
  const s = db.get(); const v = String((req.body || {}).version || '').trim();
  if (!/^\d+\.\d+(\.\d+)?$/.test(v)) return res.status(400).json({ error: 'Version must look like 1.21.9' });
  if (s.versions.some(x => x.version === v)) return res.status(409).json({ error: 'Version already exists' });
  s.versions.push({ id: db.id('ver'), version: v, type: 'release', createdAt: new Date().toISOString() }); db.save(); res.json({ ok: true });
});
router.delete('/catalog/versions/:id', (req, res) => { const s = db.get(); s.versions = s.versions.filter(x => x.id !== req.params.id); db.save(); res.json({ ok: true }); });
router.post('/catalog/plugins', (req, res) => {
  const s = db.get(); const b = req.body || {};
  if (!b.name || !b.version) return res.status(400).json({ error: 'name and version are required' });
  if (s.plugins.some(x => x.name.toLowerCase() === String(b.name).toLowerCase())) return res.status(409).json({ error: 'Plugin already exists' });
  s.plugins.push({ id: db.id('plg'), name: String(b.name).slice(0, 40), category: String(b.category || 'Utility').slice(0, 24), version: String(b.version).slice(0, 20), description: String(b.description || '').slice(0, 200), slug: b.slug ? String(b.slug).toLowerCase() : undefined, createdAt: new Date().toISOString() });
  db.save(); res.json({ ok: true });
});
router.delete('/catalog/plugins/:id', (req, res) => { const s = db.get(); s.plugins = s.plugins.filter(x => x.id !== req.params.id); db.save(); res.json({ ok: true }); });
router.post('/catalog/modpacks', (req, res) => {
  const s = db.get(); const b = req.body || {};
  if (!b.name || !b.mcVersion) return res.status(400).json({ error: 'name and Minecraft version are required' });
  if (!s.versions.some(x => x.version === b.mcVersion)) return res.status(400).json({ error: 'Minecraft version is not in the catalog' });
  if (!['Vanilla', 'Forge', 'Fabric'].includes(b.loader)) return res.status(400).json({ error: 'Loader must be Vanilla, Forge or Fabric' });
  s.modpacks.push({ id: db.id('mp'), name: String(b.name).slice(0, 40), loader: b.loader, mcVersion: b.mcVersion, description: String(b.description || '').slice(0, 200), createdAt: new Date().toISOString() });
  db.save(); res.json({ ok: true });
});
router.delete('/catalog/modpacks/:id', (req, res) => { const s = db.get(); s.modpacks = s.modpacks.filter(x => x.id !== req.params.id); db.save(); res.json({ ok: true }); });

module.exports = router;
