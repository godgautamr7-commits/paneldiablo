'use strict';
/**
 * Seeds default data on first boot: default admin, sample nodes,
 * products (free + paid), plugins, modpacks and Minecraft versions.
 */
const bcrypt = require('bcryptjs');
const db = require('./db');

function seed() {
  const s = db.get();
  let changed = false;
  // install.sh sets DIABLO_NO_DEFAULT_USERS=1 so the admin you register during
  // install is the only account (no well-known default passwords, no fake node).
  const noDefaults = process.env.DIABLO_NO_DEFAULT_USERS === '1';

  // ---- Default admin ----
  if (!noDefaults && !s.users.some(u => u.role === 'admin')) {
    s.users.push({
      id: db.id('usr'),
      username: 'admin',
      email: 'admin@diablo.local',
      passwordHash: bcrypt.hashSync('admin123', 10),
      role: 'admin',
      coins: 100000,
      provider: 'local',
      avatar: null,
      createdAt: new Date().toISOString(),
      lastAfkAt: null
    });
    changed = true;
  }

  // ---- Sample demo client ----
  if (!noDefaults && !s.users.some(u => u.role === 'client')) {
    s.users.push({
      id: db.id('usr'),
      username: 'player',
      email: 'player@diablo.local',
      passwordHash: bcrypt.hashSync('player123', 10),
      role: 'client',
      coins: 2500,
      provider: 'local',
      avatar: null,
      createdAt: new Date().toISOString(),
      lastAfkAt: null
    });
    changed = true;
  }

  // ---- Sample node (local) ----
  if (!noDefaults && s.nodes.length === 0) {
    s.nodes.push({
      id: db.id('node'),
      name: 'Local Node',
      fqdn: '127.0.0.1',
      ip: '127.0.0.1',
      daemonPort: 8080,
      scheme: 'http',
      location: 'Local',
      memory: 16384,
      disk: 102400,
      status: 'online',
      token: db.id('tok'),
      allocations: [
        { id: db.id('alloc'), ip: '127.0.0.1', port: 25565, assignedTo: null },
        { id: db.id('alloc'), ip: '127.0.0.1', port: 25566, assignedTo: null },
        { id: db.id('alloc'), ip: '127.0.0.1', port: 25567, assignedTo: null }
      ],
      createdAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString()
    });
    changed = true;
  }

  // ---- Products (free + paid) ----
  if (s.products.length === 0) {
    const mk = (name, memory, cpu, disk, price, free, expiryDays, desc) => ({
      id: db.id('prod'),
      name,
      description: desc,
      memory,        // MB
      cpu,           // percent
      disk,          // MB
      price,         // coins
      free,
      expiryDays,
      upgradeOptions: [1, 2, 4, 8],
      createdAt: new Date().toISOString()
    });
    s.products.push(
      mk('Starter 2GB', 2048, 100, 10240, 0, true, 30, 'Free forever plan. 2GB RAM, 1 vCore, 10GB disk. Perfect for vanilla survival.'),
      mk('Basic 4GB', 4096, 200, 20480, 500, false, 30, '4GB RAM, 2 vCores, 20GB NVMe disk. Great for small modpacks.'),
      mk('Standard 8GB', 8192, 300, 40960, 1200, false, 30, '8GB RAM, 3 vCores, 40GB NVMe disk. Handles medium modpacks.'),
      mk('Pro 16GB', 16384, 400, 81920, 2500, false, 30, '16GB RAM, 4 vCores, 80GB NVMe disk. Large modpacks & many players.'),
      mk('Ultra 32GB', 32768, 600, 163840, 5000, false, 30, '32GB RAM, 6 vCores, 160GB NVMe disk. Enterprise-grade performance.')
    );
    changed = true;
  }

  // ---- Plugins catalog ----
  if (s.plugins.length === 0) {
    const p = (name, category, version, desc) => ({
      id: db.id('plg'), name, category, version, description: desc,
      downloadUrl: `https://cdn.diablo.local/plugins/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jar`,
      icon: null, createdAt: new Date().toISOString()
    });
    s.plugins.push(
      p('EssentialsX', 'Utility', '2.20.1', 'Core commands, kits, warps, homes and economy for every server.'),
      p('LuckPerms', 'Permissions', '5.4.102', 'Advanced permissions, groups and inheritance system.'),
      p('WorldEdit', 'Building', '7.3.0', 'In-game map editor with powerful selection and brush tools.'),
      p('Vault', 'Economy', '1.7.3', 'Abstraction layer for economy, permissions and chat plugins.'),
      p('Dynmap', 'Web', '3.6.2', 'Live Google-Maps style web map of your world.'),
      p('ViaVersion', 'Compatibility', '4.10.1', 'Allow newer Minecraft clients to join older servers.'),
      p('CoreProtect', 'Admin', '22.2', 'Block logging and rollback to fight griefing.'),
      p('Citizens', 'NPC', '2.0.32', 'Create and manage NPCs with scripts and quests.'),
      p('GriefPrevention', 'Protection', '16.18.1', 'Claim-based land protection for players.'),
      p('PlaceholderAPI', 'Utility', '2.11.5', 'Universal placeholder engine used by hundreds of plugins.')
    );
    changed = true;
  }

  // ---- Extra plugins (added on upgrade, never duplicated) ----
  {
    const more = [
      ['WorldGuard','Protection','7.0.9','Region protection and flag system.'],
      ['Multiverse-Core','World','4.3.12','Manage multiple worlds on one server.'],
      ['ProtocolLib','Library','5.2.0','Packet library required by many plugins.'],
      ['TAB','Utility','4.1.2','Customisable tablist, nametags and scoreboard.'],
      ['ClearLag','Performance','3.2.2','Remove lag-causing entities automatically.'],
      ['Geyser-Spigot','Compatibility','2.4.2','Let Bedrock players join your Java server.'],
      ['Floodgate','Compatibility','2.2.3','Bedrock authentication for Geyser.'],
      ['DiscordSRV','Social','1.27.0','Link in-game chat with a Discord server.'],
      ['ShopGUIPlus','Economy','1.96','Powerful GUI shop system.'],
      ['Chunky','Performance','1.4.10','Pre-generate chunks for smooth exploration.'],
      ['Spark','Performance','1.10.73','Profiler to find lag sources.'],
      ['AuthMe','Security','5.6.0','Login and registration for cracked servers.'],
      ['Skript','Scripting','2.8.5','Write custom features without Java.'],
      ['MythicMobs','Mobs','5.6.1','Create custom mobs, bosses and skills.'],
      ['ChestShop','Economy','3.12.2','Player-run chest shops.'],
      ['LiteBans','Admin','2.14.1','Advanced ban and mute management.'],
      ['Jobs-Reborn','Economy','5.2.2','Earn money by doing jobs.'],
      ['PlotSquared','Building','7.3.0','Plot worlds for creative servers.'],
      ['VotingPlugin','Social','6.16','Vote rewards and vote sites.'],
      ['DecentHolograms','Utility','2.8.5','Holograms for lobbies and info boards.']
    ];
    more.forEach(([name, category, version, description]) => {
      if (!s.plugins.some(x => x.name === name)) {
        s.plugins.push({ id: db.id('plg'), name, category, version, description,
          downloadUrl: `https://cdn.diablo.local/plugins/${name.toLowerCase()}.jar`, icon: null, createdAt: new Date().toISOString() });
        changed = true;
      }
    });
  }

  // ---- Modpacks catalog ----
  if (s.modpacks.length === 0) {
    const m = (name, loader, mcVersion, size, desc) => ({
      id: db.id('mp'), name, loader, mcVersion, size, description: desc,
      downloadUrl: `https://cdn.diablo.local/modpacks/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.zip`,
      icon: null, createdAt: new Date().toISOString()
    });
    s.modpacks.push(
      m('Vanilla+', 'Vanilla', '1.20.4', '50 MB', 'Lightweight quality-of-life tweaks while keeping vanilla feel.'),
      m('RLCraft', 'Forge', '1.12.2', '1.4 GB', 'Brutal hardcore survival with dragons, thirst and temperature.'),
      m('All the Mods 9', 'Forge', '1.20.1', '3.2 GB', 'Massive kitchen-sink pack with 400+ mods.'),
      m('Better MC', 'Fabric', '1.20.1', '1.8 GB', 'Performance focused pack with new biomes and structures.'),
      m('Pixelmon', 'Forge', '1.16.5', '1.1 GB', 'Catch, train and battle Pokémon inside Minecraft.'),
      m('Create: Above and Beyond', 'Forge', '1.16.5', '900 MB', 'Automation and engineering focused tech pack.'),
      m('SkyFactory 4', 'Forge', '1.12.2', '700 MB', 'Classic skyblock with trees, automation and prestige.'),
      m('Vault Hunters', 'Forge', '1.18.2', '2.6 GB', 'RPG-lite pack with vaults, loot and abilities.')
    );
    changed = true;
  }

  // ---- Minecraft versions (full release list, added if missing) ----
  {
    const R = { '1.7': [10], '1.8': [0,1,2,3,4,5,6,7,8,9], '1.9': [0,1,2,3,4], '1.10': [0,1,2], '1.11': [0,1,2], '1.12': [0,1,2], '1.13': [0,1,2],
      '1.14': [0,1,2,3,4], '1.15': [0,1,2], '1.16': [0,1,2,3,4,5], '1.17': [0,1], '1.18': [0,1,2], '1.19': [0,1,2,3,4],
      '1.20': [0,1,2,3,4,5,6], '1.21': [0,1,2,3,4,5,6,7,8] };
    Object.entries(R).forEach(([maj, ps]) => ps.forEach(p => {
      const v = p === 0 ? maj : `${maj}.${p}`;
      if (!s.versions.some(x => x.version === v)) { s.versions.push({ id: db.id('ver'), version: v, type: 'release', createdAt: new Date().toISOString() }); changed = true; }
    }));
  }

  if (changed) db.save();
  return changed;
}

module.exports = { seed };
