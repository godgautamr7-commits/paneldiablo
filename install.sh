#!/usr/bin/env bash
# ============================================================
#  Diablo Panel — Installer / Uninstaller
#  Supports:  Panel (web + API)  and  Wings (node agent, via node-setup.sh)
#
#  Usage:  sudo bash install.sh            (interactive menu)
#          sudo bash install.sh --auto     (panel only, non-interactive)
#
#  --auto installs the panel + admin only (nodes are added from the panel).
#  --auto reads ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD from the
#  environment (a random password is generated and printed if missing).
# ============================================================
set -u

# ---- Colors ----
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'
C='\033[0;36m'; W='\033[1;37m'; D='\033[0m'
ok()   { echo -e "${G}✔${D} $*"; }
info() { echo -e "${C}ℹ${D} $*"; }
warn() { echo -e "${Y}⚠${D} $*"; }
err()  { echo -e "${R}✖${D} $*"; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$ROOT_DIR/panel"
BACKEND_DIR="$PANEL_DIR/backend"
PANEL_PORT="${PANEL_PORT:-}"
PANEL_SERVICE="diablo-panel"
NODE_MAJOR_REQUIRED=18
NODE_INSTALL_MAJOR=20
AUTO=0

# Admin credentials collected by collect_admin (kept in memory only)
ADMIN_FIRST_NAME="${ADMIN_FIRST_NAME:-}"
ADMIN_LAST_NAME="${ADMIN_LAST_NAME:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

banner() {
  echo -e "${G}"
  cat <<'ASCII'
   ____  _       _     _          ____                  _
  |  _ \(_) __ _| |__ | | ___    |  _ \ __ _ _ __   ___| |
  | | | | |/ _` | '_ \| |/ _ \   | |_) / _` | '_ \ / _ \ |
  | |_| | | (_| | |_) | | (_) |  |  __/ (_| | | | |  __/ |
  |____/|_|\__,_|_.__/|_|\___/   |_|   \__,_|_| |_|\___|_|
ASCII
  echo -e "${D}  Minecraft Hosting Panel — Installer\n"
}

# ------------------------------------------------------------
#  Helpers
# ------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

# True only when systemd is actually running as init (not in most containers).
has_systemd() { have systemctl && [ -d /run/systemd/system ]; }

is_root() { [ "$(id -u)" -eq 0 ]; }

need_root() {
  if ! is_root; then
    warn "Not running as root. Installing packages / services may fail."
    info "Re-run with: sudo bash install.sh"
  fi
}

# ask VAR "Prompt" [default]   (non-interactive --auto uses the default)
ask() {
  local __v="$1" __p="$2" __d="${3:-}" __a=""
  if [ "$AUTO" = 1 ]; then printf -v "$__v" '%s' "$__d"; return 0; fi
  if [ -n "$__d" ]; then read -r -p "$__p [$__d]: " __a; else read -r -p "$__p: " __a; fi
  printf -v "$__v" '%s' "${__a:-$__d}"
}

# ask_secret VAR "Prompt"
ask_secret() {
  local __a=""
  read -rs -p "$2: " __a; echo
  printf -v "$1" '%s' "$__a"
}

# confirm "Question" [Y|N]  -> returns 0 for yes
confirm() {
  local q="$1" d="${2:-Y}" a=""
  if [ "$AUTO" = 1 ]; then [ "$d" = "Y" ]; return; fi
  if [ "$d" = "Y" ]; then read -r -p "$q [Y/n] " a; a="${a:-Y}"; else read -r -p "$q [y/N] " a; a="${a:-N}"; fi
  [[ "$a" =~ ^[Yy] ]]
}

# JSON helpers (use Node.js, which is guaranteed present once ensure_node passed)
# jbuild key1 key2 ... : builds {"key1":"$J_key1",...} reading values from env vars J_<key>.
jbuild() {
  node -e 'const o={};for(const k of process.argv.slice(1)){o[k]=process.env["J_"+k]||""}process.stdout.write(JSON.stringify(o))' "$@"
}
# jget FILE path.to.value
jget() {
  node -e 'try{let v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of process.argv[2].split(".")){v=v==null?v:v[k]}process.stdout.write(v==null?"":String(v))}catch(e){}' "$1" "$2"
}

rand_password() { head -c 24 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-16; }

# ------------------------------------------------------------
#  Network helpers
# ------------------------------------------------------------
is_ipv4() {
  local ip="$1" o n
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS=. read -ra o <<<"$ip"
  for n in "${o[@]}"; do [ "$n" -le 255 ] || return 1; done
}

is_private_ip() {
  [[ "$1" =~ ^10\. ]] || [[ "$1" =~ ^192\.168\. ]] || [[ "$1" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] || [[ "$1" =~ ^127\. ]] || [[ "$1" =~ ^169\.254\. ]]
}

local_ips() {
  if have ip; then ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1
  elif have hostname; then hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.'
  fi
}

primary_ip() {
  local ip=""
  if have ip; then ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'); fi
  [ -z "$ip" ] && ip=$(local_ips | grep -v '^127\.' | head -n1)
  echo "${ip:-127.0.0.1}"
}

PUBLIC_IP_CACHE=""; PUBLIC_IP_TRIED=0
public_ip() {
  if [ "$PUBLIC_IP_TRIED" = 1 ]; then [ -n "$PUBLIC_IP_CACHE" ] && echo "$PUBLIC_IP_CACHE"; return; fi
  PUBLIC_IP_TRIED=1
  local ip="" u
  for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -fsS --max-time 4 "$u" 2>/dev/null | tr -d '[:space:]')
    is_ipv4 "$ip" && { PUBLIC_IP_CACHE="$ip"; echo "$ip"; return 0; }
  done
  return 1
}

resolve_host() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1; exit}'; }

ensure_curl() {
  have curl && return 0
  warn "curl not found."
  if is_root && have apt-get; then apt-get update -y >/dev/null 2>&1; apt-get install -y curl ca-certificates >/dev/null 2>&1
  elif is_root && have dnf; then dnf install -y curl >/dev/null 2>&1
  elif is_root && have yum; then yum install -y curl >/dev/null 2>&1; fi
  have curl && ok "curl installed" || { err "Please install curl and re-run."; return 1; }
}

# ------------------------------------------------------------
#  Node.js
# ------------------------------------------------------------
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
node_ok() { have node && have npm && [ "$(node_major)" -ge "$NODE_MAJOR_REQUIRED" ]; }

install_nodejs() {
  echo -e "\n${W}== Installing Node.js ${NODE_INSTALL_MAJOR}.x ==${D}"
  if node_ok; then ok "Node.js already installed: $(node --version) (npm $(npm --version))"; return 0; fi
  if ! is_root; then err "Root is required to install Node.js. Re-run with: sudo bash install.sh"; return 1; fi
  ensure_curl || return 1

  if have apt-get; then
    info "Detected Debian/Ubuntu — using NodeSource…"
    apt-get update -y >/dev/null 2>&1
    apt-get install -y ca-certificates gnupg >/dev/null 2>&1
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | bash - >/dev/null 2>&1 || { err "NodeSource setup failed"; return 1; }
    apt-get install -y nodejs >/dev/null 2>&1 || { err "apt-get install nodejs failed"; return 1; }
  elif have dnf || have yum; then
    info "Detected RHEL/Fedora family — using NodeSource…"
    local pm; pm=$(have dnf && echo dnf || echo yum)
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | bash - >/dev/null 2>&1 || { err "NodeSource setup failed"; return 1; }
    $pm install -y nodejs >/dev/null 2>&1 || { err "$pm install nodejs failed"; return 1; }
  elif have apk; then
    apk add --no-cache nodejs npm >/dev/null 2>&1 || { err "apk add nodejs failed"; return 1; }
  elif have pacman; then
    pacman -Sy --noconfirm nodejs npm >/dev/null 2>&1 || { err "pacman install failed"; return 1; }
  else
    err "Unsupported package manager. Install Node.js ${NODE_MAJOR_REQUIRED}+ manually: https://nodejs.org"
    return 1
  fi

  if node_ok; then ok "Node.js installed: $(node --version) (npm $(npm --version))"; else err "Node.js install finished but a usable node/npm (>=${NODE_MAJOR_REQUIRED}) was not found."; return 1; fi
}

ensure_node() {
  if node_ok; then ok "Node.js detected: $(node --version)"; return 0; fi
  if have node; then warn "Node.js $(node --version 2>/dev/null) is too old (need ${NODE_MAJOR_REQUIRED}+) or npm is missing."; else warn "Node.js not found."; fi
  if confirm "Install Node.js ${NODE_INSTALL_MAJOR}.x now?" Y; then install_nodejs; else
    info "Install Node.js ${NODE_MAJOR_REQUIRED}+ then re-run (menu option: Install Node.js)."; return 1
  fi
}

# ------------------------------------------------------------
#  Panel process control
# ------------------------------------------------------------
panel_env_get() { [ -f "$BACKEND_DIR/.env" ] && grep -E "^$1=" "$BACKEND_DIR/.env" | tail -n1 | cut -d= -f2-; }

load_panel_port() { [ -z "$PANEL_PORT" ] && PANEL_PORT="$(panel_env_get PORT)"; PANEL_PORT="${PANEL_PORT:-3000}"; }

panel_unit_exists() { has_systemd && [ -f "/etc/systemd/system/${PANEL_SERVICE}.service" ]; }

panel_running() {
  if panel_unit_exists; then systemctl is-active --quiet "$PANEL_SERVICE"; return; fi
  [ -f "$BACKEND_DIR/panel.pid" ] && kill -0 "$(cat "$BACKEND_DIR/panel.pid")" 2>/dev/null
}

stop_panel() {
  if panel_unit_exists; then systemctl stop "$PANEL_SERVICE" 2>/dev/null; fi
  if [ -f "$BACKEND_DIR/panel.pid" ]; then kill "$(cat "$BACKEND_DIR/panel.pid")" 2>/dev/null; rm -f "$BACKEND_DIR/panel.pid"; sleep 1; fi
}

start_panel() {
  if panel_unit_exists; then
    systemctl restart "$PANEL_SERVICE"
  else
    (
      cd "$BACKEND_DIR" || exit 1
      set -a; . ./.env; set +a
      nohup node server.js > "$BACKEND_DIR/panel.log" 2>&1 < /dev/null &
      echo $! > "$BACKEND_DIR/panel.pid"
    )
  fi
}

wait_for_panel() {
  load_panel_port
  local i
  for i in $(seq 1 30); do
    curl -fsS --max-time 2 "http://127.0.0.1:$PANEL_PORT/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# ------------------------------------------------------------
#  Admin registration
# ------------------------------------------------------------
# Collect + validate admin credentials (prompts, or env vars in --auto mode).
collect_admin() {
  local fn ln u e p1 p2
  if [ "$AUTO" = 1 ]; then
    ADMIN_FIRST_NAME="${ADMIN_FIRST_NAME:-Admin}"
    ADMIN_LAST_NAME="${ADMIN_LAST_NAME:-User}"
    ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
    ADMIN_EMAIL="${ADMIN_EMAIL:-admin@localhost.local}"
    if [ -z "$ADMIN_PASSWORD" ]; then
      ADMIN_PASSWORD="$(rand_password)"
      warn "Generated admin password: ${W}${ADMIN_PASSWORD}${D}  (save it now!)"
    fi
    return 0
  fi

  echo
  info "Register the administrator account."
  while :; do
    ask fn "First name" "${ADMIN_FIRST_NAME:-}"
    [ -n "$fn" ] && [ "${#fn}" -le 50 ] && break
    err "First name is required (max 50 chars)."
  done
  while :; do
    ask ln "Last name" "${ADMIN_LAST_NAME:-}"
    [ -n "$ln" ] && [ "${#ln}" -le 50 ] && break
    err "Last name is required (max 50 chars)."
  done
  while :; do
    ask u "Admin username (3-32 chars: letters, numbers, _ . -)" "${ADMIN_USERNAME:-admin}"
    [[ "$u" =~ ^[A-Za-z0-9_.-]{3,32}$ ]] && break
    err "Invalid username."
  done
  while :; do
    ask e "Admin email" "${ADMIN_EMAIL:-}"
    [[ "$e" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] && break
    err "Invalid email address."
  done
  while :; do
    ask_secret p1 "Admin password (min 8 chars)"
    if [ "${#p1}" -lt 8 ]; then err "Password must be at least 8 characters."; continue; fi
    ask_secret p2 "Confirm password"
    [ "$p1" = "$p2" ] && break
    err "Passwords do not match."
  done
  ADMIN_FIRST_NAME="$fn"; ADMIN_LAST_NAME="$ln"; ADMIN_USERNAME="$u"; ADMIN_EMAIL="$e"; ADMIN_PASSWORD="$p1"
}

# Writes the admin account into the panel database.
# The panel keeps its DB in memory, so it is stopped while we write.
register_admin_account() {
  if [ ! -d "$BACKEND_DIR/node_modules" ]; then
    info "Installing backend dependencies first…"
    ( cd "$BACKEND_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 ) || { err "npm install failed"; return 1; }
  fi
  local was_running=0 out rc
  panel_running && was_running=1
  [ "$was_running" = 1 ] && stop_panel
  out=$( cd "$BACKEND_DIR" && ADMIN_FIRST_NAME="$ADMIN_FIRST_NAME" ADMIN_LAST_NAME="$ADMIN_LAST_NAME" ADMIN_USERNAME="$ADMIN_USERNAME" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" node lib/create-admin.js 2>&1 ); rc=$?
  if [ "$was_running" = 1 ]; then
    start_panel
    wait_for_panel && ok "Panel restarted" || warn "Panel did not come back up — check the panel log."
  fi
  if [ $rc -eq 0 ]; then ok "$out"; else err "$out"; return 1; fi
}

# Menu option: register (or reset) an admin account on an installed panel.
register_admin() {
  echo -e "\n${W}== Register Admin Account ==${D}"
  ensure_node || return 1
  collect_admin || return 1
  if register_admin_account; then
    load_panel_port
    info "Sign in at: http://$(primary_ip):$PANEL_PORT/login.html  (email or username + your password)"
  fi
}

# ------------------------------------------------------------
#  Panel domain + reverse proxy (nginx) + optional HTTPS
# ------------------------------------------------------------
PANEL_DOMAIN=""
PANEL_PUBLIC_URL=""

pkg_install() {
  is_root || { err "Root is required to install packages."; return 1; }
  if have apt-get; then apt-get update -y >/dev/null 2>&1; apt-get install -y "$@" >/dev/null 2>&1
  elif have dnf; then dnf install -y "$@" >/dev/null 2>&1
  elif have yum; then yum install -y "$@" >/dev/null 2>&1
  else return 1; fi
}

# Writes /etc/nginx/conf.d/diablo-panel.conf proxying everything (incl. /api) to the panel.
setup_nginx() {
  local domain="$1" v6=""
  [ -f /proc/net/if_inet6 ] && [ -z "$(sysctl -n net.ipv6.conf.all.disable_ipv6 2>/dev/null | grep -x 1)" ] && v6="    listen [::]:80;"
  have nginx || { info "Installing nginx…"; pkg_install nginx || { err "Could not install nginx."; return 1; }; }
  # Disable the distro's stock "Welcome to nginx" site (Debian/Ubuntu) so it cannot shadow the panel.
  [ -L /etc/nginx/sites-enabled/default ] && rm -f /etc/nginx/sites-enabled/default
  cat > /etc/nginx/conf.d/diablo-panel.conf <<NGINXCONF
server {
    listen 80;
$v6
    server_name $domain;

    location / {
        proxy_pass http://127.0.0.1:$PANEL_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        client_max_body_size 100m;
    }
}
NGINXCONF
  if nginx -t >/dev/null 2>&1; then
    if has_systemd; then systemctl enable nginx >/dev/null 2>&1; systemctl restart nginx; else nginx -s reload 2>/dev/null || nginx; fi
    ok "nginx reverse proxy configured for $domain → 127.0.0.1:$PANEL_PORT"
  else
    err "nginx config test failed:"; nginx -t 2>&1 | tail -5; return 1
  fi
}

setup_https() {
  local domain="$1" email="$2"
  have certbot || { info "Installing certbot…"; pkg_install certbot python3-certbot-nginx || { warn "Could not install certbot."; return 1; }; }
  if certbot --nginx -d "$domain" -m "$email" --agree-tos --non-interactive --redirect >/tmp/certbot.log 2>&1; then
    ok "HTTPS enabled for $domain (Let's Encrypt)"; return 0
  fi
  warn "certbot failed — staying on HTTP. Details: /tmp/certbot.log"; return 1
}

# Checks the public path really reaches the panel API (catches the "404 on login" case).
verify_panel_route() {
  local url="$1" code body
  body="$(mktemp)"
  curl -fsS --max-time 10 -k "$url/api/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true' || { rm -f "$body"; return 1; }
  code=$(curl -sS --max-time 10 -k -o "$body" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"email":"x","password":"x"}' "$url/api/auth/login" 2>/dev/null)
  rm -f "$body"
  [ "$code" = "401" ]   # panel answered with JSON "invalid credentials" → API is routed correctly
}

# Asks for the panel domain; sets PANEL_DOMAIN / PANEL_PUBLIC_URL.
setup_panel_domain() {
  local d res lips pub email
  PANEL_PUBLIC_URL="http://$(primary_ip):$PANEL_PORT"
  if [ "$AUTO" = 1 ]; then d="${PANEL_DOMAIN_INPUT:-}"; else ask d "Panel domain (e.g. panel.example.com) — leave empty to use the server IP" ""; fi
  [ -z "$d" ] && return 0
  d="$(echo "$d" | sed -E 's#^https?://##; s#/.*$##')"
  if ! [[ "$d" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]]; then err "'$d' is not a valid domain — continuing with the server IP."; return 0; fi

  res="$(resolve_host "$d")"; lips="$(local_ips)"; pub="$(public_ip || true)"
  if [ -z "$res" ]; then
    err "$d does not resolve yet. Create a DNS A record → ${pub:-$(primary_ip)}, then run 'Install Panel' again."
    return 0
  fi
  if echo "$lips" | grep -qx "$res" || [ "$res" = "$pub" ]; then ok "$d → $res (this server)"
  else
    warn "$d → $res, which is not this server${pub:+ (public IP $pub)}. (Fine if you use Cloudflare/another proxy.)"
    confirm "Use $d anyway?" Y || return 0
  fi

  setup_nginx "$d" || { warn "Domain proxy not set up — panel stays on http://$(primary_ip):$PANEL_PORT"; return 0; }
  PANEL_DOMAIN="$d"; PANEL_PUBLIC_URL="http://$d"
  if confirm "Enable free HTTPS (Let's Encrypt) for $d?" Y; then
    if [ "$AUTO" = 1 ]; then email="${ADMIN_EMAIL:-}"; else ask email "Email for certificate notices" "${ADMIN_EMAIL:-}"; fi
    if [ -n "$email" ] && setup_https "$d" "$email"; then PANEL_PUBLIC_URL="https://$d"; fi
  fi
  if grep -q '^PUBLIC_URL=' "$BACKEND_DIR/.env"; then sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=$PANEL_PUBLIC_URL#" "$BACKEND_DIR/.env"; else echo "PUBLIC_URL=$PANEL_PUBLIC_URL" >> "$BACKEND_DIR/.env"; fi
}

# ------------------------------------------------------------
#  PANEL INSTALL
# ------------------------------------------------------------
install_panel() {
  echo -e "\n${W}== Installing Panel ==${D}"
  ensure_curl || return 1
  ensure_node || return 1

  info "Installing backend dependencies…"
  ( cd "$BACKEND_DIR" && npm install --no-audit --no-fund ) && ok "Dependencies installed" || { err "npm install failed"; return 1; }

  # --- .env: session secret, port, and "no default accounts" flag ---
  local SHIPPED_SECRET="KboIngPENOrNF4oHHeFQjbr4YLUaW47oUb1f69P4viKWXGL4"
  if [ ! -f "$BACKEND_DIR/.env" ] || [ "$(panel_env_get SESSION_SECRET)" = "$SHIPPED_SECRET" ] || [ -z "$(panel_env_get SESSION_SECRET)" ]; then
    local SECRET P
    SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-48)"
    P="${PANEL_PORT:-$(panel_env_get PORT)}"; P="${P:-3000}"
    printf 'SESSION_SECRET=%s\nPORT=%s\n' "$SECRET" "$P" > "$BACKEND_DIR/.env"
    ok "Generated a fresh session secret (.env)"
  else
    info "Existing .env kept"
    if [ -n "$PANEL_PORT" ]; then
      if grep -q '^PORT=' "$BACKEND_DIR/.env"; then sed -i "s/^PORT=.*/PORT=$PANEL_PORT/" "$BACKEND_DIR/.env"; else echo "PORT=$PANEL_PORT" >> "$BACKEND_DIR/.env"; fi
    fi
  fi
  grep -q '^DIABLO_NO_DEFAULT_USERS=' "$BACKEND_DIR/.env" || echo "DIABLO_NO_DEFAULT_USERS=1" >> "$BACKEND_DIR/.env"
  chmod 600 "$BACKEND_DIR/.env" 2>/dev/null
  load_panel_port

  # --- Admin registration (before first start) ---
  if confirm "Register the admin account now?" Y; then
    if ! { collect_admin && register_admin_account; }; then
      warn "Admin not registered. Use menu option 'Register admin account' later."
      ADMIN_EMAIL=""
    fi
  else
    warn "Skipped. Choose 'Register admin account' from the menu before logging in."
    ADMIN_EMAIL=""
  fi

  # --- Service ---
  if has_systemd; then
    info "Creating systemd service: $PANEL_SERVICE"
    cat > "/etc/systemd/system/${PANEL_SERVICE}.service" <<EOF
[Unit]
Description=Diablo Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$BACKEND_DIR
EnvironmentFile=$BACKEND_DIR/.env
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$PANEL_SERVICE" >/dev/null 2>&1
    stop_panel
    start_panel
    info "Status: systemctl status $PANEL_SERVICE"
  else
    warn "systemd not available — starting panel in background (nohup)."
    stop_panel
    start_panel
  fi

  if wait_for_panel; then ok "Panel is up and answering on port $PANEL_PORT"; else err "Panel did not respond on port $PANEL_PORT — check logs."; return 1; fi

  # --- Domain (optional) ---
  echo
  info "Panel domain"
  setup_panel_domain

  info "Verifying the panel login API through $PANEL_PUBLIC_URL …"
  if verify_panel_route "$PANEL_PUBLIC_URL"; then ok "Login API reachable at $PANEL_PUBLIC_URL"
  else
    warn "Could not confirm the API through $PANEL_PUBLIC_URL (open the panel port / 80 / 443 in your firewall, or wait for DNS)."
    warn "A '404' on the login page means the page is served by something other than the panel — point the domain/proxy at port $PANEL_PORT."
  fi

  echo
  ok "Panel installed!"
  info "URL:                $PANEL_PUBLIC_URL/login.html"
  info "URL (this machine): http://localhost:$PANEL_PORT"
  [ -n "$ADMIN_EMAIL" ] && info "Admin login:        $ADMIN_EMAIL (or username: $ADMIN_USERNAME)"

  echo
  info "Next: add a node. In the panel go to Admin → Nodes → Create Node, add its IP and ports"
  info "on the Allocation tab, then run node-setup.sh on the node machine and paste the command"
  info "from the node's Configuration tab. (No IP is connected during install.)"
}

uninstall_panel() {
  echo -e "\n${W}== Uninstalling Panel ==${D}"
  if has_systemd && systemctl list-unit-files | grep -q "^${PANEL_SERVICE}.service"; then
    systemctl stop "$PANEL_SERVICE" 2>/dev/null
    systemctl disable "$PANEL_SERVICE" 2>/dev/null
    rm -f "/etc/systemd/system/${PANEL_SERVICE}.service"
    systemctl daemon-reload
    ok "Removed systemd service"
  fi
  if [ -f "$BACKEND_DIR/panel.pid" ]; then stop_panel; ok "Stopped running panel process"; fi
  if [ -d "$BACKEND_DIR/node_modules" ]; then rm -rf "$BACKEND_DIR/node_modules"; ok "Removed node_modules"; fi
  echo
  if confirm "Also delete panel data (users, servers, settings)?" N; then rm -f "$BACKEND_DIR/data/db.json"; ok "Panel data deleted"; fi
  ok "Panel uninstalled."
}

# ------------------------------------------------------------
#  WINGS (NODE) INSTALL
# ------------------------------------------------------------

# Node install only — no panel address / IP is asked for or connected here.
# The node is connected afterwards from the panel (Admin > Nodes > <node> > Configuration).
install_wings() {
  if [ ! -f "$ROOT_DIR/node-setup.sh" ]; then err "node-setup.sh not found next to install.sh"; return 1; fi
  bash "$ROOT_DIR/node-setup.sh"
}

uninstall_wings() {
  if [ -f "$ROOT_DIR/node-setup.sh" ]; then bash "$ROOT_DIR/node-setup.sh" --uninstall; else err "node-setup.sh not found next to install.sh"; return 1; fi
}

status() {
  echo -e "\n${W}== Status ==${D}"
  if have node; then ok "Node.js: $(node --version)"; else warn "Node.js not installed"; fi
  if panel_running; then ok "Panel: running"; else warn "Panel: not running"; fi
  if have diablo-wings; then diablo-wings status | sed 's/^/  /'; else warn "Node (Wings): not installed — run node-setup.sh on the node machine"; fi
  if has_systemd; then systemctl status "$PANEL_SERVICE" --no-pager 2>/dev/null | head -5; fi
}

# ------------------------------------------------------------
#  MENU
# ------------------------------------------------------------
menu() {
  banner
  echo -e "${W}Please choose an option:${D}"
  echo "  1) Install Panel (includes admin registration)"
  echo "  2) Install Node / Wings (install only — connect it later from the panel)"
  echo "  3) Register admin account"
  echo "  4) Install Node.js"
  echo "  5) Uninstall Panel"
  echo "  6) Uninstall Node / Wings"
  echo "  7) Show status"
  echo "  8) Exit"
  echo
  read -r -p "Selection [1-8]: " choice
  case "$choice" in
    1) install_panel ;;
    2) install_wings ;;
    3) register_admin ;;
    4) install_nodejs ;;
    5) uninstall_panel ;;
    6) uninstall_wings ;;
    7) status ;;
    8) exit 0 ;;
    *) err "Invalid option"; exit 1 ;;
  esac
}

need_root
if [ "${1:-}" = "--auto" ]; then
  # Non-interactive: panel + admin + local node, all verified.
  AUTO=1
  install_panel
else
  menu
fi
