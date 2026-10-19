'use strict';
/**
 * Shared install logic used by BOTH the console and the REST API,
 * so every path behaves the same.
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const sfs = require('./serverfs');

const MODRINTH = process.env.MODRINTH_API || 'https://api.modrinth.com/v2';
const PLUGIN_SOFTWARE = ['Paper', 'Purpur', 'Spigot'];
const MIN_VERSION = { Paper: '1.8.8', Purpur: '1.14.4', Spigot: '1.8', Fabric: '1.14', Forge: '1.7.10', Vanilla: '1.7.10' };
const LOADERS = { Paper: ['paper', 'purpur', 'spigot', 'bukkit'], Purpur: ['purpur', 'paper', 'spigot', 'bukkit'], Spigot: ['spigot', 'bukkit'] };
const L = (t, c) => ({ t, c: c || '' });

const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
};
const versionOk = (software, version) => cmp(version, MIN_VERSION[software] || '1.7.10') >= 0;
const canUsePlugins = (sv) => PLUGIN_SOFTWARE.includes(sv.software);
const slugOf = (p) => p.slug || p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'diablo-panel/1.0' }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/** Try to download a real jar from Modrinth into /plugins. Returns {file, source}. */
async function downloadReal(p, sv) {
  const q = `loaders=${encodeURIComponent(JSON.stringify(LOADERS[sv.software]))}&game_versions=${encodeURIComponent(JSON.stringify([sv.version]))}`;
  const vers = await fetchJson(`${MODRINTH}/project/${slugOf(p)}/version?${q}`);
  if (!Array.isArray(vers) || !vers.length) { const e = new Error(`no build of ${p.name} for ${sv.software} ${sv.version}`); e.noBuild = true; throw e; }
  const f = vers[0].files.find(x => x.primary) || vers[0].files[0];
  const name = sfs.cleanName(f.filename);
  const r = await fetch(f.url, { headers: { 'User-Agent': 'diablo-panel/1.0' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  const dest = sfs.resolve(sv, 'plugins/' + name);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  return { file: name, source: 'modrinth', version: vers[0].version_number };
}

async function installPlugin(s, sv, p) {
  const out = [];
  if (!canUsePlugins(sv)) return { ok: false, lines: [L(`✗ ${p.name}: plugins need Paper, Purpur or Spigot (this server runs ${sv.software}). Change it in Startup.`, 't-err')] };
  if (sv.plugins.some(x => x.id === p.id)) return { ok: false, lines: [L(`• ${p.name} is already installed.`, 't-warn')] };
  out.push(L(`Resolving ${p.name} for ${sv.software} ${sv.version} ...`, 't-info'));
  let rec;
  try {
    rec = await downloadReal(p, sv);
    out.push(L(`Downloaded plugins/${rec.file} from Modrinth`, 't-dim'));
  } catch (e) {
    if (e.noBuild) return { ok: false, lines: out.concat(L(`✗ ${e.message}. Try another version or plugin.`, 't-err')) };
    const file = `${p.name}-${p.version}.jar`;
    fs.writeFileSync(sfs.resolve(sv, 'plugins/' + file), `DIABLO PLACEHOLDER\nThe real jar could not be downloaded (${e.message}).\nPlugin: ${p.name} ${p.version}\n`);
    rec = { file, source: 'placeholder', version: p.version };
    out.push(L(`⚠ Download source unreachable (${e.message}) — saved a placeholder file instead of the real jar.`, 't-warn'));
  }
  sv.plugins.push({ id: p.id, name: p.name, version: rec.version, file: rec.file, source: rec.source, installedAt: new Date().toISOString() });
  out.push(L(`✓ Installed ${p.name} ${rec.version}${rec.source === 'placeholder' ? ' (placeholder)' : ''}`, 't-ok'));
  return { ok: true, lines: out };
}

function removePlugin(sv, rec) {
  try { fs.rmSync(sfs.resolve(sv, 'plugins/' + sfs.cleanName(rec.file || `${rec.name}-${rec.version}.jar`)), { force: true }); } catch (_) {}
  sv.plugins = sv.plugins.filter(x => x.id !== rec.id);
}

function installModpack(s, sv, m) {
  const out = [L(`Installing ${m.name} (${m.loader}, MC ${m.mcVersion}) ...`, 't-info')];
  const software = ['Forge', 'Fabric'].includes(m.loader) ? m.loader : (PLUGIN_SOFTWARE.includes(sv.software) ? sv.software : 'Vanilla');
  fs.writeFileSync(sfs.resolve(sv, 'modpack.json'), JSON.stringify({ name: m.name, loader: m.loader, mcVersion: m.mcVersion, installedAt: new Date().toISOString() }, null, 2));
  fs.mkdirSync(sfs.resolve(sv, 'mods'), { recursive: true });
  fs.writeFileSync(sfs.resolve(sv, `mods/${sfs.cleanName(m.name)}.modlist`), `Modpack ${m.name}\nLoader ${m.loader}\nMinecraft ${m.mcVersion}\n`);
  sv.modpack = { id: m.id, name: m.name, loader: m.loader, mcVersion: m.mcVersion, installedAt: new Date().toISOString() };
  sv.version = m.mcVersion;
  if (software !== sv.software) { out.push(L(`Server software switched ${sv.software} → ${software} (required by this modpack).`, 't-warn')); sv.software = software; }
  if (sv.plugins.length && !canUsePlugins(sv)) out.push(L(`⚠ ${sv.plugins.length} installed plugin(s) will not load on ${software}.`, 't-warn'));
  out.push(L(`✓ Installed ${m.name}. Version set to ${m.mcVersion}.`, 't-ok'));
  return { ok: true, lines: out };
}

function removeModpack(sv) {
  if (!sv.modpack) return { ok: false, lines: [L('No modpack installed.', 't-warn')] };
  try { fs.rmSync(sfs.resolve(sv, 'modpack.json'), { force: true }); fs.rmSync(sfs.resolve(sv, `mods/${sfs.cleanName(sv.modpack.name)}.modlist`), { force: true }); } catch (_) {}
  const n = sv.modpack.name; sv.modpack = null;
  return { ok: true, lines: [L(`✓ Removed ${n}`, 't-ok')] };
}

function setVersion(s, sv, version) {
  if (!s.versions.some(v => v.version === version)) return { ok: false, lines: [L(`Unknown version "${version}". Use: version list`, 't-err')] };
  if (!versionOk(sv.software, version)) return { ok: false, lines: [L(`✗ ${sv.software} does not support ${version} (needs ${MIN_VERSION[sv.software]}+). Pick another version or software.`, 't-err')] };
  sv.version = version;
  const out = [L(`✓ Version set to ${version}. Restart to apply.`, 't-ok')];
  if (sv.modpack && sv.modpack.mcVersion !== version) out.push(L(`⚠ Modpack ${sv.modpack.name} is built for ${sv.modpack.mcVersion} and may break.`, 't-warn'));
  return { ok: true, lines: out };
}

function setSoftware(sv, software) {
  if (!versionOk(software, sv.version)) return { ok: false, lines: [L(`✗ ${software} does not support ${sv.version} (needs ${MIN_VERSION[software]}+).`, 't-err')] };
  sv.software = software;
  return { ok: true, lines: [L(`✓ Software set to ${software}.`, 't-ok')] };
}

module.exports = { installPlugin, removePlugin, installModpack, removeModpack, setVersion, setSoftware, versionOk, canUsePlugins, cmp, MIN_VERSION, PLUGIN_SOFTWARE };
