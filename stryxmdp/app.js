'use strict';

const STORE_KEY = 'stryxmdp';
const SETTINGS_KEY = 'stryxmdp-settings';
const CLIPBOARD_CLEAR_MS = 30000;
const CATEGORIES = [
  { id: 'jeux', label: 'Jeux', icon: '🎮' },
  { id: 'social', label: 'Réseaux', icon: '💬' },
  { id: 'mail', label: 'E-mail', icon: '✉' },
  { id: 'banque', label: 'Banque', icon: '💳' },
  { id: 'travail', label: 'Travail', icon: '💼' },
  { id: 'autre', label: 'Autre', icon: '◆' },
];

const $ = (id) => document.getElementById(id);
const state = {
  session: null,      // { key, salt, iterations } — uniquement en mémoire
  items: [],
  filter: 'all',
  query: '',
  current: null,      // identifiant ouvert dans la feuille de détail
  pendingImport: null,
  hiddenAt: 0,
  lockTimer: 0,
};

/* ---------- Stockage ---------- */

const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignoré */ } },
};

const settings = Object.assign({ autolock: 300 }, storage.get(SETTINGS_KEY));

async function persist() {
  const blob = await VaultCrypto.encrypt(state.session, { items: state.items, planning: state.planning });
  storage.set(STORE_KEY, blob);
}

/* ---------- Utilitaires UI ---------- */

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function openSheet(id) {
  const s = $(id);
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add('open'));
}
function closeSheet(id) {
  const s = $(id);
  s.classList.remove('open');
  setTimeout(() => { s.hidden = true; }, 220);
}
function closeAllSheets() {
  document.querySelectorAll('.sheet').forEach((s) => { s.classList.remove('open'); s.hidden = true; });
}

function setStrength(el, pw) {
  const score = VaultCrypto.strength(pw);
  el.dataset.score = score;
  el.title = ['', 'Faible', 'Moyen', 'Bon', 'Excellent'][score];
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
  if (!text) return;
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

/* ---------- Fond étoilé ---------- */

function starfield() {
  const c = $('stars');
  const ctx = c.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let stars = [];
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((innerWidth * innerHeight) / 5000);
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: Math.random() * 1.2 + 0.2,
      a: Math.random(),
      s: Math.random() * 0.015 + 0.003,
      v: Math.random() * 0.08 + 0.02,
    }));
  }
  function frame() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const st of stars) {
      st.a += st.s;
      st.y -= st.v;
      if (st.y < 0) st.y = innerHeight;
      ctx.globalAlpha = 0.25 + Math.abs(Math.sin(st.a)) * 0.75;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reduce && !document.hidden) requestAnimationFrame(frame);
  }
  resize();
  frame();
  addEventListener('resize', () => { resize(); if (reduce) frame(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !reduce) frame(); });
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
    ? 'Entrez le mot de passe maître de la sauvegarde.'
    : creating
      ? 'Choisissez un mot de passe maître. Il protège tout le coffre et ne peut pas être récupéré : ne l\'oubliez pas.'
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
  state.current = null;
  clearTimeout(state.lockTimer);
  closeAllSheets();
  $('list').replaceChildren();
  $('vault').hidden = true;
  $('lock').hidden = false;
  $('master').value = '';
  $('master2').value = '';
  $('lock-error').textContent = '';
  lockMode();
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
      await persist();
    } else {
      const blob = state.pendingImport || storage.get(STORE_KEY);
      const res = await VaultCrypto.open(pw, blob);
      state.session = res.session;
      state.items = Array.isArray(res.data.items) ? res.data.items : [];
      state.planning = res.data.planning || null;
      if (state.pendingImport) {
        storage.set(STORE_KEY, state.pendingImport);
        state.pendingImport = null;
        bio.disable(); // la sauvegarde peut avoir un autre mot de passe maître
        toast('Sauvegarde restaurée');
      }
    }
    if (!viaBio) bio.offer(pw);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    $('master').value = '';
    $('master2').value = '';
    $('lock').hidden = true;
    $('vault').hidden = false;
    render();
    showTab(settings.tab === 'plan' ? 'plan' : 'pw');
    armAutolock();
  } catch (ex) {
    if (viaBio) {
      // Le mot de passe maître a changé depuis l'activation : on repart du mot de passe.
      bio.disable();
      lockMode();
      err.textContent = 'Empreinte désactivée : entrez votre mot de passe maître.';
      return;
    }
    err.textContent = ex && ex.message === 'format' ? 'Fichier de sauvegarde invalide.' : 'Mot de passe incorrect.';
    $('lock-form').classList.remove('shake');
    void $('lock-form').offsetWidth;
    $('lock-form').classList.add('shake');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
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
  }
});

