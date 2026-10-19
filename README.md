# Diablo Panel Panel — Minecraft Hosting Panel

A complete, self-hosted **Pterodactyl-style** control panel for Minecraft game hosting.
It ships with a full **Admin** area and a **Client** area, a **multi-node** infrastructure
manager, one-click **plugin / modpack / version** installers, a **coin economy** with free
and paid products, **Google & Discord** login, and a single **`install.sh`** that installs or
uninstalls both the **Panel** and the **Wings** node agent.

> The entire interface is in **English**.

---

## <img class="ico-img" src="/assets/img/icons/sparkle.svg" alt=""> Features

### Admin Panel
- **Overview** — fleet-wide stats (users, nodes online, servers running, coins in circulation).
- **Nodes** — create unlimited nodes with **IP address + port allocations** (single or bulk port ranges),
  per-node Wings token, heartbeat status, resource limits and location.
- **Products** — define plans with RAM / CPU / disk, **free or paid**, RAM **upgrade options** and **expiry days**.
- **Users** — manage accounts, roles, passwords and balances.
- **Coin Manager** — add/remove coins per user, give coins to **all users** at once, full transaction log.
- **All Servers** — every instance across the fleet.
- **Settings** — panel name, currency, AFK rate, **theming backgrounds**, and **Google / Discord OAuth** config.

### Client Panel
- **Dashboard** — live stats, quick actions and an **AFK coin farm**.
- **My Servers** — create servers from plans, start/stop/restart, view IP:port, specs and expiry.
- **Plugin Installer** — browse the catalog and **one-click install** plugins to any server.
- **Modpack Installer** — **one-click install** full modpacks (sets the MC version automatically).
- **Version Changer** — **one-click** Minecraft version switching.
- **Coin Store** — claim **free products** or **buy paid products** with coins.
- **My Coins & AFK** — balance, AFK earning and transaction history.

### Wings (Node Agent)
- Registers with the panel, sends **heartbeats** and **system stats**.
- **Checks whether Minecraft servers are running** by probing their allocated IP:port.
- Reports live server status back to the panel.

---

## <img class="ico-img" src="/assets/img/icons/folder.svg" alt=""> Project structure

```
.
├── install.sh              # Installer (Panel, admin registration, Node.js)
├── node-setup.sh           # Standalone node installer (Wings) - install only, no IP connect
├── panel/
│   ├── backend/            # Node.js + Express API
│   │   ├── server.js
│   │   ├── lib/            # db, auth, oauth, seed
│   │   └── routes/         # auth, admin, client, wings
│   └── frontend/           # Static UI (one HTML file per page)
│       ├── login.html · register.html · dashboard.html
│       ├── servers.html · plugins.html · modpacks.html · versions.html
│       ├── store.html · coins.html
│       ├── admin/          # index, nodes, products, users, coins, servers, settings
│       └── assets/         # css, js, img (themed backgrounds)
└── wings/
    ├── wings.js            # Node agent
    └── config.json         # Created by install.sh
```

---

## <img class="ico-img" src="/assets/img/icons/rocket.svg" alt=""> Quick start

