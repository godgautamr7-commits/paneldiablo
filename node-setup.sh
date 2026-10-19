#!/usr/bin/env bash
# ============================================================
#  Diablo Panel — Node setup (Wings)
#
#  Run this on the machine that will host Minecraft servers:
#      sudo bash node-setup.sh              install the node
#      sudo bash node-setup.sh --uninstall  remove it
#
#  This script ONLY installs the node. It does not ask for, or
#  connect to, any panel address or IP. Afterwards, in the panel:
#    Admin > Nodes > Create Node > add IP/ports on the Allocation
#    tab > Configuration tab > Generate Token, then run the shown
#    command on this machine:
#      sudo diablo-wings configure --panel URL --node ID --token TOKEN
# ============================================================
set -u

INSTALL_DIR="${DIABLO_WINGS_DIR:-/opt/diablo-wings}"
SERVICE="diablo-wings"
CLI="/usr/local/bin/diablo-wings"
NODE_MAJOR_REQUIRED=18
NODE_INSTALL_MAJOR=20

G='\033[1;32m'; C='\033[1;36m'; Y='\033[1;33m'; R='\033[1;31m'; W='\033[1;37m'; D='\033[0m'
ok()   { echo -e "${G}✔${D} $*"; }
info() { echo -e "${C}ℹ${D} $*"; }
warn() { echo -e "${Y}⚠${D} $*"; }
err()  { echo -e "${R}✖${D} $*"; }

have() { command -v "$1" >/dev/null 2>&1; }
has_systemd() { have systemctl && [ -d /run/systemd/system ]; }

if [ "$(id -u)" -ne 0 ]; then err "Please run as root:  sudo bash $0"; exit 1; fi

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
node_ok() { have node && have npm && [ "$(node_major)" -ge "$NODE_MAJOR_REQUIRED" ]; }

install_nodejs() {
  if node_ok; then ok "Node.js detected: $(node --version)"; return 0; fi
  if have node; then warn "Node.js $(node --version 2>/dev/null) is too old (need ${NODE_MAJOR_REQUIRED}+) — installing ${NODE_INSTALL_MAJOR}.x"; else info "Node.js not found — installing ${NODE_INSTALL_MAJOR}.x"; fi
  if ! have curl; then
    if have apt-get; then apt-get update -y >/dev/null 2>&1; apt-get install -y curl ca-certificates >/dev/null 2>&1
    elif have dnf; then dnf install -y curl >/dev/null 2>&1
    elif have yum; then yum install -y curl >/dev/null 2>&1
    elif have apk; then apk add --no-cache curl >/dev/null 2>&1
    elif have pacman; then pacman -Sy --noconfirm curl >/dev/null 2>&1; fi
    have curl || { err "curl is required and could not be installed."; return 1; }
  fi
  if have apt-get; then
    apt-get update -y >/dev/null 2>&1
    apt-get install -y ca-certificates gnupg >/dev/null 2>&1
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | bash - >/dev/null 2>&1 || { err "NodeSource setup failed"; return 1; }
    apt-get install -y nodejs >/dev/null 2>&1 || { err "apt-get install nodejs failed"; return 1; }
  elif have dnf || have yum; then
    local pm; pm=$(have dnf && echo dnf || echo yum)
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | bash - >/dev/null 2>&1 || { err "NodeSource setup failed"; return 1; }
    $pm install -y nodejs >/dev/null 2>&1 || { err "$pm install nodejs failed"; return 1; }
  elif have apk; then apk add --no-cache nodejs npm >/dev/null 2>&1 || { err "apk add nodejs failed"; return 1; }
  elif have pacman; then pacman -Sy --noconfirm nodejs npm >/dev/null 2>&1 || { err "pacman install failed"; return 1; }
  else err "Unsupported package manager. Install Node.js ${NODE_MAJOR_REQUIRED}+ manually (https://nodejs.org) and re-run."; return 1; fi
  node_ok && ok "Node.js installed: $(node --version)" || { err "Node.js install finished but no usable node (>=${NODE_MAJOR_REQUIRED}) was found."; return 1; }
}

write_agent() {
  mkdir -p "$INSTALL_DIR"
  cat > "$INSTALL_DIR/wings.js" <<'WINGS_JS_EOF'
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
WINGS_JS_EOF
  cat > "$INSTALL_DIR/package.json" <<'PKG_EOF'
{ "name": "diablo-wings", "version": "1.1.0", "description": "Diablo Panel Wings - node agent", "main": "wings.js", "scripts": { "start": "node wings.js" } }
PKG_EOF
  ok "Wings agent installed in $INSTALL_DIR"
}

write_cli() {
  cat > "$CLI" <<'CLI_EOF'
#!/usr/bin/env bash
# diablo-wings — control the Wings node agent
DIR="__INSTALL_DIR__"
SERVICE="diablo-wings"
has_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }
running() {
  if has_systemd; then systemctl is-active --quiet "$SERVICE"; else [ -f "$DIR/wings.pid" ] && kill -0 "$(cat "$DIR/wings.pid")" 2>/dev/null; fi
}
svc_start() {
  if has_systemd; then systemctl start "$SERVICE"
  else
    running && return 0
    ( cd "$DIR" && nohup node wings.js >> "$DIR/wings.log" 2>&1 < /dev/null & echo $! > "$DIR/wings.pid" )
  fi
}
svc_stop() {
  if has_systemd; then systemctl stop "$SERVICE"
  elif [ -f "$DIR/wings.pid" ]; then kill "$(cat "$DIR/wings.pid")" 2>/dev/null; rm -f "$DIR/wings.pid"; fi
}
usage() {
  cat <<EOF
Usage: diablo-wings <command>
  configure --panel URL --node ID --token TOKEN   connect this node to the panel
  start | stop | restart                          control the agent
  status                                          show state and configuration
  logs                                            follow the agent log
EOF
}

