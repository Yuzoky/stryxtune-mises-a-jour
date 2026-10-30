'use strict';

const STORE_KEY = 'stryxmdp';
const SETTINGS_KEY = 'stryxmdp-settings';
const CLIPBOARD_CLEAR_MS = 30000;
const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
const CATEGORIES = [
  { id: 'jeux', label: 'Jeux' },
  { id: 'social', label: 'Réseaux' },
  { id: 'mail', label: 'E-mail' },
  { id: 'banque', label: 'Banque' },
  { id: 'travail', label: 'Travail' },
  { id: 'autre', label: 'Autre' },
];
const PAGES = ['home', 'pw', 'plan', 'settings'];

const $ = (id) => document.getElementById(id);
const state = {
  session: null,      // { key, salt, iterations } — uniquement en mémoire
  items: [],
  planning: null,
  sync: null,         // liaison du planning automatique (clé privée incluse), stockée dans le coffre
  page: 'home',
  filter: 'all',
  query: '',
  current: null,      // identifiant ouvert dans la feuille de détail
  pendingImport: null,
  hiddenAt: 0,
  lockTimer: 0,
  syncStatus: 'idle', // idle | loading | ok | waiting | none | error | unavailable
  syncAsked: 0,
};

/* ---------- Stockage ---------- */

const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignoré */ } },
};

const settings = Object.assign({ autolock: 300 }, storage.get(SETTINGS_KEY));
const saveSettings = () => storage.set(SETTINGS_KEY, settings);

async function persist() {
  const blob = await VaultCrypto.encrypt(state.session, { items: state.items, planning: state.planning, sync: state.sync });
  storage.set(STORE_KEY, blob);
}

/* ---------- Utilitaires UI ---------- */

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function openSheet(id) {
  const s = $(id);
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add('open'));
}
function closeSheet(id) {
  const s = $(id);
  s.classList.remove('open');
  setTimeout(() => { if (!s.classList.contains('open')) s.hidden = true; }, 240);
}
function closeAllSheets() {
  document.querySelectorAll('.sheet').forEach((s) => { s.classList.remove('open'); s.hidden = true; });
}

function setStrength(el, pw) {
  const score = VaultCrypto.strength(pw);
  el.dataset.score = score;
  el.title = ['', 'Faible', 'Moyen', 'Bon', 'Excellent'][score];
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// Icône du sprite SVG (<svg class="ic"><use href="#i-…"/></svg>).
function icon(name, cls = 'ic') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const weakLabel = (n) => (n > 1 ? `${n} mots de passe faibles` : `${n} mot de passe faible`);

function timeAgo(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'à l\'instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `le ${new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
}

/* ---------- Logos des sites ---------- */

// Noms courants sans adresse web → domaine du site.
const KNOWN_SITES = {
  steam: 'steampowered.com', discord: 'discord.com', instagram: 'instagram.com', insta: 'instagram.com',
  facebook: 'facebook.com', messenger: 'messenger.com', whatsapp: 'whatsapp.com', snapchat: 'snapchat.com', snap: 'snapchat.com',
  tiktok: 'tiktok.com', twitter: 'x.com', x: 'x.com', youtube: 'youtube.com', twitch: 'twitch.tv', reddit: 'reddit.com',
  telegram: 'telegram.org', linkedin: 'linkedin.com', pinterest: 'pinterest.com', bereal: 'bereal.com',
  google: 'google.com', gmail: 'gmail.com', outlook: 'outlook.com', hotmail: 'outlook.com', yahoo: 'yahoo.com',
  icloud: 'icloud.com', apple: 'apple.com', microsoft: 'microsoft.com', proton: 'proton.me', protonmail: 'proton.me',
  netflix: 'netflix.com', spotify: 'spotify.com', deezer: 'deezer.com', disney: 'disneyplus.com', primevideo: 'primevideo.com',
  amazon: 'amazon.fr', paypal: 'paypal.com', revolut: 'revolut.com', lydia: 'lydia-app.com', boursorama: 'boursorama.com',
  epicgames: 'epicgames.com', epic: 'epicgames.com', fortnite: 'fortnite.com', riot: 'riotgames.com', riotgames: 'riotgames.com',
  valorant: 'playvalorant.com', leagueoflegends: 'leagueoflegends.com', lol: 'leagueoflegends.com',
  playstation: 'playstation.com', psn: 'playstation.com', xbox: 'xbox.com', nintendo: 'nintendo.com', ubisoft: 'ubisoft.com',
  ea: 'ea.com', battlenet: 'battle.net', blizzard: 'blizzard.com', roblox: 'roblox.com', minecraft: 'minecraft.net',
  rockstar: 'rockstargames.com', faceit: 'faceit.com', uber: 'uber.com', ubereats: 'ubereats.com', deliveroo: 'deliveroo.fr',
  vinted: 'vinted.fr', leboncoin: 'leboncoin.fr', shein: 'shein.com', temu: 'temu.com', zalando: 'zalando.fr',
  burgerking: 'burgerking.fr', mcdonalds: 'mcdonalds.fr', sncf: 'sncf-connect.com', ameli: 'ameli.fr', caf: 'caf.fr',
  impots: 'impots.gouv.fr', franceconnect: 'franceconnect.gouv.fr', orange: 'orange.fr', sfr: 'sfr.fr', free: 'free.fr',
  bouygues: 'bouyguestelecom.fr', github: 'github.com', chatgpt: 'chatgpt.com', claude: 'claude.ai', canva: 'canva.com',
};

function siteDomain(it) {
  if (it.url) {
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(it.url) ? it.url : 'https://' + it.url);
      if (u.hostname.includes('.')) return u.hostname.replace(/^www\./, '');
    } catch { /* adresse invalide : on essaie le nom */ }
  }
  const title = (it.title || '').trim().toLowerCase();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(title)) return title.replace(/^www\./, '');
  const key = title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  return KNOWN_SITES[key] || KNOWN_SITES[key.split(/\d/)[0]] || '';
}

// Sites sans logo (pour ne pas les redemander pendant la session).
const iconFailed = new Set();

// Remplit une pastille : logo du site si disponible, sinon l'initiale.
function fillAvatar(av, it) {
  av.replaceChildren();
  av.classList.remove('has-icon');
  av.textContent = ((it.title || '?')[0] || '?').toUpperCase();
  const domain = settings.icons !== false ? siteDomain(it) : '';
  if (!domain || iconFailed.has(domain)) return;
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  const show = () => {
    av.textContent = '';
    av.append(img);
    av.classList.add('has-icon');
  };
  img.onload = () => {
    if (img.naturalWidth < 8) { iconFailed.add(domain); return; } // icône vide
    show();
  };
  img.onerror = () => iconFailed.add(domain);
  img.src = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
  if (img.complete && img.naturalWidth >= 8) show(); // déjà en cache : pas de clignotement
}

const catOf = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];

function safeUrl(u) {
  if (!u) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}

// Présent uniquement dans l'application Android (pont natif).
const native = window.StryxAndroid || null;

