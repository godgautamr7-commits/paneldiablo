/* ============================================================
   Diablo Panel — shared frontend runtime
   - Auth guard (redirects to login when not authorized)
   - Role-based sidebar
   - API helper, toasts, modals, formatting
   ============================================================ */
(function () {
  'use strict';

  const API = {
    async req(method, url, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) {
        const err = new Error((data && data.error) || `Request failed (${res.status})`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    },
    get(u) { return this.req('GET', u); },
    post(u, b) { return this.req('POST', u, b); },
    put(u, b) { return this.req('PUT', u, b); },
    del(u) { return this.req('DELETE', u); }
  };

  // ---- Toast ----
  function toast(msg, kind) {
    let wrap = document.querySelector('.toasts');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toasts'; document.body.appendChild(wrap); }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'ok');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3200);
  }

  // ---- Modal ----
  function openModal(id) { const m = document.getElementById(id); if (m) m.classList.add('open'); }
  function closeModal(id) { const m = document.getElementById(id); if (m) m.classList.remove('open'); }
  document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('modal-back')) e.target.classList.remove('open');
    const closer = e.target.closest && e.target.closest('[data-close]');
    if (closer) { const m = closer.closest('.modal-back'); if (m) m.classList.remove('open'); }
  });

  // ---- Formatting ----
  const fmt = {
    coins(n) { return (n || 0).toLocaleString('en-US'); },
    mb(mb) { return mb >= 1024 ? (mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1) + ' GB' : mb + ' MB'; },
    date(d) { if (!d) return '—'; return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); },
    dateTime(d) { if (!d) return '—'; return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); },
    rel(d) {
      if (!d) return 'never';
      const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    },
    initials(name) { return (name || '?').slice(0, 2).toUpperCase(); }
  };

  // ---- Sidebar ----
  const ic = (n) => `<img class="ico-img" src="/assets/img/icons/${n}.svg" alt="">`;
  const ICONS = {
    dashboard: ic('chart'), servers: ic('server'), plugins: ic('puzzle'), modpacks: ic('package'), versions: ic('tag'),
    store: ic('cart'), coins: ic('coin'), nodes: ic('globe'), products: ic('gift'), users: ic('users'),
    settings: ic('gear'), logout: ic('logout'), home: ic('home'), admin: ic('shield'), status: ic('activity'),
    create: ic('rocket'), console: ic('terminal'), profile: ic('user')
  };

  function navLink(href, icon, label, active, cls) {
    return `<a href="${href}" class="${active ? 'active' : ''} ${cls || ''}"><span class="ic">${icon}</span>${label}</a>`;
  }

  function buildSidebar(user, cfg, active) {
    const isAdmin = user.role === 'admin';
    const adminLinks = `
      <div class="section">Administration</div>
      ${navLink('/admin/index.html', ICONS.dashboard, 'Admin Overview', active === 'admin-index')}
      ${navLink('/admin/nodes.html', ICONS.nodes, 'Nodes', active === 'admin-nodes')}
      ${navLink('/admin/products.html', ICONS.products, 'Products', active === 'admin-products')}
      ${navLink('/admin/users.html', ICONS.users, 'Users', active === 'admin-users')}
      ${navLink('/admin/coins.html', ICONS.coins, 'Coin Manager', active === 'admin-coins')}
      ${navLink('/admin/coupons.html', ICONS.products, 'Coupons', active === 'admin-coupons')}
      ${navLink('/admin/catalog.html', ICONS.plugins, 'Catalog', active === 'admin-catalog')}
      ${navLink('/admin/servers.html', ICONS.servers, 'All Servers', active === 'admin-servers')}
      ${navLink('/admin/settings.html', ICONS.settings, 'Settings', active === 'admin-settings')}
    `;
    const clientLinks = `
      ${navLink('/dashboard.html', ICONS.dashboard, 'Dashboard', active === 'dashboard')}
      <div class="section">Servers</div>
      ${navLink('/servers.html', ICONS.servers, 'Your servers', active === 'servers')}
      ${navLink('/servers.html?new=1', ICONS.create, 'Create server', active === 'create')}
      ${navLink('/store.html', ICONS.store, 'Store', active === 'store')}
      <div class="section">Account</div>
      ${navLink('/coins.html', ICONS.coins, 'My Coins & AFK', active === 'coins')}
      <div class="section">More</div>
      ${navLink('/status.html', ICONS.status, 'Node status', active === 'status')}
    `;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = `
      <div class="brand">
        <div class="logo"><img class="ico-img" src="/assets/img/logo.svg" alt="Diablo"></div>
        <div class="name">${cfg.panelName || 'Diablo Panel'}<small>${isAdmin ? 'Admin Panel' : 'Minecraft Hosting'}</small></div>
      </div>
      <nav class="nav">
        ${clientLinks}
        ${isAdmin ? adminLinks : ''}
      </nav>
      <div class="foot">
        <button class="btn btn-ghost btn-block btn-sm" id="logoutBtn">${ICONS.logout} Sign out</button>
      </div>
    `;
    // mobile: tap a link or the dark backdrop to close the menu
    let bd = document.getElementById('sbBackdrop');
    if (!bd) { bd = document.createElement('div'); bd.id = 'sbBackdrop'; bd.className = 'sb-backdrop'; document.body.appendChild(bd); }
    const closeSb = () => { sidebar.classList.remove('open'); bd.classList.remove('show'); };
    bd.onclick = closeSb;
    sidebar.querySelectorAll('a').forEach(a => a.addEventListener('click', closeSb));
    const lb = document.getElementById('logoutBtn');
    if (lb) lb.addEventListener('click', async () => {
      try { await API.post('/api/auth/logout'); } catch (e) {}
      location.href = '/login.html';
    });
  }

  async function renderTopbar(user, title, subtitle) {
    const tb = document.getElementById('topbar');
    if (!tb) return;
    let st = { nodesOnline: 0, nodesTotal: 0, serversRunning: 0, users: 0, usersOnline: 0, loginsToday: 0, totalLogins: 0 };
    try { st = await API.get('/api/status/summary'); } catch (e) {}
    tb.innerHTML = `
      <button class="menu-toggle" id="menuToggle">${ic('menu')}</button>
      <div class="title">${title || ''}<small>${subtitle || ''}</small></div>
      <div class="spacer"></div>
      <span class="online-pill" title="${st.usersOnline} online now · ${st.loginsToday} logins today · ${st.totalLogins} total logins · ${st.users} registered"><span class="dot dot-green"></span><b>${st.usersOnline}</b><span class="lbl">users online</span><span class="sep">·</span><b>${st.loginsToday}</b><span class="lbl">logins today</span></span>
      <a class="tlink" href="/status.html">Status</a>
      <a class="btn-new" href="/servers.html?new=1">+ New server</a>
      <div class="coin-chip"><span class="c">${ic('coin')}</span> <span id="coinBalance">${fmt.coins(user.coins)}</span></div>
      <div class="utag"><i>${fmt.initials(user.username)}</i>${user.username}</div>
    `;
    const mt = document.getElementById('menuToggle');
    if (mt) mt.addEventListener('click', () => { const sb = document.getElementById('sidebar'); sb.classList.toggle('open'); const bd = document.getElementById('sbBackdrop'); if (bd) bd.classList.toggle('show', sb.classList.contains('open')); });
  }

  /**
   * Guard a page. Redirects to /login.html unless authenticated.
   * If requireAdmin, also enforces admin role.
   */
  async function guard(opts) {
    opts = opts || {};
    let me;
    try {
      me = await API.get('/api/auth/me');
    } catch (e) {
      location.href = '/login.html';
      return null;
    }
    if (!me.user) { location.href = '/login.html'; return null; }
    if (opts.requireAdmin && me.user.role !== 'admin') { location.href = '/dashboard.html'; return null; }
    let cfg = { panelName: 'Diablo Panel' };
    try { cfg = await API.get('/api/config'); } catch (e) {}
    applyTheme(cfg.theme);
    buildSidebar(me.user, cfg, opts.active);
    renderTopbar(me.user, opts.title, opts.subtitle);
    window.__user = me.user;
    return me.user;
  }

  function setCoins(n) { const el = document.getElementById('coinBalance'); if (el) el.textContent = fmt.coins(n); if (window.__user) window.__user.coins = n; }

  // Apply admin-configured theme backgrounds via a dynamic style override.
  function applyTheme(theme) {
    if (!theme) return;
    const map = [
      ['.bg-login::before', theme.loginBackground, 'linear-gradient(160deg, rgba(7,11,18,0.78), rgba(7,11,18,0.92))'],
      ['.bg-dashboard::before', theme.dashboardBackground, 'linear-gradient(180deg, rgba(7,11,18,0.86), rgba(7,11,18,0.96))'],
      ['.bg-panel::before', theme.panelBackground, 'linear-gradient(180deg, rgba(7,11,18,0.9), rgba(7,11,18,0.97))']
    ];
    const css = map.map(([sel, url, grad]) => url ? `${sel}{background-image:${grad}, url('${url}');}` : '').join('');
    let el = document.getElementById('themeOverride');
    if (!el) { el = document.createElement('style'); el.id = 'themeOverride'; document.head.appendChild(el); }
    el.textContent = css;
  }

  window.Nova = { API, toast, openModal, closeModal, fmt, guard, setCoins, ICONS, ic, applyTheme };
})();