### Option A — one command installer (recommended)
```bash
sudo bash install.sh
```
You get a menu:
```
1) Install Panel (includes admin registration)
2) Install Node / Wings (install only - connect it later from the panel)
3) Register admin account
4) Install Node.js
5) Uninstall Panel
6) Uninstall Node / Wings
7) Show status
8) Exit
```
The installer can install **Node.js 20** for you, set up your **panel domain** (nginx reverse proxy + optional free HTTPS via Let's Encrypt), installs dependencies, generates a fresh session
secret, **asks you to register the admin account**, and registers **systemd services**
(`diablo-panel`, `diablo-wings`). If systemd is unavailable it falls back to `nohup`.

Non-interactive: `ADMIN_FIRST_NAME=Me ADMIN_LAST_NAME=Admin ADMIN_USERNAME=me ADMIN_EMAIL=me@x.com ADMIN_PASSWORD='...' sudo -E bash install.sh --auto`
installs the panel and registers the admin (a random password is generated
and printed if `ADMIN_PASSWORD` is not set).

### Option B — run manually
```bash
cd panel/backend
npm install
node server.js
# Panel -> http://localhost:3000
```

### Admin account
`install.sh` creates **no default accounts** - you register your own admin (first name, last name, username, email, password) during install (or later via
menu option **3**, which also works as a password reset). Only when you run the panel manually
(Option B, without the installer) are the demo accounts `admin@diablo.local / admin123` and
`player@diablo.local / player123` seeded - change those immediately.


---

## <img class="ico-img" src="/assets/img/icons/globe.svg" alt=""> Setting up a node (Pterodactyl-style)

Nodes are installed first and connected afterwards from the panel. **The node script never asks for a panel address or IP.**

1. **On the node machine** run `sudo bash node-setup.sh` (a single standalone file - copy it to the machine).
   It installs Node.js if needed, the Wings agent (`/opt/diablo-wings`), the `diablo-wings` command and a
   systemd service. Wings then simply waits to be configured.
2. **In the panel** go to **Admin > Nodes > Create Node**. You land on the node page:
   - **About** - daemon version, system info, allocated disk / memory, delete node
   - **Settings** - name, description, location, FQDN, IP, limits, reset token
   - **Allocation** - assign an **IP (+ alias)** and **ports** (`25565, 25570-25580`)
   - **Configuration** - the `config.json` and the **Auto-Deploy** command
   - **Servers** - servers on this node
3. On the **Configuration** tab click **Generate Token** and run the shown command on the node machine:
   ```bash
   sudo diablo-wings configure --panel https://panel.example.com --node <node-id> --token <token>
   ```
   The node turns **online** in the panel within ~15 seconds.

Other commands on the node: `diablo-wings status | logs | restart`. Remove with `sudo bash node-setup.sh --uninstall`.
`install.sh` options 2 / 6 simply call `node-setup.sh`.

Server statuses (running / offline) are detected by probing each server's allocated IP:port.

---

## <img class="ico-img" src="/assets/img/icons/lock.svg" alt=""> OAuth setup (Google & Discord)

Sign in as admin <img class="ico-img" src="/assets/img/icons/arrow.svg" alt=""> **Settings**. The exact **Authorized redirect URI** to register with each
provider is shown on the page:

- Google:  `https://YOUR-PANEL/api/auth/oauth/google/callback`
- Discord: `https://YOUR-PANEL/api/auth/oauth/discord/callback`

Paste the **Client ID** and **Client secret**, tick **Enable**, and save. The login and register
pages automatically activate the corresponding buttons. Until configured, the buttons are shown
disabled (no crash) and local email/password login still works.

---

## <img class="ico-img" src="/assets/img/icons/coin.svg" alt=""> Coin economy

- Set the **AFK rate** (coins per minute) in Settings.
- Users earn coins by keeping the dashboard/coins page open and clicking **Claim coins**.
- Admins can **add/remove** coins per user or **give to all users** from **Coin Manager**.
- **Free products** cost nothing; **paid products** are charged in coins at server creation.
- Each product can define **RAM upgrade options** (e.g. `1,2,4,8` GB) and an **expiry** in days.

---

## <img class="ico-img" src="/assets/img/icons/tools.svg" alt=""> API overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/logout` | Local auth |
| GET  | `/api/auth/oauth/:provider` | Start Google/Discord login |
| GET  | `/api/admin/stats` | Fleet statistics |
| GET/POST/PUT/DELETE | `/api/admin/nodes[/:id]` | Node CRUD |
| POST | `/api/admin/nodes/:id/allocations[/bulk]` | Add IP:port allocations |
| GET/POST/PUT/DELETE | `/api/admin/products[/:id]` | Product CRUD |
| GET/PUT/DELETE | `/api/admin/users[/:id]` | User management |
| POST | `/api/admin/coins/adjust` · `/api/admin/coins/give-all` | Coin control |
| GET/PUT | `/api/admin/settings` | Panel settings & OAuth |
| GET/POST | `/api/client/servers` | List / create servers |
| POST | `/api/client/servers/:id/power` | start / stop / restart / kill |
| POST | `/api/client/servers/:id/plugins` | One-click plugin install |
| POST | `/api/client/servers/:id/modpack` | One-click modpack install |
| POST | `/api/client/servers/:id/version` | One-click version change |
| GET  | `/api/client/store` | Products + balance |
| POST | `/api/client/coins/afk` | Claim AFK coins |
| POST | `/api/wings/heartbeat` | Node heartbeat (agent) |
| POST | `/api/wings/servers/:id/status` | Node reports server status |

---

## <img class="ico-img" src="/assets/img/icons/gear.svg" alt=""> Configuration

Environment variables (written to `panel/backend/.env` by the installer):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Panel HTTP port |
| `SESSION_SECRET` | generated | Cookie signing secret |
| `DIABLO_NO_DEFAULT_USERS` | `1` (installer) | Skip the demo accounts and sample node |

Data is stored in `panel/backend/data/db.json` (users, nodes, servers, products, plugins, modpacks, transactions, settings).

---

## <img class="ico-img" src="/assets/img/icons/puzzle.svg" alt=""> Notes

- The panel is a full-stack app (Node backend + static frontend), so it must run on a server
  (VPS / container) rather than a static host.
- Wings detects running servers by TCP-probing their allocated IP:port; integrate a real
  Minecraft process manager if you want start/stop to launch actual server JARs.
- All default catalogs (plugins, modpacks, versions, products) are seeded on first boot and can be
  edited from the admin panel.
