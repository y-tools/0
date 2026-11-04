[Reading 297 lines from start (total: 297 lines, 0 remaining)]

'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const iconMap = {
    'monitor-play': '▣', link: '⇄', sparkles: '✧',
    dice: '⚄', layers: '◈', grid: '▦'
  };
  const API_FALLBACK = 'https://153-127-64-17.sslip.io/api';
  const state = {config: null, token: '', open: false, tapCount: 0, lastTap: 0, timer: null, device: '', authenticating: false};
  const getStorage = (store, key) => {try {return store.getItem(key) || '';}catch {return '';}};
  const setStorage = (store, key, value) => {try {store.setItem(key, value);}catch {}};
  const removeStorage = (store, key) => {try {store.removeItem(key);}catch {}};
  const create = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  // Only HTTP(S) and local anchors are allowed. Never render user-supplied HTML.
  const safeHref = (value, allowAnchor = true) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    const input = value.trim();
    if (allowAnchor && /^#[A-Za-z0-9_-]+$/.test(input)) return input;
    try {
      const u = new URL(input);
      return u.protocol === 'https:' ? u.href : '';
    } catch {return '';}
  };

  function loadMenu(items) {
    const grid = $('toolGrid');
    const drawer = $('drawerLinks');
    grid.replaceChildren();
    drawer.replaceChildren();
    const valid = Array.isArray(items) ? items.slice(0, 24) : [];
    valid.forEach((item, i) => {
      const title = String(item.title || 'TOOL').slice(0, 45);
      const subtitle = String(item.subtitle || '').slice(0, 55);
      const href = safeHref(item.href);
      const available = item.status !== 'soon' && !!href;
      const card = create(available ? 'a' : 'div', 'tool-card' + (available ? '' : ' soon'));
      if (available) {
        card.href = href;
        if (!href.startsWith('#')) {card.target = '_blank';card.rel = 'noopener noreferrer';}
      } else {
        card.setAttribute('aria-label', title + ' - 準備中');
      }
      const icon = create('span', 'tool-icon', iconMap[item.icon] || '✦');
      icon.setAttribute('aria-hidden', 'true');
      const meta = create('div', 'tool-meta');
      const words = create('span');
      words.append(create('strong', '', title), create('small', '', subtitle));
      const arrow = create('span', 'tool-arrow', available ? '↗' : '·');
      arrow.setAttribute('aria-hidden', 'true');
      meta.append(words, arrow);
      card.append(icon, meta);
      if (!available) card.append(create('span', 'soon-label', 'COMING SOON'));
      grid.append(card);

      const nav = create(available ? 'a' : 'span', available ? '' : 'disabled');
      if (available) {
        nav.href = href;
        if (!href.startsWith('#')) {nav.target = '_blank';nav.rel = 'noopener noreferrer';}
        nav.addEventListener('click', closeDrawer);
      }
      nav.append(create('span', 'menu-index', String(i + 1).padStart(2, '0')), create('span', '', title + (available ? '' : ' — 準備中')));
      drawer.append(nav);
    });
    const profile = create('a', '', '');
    profile.href = '#profile';
    profile.append(create('span', 'menu-index', '↗'), create('span', '', 'PROFILE'));
    profile.addEventListener('click', closeDrawer);
    drawer.append(profile);
  }

  function renderProfile(data) {
    const c = data || {};
    $('profileName').textContent = String(c.displayName || 'Y++').slice(0, 70);
    $('profileHandle').textContent = String(c.handle || '').slice(0, 110);
    $('profileStatement').textContent = String(c.statement || '').slice(0, 160);
    $('profileDescription').textContent = String(c.description || '').slice(0, 1000);
    const root = $('profileLinks');
    root.replaceChildren();
    (Array.isArray(c.links) ? c.links.slice(0, 10) : []).forEach(link => {
      const href = safeHref(link.href, false);
      if (!href) return;
      const a = create('a', '', String(link.label || 'LINK').slice(0, 40) + ' ↗');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      root.append(a);
    });
  }

  function openDrawer() {
    state.open = true;
    $('drawerBackdrop').hidden = false;
    $('drawer').inert = false;
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawer').classList.add('open');
    $('menuButton').setAttribute('aria-expanded', 'true');
    $('menuButton').setAttribute('aria-label', 'メニューを閉じる');
    $('menuClose').focus();
  }
  function closeDrawer() {
    if (!state.open) return;
    state.open = false;
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('drawer').inert = true;
    $('drawerBackdrop').hidden = true;
    $('menuButton').setAttribute('aria-expanded', 'false');
    $('menuButton').setAttribute('aria-label', 'メニューを開く');
    $('menuButton').focus();
  }

  function apiBase() {
    const configured = state.config?.auth?.apiBase || API_FALLBACK;
    try {
      const u = new URL(configured);
      if (u.protocol !== 'https:' || u.origin !== 'https://153-127-64-17.sslip.io') return API_FALLBACK;
      return u.href.replace(/\/$/, '');
    } catch {return API_FALLBACK;}
  }

  function ensureDevice() {
    let id = getStorage(localStorage, 'yplus.device.v1');
    if (!/^[a-f0-9]{24,64}$/i.test(id)) {
      if (crypto.randomUUID) id = crypto.randomUUID().replaceAll('-', '');
      else {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      }
      setStorage(localStorage, 'yplus.device.v1', id);
    }
    state.device = id;
  }

  async function fetchAPI(path, options = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(apiBase() + path, {
        method: options.method || 'GET', cache: 'no-store', mode: 'cors',
        headers: {'Content-Type': 'application/json', ...(options.token ? {'Authorization': 'Bearer ' + options.token} : {})},
        body: options.payload ? JSON.stringify(options.payload) : undefined,
        signal: controller.signal
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const message = String(data.error || ('通信エラー HTTP ' + r.status)).slice(0, 250);
        const error = new Error(message);
        error.status = r.status;
        throw error;
      }
      return data;
    } finally {clearTimeout(id);}
  }

  function showAuth() {
    $('adminError').textContent = '';
    $('pinInput').value = '';
    $('adminPanel').hidden = true;
    $('pinForm').hidden = false;
  }
  function hideAdmin() {
    if ($('adminDialog').open) $('adminDialog').close();
    $('pinInput').value = '';
    $('adminError').textContent = '';
    state.tapCount = 0;
  }
  function showAdmin() {
    if (!$('adminDialog').open) $('adminDialog').showModal();
    showAuth();
    // Session token is never considered valid until checked server-side.
    const saved = getStorage(sessionStorage, 'yplus.admin.token');
    if (saved) {
      fetchAPI('/admin/state', {token: saved}).then(() => {
        if ($('adminDialog').open) authorize(saved);
      }).catch(() => {
        removeStorage(sessionStorage, 'yplus.admin.token');
        $('pinInput').focus();
      });
    } else $('pinInput').focus();
  }

  function authorize(token) {
    state.token = token;
    setStorage(sessionStorage, 'yplus.admin.token', token);
    $('pinForm').hidden = true;
    $('adminPanel').hidden = false;
    $('adminError').textContent = '';
    const preview = $('adminPreview');
    preview.replaceChildren();
    const menuNames = (state.config?.menu || []).map(x => x.title).join(' / ');
    preview.append(create('strong', '', '現在のメニュー'), create('p', '', menuNames || '未設定'));
    preview.append(create('strong', '', 'プロフィール'), create('p', '', state.config?.profile?.displayName || 'Y++'));
    preview.append(create('strong', '', '編集機能'), create('p', '', '今後追加予定：ツールカードの追加・並び替え、プロフィール編集'));
  }

  async function login(e) {
    e.preventDefault();
    if (state.authenticating) return;
    const pin = $('pinInput').value.replace(/\D/g, '').slice(0, 20);
    if (!pin) {$('adminError').textContent = '数字の暗証番号を入力してください。';return;}
    state.authenticating = true;
    const submit = $('pinForm').querySelector('button[type=submit]');
    submit.disabled = true;
    $('adminError').textContent = '';
    try {
      const result = await fetchAPI('/login', {
        method: 'POST', payload: {device: state.device, pin}
      });
      if (typeof result.token !== 'string' || !result.token) throw new Error('認証トークンを取得できませんでした。');
      await fetchAPI('/admin/state', {token: result.token});
      authorize(result.token);
    } catch(err) {
      $('adminError').textContent = err.name === 'AbortError'
        ? '通信がタイムアウトしました。接続を確認してください。'
        : String(err.message || '認証できませんでした。');
    } finally {
      $('pinInput').value = '';
      submit.disabled = false;
      state.authenticating = false;
    }
  }

  function onBrandTap() {
    const now = Date.now();
    if (now - state.lastTap > 6000) state.tapCount = 0;
    state.lastTap = now;
    state.tapCount++;
    if (state.tapCount >= 10) {
      state.tapCount = 0;
      clearTimeout(state.timer);
      showAdmin();
    } else {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {state.tapCount = 0;}, 6000);
    }
  }

  async function loadConfig() {
    try {
      const resp = await fetch('./site.config.json', {cache: 'no-store'});
      if (!resp.ok) throw new Error('設定ファイルを読み込めません');
      const config = await resp.json();
      state.config = config;
      $('heroEyebrow').textContent = String(config.eyebrow || 'Y++ TOOLS / PORTAL').slice(0, 100);
      $('heroTitle').textContent = String(config.hero?.title || '創る、つなぐ、楽しむ。').slice(0, 100);
      // Hero line break is part of the default design; do not use innerHTML from config.
      if (config.hero?.title === '創る、つなぐ、楽しむ。') {
        $('heroTitle').replaceChildren('創る、', document.createElement('br'));
        const em = document.createElement('em');em.textContent = 'つなぐ、';
        $('heroTitle').append(em, document.createTextNode('楽しむ。'));
      }
      $('heroDescription').textContent = String(config.hero?.description || '').slice(0, 500);
      loadMenu(config.menu);
      renderProfile(config.profile);
    } catch(err) {
      loadMenu([{id: 'yobs', title:'Y-OBS', subtitle:'配信を見る', icon:'monitor-play', href:'#y-obs',status:'ready'}]);
      renderProfile({});
      console.warn('Y++ config:', err.message);
    }
  }

  $('menuButton').addEventListener('click', () => state.open ? closeDrawer() : openDrawer());
  $('menuClose').addEventListener('click', closeDrawer);
  $('drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {if (e.key === 'Escape') closeDrawer();});
  $('brandButton').addEventListener('click', onBrandTap);
  $('adminClose').addEventListener('click', hideAdmin);
  $('adminDialog').addEventListener('click', e => {
    if (e.target === $('adminDialog')) hideAdmin();
  });
  $('pinForm').addEventListener('submit', login);
  $('pinInput').addEventListener('input', () => {
    const f = $('pinInput');
    f.value = f.value.replace(/\D/g, '');
  });
  $('adminLogout').addEventListener('click', async () => {
    const token = state.token;
    state.token = '';
    removeStorage(sessionStorage, 'yplus.admin.token');
    if (token) await fetchAPI('/admin/logout', {method:'POST', payload:{}, token}).catch(() => {});
    showAuth();
  });
  window.addEventListener('pagehide', () => {
    state.token = '';
    $('pinInput').value = '';
  });
  $('copyrightYear').textContent = String(new Date().getFullYear());
  ensureDevice();
  loadConfig();
})();

[executed on device: hiratayuusukenoMacBook-Air.local (348dc674-ae2f-4808-9160-3521fd911771)]