'use strict';
/**
 * Public node-status API. Every node an admin creates shows up here
 * automatically (pending -> online as soon as Wings sends a heartbeat).
 */
const express = require('express');
const db = require('../lib/db');

const router = express.Router();
const ONLINE_WINDOW_MS = 90 * 1000;
const HISTORY = 48;

function liveStatus(n) {
  if (!n.lastHeartbeat) return 'pending';
  return Date.now() - new Date(n.lastHeartbeat).getTime() <= ONLINE_WINDOW_MS ? 'online' : 'offline';
}

function sample() {
  const s = db.get();
  s.nodes.forEach(n => {
    n.status = liveStatus(n) === 'online' ? 'online' : 'offline';
    n.history = n.history || [];
    n.history.push(liveStatus(n) === 'pending' ? 'none' : n.status === 'online' ? 'up' : 'down');
    if (n.history.length > HISTORY) n.history = n.history.slice(-HISTORY);
  });
  db.save();
}
setInterval(sample, 60 * 1000).unref();

function nodeView(s, n) {
  const hist = (n.history || []);
  const known = hist.filter(h => h !== 'none');
  const up = known.filter(h => h === 'up').length;
  return {
    id: n.id, name: n.name, location: n.location, status: liveStatus(n),
    uptime: known.length ? +(up / known.length * 100).toFixed(2) : null,
    history: Array(Math.max(0, HISTORY - hist.length)).fill('none').concat(hist),
    servers: s.servers.filter(sv => sv.nodeId === n.id).length,
    freePorts: n.allocations.filter(a => !a.assignedTo).length,
    lastHeartbeat: n.lastHeartbeat,
    cpu: n.system && n.system.cpuLoad !== undefined ? n.system.cpuLoad : null
  };
}

router.get('/summary', (req, res) => {
  const s = db.get();
  const nodes = s.nodes.map(n => liveStatus(n));
  res.json({
    nodesTotal: nodes.length, nodesOnline: nodes.filter(x => x === 'online').length,
    serversRunning: s.servers.filter(x => x.status === 'running').length, users: s.users.length,
    usersOnline: s.users.filter(u => u.lastSeenAt && Date.now() - new Date(u.lastSeenAt).getTime() < 5 * 60000).length,
    loginsToday: (s.loginLog || []).filter(l => new Date(l.at).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
    totalLogins: s.users.reduce((a, u) => a + (u.loginCount || 0), 0)
  });
});

router.get('/', (req, res) => {
  const s = db.get();
  const nodes = s.nodes.map(n => nodeView(s, n));
  const online = nodes.filter(n => n.status === 'online').length;
  const ups = nodes.filter(n => n.uptime !== null);
  res.json({
    overall: !nodes.length ? 'none' : online === nodes.length ? 'operational' : online === 0 ? 'outage' : 'degraded',
    nodesOnline: online, nodesTotal: nodes.length,
    uptime: ups.length ? +(ups.reduce((a, n) => a + n.uptime, 0) / ups.length).toFixed(2) : null,
    checkedAt: new Date().toISOString(), nodes
  });
});

module.exports = router;
module.exports.liveStatus = liveStatus;