/* ---------- Liste ---------- */

function renderChips() {
  const chips = $('chips');
  const counts = {};
  state.items.forEach((it) => { counts[it.cat] = (counts[it.cat] || 0) + 1; });
  const all = [{ id: 'all', label: 'Tout', icon: '✦' }, ...CATEGORIES.filter((c) => counts[c.id])];
  if (!all.some((c) => c.id === state.filter)) state.filter = 'all';
  chips.replaceChildren(...all.map((c) => {
    const b = document.createElement('button');
    b.className = 'chip' + (state.filter === c.id ? ' active' : '');
    b.textContent = `${c.icon} ${c.label}`;
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
    ? `${state.items.length} identifiant${state.items.length > 1 ? 's' : ''}` + (weak ? ` · ⚠ ${weak} faible${weak > 1 ? 's' : ''}` : ' · tous sécurisés')
    : '';

  $('empty').hidden = state.items.length > 0;
  $('list').replaceChildren(...list.map((it, i) => {
    const li = document.createElement('li');
    li.className = 'item glass';
    li.style.animationDelay = Math.min(i * 30, 300) + 'ms';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = (it.title[0] || '?').toUpperCase();
    const txt = document.createElement('div');
    txt.className = 'item-txt';
    const t = document.createElement('b');
    t.textContent = it.title;
    const u = document.createElement('span');
    u.textContent = it.user || catOf(it.cat).label;
    txt.append(t, u);
    const cp = document.createElement('button');
    cp.className = 'icon-btn';
    cp.setAttribute('aria-label', 'Copier le mot de passe');
    cp.textContent = '⧉';
    cp.onclick = (e) => { e.stopPropagation(); copy(it.pass, 'Mot de passe'); };
    li.append(av, txt, cp);
    li.onclick = () => openView(it.id);
    return li;
  }));
}

/* ---------- Détail ---------- */

function openView(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  state.current = id;
  $('v-avatar').textContent = (it.title[0] || '?').toUpperCase();
  $('v-title').textContent = it.title;
  $('v-cat').textContent = `${catOf(it.cat).icon} ${catOf(it.cat).label}`;
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
  const el = $('v-pass');
  const show = !el.dataset.shown;
  el.dataset.shown = show ? '1' : '';
  el.textContent = show ? (it.pass || '—') : '••••••••••';
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

/* ---------- Onglets ---------- */

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-pw').hidden = name !== 'pw';
  $('tab-plan').hidden = name !== 'plan';
  if (name === 'plan') Planning.show(state.planning);
  settings.tab = name;
  storage.set(SETTINGS_KEY, settings);
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });

/* ---------- Import d'un planning (code fourni par Claude) ---------- */

$('plan-import').onclick = () => {
  $('plan-code').value = '';
  $('plan-error').textContent = '';
  $('plan-clear').hidden = !state.planning;
  openSheet('plan-sheet');
};
$('plan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let add;
  try {
    add = await Planning.decode($('plan-code').value);
  } catch {
    $('plan-error').textContent = 'Code non reconnu : copiez bien tout le code envoyé par Claude (il commence par STRYXPLAN:).';
    return;
  }
  state.planning = Planning.merge(state.planning, add);
  await persist();
  $('plan-code').value = '';
  closeSheet('plan-sheet');
  Planning.show(state.planning);
  const nDays = new Set(add.entries.map((x) => x.date)).size;
  toast(`Planning ajouté ✓ (${nDays} jour${nDays > 1 ? 's' : ''})`);
});
$('plan-clear').onclick = async () => {
  if (!confirm('Effacer tout le planning ?')) return;
  state.planning = null;
  await persist();
  closeSheet('plan-sheet');
  Planning.show(null);
  toast('Planning effacé');
};

/* ---------- Ajout / modification ---------- */

$('f-cat').replaceChildren(...CATEGORIES.map((c) => {
  const o = document.createElement('option');
  o.value = c.id;
  o.textContent = `${c.icon} ${c.label}`;
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
  if (!it) setTimeout(() => $('f-title').focus(), 250);
}

$('f-pass').addEventListener('input', () => setStrength($('strength-f'), $('f-pass').value));

$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
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
  if (!data.title) return;
  const existing = state.items.find((x) => x.id === state.current);
  if (existing) Object.assign(existing, data);
  else state.items.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random(), created: now, ...data });
  await persist();
  closeSheet('edit-sheet');
  render();
  toast(existing ? 'Modifié' : 'Enregistré');
});