async function copy(text, label) {
  if (!text) { toast(`Pas de ${label.toLowerCase()} enregistré`); return; }
  if (native) {
    native.copy(text);
    toast(`${label} copié · effacé dans 30 s`);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copié · effacé dans 30 s`);
    setTimeout(async () => {
      try {
        if (document.hasFocus() && (await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText('');
      } catch { /* lecture du presse-papiers refusée : rien à faire */ }
    }, CLIPBOARD_CLEAR_MS);
  } catch {
    toast('Copie impossible sur cet appareil');
  }
}

// Copie d'un texte non secret (code de liaison) : pas d'effacement automatique.
function copyPlain(text, label) {
  if (native && native.copyPlain) { native.copyPlain(text); toast(`${label} copié`); return; }
  if (native) { native.copy(text); toast(`${label} copié`); return; }
  navigator.clipboard.writeText(text).then(() => toast(`${label} copié`), () => toast('Copie impossible sur cet appareil'));
}

// Empêche une double validation (double appui sur OK / double clic).
function once(fn) {
  let busy = false;
  return async (...args) => {
    if (busy) return;
    busy = true;
    try { await fn(...args); } finally { setTimeout(() => { busy = false; }, 400); }
  };
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/* ---------- Fond étoilé ---------- */

function starfield() {
  const c = $('stars');
  const ctx = c.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let stars = [];
  let running = false;
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((innerWidth * innerHeight) / 5200);
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: Math.random() * 1.2 + 0.2,
      a: Math.random() * 6,
      s: Math.random() * 0.015 + 0.003,
      v: Math.random() * 0.08 + 0.02,
    }));
  }
  function draw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.fillStyle = '#fff';
    for (const st of stars) {
      st.a += st.s;
      st.y -= st.v;
      if (st.y < 0) st.y = innerHeight;
      ctx.globalAlpha = 0.25 + Math.abs(Math.sin(st.a)) * 0.75;
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function frame() {
    draw();
    if (!reduce && !document.hidden) requestAnimationFrame(frame);
    else running = false;
  }
  function start() {
    if (reduce) { draw(); return; }
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  }
  resize();
  start();
  addEventListener('resize', () => { resize(); if (reduce) draw(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
}

/* ---------- Écran de verrouillage ---------- */

function lockMode() {
  const exists = !!storage.get(STORE_KEY);
  const creating = !exists && !state.pendingImport;
  $('confirm-field').hidden = !creating;
  $('master2').required = creating;
  $('strength-master').hidden = !creating;
  $('lock-btn').textContent = state.pendingImport ? 'Restaurer' : creating ? 'Créer mon coffre' : 'Déverrouiller';
  $('lock-hint').textContent = state.pendingImport
    ? 'Entre le mot de passe maître de la sauvegarde.'
    : creating
      ? 'Choisis un mot de passe maître. Il protège tout le coffre et ne peut pas être récupéré : ne l\'oublie pas.'
      : '';
  $('master').autocomplete = creating ? 'new-password' : 'current-password';
  $('restore-btn').textContent = state.pendingImport ? 'Annuler la restauration' : 'Restaurer une sauvegarde';
  $('bio-btn').hidden = !(exists && !state.pendingImport && bio.enabled());
  return creating;
}

function lock() {
  state.session = null;
  state.items = [];
  state.planning = null;
  state.sync = null;
  state.current = null;
  state.syncStatus = 'idle';
  clearTimeout(state.lockTimer);
  closeAllSheets();
  wipeScreen();
  $('vault').hidden = true;
  $('lock').hidden = false;
  $('lock-error').textContent = '';
  lockMode();
}

// Retire de l'écran tout ce qui est secret (mots de passe, planning, champs remplis).
function wipeScreen() {
  bio.pendingPw = null;
  csvPending = [];
  ['list', 'days', 'timeline', 'rest-list', 'day-strip', 'team-sum', 'plan-next', 'csv-preview', 'home-next', 'home-bars'].forEach((id) => $(id).replaceChildren());
  ['v-pass', 'v-user', 'v-title', 'v-notes', 'v-url', 'gen-out', 'sync-code', 'home-team-sub'].forEach((id) => { $(id).textContent = ''; });
  document.querySelectorAll('input[type=password], input[type=text], input[type=search], textarea, #f-title, #f-user, #f-url').forEach((i) => { i.value = ''; });
  document.querySelectorAll('[data-toggle]').forEach((b) => { $(b.dataset.toggle).type = 'password'; });
  $('f-pass').type = 'password';
  state.query = '';
}

async function onUnlock(e, bioPassword) {
  if (e) e.preventDefault();
  const viaBio = typeof bioPassword === 'string';
  const pw = viaBio ? bioPassword : $('master').value;
  const err = $('lock-error');
  const btn = $('lock-btn');
  err.textContent = '';
  const creating = lockMode();

  if (creating) {
    if (pw.length < 8) { err.textContent = '8 caractères minimum.'; return; }
    if (pw !== $('master2').value) { err.textContent = 'Les mots de passe ne correspondent pas.'; return; }
  }

  btn.disabled = true;
  btn.classList.add('loading');
  try {
    if (creating) {
      state.session = await VaultCrypto.newKey(pw);
      state.items = [];
      state.planning = null;
      state.sync = null;
      await persist();
    } else {
      const blob = state.pendingImport || storage.get(STORE_KEY);
      const res = await VaultCrypto.open(pw, blob);
      state.session = res.session;
      state.items = Array.isArray(res.data.items) ? res.data.items : [];
      state.planning = res.data.planning || null;
      state.sync = res.data.sync && res.data.sync.priv ? res.data.sync : null;
      if (state.pendingImport) {
        storage.set(STORE_KEY, state.pendingImport);
        state.pendingImport = null;
        bio.disable(); // la sauvegarde peut avoir un autre mot de passe maître
        toast('Sauvegarde restaurée');
      }
    }
  } catch (ex) {
    if (viaBio) {
      // Le mot de passe maître a changé depuis l'activation : on repart du mot de passe.
      bio.disable();
      lockMode();
      err.textContent = 'Empreinte désactivée : entre ton mot de passe maître.';
      return;
    }
    err.textContent = ex && ex.message === 'format' ? 'Fichier de sauvegarde invalide.' : 'Mot de passe incorrect.';
    $('lock-form').classList.remove('shake');
    void $('lock-form').offsetWidth;
    $('lock-form').classList.add('shake');
    return;
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
  // Coffre ouvert : la suite ne peut plus être prise pour un mauvais mot de passe.
  $('master').value = '';
  $('master2').value = '';
  $('lock').hidden = true;
  $('vault').hidden = false;
  try {
    if (!viaBio) bio.offer(pw);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    render();
    showPage(PAGES.includes(settings.page) ? settings.page : 'home', { instant: true });
  } catch (ex) {
    console.error(ex);
    try { showPage('pw', { instant: true }); } catch { /* affichage minimal */ }
    toast('Un affichage a échoué, tes données sont intactes');
  }
  armAutolock();
  sync.fetch(false);
}

/* ---------- Verrouillage automatique ---------- */

function armAutolock() {
  clearTimeout(state.lockTimer);
  if (!state.session || !settings.autolock) return;
  state.lockTimer = setTimeout(lock, settings.autolock * 1000);
}

['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) =>
  addEventListener(ev, () => { if (state.session) armAutolock(); }, { passive: true, capture: true }));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { state.hiddenAt = Date.now(); return; }
  // En revenant dans l'appli : verrouille si on est resté absent trop longtemps (30 s max).
  const limit = settings.autolock ? Math.min(settings.autolock, 30) * 1000 : 0;
  if (state.session && limit && Date.now() - state.hiddenAt >= limit) {
    lock();
    bio.prompt();
    return;
  }
  if (state.session) {
    sync.fetch(false);
    updateHeader();
    if (state.page === 'home') renderHome();
  } else if (!$('lock').hidden) {
    bio.prompt();
  }
});

/* ---------- Navigation ---------- */

function pageTitle(name) {
  const dash = Planning.dashboard(state.planning);
  const today = capitalize(new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }));
  switch (name) {
    case 'home': {
      const h = new Date().getHours();
      const hello = h >= 18 || h < 5 ? 'Bonsoir' : 'Salut';
      return { kicker: today, title: dash.name ? `${hello} ${dash.name}` : hello };
    }
    case 'pw': return { kicker: plural(state.items.length, 'identifiant'), title: 'Mots de passe' };
    case 'plan': return { kicker: today, title: 'Planning' };
    default: return { kicker: 'Stryx Hub', title: 'Réglages' };
  }
}

function updateHeader() {
  const { kicker, title } = pageTitle(state.page);
  $('page-kicker').textContent = kicker;
  $('page-title').textContent = title;
}

function showPage(name, opts = {}) {
  if (!PAGES.includes(name)) name = 'home';
  const changed = state.page !== name;
  state.page = name;
  settings.page = name;
  saveSettings();
  PAGES.forEach((p) => {
    const page = $(`page-${p}`);
    const visible = p === name;
    if (visible && (changed || opts.instant)) {
      page.hidden = false;
      page.style.animation = 'none';
      void page.offsetWidth;
      page.style.animation = '';
    } else {
      page.hidden = !visible;
    }
  });
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === name));
  if (name === 'home') renderHome();
  if (name === 'pw') render();
  if (name === 'plan') { Planning.show(state.planning); updatePlanSyncButton(); }
  if (name === 'settings') refreshSettings();
  updateHeader();
  if (changed) window.scrollTo({ top: 0, behavior: opts.instant ? 'auto' : 'smooth' });
}

document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showPage(t.dataset.page); });

/* ---------- Accueil ---------- */

function renderHome() {
  if (!state.session) return;
  const dash = Planning.dashboard(state.planning);

  // Prochain service
  const hero = $('home-next');
  hero.classList.toggle('empty-hero', !dash.next);
  if (dash.next) {
    const n = dash.next;
    const meta = el('div', 'hero-meta');
    const pill = el('span', 'pill accent');
    pill.append(icon('clock'), document.createTextNode(n.countdown));
    meta.append(pill, el('span', 'pill', n.dur), el('span', 'pill', n.label));
    if (n.note) {
      const sw = el('span', 'pill swap');
      sw.append(icon('swap'), document.createTextNode(n.note));
      meta.append(sw);
    }
    const parts = [
      icon('calendar', 'ic hero-ic'),
      el('small', 'kicker', n.ongoing ? 'En service' : 'Prochain service'),
      el('span', 'hero-day', n.dayLabel),
      el('span', 'hero-time', `${n.start} – ${n.end}`),
      meta,
    ];
    if (n.then.length) parts.push(el('div', 'hero-then', `Puis ${n.then.join(' · ')}`));
    if (n.ongoing) {
      const bar = el('div', 'hero-progress');
      const fill = el('i');
      fill.style.width = `${Math.round(n.progress * 100)}%`;
      bar.append(fill);
      parts.push(bar);
    }
    hero.replaceChildren(...parts);
  } else if (dash.empty) {
    hero.replaceChildren(
      icon('link', 'ic hero-ic'),
      el('small', 'kicker', 'Planning'),
      el('span', 'hero-time', 'Ajoute ton planning'),
      el('span', 'hero-day', !sync.supported() ? 'Colle un code planning envoyé par Claude (page Planning).'
        : state.sync ? 'En attente du premier planning de Claude.' : 'Connecte le planning automatique : Claude l\'enverra directement ici.'),
    );
  } else {
    hero.replaceChildren(
      icon('calendar', 'ic hero-ic'),
      el('small', 'kicker', 'Planning'),
      el('span', 'hero-time', 'Rien de prévu'),
      el('span', 'hero-day', 'Aucun service à venir dans ton planning.'),
    );
  }

  // Semaine : anneau heures / contrat + barres par jour
  const w = dash.week;
  const goal = w.contract || Math.max(w.total, 1);
  const ratio = w.hasData ? Math.min(1, w.total / goal) : 0;
  $('home-ring').style.strokeDashoffset = String(263.9 * (1 - ratio));
  $('home-hours').textContent = w.hasData ? w.fmtTotal : '—';
  $('home-contract').textContent = w.hasData ? (w.fmtContract ? `sur ${w.fmtContract}` : 'cette semaine') : 'cette semaine';
  const max = Math.max(8 * 60, ...w.perDay);
  $('home-bars').replaceChildren(...['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => {
    const b = el('div', 'bar' + (w.perDay[i] ? ' on' : '') + (i === w.todayIdx ? ' today' : ''));
    const fill = el('i');
    fill.style.height = `${Math.max(4, Math.round((w.perDay[i] / max) * 62))}px`;
    b.append(fill, el('small', '', d));
    return b;
  }));

  // Équipe aujourd'hui
  if (dash.today) {
    $('home-team-count').textContent = plural(dash.today.count, 'personne');
    $('home-team-sub').textContent = dash.today.meWorking
      ? (dash.today.withMe.length ? `Avec toi : ${dash.today.withMe.slice(0, 4).join(', ')}${dash.today.withMe.length > 4 ? '…' : ''}` : 'au travail aujourd\'hui')
      : 'au travail aujourd\'hui · toi en repos';
  } else {
    $('home-team-count').textContent = 'Équipe';
    $('home-team-sub').textContent = dash.empty ? 'Le planning d\'équipe apparaîtra ici.' : 'Pas de planning d\'équipe cette semaine.';
  }

  // Coffre
  const n = state.items.length;
  const weak = state.items.filter((it) => it.pass && VaultCrypto.strength(it.pass) < 2).length;
  $('home-vault-count').textContent = plural(n, 'identifiant');
  $('home-vault-health').textContent = n ? (weak ? `${weakLabel(weak)} à changer` : 'Tous tes mots de passe sont solides') : 'Ajoute ton premier mot de passe';
  const score = n ? (n - weak) / n : 0;
  const health = $('home-health');
  health.className = 'health' + (score < 0.5 ? ' low' : score < 0.85 ? ' mid' : '');
  health.firstElementChild.style.width = `${Math.round(score * 100)}%`;

  renderSyncLine();
}

function renderSyncLine() {
  const line = $('home-sync');
  const dot = el('i', 'dot');
  let text;
  line.classList.remove('ok');
  if (!native || !native.fetchPlanning) {
    line.hidden = true;
    return;
  }
  line.hidden = false;
  if (!state.sync) {
    line.replaceChildren(icon('link'), el('span', '', ''));
    line.lastChild.append(el('b', '', 'Planning automatique'), document.createTextNode(' · touche pour connecter ce téléphone'));
    return;
  }
  const st = state.syncStatus;
  if (st === 'loading') { text = 'Recherche d\'un nouveau planning…'; dot.classList.add('wait'); }
  else if (st === 'error') { text = 'Hors ligne · dernier planning gardé'; dot.classList.add('err'); }
  else if (st === 'bad') { text = 'Planning reçu illisible · dernier planning gardé'; dot.classList.add('err'); }
  else if (st === 'waiting') { text = 'En attente d\'un planning pour ce téléphone'; dot.classList.add('wait'); }
  else if (state.sync.lastAt) { text = `Planning synchronisé ${timeAgo(state.sync.lastAt)}`; dot.classList.add('ok'); line.classList.add('ok'); }
  else { text = 'Connecté · en attente du premier planning de Claude'; dot.classList.add('wait'); }
  line.replaceChildren(dot, el('span', '', text));
}

$('home-next').onclick = () => {
  const dash = Planning.dashboard(state.planning);
  if (dash.empty && sync.supported() && !state.sync) { sync.openSheet(); return; }
  showPage('plan');
  Planning.openMine();
};
$('home-week').onclick = () => {
  showPage('plan');
  Planning.openMine();
};
$('home-team').onclick = () => {
  showPage('plan');
  Planning.openTeamToday();
};
$('home-sync').onclick = () => sync.openSheet();
$('home-gen').onclick = () => openGenerator(false);
$('home-add').onclick = () => openEdit(null);

// Appelé par planning.js après chaque affichage (titre, bouton de synchro).
window.onPlanningRendered = () => {
  if (state.page === 'plan') updateHeader();
  updatePlanSyncButton();
};

/* ---------- Liste des mots de passe ---------- */

function renderChips() {
  const chips = $('chips');
  const counts = {};
  state.items.forEach((it) => { counts[it.cat] = (counts[it.cat] || 0) + 1; });
  const all = [{ id: 'all', label: 'Tout' }, ...CATEGORIES.filter((c) => counts[c.id])];
  if (!all.some((c) => c.id === state.filter)) state.filter = 'all';
  chips.replaceChildren(...all.map((c) => {
    const b = el('button', 'chip' + (state.filter === c.id ? ' active' : ''), c.id === 'all' ? `Tout · ${state.items.length}` : `${c.label} · ${counts[c.id]}`);
    b.type = 'button';
    b.onclick = () => { state.filter = c.id; render(); };
    return b;
  }));
}

function render() {
  renderChips();
  const q = state.query.trim().toLowerCase();
  const list = state.items
    .filter((it) => state.filter === 'all' || it.cat === state.filter)
    .filter((it) => !q || [it.title, it.user, it.url].some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));

  const weak = state.items.filter((it) => it.pass && VaultCrypto.strength(it.pass) < 2).length;
  $('stats').textContent = state.items.length
    ? (q || state.filter !== 'all' ? `${plural(list.length, 'résultat')}` : (weak ? `${weakLabel(weak)} à renforcer` : 'Tous tes mots de passe sont solides'))
    : '';

  $('empty').hidden = state.items.length > 0;
  $('list').replaceChildren(...list.map((it, i) => {
    const li = el('li', 'item card');
    li.style.animationDelay = Math.min(i * 25, 300) + 'ms';
    const av = el('div', 'avatar');
    fillAvatar(av, it);
    const txt = el('div', 'item-txt');
    txt.append(el('b', '', it.title), el('span', '', it.user || catOf(it.cat).label));
    li.append(av, txt);
    if (it.pass && VaultCrypto.strength(it.pass) < 2) li.append(el('span', 'weak-tag', 'Faible'));
    const cp = el('button', 'icon-btn sm');
    cp.type = 'button';
    cp.setAttribute('aria-label', 'Copier le mot de passe');
    cp.append(icon('copy'));
    cp.onclick = (e) => { e.stopPropagation(); copy(it.pass, 'Mot de passe'); };
    li.append(cp);
    li.onclick = () => openView(it.id);
    return li;
  }));
  if (state.page === 'pw') updateHeader();
}

/* ---------- Détail ---------- */

function openView(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  state.current = id;
  fillAvatar($('v-avatar'), it);
  $('v-title').textContent = it.title;
  $('v-cat').textContent = catOf(it.cat).label;
  $('v-user').textContent = it.user || '—';
  $('v-pass').textContent = '••••••••••';
  $('v-pass').dataset.shown = '';
  const href = safeUrl(it.url);
  $('v-url-row').hidden = !it.url;
  $('v-url').textContent = it.url || '';
  if (href) $('v-url').href = href; else $('v-url').removeAttribute('href');
  $('v-notes-row').hidden = !it.notes;
  $('v-notes').textContent = it.notes || '';
  $('v-date').textContent = 'Modifié le ' + new Date(it.updated).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  openSheet('view-sheet');
}

$('v-eye').onclick = () => {
  const it = state.items.find((x) => x.id === state.current);
  if (!it) return;
  const out = $('v-pass');
  const show = !out.dataset.shown;
  out.dataset.shown = show ? '1' : '';
  out.textContent = show ? (it.pass || '—') : '••••••••••';
};

document.querySelectorAll('[data-copy]').forEach((b) => {
  b.onclick = () => {
    const it = state.items.find((x) => x.id === state.current);
    if (!it) return;
    if (b.dataset.copy === 'pass') copy(it.pass, 'Mot de passe');
    else copy(it.user, 'Identifiant');
  };
});

$('v-edit').onclick = () => { closeSheet('view-sheet'); openEdit(state.current); };

/* ---------- Planning : codes, suppression ---------- */

function openPlanCode() {
  $('plan-code').value = '';
  $('plan-error').textContent = '';
  $('plan-clear').hidden = !state.planning;
  $('plan-version').textContent = native && native.appVersion ? `Stryx Hub ${native.appVersion()}` : '';
  openSheet('plan-sheet');
}
$('plan-import').onclick = openPlanCode;
$('s-plancode').onclick = openPlanCode;

$('plan-form').addEventListener('submit', (e) => { e.preventDefault(); addPlanCode(); });
const addPlanCode = once(async () => {
  if (!$('plan-sheet').classList.contains('open')) return;
  let add;
  try {
    add = await Planning.decode($('plan-code').value);
  } catch (ex) {
    const why = ex && ex.message;
    $('plan-error').textContent = why === 'empty' ? 'Colle d\'abord le code (appui long dans la case › Coller).'
      : why === 'linkcode' ? 'Ça, c\'est ton code de liaison (STRYXKEY) : envoie-le à Claude dans la conversation, pas ici.'
        : why === 'inflate' ? 'Ce téléphone ne lit pas les codes compressés : demande à Claude le « code long ».'
          : 'Code incomplet ou abîmé : recopie tout le code envoyé par Claude, du début (STRYXPLAN) jusqu\'à la fin.';
    return;
  }
  state.planning = Planning.merge(state.planning, add);
  await persist();
  $('plan-code').value = '';
  closeSheet('plan-sheet');
  afterPlanningChange();
  const nDays = new Set(add.entries.map((x) => x.date)).size;
  toast(`Planning ajouté ✓ (${plural(nDays, 'jour')})`);
});
$('plan-remove').onclick = async () => {
  const wk = Planning.currentWeek();
  if (!wk || !confirm(`Supprimer le planning ${Planning.weekLabel(wk)} ?`)) return;
  state.planning = Planning.removeWeek(state.planning, wk);
  await persist();
  afterPlanningChange();
  toast('Semaine supprimée');
};
$('plan-clear').onclick = async () => {
  if (!confirm('Effacer TOUT le planning (toutes les semaines) ?')) return;
  state.planning = null;
  await persist();
  closeSheet('plan-sheet');
  afterPlanningChange();
  toast('Planning effacé');
};

function afterPlanningChange() {
  if (state.page === 'plan') { Planning.show(state.planning); updatePlanSyncButton(); }
  if (state.page === 'home') renderHome();
  updateHeader();
}

/* ---------- Planning automatique (synchronisation chiffrée) ---------- */

const sync = {
  supported: () => !!(native && native.fetchPlanning),

  fetch(manual) {
    if (!state.session || !state.sync || !sync.supported()) return;
    if (!manual && Date.now() - state.syncAsked < SYNC_MIN_INTERVAL_MS) return;
    state.syncAsked = Date.now();
    state.syncStatus = 'loading';
    sync.manual = manual;
    sync.refreshUi();
    native.fetchPlanning();
  },

  // Applique un planning reçu : semaines retirées, puis semaines ajoutées ou remplacées.
  // Les identifiants d'envoi commencent par la date (AAAAMMJJTHHMMSSZ) : un envoi plus ancien
  // que le dernier appliqué n'est jamais réappliqué. Un « Actualiser » peut rejouer le même envoi.
  async apply(payload, manual) {
    const last = state.sync.lastId || '';
    if (payload.id < last || (payload.id === last && !manual)) return false;
    let plan = state.planning;
    for (const wk of Array.isArray(payload.removeWeeks) ? payload.removeWeeks : []) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(wk)) plan = Planning.removeWeek(plan, wk);
    }
    for (const obj of Array.isArray(payload.plans) ? payload.plans : []) {
      if (!obj || !/^\d{4}-\d{2}-\d{2}$/.test(obj.week || '') || !Array.isArray(obj.people)) continue;
      try {
        plan = Planning.merge(plan, Planning.fromTeam(obj));
      } catch { /* semaine mal formée : ignorée */ }
    }
    state.planning = plan;
    state.sync.lastId = payload.id;
    state.sync.lastAt = Date.now();
    await persist();
    return true;
  },

  async receive(ok, text) {
    if (!state.session || !state.sync) return;
    const manual = sync.manual;
    sync.manual = false;
    if (!ok) {
      state.syncStatus = text === 'none' ? 'none' : 'error';
      sync.refreshUi();
      if (manual) toast(text === 'none' ? 'Pas encore de planning envoyé par Claude' : 'Connexion impossible pour le moment');
      return;
    }
    try {
      // Nouvelle version native : tableau de toutes les copies trouvées ; ancienne : une seule.
      let bodies;
      try { bodies = JSON.parse(text); } catch { bodies = null; }
      if (!Array.isArray(bodies)) bodies = [text];
      let best = null;
      let otherKey = false;
      for (const body of bodies) {
        try {
          const env = typeof body === 'string' ? JSON.parse(body) : body;
          const payload = await PlanSync.open(env, state.sync);
          if (!best || payload.id > best.id) best = payload;
        } catch (e) {
          if (e && e.message === 'other-key') otherKey = true;
        }
      }
      if (!best) throw new Error(otherKey ? 'other-key' : 'unreadable');
      const changed = await sync.apply(best, manual);
      state.syncStatus = 'ok';
      if (!state.sync.lastAt) state.sync.lastAt = Date.now();
      if (changed) {
        afterPlanningChange();
        toast('Planning mis à jour automatiquement ✓');
      } else if (manual) {
        toast('Ton planning est déjà à jour');
      }
    } catch (ex) {
      // Fichier chiffré pour une autre liaison (ancien téléphone) : on attend le prochain envoi.
      state.syncStatus = ex && ex.message === 'other-key' ? 'waiting' : 'bad';
      if (manual) toast(state.syncStatus === 'waiting' ? 'En attente d\'un planning pour ce téléphone' : 'Planning reçu illisible : demande à Claude de le renvoyer');
    }
    sync.refreshUi();
  },

  statusText() {
    if (!sync.supported()) return 'Disponible dans l\'appli Android';
    if (!state.sync) return 'Non connecté · touche pour connecter';
    switch (state.syncStatus) {
      case 'loading': return 'Recherche d\'un nouveau planning…';
      case 'error': return 'Hors ligne pour le moment';
      case 'bad': return 'Planning reçu illisible';
      case 'waiting': return 'En attente d\'un planning pour ce téléphone';
      case 'none': return state.sync.lastAt ? `À jour · ${timeAgo(state.sync.lastAt)}` : 'Connecté · en attente du premier planning';
      default: return state.sync.lastAt ? `Synchronisé ${timeAgo(state.sync.lastAt)}` : 'Connecté · en attente du premier planning';
    }
  },

  openSheet() {
    if (!sync.supported()) { toast('Le planning automatique marche dans l\'appli Android'); return; }
    sync.refreshSheet();
    openSheet('sync-sheet');
  },

  refreshSheet() {
    const on = !!state.sync;
    $('sync-off').hidden = on;
    $('sync-on').hidden = !on;
    $('sync-actions-off').hidden = on;
    $('sync-actions-on').hidden = !on;
    $('sync-error').textContent = '';
    if (on) {
      $('sync-code').textContent = state.sync.code;
      const st = state.syncStatus;
      const dot = el('i', 'dot' + (st === 'error' || st === 'bad' ? ' err' : st === 'waiting' || !state.sync.lastAt ? ' wait' : ' ok'));
      $('sync-status').replaceChildren(dot, el('span', '', `${sync.statusText()} · clé ${state.sync.kid}`));
    }
  },

  refreshUi() {
    if (!$('sync-sheet').hidden) sync.refreshSheet();
    if (state.page === 'home') renderSyncLine();
    if (state.page === 'settings') refreshSettings();
    updatePlanSyncButton();
  },
};

function updatePlanSyncButton() {
  const btn = $('plan-sync-btn');
  btn.hidden = !sync.supported();
  $('plan-empty-txt').textContent = !sync.supported()
    ? 'Envoie une photo de ton planning à Claude : il te donnera un code à coller ici (« Coller un code »).'
    : state.sync ? 'Connecté : le prochain planning envoyé par Claude arrivera ici automatiquement.'
      : 'Connecte le planning automatique une fois : Claude l\'enverra ensuite directement ici.';
  $('plan-sync-label').textContent = state.sync ? (state.syncStatus === 'loading' ? 'Recherche…' : 'Actualiser') : 'Planning automatique';
}

window.stryxSync = (ok, text) => { sync.receive(ok, text); };

$('plan-sync-btn').onclick = () => { if (state.sync) sync.fetch(true); else sync.openSheet(); };
$('s-sync').onclick = () => sync.openSheet();
$('sync-link').onclick = async () => {
  try {
    state.sync = await PlanSync.createLink();
    state.syncStatus = 'idle';
    await persist();
    sync.refreshSheet();
    sync.refreshUi();
    copyPlain(state.sync.code, 'Code de liaison');
  } catch {
    state.sync = null;
    $('sync-error').textContent = 'Impossible de créer la clé sur ce téléphone.';
  }
};
$('sync-copy').onclick = () => state.sync && copyPlain(state.sync.code, 'Code de liaison');
$('sync-code').onclick = () => state.sync && copyPlain(state.sync.code, 'Code de liaison');
$('sync-share').onclick = () => {
  if (!state.sync) return;
  if (native && native.shareText) native.shareText(state.sync.code);
  else copyPlain(state.sync.code, 'Code de liaison');
};
$('sync-refresh').onclick = () => sync.fetch(true);
$('sync-unlink').onclick = async () => {
  if (!confirm('Déconnecter le planning automatique ?\n\nTon planning actuel est gardé. Pour te reconnecter, il faudra renvoyer un nouveau code à Claude.')) return;
  state.sync = null;
  state.syncStatus = 'idle';
  await persist();
  sync.refreshSheet();
  sync.refreshUi();
  toast('Planning automatique déconnecté');
};

/* ---------- Ajout / modification ---------- */

$('f-cat').replaceChildren(...CATEGORIES.map((c) => {
  const o = el('option', '', c.label);
  o.value = c.id;
  return o;
}));

function openEdit(id) {
  const it = id ? state.items.find((x) => x.id === id) : null;
  state.current = it ? it.id : null;
  $('edit-title').textContent = it ? 'Modifier' : 'Nouvel identifiant';
  $('f-title').value = it ? it.title : '';
  $('f-user').value = it ? it.user : '';
  $('f-pass').value = it ? it.pass : '';
  $('f-pass').type = 'password';
  $('f-url').value = it ? it.url : '';
  $('f-cat').value = it ? it.cat : (state.filter !== 'all' ? state.filter : 'jeux');
  $('f-notes').value = it ? it.notes : '';
  $('del-btn').hidden = !it;
  setStrength($('strength-f'), $('f-pass').value);
  openSheet('edit-sheet');
  if (!it) setTimeout(() => $('f-title').focus(), 260);
}

$('f-pass').addEventListener('input', () => setStrength($('strength-f'), $('f-pass').value));

$('edit-form').addEventListener('submit', (e) => { e.preventDefault(); saveEdit(); });
const saveEdit = once(async () => {
  if (!$('edit-sheet').classList.contains('open')) return;
  const now = Date.now();
  const data = {
    title: $('f-title').value.trim(),
    user: $('f-user').value.trim(),
    pass: $('f-pass').value,
    url: $('f-url').value.trim(),
    cat: $('f-cat').value,
    notes: $('f-notes').value.trim(),
    updated: now,
  };
  if (!data.title) { toast('Donne un nom à cet identifiant'); $('f-title').focus(); return; }
  const existing = state.items.find((x) => x.id === state.current);
  if (existing) Object.assign(existing, data);
  else {
    const id = crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random();
    state.items.push({ id, created: now, ...data });
    state.current = id; // une validation tardive devient une modification, pas un doublon
  }
  await persist();
  closeSheet('edit-sheet');
  render();
  if (state.page === 'home') renderHome();
  toast(existing ? 'Modifié' : 'Enregistré');
});

$('del-btn').onclick = async () => {
  const it = state.items.find((x) => x.id === state.current);
  if (!it || !confirm(`Supprimer « ${it.title} » ?`)) return;
  state.items = state.items.filter((x) => x.id !== it.id);
  await persist();
  closeSheet('edit-sheet');
  render();
  if (state.page === 'home') renderHome();
  toast('Supprimé');
};

/* ---------- Générateur ---------- */

function regen() {
  const len = +$('gen-len').value;
  $('gen-len-v').textContent = len;
  const pw = VaultCrypto.generate(len, {
    upper: $('g-up').checked, lower: $('g-low').checked, digits: $('g-num').checked, symbols: $('g-sym').checked,
  });
  $('gen-out').textContent = pw;
  setStrength($('strength-g'), pw);
}
['gen-len', 'g-up', 'g-low', 'g-num', 'g-sym'].forEach((id) => $(id).addEventListener('input', regen));
// Au moins une famille de caractères reste cochée.
['g-up', 'g-low', 'g-num', 'g-sym'].forEach((id) => $(id).addEventListener('change', (e) => {
  if (!['g-up', 'g-low', 'g-num', 'g-sym'].some((x) => $(x).checked)) {
    e.target.checked = true;
    toast('Garde au moins un type de caractères');
    regen();
  }
}));
$('gen-again').onclick = regen;
// Deux usages : depuis le formulaire (« Utiliser ») ou depuis l'appli (« Enregistrer »).
let genFromForm = false;
function openGenerator(fromForm) {
  genFromForm = fromForm;
  $('gen-use').textContent = fromForm ? 'Utiliser' : 'Enregistrer';
  regen();
  openSheet('gen-sheet');
}
$('gen-open').onclick = () => openGenerator(true);
$('quick-gen').onclick = () => openGenerator(false);
$('gen-copy').onclick = () => copy($('gen-out').textContent, 'Mot de passe');
$('gen-out').onclick = () => copy($('gen-out').textContent, 'Mot de passe');
$('gen-use').onclick = () => {
  const pw = $('gen-out').textContent;
  closeSheet('gen-sheet');
  // Depuis l'appli : nouvel identifiant pré-rempli, il ne reste qu'à le nommer.
  if (!genFromForm) openEdit(null);
  $('f-pass').value = pw;
  $('f-pass').type = 'text';
  setStrength($('strength-f'), pw);
};

/* ---------- Réglages ---------- */

function setSwitch(id, on) { $(id).classList.toggle('on', !!on); }

function refreshSettings() {
  $('s-autolock').value = String(settings.autolock);
  $('s-sync-sub').textContent = sync.statusText();
  bio.refreshSettings();
  updates.refreshSettings();
  refreshScreenSetting();
  refreshIconsSetting();
}

$('s-autolock').onchange = () => {
  settings.autolock = +$('s-autolock').value;
  saveSettings();
  armAutolock();
};

$('s-export').onclick = () => {
  const blob = storage.get(STORE_KEY);
  if (!blob) return;
  const d = new Date();
  const name = `stryxhub-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  if (native) {
    native.saveFile(name, JSON.stringify(blob));
    return;
  }
  const file = new Blob([JSON.stringify(blob)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Sauvegarde exportée (chiffrée)');
};

/* ---------- Import de mots de passe (CSV) ---------- */

let csvPending = [];
const sameEntry = (a, b) => a.title.toLowerCase() === b.title.toLowerCase() && a.user === b.user && a.pass === b.pass;

function csvReset() {
  csvPending = [];
  $('csv-n').textContent = '';
  $('csv-detail').textContent = '';
  $('csv-intro').hidden = false;
  $('csv-result').hidden = true;
  $('csv-go').hidden = true;
  $('csv-pick').textContent = 'Choisir un fichier';
  $('csv-error').textContent = '';
}

$('s-csv').onclick = () => {
  csvReset();
  openSheet('csv-sheet');
};
$('csv-pick').onclick = () => { $('csv-in').value = ''; $('csv-in').click(); };
$('csv-in').onchange = async () => {
  const f = $('csv-in').files[0];
  if (!f) return;
  csvReset();
  try {
    const { items, skipped } = CsvImport.read(await f.text());
    const unique = items.filter((it, i) => items.findIndex((y) => sameEntry(y, it)) === i);
    const fresh = unique.filter((it) => !state.items.some((x) => sameEntry(x, it)));
    const dupes = unique.length - fresh.length;
    const inFile = items.length - unique.length;
    csvPending = fresh;
    $('csv-n').textContent = fresh.length ? `${plural(fresh.length, 'identifiant')} à importer` : 'Rien de nouveau à importer';
    $('csv-detail').textContent = [
      dupes ? `${dupes} déjà dans le coffre` : '',
      inFile ? `${plural(inFile, 'doublon')} dans le fichier` : '',
      skipped ? `${plural(skipped, 'ligne')} vide${skipped > 1 ? 's' : ''} ignorée${skipped > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' · ');
    $('csv-preview').replaceChildren(...fresh.slice(0, 50).map((it) => {
      const li = el('li');
      const av = el('div', 'avatar');
      fillAvatar(av, it);
      li.append(av, el('span', '', it.title + (it.user ? ` · ${it.user}` : '')), el('em', '', catOf(it.cat).label));
      return li;
    }));
    $('csv-intro').hidden = true;
    $('csv-result').hidden = false;
    $('csv-go').hidden = !fresh.length;
    $('csv-pick').textContent = 'Autre fichier';
  } catch (ex) {
    $('csv-error').textContent = ex && ex.message === 'colonnes'
      ? 'Fichier non reconnu : aucune colonne « password » trouvée. Vérifie que c\'est bien un export CSV de mots de passe.'
      : 'Impossible de lire ce fichier.';
  }
};
$('csv-go').onclick = once(async () => {
  if (!csvPending.length || !state.session) return;
  const now = Date.now();
  csvPending.forEach((it, i) => {
    state.items.push({ id: crypto.randomUUID ? crypto.randomUUID() : `${now}-${i}-${Math.random()}`, created: now, updated: now, ...it });
  });
  const n = csvPending.length;
  csvPending = [];
  await persist();
  closeSheet('csv-sheet');
  state.filter = 'all';
  render();
  toast(`${plural(n, 'identifiant')} importé${n > 1 ? 's' : ''} ✓ · supprime le fichier CSV`);
});

/* ---------- Sauvegardes ---------- */

function pickBackup() { $('file-in').value = ''; $('file-in').click(); }
$('s-import').onclick = () => {
  if (confirm('Importer une sauvegarde remplacera le coffre actuel. Continuer ?')) pickBackup();
};
$('restore-btn').onclick = () => {
  if (state.pendingImport) { state.pendingImport = null; lock(); return; }
  if (!storage.get(STORE_KEY) || confirm('Restaurer une sauvegarde remplacera le coffre de cet appareil. Continuer ?')) pickBackup();
};
$('file-in').onchange = async () => {
  const f = $('file-in').files[0];
  if (!f) return;
  try {
    const blob = JSON.parse(await f.text());
    if (!blob || blob.app !== 'stryxmdp') throw new Error();
    lock();
    state.pendingImport = blob;
    lockMode();
    $('master').focus();
  } catch {
    toast('Fichier de sauvegarde invalide');
  }
};

/* ---------- Mot de passe maître ---------- */

$('s-change').onclick = () => {
  ['pw-old', 'pw-new', 'pw-new2'].forEach((id) => { $(id).value = ''; });
  $('pw-error').textContent = '';
  setStrength($('strength-pw'), '');
  openSheet('pw-sheet');
};
$('pw-new').addEventListener('input', () => setStrength($('strength-pw'), $('pw-new').value));
$('pw-form').addEventListener('submit', (e) => { e.preventDefault(); changeMaster(); });
const changeMaster = once(async () => {
  if (!$('pw-sheet').classList.contains('open')) return;
  const err = $('pw-error');
  if ($('pw-new').value !== $('pw-new2').value) { err.textContent = 'Les mots de passe ne correspondent pas.'; return; }
  try {
    await VaultCrypto.open($('pw-old').value, storage.get(STORE_KEY));
  } catch {
    err.textContent = 'Mot de passe actuel incorrect.';
    return;
  }
  state.session = await VaultCrypto.newKey($('pw-new').value);
  await persist();
  closeSheet('pw-sheet');
  if (bio.enabled()) {
    bio.disable();
    toast('Mot de passe changé · réactive l\'empreinte dans les réglages');
  } else {
    toast('Mot de passe maître changé');
  }
  refreshSettings();
});

$('s-wipe').onclick = () => {
  if (!confirm('Effacer définitivement tous les mots de passe et le planning de cet appareil ?')) return;
  if (!confirm('Dernière confirmation : cette action est irréversible.')) return;
  storage.remove(STORE_KEY);
  bio.disable();
  delete settings.page;
  delete settings.bioAsked;
  saveSettings();
  lock();
  toast('Coffre effacé');
};

/* ---------- Câblage général ---------- */

$('lock-form').addEventListener('submit', onUnlock);
$('master').addEventListener('input', () => {
  if (!$('strength-master').hidden) setStrength($('strength-master'), $('master').value);
});
$('lock-now').onclick = lock;
$('add-btn').onclick = () => openEdit(null);
$('search').addEventListener('input', (e) => { state.query = e.target.value; render(); });

document.querySelectorAll('[data-toggle]').forEach((b) => {
  b.onclick = () => {
    const input = $(b.dataset.toggle);
    input.type = input.type === 'password' ? 'text' : 'password';
  };
});
document.querySelectorAll('[data-close]').forEach((b) => {
  b.onclick = () => closeSheet(b.closest('.sheet').id);
});
document.querySelectorAll('.sheet').forEach((s) => {
  s.addEventListener('click', (e) => { if (e.target === s) closeSheet(s.id); });
});

if (!window.crypto || !crypto.subtle) {
  $('lock-error').textContent = 'Cet appareil/navigateur ne prend pas en charge le chiffrement requis (HTTPS obligatoire).';
  $('lock-btn').disabled = true;
}

// Bouton « retour » d'Android : ferme la fenêtre ouverte, puis revient à l'accueil, puis quitte.
window.stryxBack = () => {
  const open = [...document.querySelectorAll('.sheet')].filter((s) => !s.hidden).pop();
  if (open) {
    closeSheet(open.id);
    return true;
  }
  if (state.session && state.page !== 'home') {
    showPage('home');
    return true;
  }
  return false;
};

if (!native && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ---------- Empreinte digitale (application Android uniquement) ---------- */

// Le mot de passe maître est chiffré par une clé du Keystore Android qui ne s'ouvre
// qu'après une empreinte valide. Il ne quitte jamais le téléphone.
const bio = {
  available: () => !!(native && native.biometricStatus && native.biometricStatus() === 'available'),
  enabled: () => !!(native && native.biometricEnabled && native.biometricEnabled()),
  pendingPw: null,

  prompt() {
    if (!bio.enabled() || state.session || state.pendingImport || !storage.get(STORE_KEY)) return;
    native.biometricUnlock();
  },
  disable() {
    if (native && native.biometricDisable) native.biometricDisable();
    $('bio-btn').hidden = true;
  },
  // Après un déverrouillage par mot de passe : propose l'empreinte une seule fois.
  offer(pw) {
    if (!bio.available() || bio.enabled() || settings.bioAsked) return;
    settings.bioAsked = true;
    saveSettings();
    bio.openSheet(pw);
  },
  openSheet(pw) {
    bio.pendingPw = pw || null;
    $('bio-pw').value = '';
    $('bio-pw-field').hidden = !!pw;
    $('bio-error').textContent = '';
    openSheet('bio-sheet');
  },
  refreshSettings() {
    $('s-bio').hidden = !bio.available() && !bio.enabled();
    const on = bio.enabled();
    $('s-bio-sub').textContent = on ? 'Activée · touche pour la désactiver' : 'Déverrouille le coffre avec ton doigt';
    setSwitch('s-bio-switch', on);
  },
};

$('bio-btn').onclick = () => bio.prompt();
$('s-bio').onclick = () => {
  if (bio.enabled()) {
    if (!confirm('Désactiver le déverrouillage par empreinte ?')) return;
    bio.disable();
    bio.refreshSettings();
    toast('Empreinte désactivée');
  } else {
    bio.openSheet(null);
  }
};
$('bio-form').addEventListener('submit', (e) => { e.preventDefault(); enableBio(); });
const enableBio = once(async () => {
  const pw = bio.pendingPw || $('bio-pw').value;
  if (!bio.pendingPw) {
    try {
      await VaultCrypto.open(pw, storage.get(STORE_KEY));
    } catch {
      $('bio-error').textContent = 'Mot de passe incorrect.';
      return;
    }
  }
  bio.pendingPw = null;
  $('bio-pw').value = '';
  native.biometricEnable(pw);
});
$('bio-sheet').addEventListener('click', (e) => {
  if (e.target === $('bio-sheet') || (e.target.closest && e.target.closest('[data-close]'))) bio.pendingPw = null;
});
// Fermée autrement (bouton retour) : le mot de passe gardé pour l'activation est oublié.
new MutationObserver(() => { if ($('bio-sheet').hidden) bio.pendingPw = null; })
  .observe($('bio-sheet'), { attributes: true, attributeFilter: ['hidden'] });

// Réponses du code Android : action = 'enable' | 'unlock', ok = vrai/faux.
window.stryxBio = (action, ok, payload) => {
  if (action === 'unlock') {
    if (ok && (state.pendingImport || state.session)) return; // restauration en cours ou déjà ouvert
    if (ok) onUnlock(null, payload);
    else if (payload === 'invalidated') {
      lockMode();
      $('lock-error').textContent = 'Tes empreintes ont changé : entre ton mot de passe maître, puis réactive l\'empreinte.';
    } else if (payload !== 'cancel') toast(payload);
    return;
  }
  if (action === 'enable') {
    if (ok) {
      closeSheet('bio-sheet');
      lockMode();
      bio.refreshSettings();
      toast('Empreinte activée ✓');
    } else if (payload !== 'cancel') {
      $('bio-error').textContent = payload;
    }
  }
};

/* ---------- Réglage : logos des sites ---------- */

function refreshIconsSetting() {
  const on = settings.icons !== false;
  $('s-icons-sub').textContent = on
    ? 'Le nom du site (ex. discord.com) est demandé à DuckDuckGo pour son logo'
    : 'Masqués : seules les initiales sont affichées';
  setSwitch('s-icons-switch', on);
}
$('s-icons').onclick = () => {
  settings.icons = settings.icons === false;
  saveSettings();
  refreshIconsSetting();
  render();
};

/* ---------- Protection d'écran (captures / partage d'écran) ---------- */

function refreshScreenSetting() {
  const ok = !!(native && native.screenProtected);
  $('s-screen').hidden = !ok;
  if (!ok) return;
  const on = native.screenProtected();
  $('s-screen-sub').textContent = on
    ? 'Captures et partage d\'écran bloqués (écran noir sur Discord)'
    : 'Stream autorisé : attention à ne pas afficher de mot de passe';
  $('s-screen').classList.toggle('warn', !on);
  setSwitch('s-screen-switch', on);
}
$('s-screen').onclick = () => {
  const on = native.screenProtected();
  if (on && !confirm('Autoriser les captures et le partage d\'écran ?\n\nTout ce qui est affiché pourra être vu par les personnes qui regardent ton stream.')) return;
  native.setScreenProtected(!on);
  refreshScreenSetting();
  toast(on ? 'Stream autorisé · pense à la remettre après' : 'Protection d\'écran réactivée');
};

/* ---------- Mises à jour depuis l'application (Android) ---------- */

const updates = {
  manual: false,
  supported: () => !!(native && native.checkUpdate),
  check(manual) {
    if (!updates.supported()) return;
    updates.manual = manual;
    if (manual) $('s-update-sub').textContent = 'Recherche…';
    native.checkUpdate(manual);
  },
  reset() {
    $('update-go').disabled = false;
    $('update-go').textContent = 'Mettre à jour';
    $('update-progress').style.width = '0';
  },
  refreshSettings() {
    $('s-update').hidden = !updates.supported();
    if (updates.supported()) $('s-update-sub').textContent = `Version ${native.appVersion()} · touche pour vérifier`;
  },
};

$('s-update').onclick = () => updates.check(true);
$('update-close').onclick = () => { $('update-bar').hidden = true; document.body.classList.remove('has-update'); };
$('update-go').onclick = () => {
  $('update-go').disabled = true;
  $('update-go').textContent = 'Téléchargement…';
  native.installUpdate();
};

// Réponses du code Android.
window.stryxUpdate = (event, payload) => {
  switch (event) {
    case 'available':
      $('update-title').textContent = 'Mise à jour disponible';
      $('update-sub').textContent = `Stryx Hub ${payload} · tes données sont conservées`;
      $('update-bar').hidden = false;
      document.body.classList.add('has-update');
      if (updates.manual) $('s-update-sub').textContent = `Version ${payload} disponible · voir le bandeau en haut`;
      updates.reset();
      break;
    case 'none':
      if (updates.manual) {
        $('s-update-sub').textContent = `Version ${payload} · à jour ✓`;
        toast('Stryx Hub est à jour');
      }
      break;
    case 'progress':
      $('update-go').textContent = `${payload} %`;
      $('update-progress').style.width = payload + '%';
      break;
    case 'installing':
      $('update-go').textContent = 'Installation…';
      $('update-progress').style.width = '100%';
      break;
    case 'permission':
      updates.reset();
      $('update-sub').textContent = 'Autorise Stryx Hub à installer des applis, puis reviens et touche « Mettre à jour ».';
      break;
    case 'error':
      updates.reset();
      if (payload !== 'cancel') toast(payload);
      if (updates.manual) updates.refreshSettings();
      break;
  }
};

/* ---------- Installation (icône sur l'écran d'accueil, version web) ---------- */

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;

// Android / Chrome : le navigateur propose l'installation, on la déclenche depuis notre bouton.
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  if (native) return;
  installPrompt = e;
  $('install-btn').hidden = false;
});
addEventListener('appinstalled', () => {
  installPrompt = null;
  $('install-btn').hidden = true;
  toast('Stryx Hub est installé sur ton écran d\'accueil');
});
if (isIOS && !isStandalone() && !native) $('install-btn').hidden = false;

$('install-btn').onclick = async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    $('install-btn').hidden = true;
  } else {
    openSheet('ios-sheet');
  }
};

// Rafraîchit l'accueil chaque minute (compte à rebours du prochain service).
setInterval(() => {
  if (!state.session || document.hidden) return;
  updateHeader();
  if (state.page === 'home') renderHome();
}, 60000);

starfield();
lockMode();
bio.prompt();
updates.check(false);
