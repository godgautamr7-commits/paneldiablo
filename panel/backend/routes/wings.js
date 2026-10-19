'use strict';
/**
 * Wings (node agent) facing API.
 * Agents authenticate with a per-node token and report heartbeats,
 * system stats and the status of Minecraft servers they host.
 */
const express = require('express');
const db = require('../lib/db');

const router = express.Router();

function authNode(req, res, next) {
  const token = req.headers['x-node-token'] || (req.body && req.body.token) || req.query.token;
  const s = db.get();
  const node = s.nodes.find(n => n.token === token);
  if (!node) return res.status(401).json({ error: 'Invalid node token' });
  req.node = node;
  next();
}

// Agent -> Panel: validate a token and learn which node it belongs to.
// Read-only: does NOT mark the node online (used by install.sh to verify tokens).
router.get('/whoami', authNode, (req, res) => {
  const n = req.node;
  res.json({ ok: true, node: { id: n.id, name: n.name, fqdn: n.fqdn, ip: n.ip } });
});

// Agent -> Panel: heartbeat + system stats
router.post('/heartbeat', authNode, (req, res) => {
  const s = db.get();
  const node = req.node;
  node.status = 'online';
  node.lastHeartbeat = new Date().toISOString();
  const b = req.body || {};
  if (b.system) node.system = b.system;
  if (b.version) node.daemonVersion = String(b.version).slice(0, 32);
  if (b.allocationsUsed !== undefined) node.allocationsUsed = b.allocationsUsed;
  db.save();
  res.json({ ok: true, node: { id: node.id, name: node.name } });
});

// Agent -> Panel: report status of a server (running/offline + port check)
router.post('/servers/:id/status', authNode, (req, res) => {
  const s = db.get();
  const sv = s.servers.find(x => x.id === req.params.id);
  if (!sv) return res.status(404).json({ error: 'Server not found' });
  const b = req.body || {};
  if (b.status) sv.status = b.status;
  if (b.portOpen !== undefined) sv.portOpen = !!b.portOpen;
  if (b.players !== undefined) sv.players = b.players;
  sv.lastStatusAt = new Date().toISOString();
  db.save();
  res.json({ ok: true });
});

// Agent -> Panel: servers assigned to this node (token required, own node only)
router.get('/nodes/:id/config', authNode, (req, res) => {
  const s = db.get();
  const node = req.node;
  if (node.id !== req.params.id) return res.status(403).json({ error: 'Token does not belong to this node' });
  res.json({
    node: {
      id: node.id, name: node.name, fqdn: node.fqdn, ip: node.ip,
      daemonPort: node.daemonPort, scheme: node.scheme, token: node.token
    },
    servers: s.servers.filter(sv => sv.nodeId === node.id)
  });
});

module.exports = router;