$('del-btn').onclick = async () => {
  const it = state.items.find((x) => x.id === state.current);
  if (!it || !confirm(`Supprimer « ${it.title} » ?`)) return;
  state.items = state.items.filter((x) => x.id !== it.id);
  await persist();
  closeSheet('edit-sheet');
  render();
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
$('gen-again').onclick = regen;
// Deux usages : depuis le formulaire (« Utiliser ») ou depuis l'écran principal (« Enregistrer »).
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
  if (!genFromForm) {
    // Nouvel identifiant pré-rempli avec le mot de passe généré : il ne reste qu'à le nommer.
    openEdit(null);
  }
  $('f-pass').value = pw;
  $('f-pass').type = 'text';
  setStrength($('strength-f'), pw);
};

/* ---------- Paramètres ---------- */

$('settings-btn').onclick = () => {
  $('s-autolock').value = String(settings.autolock);
  bio.refreshSettings();
  updates.refreshSettings();
  openSheet('settings-sheet');
};
$('s-autolock').onchange = () => {
  settings.autolock = +$('s-autolock').value;
  storage.set(SETTINGS_KEY, settings);
  armAutolock();
};

$('s-export').onclick = () => {
  const blob = storage.get(STORE_KEY);
  if (!blob) return;
  const name = `stryxmdp-${new Date().toISOString().slice(0, 10)}.json`;
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
  closeSheet('settings-sheet');
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
    const fresh = items.filter((it, i) => !state.items.some((x) => sameEntry(x, it)) && items.findIndex((y) => sameEntry(y, it)) === i);
    const dupes = items.length - fresh.length;
    csvPending = fresh;
    $('csv-n').textContent = fresh.length
      ? `${fresh.length} identifiant${fresh.length > 1 ? 's' : ''} à importer`
      : 'Rien de nouveau à importer';
    $('csv-detail').textContent = [
      dupes ? `${dupes} déjà dans le coffre` : '',
      skipped ? `${skipped} ligne${skipped > 1 ? 's' : ''} vide${skipped > 1 ? 's' : ''} ignorée${skipped > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' · ');
    $('csv-preview').replaceChildren(...fresh.slice(0, 50).map((it) => {
      const li = document.createElement('li');
      const av = document.createElement('div');
      av.className = 'avatar';
      av.textContent = (it.title[0] || '?').toUpperCase();
      const t = document.createElement('span');
      t.textContent = it.title + (it.user ? ` · ${it.user}` : '');
      const c = document.createElement('em');
      c.textContent = catOf(it.cat).label;
      li.append(av, t, c);
      return li;
    }));
    $('csv-intro').hidden = true;
    $('csv-result').hidden = false;
    $('csv-go').hidden = !fresh.length;
    $('csv-pick').textContent = 'Autre fichier';
  } catch (ex) {
    $('csv-error').textContent = ex && ex.message === 'colonnes'
      ? 'Fichier non reconnu : aucune colonne « password » trouvée. Vérifiez que c\'est bien un export CSV de mots de passe.'
      : 'Impossible de lire ce fichier.';
  }
};
$('csv-go').onclick = async () => {
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
  toast(`${n} identifiant${n > 1 ? 's' : ''} importé${n > 1 ? 's' : ''} ✓ · supprimez le fichier CSV`);
};

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

$('s-change').onclick = () => {
  closeSheet('settings-sheet');
  ['pw-old', 'pw-new', 'pw-new2'].forEach((id) => { $(id).value = ''; });
  $('pw-error').textContent = '';
  setStrength($('strength-pw'), '');
  openSheet('pw-sheet');
};
$('pw-new').addEventListener('input', () => setStrength($('strength-pw'), $('pw-new').value));
$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
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
    toast('Mot de passe changé · réactivez l\'empreinte dans les paramètres');
  } else {
    toast('Mot de passe maître changé');
  }
});

$('s-wipe').onclick = () => {
  if (!confirm('Effacer définitivement tous les mots de passe de cet appareil ?')) return;
  if (!confirm('Dernière confirmation : cette action est irréversible.')) return;
  storage.remove(STORE_KEY);
  bio.disable();
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

// Bouton « retour » d'Android : ferme la fenêtre ouverte au lieu de quitter l'appli.
window.stryxBack = () => {
  const open = [...document.querySelectorAll('.sheet')].filter((s) => s.classList.contains('open')).pop();
  if (!open) return false;
  closeSheet(open.id);
  return true;
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
    storage.set(SETTINGS_KEY, settings);
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
    const tile = $('s-bio');
    tile.hidden = !bio.available() && !bio.enabled();
    const on = bio.enabled();
    $('s-bio-title').textContent = on ? 'Empreinte digitale : activée' : 'Activer l\'empreinte digitale';
    $('s-bio-sub').textContent = on ? 'Touchez pour la désactiver' : 'Déverrouillez le coffre avec votre doigt';
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
    closeSheet('settings-sheet');
    bio.openSheet(null);
  }
};
$('bio-form').addEventListener('submit', async (e) => {
  e.preventDefault();
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
  if (e.target === $('bio-sheet') || e.target.hasAttribute('data-close')) bio.pendingPw = null;
});

// Réponses du code Android : action = 'enable' | 'unlock', ok = vrai/faux.
window.stryxBio = (action, ok, payload) => {
  if (action === 'unlock') {
    if (ok) onUnlock(null, payload);
    else if (payload === 'invalidated') {
      lockMode();
      $('lock-error').textContent = 'Vos empreintes ont changé : entrez votre mot de passe maître, puis réactivez l\'empreinte.';
    } else if (payload !== 'cancel') toast(payload);
    return;
  }
  if (action === 'enable') {
    if (ok) {
      closeSheet('bio-sheet');
      lockMode();
      toast('Empreinte activée ✓');
    } else if (payload !== 'cancel') {
      $('bio-error').textContent = payload;
    }
  }
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
    if (updates.supported()) $('s-update-sub').textContent = `Version ${native.appVersion()} · toucher pour vérifier`;
  },
};

$('s-update').onclick = () => updates.check(true);
$('update-close').onclick = () => { $('update-bar').hidden = true; };
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
      $('update-sub').textContent = `StryxMDP ${payload} · vos mots de passe sont conservés`;
      $('update-bar').hidden = false;
      if (updates.manual) closeSheet('settings-sheet');
      updates.reset();
      break;
    case 'none':
      if (updates.manual) {
        $('s-update-sub').textContent = `Version ${payload} · à jour ✓`;
        toast('StryxMDP est à jour');
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
      $('update-sub').textContent = 'Autorisez StryxMDP à installer des applis, puis revenez et touchez « Mettre à jour ».';
      break;
    case 'error':
      updates.reset();
      if (payload !== 'cancel') toast(payload);
      if (updates.manual) updates.refreshSettings();
      break;
  }
};

/* ---------- Installation (icône sur l'écran d'accueil) ---------- */

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
  toast('StryxMDP est installé sur votre écran d\'accueil');
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

starfield();
lockMode();
bio.prompt();
updates.check(false);
