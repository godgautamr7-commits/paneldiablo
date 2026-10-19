'use strict';
/**
 * Diablo Panel Wings — Node Agent
 * Runs on each node machine. Registers with the panel, sends heartbeats,
 * reports system stats and the live status of Minecraft servers it hosts.
 *
 * Config: config.json next to this file (written by `diablo-wings configure`)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');

const CONFIG_PATH = process.env.WINGS_CONFIG || path.join(__dirname, 'config.json');
const VERSION = '1.1.0';

// The node is installed first and connected later: until an admin runs
// `diablo-wings configure ...` (command shown on the node's Configuration tab in
// the panel) there is no config, and Wings simply waits for it.
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return c && c.panelUrl && c.token && c.nodeId ? c : null;
  } catch (e) { return null; }
}

function log(...a) { console.log(`[wings ${new Date().toISOString()}]`, ...a); }

function systemStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    loadAvg: os.loadavg().map(n => Number(n.toFixed(2))),
    memoryTotalMb: Math.round(totalMem / 1048576),
    memoryUsedMb: Math.round((totalMem - freeMem) / 1048576),
    uptimeSec: Math.round(os.uptime())
  };
}

// Check whether a TCP port is open (i.e. a Minecraft server is listening).
function checkPort(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => { if (done) return; done = true; sock.destroy(); resolve(open); };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, ip);
  });
}

async function api(cfg, method, endpoint, body) {
  const res = await fetch(cfg.panelUrl.replace(/\/$/, '') + endpoint, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Node-Token': cfg.token },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status}`);
  return res.json();
}

async function heartbeat(cfg) {
  try {
    await api(cfg, 'POST', '/api/wings/heartbeat', { system: systemStats(), version: VERSION });
    log('heartbeat ok');
  } catch (e) {
    log('heartbeat failed:', e.message);
  }
}

async function reportServers(cfg) {
  // Ask the panel for the servers assigned to this node, then check their ports.
  try {
    const out = await api(cfg, 'GET', `/api/wings/nodes/${encodeURIComponent(cfg.nodeId)}/config`);
    for (const sv of (out.servers || [])) {
      const ip = sv.allocation && sv.allocation.ip ? sv.allocation.ip : '127.0.0.1';
      const port = sv.allocation && sv.allocation.port;
      if (!port) continue;
      const open = await checkPort(ip === '0.0.0.0' ? '127.0.0.1' : ip, port);
      await api(cfg, 'POST', `/api/wings/servers/${sv.id}/status`, {
        status: open ? 'running' : 'offline',
        portOpen: open
      }).catch(() => {});
      log(`server ${sv.name} (${ip}:${port}) -> ${open ? 'running' : 'offline'}`);
    }
  } catch (e) {
    log('server report failed:', e.message);
  }
}

let waitingLogged = false;
async function tick() {
  const cfg = loadConfig();           // re-read every cycle: `configure` takes effect without a restart
  if (!cfg) {
    if (!waitingLogged) { log(`Not configured yet - waiting for ${CONFIG_PATH}. Add this node in the panel (Admin > Nodes) and run the command from its Configuration tab.`); waitingLogged = true; }
    return;
  }
  if (waitingLogged) { log(`Configuration found - connecting to ${cfg.panelUrl} (node ${cfg.nodeId})`); waitingLogged = false; }
  await heartbeat(cfg);
  await reportServers(cfg);
}

log(`Wings ${VERSION} started`);
tick();
setInterval(() => tick().catch(e => log('tick error:', e.message)), 15 * 1000);