case "${1:-}" in
  configure)
    shift; PANEL=""; NODE=""; TOKEN=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --panel) PANEL="${2:-}"; shift 2 ;;
        --node)  NODE="${2:-}";  shift 2 ;;
        --token) TOKEN="${2:-}"; shift 2 ;;
        *) echo "Unknown option: $1"; usage; exit 1 ;;
      esac
    done
    PANEL="${PANEL%/}"
    if [ -z "$PANEL" ] || [ -z "$NODE" ] || [ -z "$TOKEN" ]; then echo "Missing --panel, --node or --token. Copy the command from the node's Configuration tab in the panel."; exit 1; fi
    [[ "$PANEL" =~ ^https?://[A-Za-z0-9._:-]+$ ]] || { echo "Invalid --panel (expected e.g. https://panel.example.com or http://203.0.113.5:3000)"; exit 1; }
    [[ "$NODE" =~ ^[A-Za-z0-9_-]+$ && "$TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid --node or --token"; exit 1; }
    ( umask 077; P="$PANEL" N="$NODE" T="$TOKEN" node -e '
      const fs=require("fs");
      fs.writeFileSync(process.argv[1], JSON.stringify({panelUrl:process.env.P,nodeId:process.env.N,token:process.env.T,heartbeatInterval:15},null,2)+"\n");
    ' "$DIR/config.json" ) || { echo "Could not write $DIR/config.json"; exit 1; }
    chmod 600 "$DIR/config.json"
    echo "✔ Configuration saved to $DIR/config.json"
    if command -v curl >/dev/null 2>&1; then
      if out=$(curl -fsS --max-time 8 -H "X-Node-Token: $TOKEN" "$PANEL/api/wings/whoami" 2>&1); then echo "✔ Panel accepted the token: $out"
      else echo "⚠ Could not verify with the panel yet ($PANEL). Check the URL, token and firewall — Wings keeps retrying."; fi
    fi
    svc_stop; svc_start
    echo "✔ Wings restarted. The node should show as online in the panel within ~15 seconds."
    ;;
  start)   svc_start && echo "Wings started" ;;
  stop)    svc_stop && echo "Wings stopped" ;;
  restart) svc_stop; svc_start && echo "Wings restarted" ;;
  status)
    if running; then echo "Wings: running"; else echo "Wings: not running"; fi
    if [ -f "$DIR/config.json" ]; then echo "Configured for: $(node -p 'const c=require(process.argv[1]);c.panelUrl+"  (node "+c.nodeId+")"' "$DIR/config.json" 2>/dev/null)"; else echo "Not configured yet — add this node in the panel and run the command from its Configuration tab."; fi
    ;;
  logs)
    if has_systemd; then journalctl -u "$SERVICE" -f -n 50; else tail -n 50 -f "$DIR/wings.log"; fi
    ;;
  *) usage; exit 1 ;;
esac
CLI_EOF
  sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$CLI"
  chmod 755 "$CLI"
  ok "Command installed: diablo-wings"
}

install_service() {
  if has_systemd; then
    cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Diablo Panel Wings (node agent)
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) wings.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE" >/dev/null 2>&1
    ok "systemd service '$SERVICE' enabled (starts on boot)"
  else
    warn "systemd not available — Wings will run in the background with nohup."
  fi
  "$CLI" restart >/dev/null 2>&1
  sleep 1
  if "$CLI" status | grep -q "Wings: running"; then ok "Wings is running and waiting to be connected"; else warn "Wings did not start — run: diablo-wings logs"; fi
}

uninstall() {
  echo -e "\n${W}== Uninstalling Wings ==${D}"
  [ -x "$CLI" ] && "$CLI" stop >/dev/null 2>&1
  if [ -f "/etc/systemd/system/${SERVICE}.service" ]; then
    systemctl disable "$SERVICE" >/dev/null 2>&1
    rm -f "/etc/systemd/system/${SERVICE}.service"; systemctl daemon-reload; ok "Removed systemd service"
  fi
  rm -f "$CLI"
  rm -rf "$INSTALL_DIR" && ok "Removed $INSTALL_DIR"
  ok "Wings uninstalled."
}

if [ "${1:-}" = "--uninstall" ]; then uninstall; exit 0; fi

echo -e "\n${W}== Installing Diablo Panel node (Wings) ==${D}"
install_nodejs || exit 1
write_agent
write_cli
install_service

echo
ok "Node installed!"
echo
info "Next steps (in your panel):"
echo "   1. Admin → Nodes → Create Node, then add the node's IP and ports on the Allocation tab"
echo "   2. Open the node's Configuration tab → Generate Token"
echo "   3. Run the command it shows on THIS machine, e.g.:"
echo -e "      ${W}sudo diablo-wings configure --panel https://your-panel --node <id> --token <token>${D}"
echo
