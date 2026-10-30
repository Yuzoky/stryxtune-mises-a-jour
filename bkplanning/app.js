// Planning BK : écrans, modifications, lecture des photos, synchronisation entre managers.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const M = Model;
  const native = window.BKAndroid || null;
  const STORE = 'bkplanning';
  const APK_URL = 'https://github.com/Yuzoky/stryxtune-mises-a-jour/releases/download/bkplanning/PlanningBK.apk';

  /* ---------- Outils ---------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ic');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  let toastTimer = null;
  function toast(text, ms = 2600) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  window.toast = toast;
  const showError = (id, text) => { const e = $(id); e.textContent = text || ''; e.hidden = !text; };
  const todayIdx = () => (new Date().getDay() + 6) % 7;
  const currentMonday = () => M.iso(M.mondayOf(new Date()));
  function ago(isoDate) {
    if (!isoDate) return '';
    const s = Math.round((Date.now() - new Date(isoDate).getTime()) / 1000);
    if (s < 60) return 'à l\'instant';
    if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
    const d = new Date(isoDate);
    return `le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const stable = (v) => M.stable(v);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function copyText(text) {
    if (native && native.copyText) native.copyText(text);
    else if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    toast('Copié');
  }
  function shareText(text) {
    if (native && native.shareText) native.shareText(text);
    else copyText(text);
  }

  /* ---------- Fenêtres ---------- */

  const openSheets = [];
  function openSheet(id) {
    const s = $(id);
    s.classList.add('open');
    if (!openSheets.includes(id)) openSheets.push(id);
  }
  function closeSheet(id) {
    $(id).classList.remove('open');
    const i = openSheets.indexOf(id);
    if (i >= 0) openSheets.splice(i, 1);
  }
  document.querySelectorAll('.sheet').forEach((s) => {
    s.addEventListener('click', (e) => { if (e.target === s && s.id !== 'sh-confirm') closeSheet(s.id); });
    s.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => closeSheet(s.id); });
  });
  let confirmDone = null;
  function confirmBox(title, text, yes = 'Confirmer') {
    $('cf-title').textContent = title;
    $('cf-text').textContent = text;
    $('cf-yes').textContent = yes;
    openSheet('sh-confirm');
    return new Promise((resolve) => { confirmDone = resolve; });
  }
  $('cf-yes').onclick = () => { closeSheet('sh-confirm'); if (confirmDone) confirmDone(true); confirmDone = null; };
  $('cf-no').onclick = () => { closeSheet('sh-confirm'); if (confirmDone) confirmDone(false); confirmDone = null; };

  /* ---------- État (sur le téléphone) ---------- */

  // { code, resto, me, token, doc, sha, dirty, lastSync, lock }
  let st = null;
  try { st = JSON.parse(localStorage.getItem(STORE)); } catch { st = null; }
  if (st && !st.code) st = null;
  let room = null;
  let week = currentMonday();
  let page = 'plan';
  let mode = 'day';
  let day = todayIdx();

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(st)); } catch { toast('Stockage du téléphone plein ?'); }
  }
  const curWeek = () => (st && st.doc && st.doc.weeks[week]) || null;
  // Ma ligne dans le planning : choisie (« C'est moi »), sinon le seul prénom qui correspond.
  function mePerson(w) {
    if (!w || !st) return null;
    if (st.mePerson) { const p = w.people.find((x) => M.norm(x.name) === M.norm(st.mePerson)); if (p) return p; }
    const first = M.norm(String(st.me || '').split(/\s+/)[0]);
    if (!first) return null;
    const hits = w.people.filter((x) => M.norm(x.name.split(/\s+/)[0]) === first);
    return hits.length === 1 ? hits[0] : null;
  }

  // Modification locale : enregistrée tout de suite, envoyée aux autres managers juste après.
  function commitWeek(w) {
    st.doc.weeks[w.week] = w;
    delete st.doc.deleted[w.week];
    st.dirty = true;
    save();
    renderAll();
    sync.soon();
  }

  /* ---------- Synchronisation ---------- */

  const sync = {
    busy: false,
    again: false,
    error: '',
    timer: null,
    soon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(false), 700); },
    async run(manual) {
      if (!room || !st) return;
      if (!st.token) { this.error = ''; ui.sync(); if (manual) toast('Envoi automatique pas encore activé (Réglages)'); return; }
      if (this.busy) { this.again = true; return; }
      this.busy = true;
      ui.sync();
      try {
        const before = {};
        for (const [k, w] of Object.entries(st.doc.weeks)) before[k] = w.updated;
        let pushed = false;
        let base = st.base || null;
        let local = st.doc;
        for (let attempt = 0; attempt < 4; attempt++) {
          const remote = await Vault.pull(room, st.token);
          const merged = M.prune(remote.doc ? M.merge3(base, local, remote.doc) : local);
          if (remote.doc && remote.doc.name && !st.resto) st.resto = remote.doc.name;
          const same = remote.doc && M.stable(M.prune(remote.doc)) === M.stable(merged);
          if (same) { st.doc = merged; st.base = clone(merged); st.sha = remote.sha; st.dirty = false; break; }
          try {
            st.sha = await Vault.push(room, st.token, merged, remote.sha);
            st.doc = merged;
            st.base = clone(merged); // copie : la base ne doit pas suivre les modifications locales
            st.dirty = false;
            pushed = true;
            break;
          } catch (e) {
            if (e.code !== 'conflict' || attempt === 3) throw e;
            // Quelqu'un a publié entre-temps : on refusionne avec sa version.
            base = remote.doc;
            local = merged;
          }
        }
        st.lastSync = new Date().toISOString();
        this.error = '';
        save();
        // Modifications venues d'un autre manager ?
        const incoming = Object.values(st.doc.weeks).filter((w) => w.updated !== before[w.week] && w.by && w.by !== st.me);
        renderAll();
        if (incoming.length) toast(`Planning mis à jour par ${incoming[incoming.length - 1].by}`);
        else if (manual) toast(pushed ? 'Planning envoyé aux managers' : 'Planning à jour');
      } catch (e) {
        this.error = syncError(e);
        if (manual) toast(this.error, 4000);
      } finally {
        this.busy = false;
        ui.sync();
        if (this.again) { this.again = false; this.run(false); }
      }
    },
  };

  function syncError(e) {
    switch (e && e.code) {
      case 'native': return 'Envoi automatique disponible dans l\'appli Android';
      case 'network': return 'Pas de connexion : les modifications partiront plus tard';
      case 'token-bad': return 'Clé GitHub refusée (expirée ?) : à remplacer dans Réglages';
      case 'token-denied': return 'La clé GitHub n\'a pas le droit d\'écrire dans le dépôt';
      case 'rate': return 'GitHub limite les accès : réessaie dans quelques minutes';
      case 'http': return `Erreur GitHub (${e.status})`;
      default: return e && e.name === 'OperationError' ? 'Planning en ligne illisible avec ce code' : 'Synchronisation impossible';
    }
  }

  const ui = {
    sync() {
      const b = $('sync-btn');
      b.classList.toggle('busy', sync.busy);
      b.classList.toggle('bad', !!sync.error);
      b.querySelector('use').setAttribute('href', sync.busy ? '#i-sync' : !st || !st.token ? '#i-cloud-off' : sync.error || st.dirty ? '#i-cloud' : '#i-cloud-ok');
      if (page === 'settings') renderSettings();
    },
  };

  /* ---------- Écrans ---------- */

  function showScreen(id) {
    for (const s of ['welcome', 'lock', 'app']) $(s).hidden = s !== id;
  }

  async function start() {
    if (!st) { showScreen('welcome'); return; }
    if (st.lock && native && native.authenticate) { showScreen('lock'); $('lock-title').textContent = st.resto || 'Planning équipe'; unlock(); return; }
    await enter();
  }

  async function enter() {
    try {
      room = await Vault.open(st.code);
    } catch {
      showScreen('welcome');
      toast('Code du restaurant illisible : rejoins-le à nouveau');
      return;
    }
    st.doc = M.cleanDoc(st.doc);
    showScreen('app');
    renderAll();
    sync.run(false);
    if (native && native.checkUpdate) native.checkUpdate(false);
  }

  /* ---------- Démarrage : rejoindre / créer ---------- */

  function welcomeStep(id) {
    for (const s of ['w-choice', 'w-join', 'w-create', 'w-created']) $(s).hidden = s !== id;
  }
  $('w-join-btn').onclick = () => { welcomeStep('w-join'); $('j-code').focus(); };
  $('w-create-btn').onclick = () => { welcomeStep('w-create'); $('c-name').focus(); };
  document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => welcomeStep('w-choice'); });
  $('j-code').addEventListener('input', (e) => {
    const raw = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 16);
    e.target.value = raw.match(/.{1,4}/g) ? raw.match(/.{1,4}/g).join('-') : '';
  });

  $('w-join').onsubmit = async (e) => {
    e.preventDefault();
    const code = Vault.normCode($('j-code').value);
    const me = $('j-name').value.trim();
    if (!code) return showError('j-error', 'Le code fait 16 caractères (ex. 7K4P-M2QX-9TRB-H6WD).');
    if (!me) return showError('j-error', 'Indique ton prénom.');
    showError('j-error', '');
    const btn = $('j-submit');
    btn.disabled = true;
    btn.textContent = 'Recherche du restaurant…';
    try {
      const r = await Vault.open(code);
      const key = await Vault.fetchToken(r, '');
      if (!key) throw Object.assign(new Error('unknown'), { code: 'unknown' });
      const remote = await Vault.pull(r, key.token);
      const doc = M.cleanDoc(remote.doc || M.emptyDoc());
      st = { code, resto: doc.name, me, token: key.token, doc, base: remote.doc ? clone(doc) : null, sha: remote.sha, dirty: false, lastSync: new Date().toISOString(), lock: false };
      save();
      room = r;
      week = currentMonday();
      showScreen('app');
      renderAll();
      toast(`Bienvenue, ${me} !`);
      if (native && native.checkUpdate) native.checkUpdate(false);
    } catch (err) {
      showError('j-error', err.code === 'unknown'
        ? 'Code inconnu. Vérifie le code, ou demande à l\'administrateur d\'activer l\'envoi automatique.'
        : syncError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Rejoindre';
    }
  };

  $('w-create').onsubmit = async (e) => {
    e.preventDefault();
    const resto = $('c-resto').value.trim() || 'BK Claye-Souilly';
    const me = $('c-name').value.trim();
    if (!me) return showError('c-error', 'Indique ton prénom.');
    showError('c-error', '');
    const code = Vault.newCode();
    room = await Vault.open(code);
    st = { code, resto, me, token: '', doc: M.emptyDoc(resto), base: null, sha: null, dirty: true, lastSync: '', lock: false };
    save();
    $('cr-code').textContent = code;
    welcomeStep('w-created');
  };
  $('cr-copy').onclick = () => copyText(st.code);
  $('cr-share').onclick = () => shareText(inviteText());
  $('cr-go').onclick = () => { showScreen('app'); renderAll(); };
  const inviteText = () => `Planning ${st.resto || 'BK'} — code du restaurant : ${st.code}\nAppli Android : ${APK_URL}`;

  /* ---------- Verrouillage ---------- */

  function unlock() {
    showError('lock-error', '');
    native.authenticate('Déverrouiller le planning');
  }
  $('lock-open').onclick = unlock;
  let authWanted = null;
  window.bkAuth = (ok, msg) => {
    if (authWanted) { const f = authWanted; authWanted = null; f(ok, msg); return; }
    if (ok) enter();
    else showError('lock-error', msg && msg !== 'cancel' ? msg : '');
  };
  let pausedAt = 0;
  window.bkPause = () => { pausedAt = Date.now(); };
  window.bkResume = () => {
    if (st && st.lock && native && native.authenticate && pausedAt && Date.now() - pausedAt > 120000 && !$('app').hidden) {
      showScreen('lock');
      unlock();
      return;
    }
    if (room && !$('app').hidden) sync.run(false);
  };
  setInterval(() => { if (room && !document.hidden && !$('app').hidden) sync.run(false); }, 180000);

  /* ---------- Navigation ---------- */

  const TITLES = { plan: 'Planning', hours: 'Heures et alertes', add: 'Ajouter un planning', settings: 'Réglages' };
  function showPage(p) {
    page = p;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === p));
    for (const id of ['plan', 'hours', 'add', 'settings']) $(`page-${id}`).hidden = id !== p;
    $('page-title').textContent = TITLES[p];
    $('weekbar').hidden = p === 'add' || p === 'settings';
    renderAll();
    $('pages').scrollTop = 0;
  }
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showPage(t.dataset.page); });
  document.querySelectorAll('#plan-mode button').forEach((b) => {
    b.onclick = () => { mode = b.dataset.mode; renderPlan(); };
  });
  $('wk-prev').onclick = () => { week = M.iso(M.addDays(M.parseDate(week), -7)); renderAll(); };
  $('wk-next').onclick = () => { week = M.iso(M.addDays(M.parseDate(week), 7)); renderAll(); };
  $('wk-title').onclick = () => { week = currentMonday(); day = todayIdx(); renderAll(); };
  $('sync-btn').onclick = () => sync.run(true);

  window.bkBack = () => {
    if (openSheets.length) {
      const top = openSheets[openSheets.length - 1];
      if (top === 'sh-confirm') $('cf-no').click(); else closeSheet(top);
      return true;
    }
    if (!$('app').hidden && page !== 'plan') { showPage('plan'); return true; }
    if (!$('welcome').hidden && $('w-choice').hidden && $('w-created').hidden) { welcomeStep('w-choice'); return true; }
    return false;
  };

  /* ---------- Rendu ---------- */

  function renderAll() {
    if (!st || $('app').hidden) return;
    $('resto-name').textContent = st.resto || 'BK Claye-Souilly';
    renderWeekbar();
    renderBadge();
    if (page === 'plan') renderPlan();
    else if (page === 'hours') renderHours();
    else if (page === 'settings') renderSettings();
    ui.sync();
  }

  function renderWeekbar() {
    $('wk-range').textContent = M.weekRange(week);
    const diff = Math.round((M.parseDate(week) - M.parseDate(currentMonday())) / (7 * 86400000));
    const w = curWeek();
    const when = diff === 0 ? 'Cette semaine' : diff === 1 ? 'Semaine prochaine' : diff === -1 ? 'Semaine dernière'
      : diff > 0 ? `Dans ${diff} semaines` : `Il y a ${-diff} semaines`;
    $('wk-sub').textContent = w ? `${when} · ${w.people.length} personnes` : `${when} · pas de planning`;
  }

  function warnAlerts(wk = week) {
    return st.doc.weeks[wk] ? M.alerts(st.doc, wk).filter((a) => a.level === 'warn') : [];
  }
  function renderBadge() {
    const n = warnAlerts().length;
    $('al-badge').hidden = !n;
    $('al-badge').textContent = n > 99 ? '99+' : String(n);
  }

  /* ----- Planning ----- */

  function renderPlan() {
    const w = curWeek();
    document.querySelectorAll('#plan-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('plan-empty').hidden = !!w;
    $('plan-mode').hidden = !w;
    $('plan-foot').hidden = !w;
    $('plan-day').hidden = !w || mode !== 'day';
    $('plan-week').hidden = !w || mode !== 'week';
    if (!w) return;
    if (mode === 'day') renderDay(w); else renderGrid(w);
    const last = (w.log || [])[w.log.length - 1];
    $('last-edit').textContent = last ? `Modifié ${last.by ? `par ${last.by} ` : ''}${ago(last.at)}` : 'Historique';
  }

  function renderDay(w) {
    const alertsByDay = new Set(warnAlerts().map((a) => a.day).filter((d) => d !== null));
    const monday = M.parseDate(week);
    const isCurrent = week === currentMonday();
    const me = mePerson(w);
    $('day-strip').replaceChildren(...M.DAYS_SHORT.map((name, i) => {
      const d = M.addDays(monday, i);
      const n = w.people.filter((p) => M.work(p.days[i]).length).length;
      const mine = me && M.work(me.days[i]).length;
      const b = el('button', `day-pill${i === day ? ' active' : ''}${isCurrent && i === todayIdx() ? ' today' : ''}${alertsByDay.has(i) ? ' alert' : ''}${mine ? ' mine' : ''}`);
      b.append(el('small', '', name), el('b', '', String(d.getDate())), el('i', '', `${n} 👤`));
      b.title = `${n} personnes au travail`;
      b.onclick = () => { day = i; renderDay(w); };
      return b;
    }));

    const rows = [];
    const resting = [];
    for (const p of w.people) {
      const work = M.work(p.days[day]);
      const cp = M.leave(p.days[day]);
      if (!work.length) { resting.push({ p, cp }); continue; }
      rows.push({ p, work, cp, swap: M.swapWith(w, p.name, day) });
    }
    rows.sort((a, b) => (a.work[0].a - b.work[0].a) || (a.work[a.work.length - 1].b - b.work[b.work.length - 1].b) || a.p.name.localeCompare(b.p.name));
    const total = M.dayTotal(w, day);
    $('day-title').textContent = M.dayLabel(week, day);
    $('day-sub').textContent = rows.length ? `${rows.length} au travail · ${M.fmtDur(total)}` : 'Personne ne travaille';
    const meLine = $('me-line');
    meLine.hidden = !me;
    if (me) {
      const mw = M.work(me.days[day]);
      const mcp = M.leave(me.days[day]);
      meLine.textContent = mw.length ? `Toi : ${mw.map((s) => `${M.fmtClock(s.a)}–${M.fmtClock(s.b)}`).join(' · ')}` : mcp ? `Toi : congé ${M.fmtDur(mcp)}` : 'Toi : repos';
    }

    const all = rows.flatMap((r) => r.work);
    const from = all.length ? Math.floor(Math.min(...all.map((s) => s.a)) / 60) * 60 : 9 * 60;
    let to = all.length ? Math.ceil(Math.max(...all.map((s) => s.b)) / 60) * 60 : 23 * 60;
    if (to - from < 6 * 60) to = from + 6 * 60;
    const span = to - from;
    const pct = (m) => `${((m - from) / span) * 100}%`;

    // Effectif par quart d'heure
    const cov = M.coverage(w, day);
    const min = st.doc.settings.minStaff || 0;
    const covEl = $('cov');
    covEl.replaceChildren();
    if (cov) {
      const bars = [];
      for (let m = from; m < to; m += 15) {
        const k = (m - cov.from) / 15;
        const n = k >= 0 && k < cov.counts.length ? cov.counts[k] : 0;
        const inRange = m >= cov.from && m < cov.to;
        const i = el('i', inRange && (n === 0 || n < min) ? 'low' : '');
        i.style.height = `${Math.max(2, (n / Math.max(1, cov.max)) * 100)}%`;
        if (!inRange) i.style.opacity = '0';
        i.title = `${M.fmtClock(m)} : ${n} pers.`;
        bars.push(i);
      }
      covEl.append(...bars);
    }
    covEl.hidden = !cov;

    const step = span > 12 * 60 ? 180 : 120;
    const head = el('div', 'tl-row tl-head');
    head.append(el('div', 'tl-name'));
    const scale = el('div', 'tl-track');
    for (let m = Math.ceil(from / step) * step; m <= to; m += step) {
      const t = el('span', 'tl-tick', `${Math.floor(m / 60) % 24}h`);
      t.style.left = pct(m);
      scale.append(t);
    }
    head.append(scale);
    const body = [head];
    for (const r of rows) {
      const row = el('div', `tl-row${r.swap ? ' swapped' : ''}${me && r.p === me ? ' me' : ''}`);
      const name = el('button', 'tl-name', r.p.name);
      if (r.swap) name.title = `Échange avec ${r.swap}`;
      name.onclick = () => openDay(r.p.name, day);
      row.append(name);
      const track = el('div', 'tl-track');
      for (let m = Math.ceil(from / step) * step; m <= to; m += step) {
        const g = el('i', 'tl-grid');
        g.style.left = pct(m);
        track.append(g);
      }
      for (const s of r.work) {
        const bar = el('button', `tl-bar${s.b > 24 * 60 ? ' night' : ''}`);
        bar.style.left = pct(s.a);
        bar.style.width = `${((s.b - s.a) / span) * 100}%`;
        const ratio = (s.b - s.a) / span;
        const short = (m) => `${Math.floor(m / 60) % 24}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
        bar.textContent = ratio > 0.25 ? `${short(s.a)}–${short(s.b)}` : ratio > 0.11 ? short(s.a) : '';
        bar.onclick = () => openDay(r.p.name, day);
        track.append(bar);
      }
      row.append(track);
      body.push(row);
    }
    if (!rows.length) body.push(el('p', 'tl-empty', 'Personne ne travaille ce jour-là.'));
    if (isCurrent && day === todayIdx()) {
      const now = new Date();
      const m = now.getHours() * 60 + now.getMinutes();
      if (m >= from && m <= to) {
        const line = el('i', 'tl-now');
        line.style.left = `calc(var(--tl-name) + (100% - var(--tl-name)) * ${(m - from) / span})`;
        body.push(line);
      }
    }
    const tl = $('timeline');
    tl.style.position = 'relative';
    tl.replaceChildren(...body);

    const rest = $('rest-list');
    rest.replaceChildren();
    if (resting.length) {
      rest.append(el('small', '', `En repos ou en congé (${resting.length})`));
      for (const r of resting) {
        const c = el('button', 'chip', r.cp ? `${r.p.name} · congé ${M.fmtDur(r.cp)}` : r.p.name);
        c.onclick = () => openDay(r.p.name, day);
        rest.append(c);
      }
    }
  }

  function renderGrid(w) {
    const monday = M.parseDate(week);
    const table = $('grid');
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', 'name', 'Nom'));
    M.DAYS_SHORT.forEach((d, i) => hr.append(el('th', '', `${d} ${M.addDays(monday, i).getDate()}`)));
    hr.append(el('th', '', 'Total'));
    thead.append(hr);
    const tbody = el('tbody');
    for (const p of w.people) {
      const tr = el('tr');
      const name = el('td', 'name');
      const b = el('b', '', p.name);
      name.append(b, el('small', '', p.contract ? `contrat ${M.fmtDur(M.toMin(p.contract))}` : 'contrat ?'));
      name.onclick = () => openPerson(p.name);
      tr.append(name);
      p.days.forEach((slots, i) => {
        const work = M.work(slots);
        const cp = M.leave(slots);
        const td = el('td', `cell${!work.length && !cp ? ' off' : ''}${!work.length && cp ? ' cp' : ''}${M.swapWith(w, p.name, i) ? ' swapped' : ''}`);
        if (!work.length && !cp) td.textContent = 'Repos';
        else {
          work.forEach((s, k) => { if (k) td.append(el('br')); td.append(document.createTextNode(`${M.fmtClock(s.a)}–${M.fmtClock(s.b)}`)); });
          if (cp) { if (work.length) td.append(el('br')); td.append(document.createTextNode(`CP ${M.fmtDur(cp)}`)); }
        }
        td.onclick = () => openDay(p.name, i);
        tr.append(td);
      });
      const tot = M.personMinutes(p);
      const td = el('td', 'tot');
      td.append(el('div', '', M.fmtDur(tot)));
      if (p.contract) {
        const diff = tot - M.toMin(p.contract);
        if (diff) td.append(el('small', diff > 0 ? 'diff-plus' : 'diff-minus', `${diff > 0 ? '+' : ''}${M.fmtDur(diff)}`));
      }
      tr.append(td);
      tbody.append(tr);
    }
    const totals = M.weekTotals(w);
    const tfoot = el('tfoot');
    const fr = el('tr');
    fr.append(el('td', 'name', 'Total'));
    totals.days.forEach((m) => fr.append(el('td', '', M.fmtDur(m))));
    fr.append(el('td', '', M.fmtDur(totals.planned)));
    tfoot.append(fr);
    table.replaceChildren(thead, tbody, tfoot);
  }

  /* ----- Modifier une journée ----- */

  let edit = null; // { name, day, kind, slots: [{ start, end }], cp }
  function openDay(name, d) {
    const w = curWeek();
    const p = w && w.people.find((x) => x.name === name);
    if (!p) return;
    const work = M.work(p.days[d]);
    const cp = M.leave(p.days[d]);
    const defCp = p.contract ? Math.round(M.toMin(p.contract) / 5) : 0;
    edit = {
      name, day: d,
      kind: work.length ? 'work' : cp ? 'cp' : 'off',
      slots: work.length ? work.map((s) => ({ start: M.hhmm(s.a % 1440), end: M.hhmm(s.b % 1440) })) : [{ start: '', end: '' }],
      cp: M.hhmm(cp || defCp),
    };
    $('sd-name').textContent = name;
    const swap = M.swapWith(w, name, d);
    $('sd-date').textContent = M.dayLabel(week, d) + (swap ? ` · échangé avec ${swap}` : '');
    $('sd-info').textContent = '';
    showError('sd-error', '');
    renderEdit();
    openSheet('sh-day');
  }

  function renderEdit() {
    document.querySelectorAll('#sd-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === edit.kind));
    $('sd-work').hidden = edit.kind !== 'work';
    $('sd-cp').hidden = edit.kind !== 'cp';
    $('sd-cp-dur').value = edit.cp;
    const list = $('sd-slots');
    list.replaceChildren(...edit.slots.map((s, i) => {
      const li = el('li');
      const a = el('input');
      a.type = 'time';
      a.value = s.start;
      a.setAttribute('aria-label', 'Début');
      a.onchange = () => { s.start = a.value; renderEditInfo(); };
      const b = el('input');
      b.type = 'time';
      b.value = s.end;
      b.setAttribute('aria-label', 'Fin');
      b.onchange = () => { s.end = b.value; renderEditInfo(); };
      const del = el('button', 'icon-btn');
      del.setAttribute('aria-label', 'Retirer ce créneau');
      del.append(icon('trash'));
      del.onclick = () => { edit.slots.splice(i, 1); if (!edit.slots.length) edit.slots.push({ start: '', end: '' }); renderEdit(); };
      li.append(a, el('span', '', '→'), b, del);
      return li;
    }));
    renderEditInfo();
  }

  // Créneaux saisis → 'HH:MM-HH:MM' (fin le lendemain si elle est avant le début).
  function editedSlots() {
    if (edit.kind === 'off') return { slots: [] };
    if (edit.kind === 'cp') {
      const m = M.toMin(edit.cp);
      if (!m || m > 14 * 60) return { error: 'Durée de congé invalide.' };
      return { slots: [`CP ${M.hhmm(m)}`] };
    }
    const filled = edit.slots.filter((s) => s.start || s.end);
    if (!filled.length) return { error: 'Ajoute au moins un créneau, ou choisis Repos.' };
    const out = [];
    let prev = -1;
    for (const s of filled) {
      if (!s.start || !s.end) return { error: 'Chaque créneau a un début et une fin.' };
      let a = M.toMin(s.start);
      let b = M.toMin(s.end);
      if (prev > 18 * 60 && a < 12 * 60) { a += 1440; b += 1440; }
      if (b <= a) b += 1440;
      if (b - a > 16 * 60) return { error: 'Créneau trop long.' };
      out.push({ a, b });
      prev = b;
    }
    out.sort((x, y) => x.a - y.a);
    for (let i = 1; i < out.length; i++) if (out[i].a < out[i - 1].b) return { error: 'Deux créneaux se chevauchent.' };
    return { slots: out.map((s) => `${M.hhmm(s.a)}-${M.hhmm(s.b)}${s.b >= 1440 ? '*' : ''}`) };
  }

  function renderEditInfo() {
    const r = editedSlots();
    if (r.error) { $('sd-info').textContent = ''; return; }
    const m = M.dayMinutes(r.slots);
    const night = r.slots.some((s) => s.endsWith('*'));
    $('sd-info').textContent = edit.kind === 'off' ? 'Repos ce jour-là.' : `${M.fmtDur(m)} ce jour-là${night ? ' (fin le lendemain)' : ''}.`;
  }

  document.querySelectorAll('#sd-kind button').forEach((b) => { b.onclick = () => { edit.kind = b.dataset.kind; renderEdit(); }; });
  $('sd-cp-dur').onchange = (e) => { edit.cp = e.target.value; renderEditInfo(); };
  $('sd-add').onclick = () => {
    const last = edit.slots[edit.slots.length - 1];
    edit.slots.push({ start: last && last.end ? last.end : '', end: '' });
    renderEdit();
  };
  $('sd-save').onclick = () => {
    const r = editedSlots();
    if (r.error) return showError('sd-error', r.error);
    const w = curWeek();
    const p = w.people.find((x) => x.name === edit.name);
    if (stable(p.days[edit.day]) === stable(r.slots)) { closeSheet('sh-day'); return; }
    commitWeek(M.setDay(w, edit.name, edit.day, r.slots, st.me));
    closeSheet('sh-day');
    toast('Enregistré');
  };
  $('sd-person').onclick = () => { closeSheet('sh-day'); openPerson(edit.name); };

  $('sd-swap').onclick = () => {
    const w = curWeek();
    $('sw-sub').textContent = `${edit.name} · ${M.dayLabel(week, edit.day)}`;
    const mine = w.people.find((x) => x.name === edit.name);
    $('sw-list').replaceChildren(...w.people.filter((p) => p.name !== edit.name).map((p) => {
      const li = el('li');
      const b = el('button');
      const left = el('span');
      left.append(el('b', '', p.name));
      b.append(left, el('small', '', M.slotsShort(p.days[edit.day])));
      b.onclick = async () => {
        const ok = await confirmBox('Confirmer l\'échange',
          `${M.dayLabel(week, edit.day)} : ${edit.name} prend « ${M.slotsShort(p.days[edit.day])} » et ${p.name} prend « ${M.slotsShort(mine.days[edit.day])} ».`, 'Échanger');
        if (!ok) return;
        commitWeek(M.swapDay(curWeek(), edit.name, p.name, edit.day, st.me));
        closeSheet('sh-swap');
        closeSheet('sh-day');
        toast('Échange enregistré');
      };
      li.append(b);
      return li;
    }));
    openSheet('sh-swap');
  };

  /* ----- Une personne ----- */

  let personName = '';
  function openPerson(name) {
    const w = curWeek();
    const p = w && w.people.find((x) => x.name === name);
    if (!p) return;
    personName = name;
    $('sp-title').textContent = name;
    $('sp-sub').textContent = `${M.fmtDur(M.personMinutes(p))} prévues${p.contract ? ` · contrat ${M.fmtDur(M.toMin(p.contract))}` : ''}`;
    $('sp-days').replaceChildren(...p.days.map((slots, i) => {
      const li = el('li');
      const b = el('button');
      const swap = M.swapWith(w, name, i);
      b.append(el('b', '', M.dayLabel(week, i).split(' ').slice(0, 2).join(' ')), el('span', '', M.slotsShort(slots)), el('em', '', swap ? `⇄ ${swap.split(' ')[0]}` : M.dayMinutes(slots) ? M.fmtDur(M.dayMinutes(slots)) : ''));
      b.onclick = () => { closeSheet('sh-person'); openDay(name, i); };
      li.append(b);
      return li;
    }));
    $('sp-name').value = p.name;
    $('sp-contract').value = p.contract;
    const isMe = mePerson(w) === p;
    $('sp-me').lastChild.textContent = isMe ? 'Ce n\'est pas moi' : 'C\'est moi (mettre ma ligne en avant)';
    showError('sp-error', '');
    openSheet('sh-person');
  }
  const normContract = (v) => {
    const t = String(v || '').trim();
    if (!t) return '';
    const m = t.match(/^(\d{1,2})(?:[:hH.,](\d{1,2}))?$/);
    if (!m) return null;
    const min = m[2] ? (m[2].length === 1 ? Number(m[2]) * 10 : Number(m[2])) : 0;
    return min < 60 ? `${m[1].padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
  };
  $('sp-save').onclick = () => {
    const contract = normContract($('sp-contract').value);
    if (contract === null) return showError('sp-error', 'Contrat : écris par ex. 24 ou 24:00.');
    try {
      const w = M.editPerson(curWeek(), personName, { name: $('sp-name').value, contract }, st.me);
      if (w !== curWeek()) commitWeek(w);
      closeSheet('sh-person');
    } catch (e) {
      showError('sp-error', e.message === 'exists' ? 'Ce nom existe déjà dans la semaine.' : 'Nom invalide.');
    }
  };
  $('sp-me').onclick = () => {
    const w = curWeek();
    const p = w && w.people.find((x) => x.name === personName);
    if (!p) return;
    st.mePerson = mePerson(w) === p ? '' : p.name;
    if (!st.mePerson) st.me = st.me || '';
    save();
    closeSheet('sh-person');
    renderAll();
    toast(st.mePerson ? 'Ta ligne est mise en avant' : 'Ligne normale');
  };
  $('sp-remove').onclick = async () => {
    if (!(await confirmBox('Retirer du planning', `Retirer ${personName} de la semaine ${M.weekRange(week)} ?`, 'Retirer'))) return;
    commitWeek(M.removePerson(curWeek(), personName, st.me));
    closeSheet('sh-person');
  };

  /* ----- Semaine : plus d'actions ----- */

  $('more-btn').onclick = () => { $('mo-sub').textContent = M.weekRange(week); openSheet('sh-more'); };
  $('mo-add').onclick = () => {
    closeSheet('sh-more');
    $('ap-sub').textContent = M.weekRange(week);
    $('ap-name').value = '';
    $('ap-contract').value = '';
    showError('ap-error', '');
    openSheet('sh-add-person');
    $('ap-name').focus();
  };
  $('ap-form').onsubmit = (e) => {
    e.preventDefault();
    const contract = normContract($('ap-contract').value);
    if (contract === null) return showError('ap-error', 'Contrat : écris par ex. 24 ou 24:00.');
    try {
      commitWeek(M.addPerson(curWeek(), $('ap-name').value, contract, st.me));
      closeSheet('sh-add-person');
      mode = 'week';
      renderPlan();
    } catch (err) {
      showError('ap-error', err.message === 'exists' ? 'Cette personne est déjà dans la semaine.' : 'Indique un nom.');
    }
  };
  $('mo-photo').onclick = () => { closeSheet('sh-more'); showPage('add'); };
  $('mo-delete').onclick = async () => {
    closeSheet('sh-more');
    if (!(await confirmBox('Supprimer la semaine', `Supprimer le planning ${M.weekRange(week)} pour tous les managers ?`, 'Supprimer'))) return;
    delete st.doc.weeks[week];
    st.doc.deleted[week] = new Date().toISOString();
    st.dirty = true;
    save();
    renderAll();
    sync.soon();
    toast('Semaine supprimée');
  };
  $('hist-btn').onclick = () => {
    const w = curWeek();
    if (!w) return;
    $('hi-sub').textContent = M.weekRange(week);
    const items = [...(w.log || [])].reverse();
    $('hi-list').replaceChildren(...(items.length ? items.map((l) => {
      const li = el('li', '', l.what);
      li.append(el('small', '', `${l.by || '—'} · ${ago(l.at)}`));
      return li;
    }) : [el('li', '', 'Aucune modification.')]));
    openSheet('sh-history');
  };

  /* ----- Heures et alertes ----- */

  function renderHours() {
    const w = curWeek();
    const stats = $('stats');
    if (!w) {
      stats.replaceChildren();
      $('al-title').textContent = 'Alertes';
      $('alerts').replaceChildren(el('li', 'none', 'Pas de planning pour cette semaine.'));
      $('hours').replaceChildren();
      return;
    }
    const all = M.alerts(st.doc, week);
    const shown = all.filter((a) => a.kind !== 'contrat').sort((a, b) => (a.level === 'warn' ? 0 : 1) - (b.level === 'warn' ? 0 : 1));
    const warns = shown.filter((a) => a.level === 'warn').length;
    const t = M.weekTotals(w);
    const stat = (label, value, cls = '') => { const d = el('div', `stat ${cls}`); d.append(el('small', '', label), el('b', '', value)); return d; };
    stats.replaceChildren(stat('Prévu', M.fmtDur(t.planned)), stat('Contrats', t.contract ? M.fmtDur(t.contract) : '—'), stat('Alertes', String(warns), warns ? 'warn' : ''));
    $('al-title').textContent = shown.length ? `Alertes (${shown.length})` : 'Alertes';
    $('alerts').replaceChildren(...(shown.length ? shown.map((a) => {
      const li = el('li');
      const b = el('button', `alert ${a.level}`);
      b.append(icon(a.level === 'warn' ? 'alert' : 'info'));
      const txt = el('div');
      if (a.person) txt.append(el('b', '', a.person));
      txt.append(el('span', '', a.text));
      b.append(txt);
      b.onclick = () => {
        if (a.person && a.day !== null) openDay(a.person, a.day);
        else if (a.person) openPerson(a.person);
        else if (a.day !== null) { day = a.day; mode = 'day'; showPage('plan'); }
      };
      li.append(b);
      return li;
    }) : [el('li', 'none', '✓ Aucune alerte cette semaine')]));

    const head = el('tr');
    ['Nom', 'Prévu', 'Contrat', 'Écart'].forEach((h) => head.append(el('th', '', h)));
    const rows = w.people.map((p) => {
      const tot = M.personMinutes(p);
      const c = p.contract ? M.toMin(p.contract) : null;
      const tr = el('tr');
      tr.append(el('td', '', p.name), el('td', '', M.fmtDur(tot)), el('td', '', c === null ? '—' : M.fmtDur(c)));
      const diff = c === null ? null : tot - c;
      tr.append(el('td', diff > 0 ? 'diff-plus' : diff < 0 ? 'diff-minus' : '', diff === null || diff === 0 ? (diff === 0 ? '✓' : '') : `${diff > 0 ? '+' : ''}${M.fmtDur(diff)}`));
      tr.onclick = () => openPerson(p.name);
      return tr;
    });
    $('hours').replaceChildren(head, ...rows);
  }

  /* ----- Ajouter : lecture des photos ----- */

  let review = null; // { pages: [{ src, scale, result }], week, people, totals, dropped }
  function setAddState(s) {
    $('add-intro').hidden = s !== 'intro';
    $('add-busy').hidden = s !== 'busy';
    $('review').hidden = s !== 'review';
  }
  function pick(camera) {
    if (!native || !native.pickPhotos) { toast('La lecture des photos se fait dans l\'appli Android'); return; }
    native.pickPhotos(!!camera);
  }
  $('add-camera').onclick = () => pick(true);
  $('add-gallery').onclick = () => pick(false);
  $('rv-add-camera').onclick = () => pick(true);
  $('rv-add-gallery').onclick = () => pick(false);
  $('empty-photo').onclick = () => { showPage('add'); };

  window.bkPhoto = (event, payload) => {
    if (event === 'busy') {
      $('busy-text').textContent = payload || 'Lecture de la photo…';
      if (page !== 'add') showPage('add');
      setAddState('busy');
    } else if (event === 'page') {
      let data;
      try { data = JSON.parse(payload); } catch { return; }
      const result = SheetReader.combine(SheetReader.read(data.ocr), data.tiled ? SheetReader.read(data.tiled) : null);
      if (!result.ok || !result.people.length) {
        toast('Aucun planning reconnu sur cette photo. Recadre le tableau et réessaie.', 4200);
        return;
      }
      if (!review) review = { pages: [], week: null, dropped: new Set() };
      const idx = review.pages.length;
      result.people.forEach((p, k) => { p.page = idx; p.uid = `${idx}:${k}`; });
      review.pages.push({ src: data.src, scale: data.scale || 1, result });
      rebuildReview();
    } else if (event === 'done' || event === 'cancel') {
      setAddState(review ? 'review' : 'intro');
      if (review) renderReview();
    } else if (event === 'error') {
      setAddState(review ? 'review' : 'intro');
      toast(payload || 'Lecture impossible', 4000);
    }
  };

  // Les lignes corrigées sont modifiées sur place : elles le restent quand on ajoute une page.
  function rebuildReview() {
    const merged = SheetReader.mergePages(review.pages.map((pg) => pg.result));
    review.people = merged.people.filter((p) => !review.dropped.has(p.uid));
    review.totals = merged.totals;
    if (!review.week) review.week = merged.week || nextMondayGuess();
    setAddState('review');
    renderReview();
  }
  function nextMondayGuess() {
    const cur = currentMonday();
    return st.doc.weeks[cur] ? M.iso(M.addDays(M.parseDate(cur), 7)) : cur;
  }

  function reviewDayCheck() {
    if (!review.totals || !review.totals.days) return null;
    return review.totals.days.map((t, i) => {
      if (!t) return null;
      const sum = review.people.reduce((s, p) => s + M.dayMinutes(p.days[i].slots), 0);
      return sum === M.toMin(t);
    });
  }

  function renderReview() {
    $('rv-week').value = review.week;
    const total = review.people.length;
    const ok = review.people.filter((p) => p.ok || p.fixed).length;
    const chips = [el('span', 'chip', `${total} personne${total > 1 ? 's' : ''} · ${review.pages.length} photo${review.pages.length > 1 ? 's' : ''}`)];
    chips.push(el('span', 'chip ok', `${ok} ✓`));
    if (total - ok) chips.push(el('span', 'chip warn', `${total - ok} à vérifier`));
    const dc = reviewDayCheck();
    if (dc) {
      const known = dc.filter((x) => x !== null);
      const good = known.filter(Boolean).length;
      chips.push(el('span', `chip ${good === known.length ? 'ok' : 'warn'}`, `Totaux des jours ${good}/${known.length}`));
    }
    $('rv-summary').replaceChildren(...chips);
    $('rv-list').replaceChildren(...review.people.map((p, i) => {
      const li = el('li');
      const b = el('button', `rv-item${p.fixed ? ' fixed' : p.ok ? '' : ' check'}`);
      b.append(el('b', '', p.name || 'Nom illisible'));
      const sum = M.hhmm(p.days.reduce((t, d) => t + M.dayMinutes(d.slots), 0));
      b.append(el('span', 'st', p.fixed ? 'Corrigé' : p.ok ? `✓ ${M.fmtDur(M.toMin(sum))}` : p.planned ? `${M.fmtDur(M.toMin(sum))} ≠ ${M.fmtDur(M.toMin(p.planned))}` : 'À vérifier'));
      b.append(el('small', '', p.days.map((d, k) => `${M.DAYS_SHORT[k]} ${d.status === 'missing' ? '?' : M.slotsShort(d.slots)}`).join(' · ')));
      b.onclick = () => openReviewRow(i);
      li.append(b);
      return li;
    }));
  }
  $('rv-week').onchange = (e) => {
    if (!e.target.value) return;
    review.week = M.iso(M.mondayOf(M.parseDate(e.target.value)));
    if (review.week !== e.target.value) toast(`Semaine du lundi ${M.weekRange(review.week)}`);
    renderReview();
  };
  $('rv-cancel').onclick = async () => {
    if (!(await confirmBox('Annuler la lecture', 'Les lignes lues et corrigées seront perdues.', 'Annuler la lecture'))) return;
    review = null;
    setAddState('intro');
  };
  $('rv-save').onclick = async () => {
    if (!review || !review.people.length) return;
    const monday = review.week;
    const left = review.people.filter((p) => !p.ok && !p.fixed).length;
    if (left && !(await confirmBox('Lignes à vérifier', `${left} ligne${left > 1 ? 's ne tombent' : ' ne tombe'} pas juste avec le total imprimé. Enregistrer quand même ?`, 'Enregistrer'))) return;
    if (st.doc.weeks[monday] && !(await confirmBox('Remplacer la semaine', `Un planning existe déjà pour ${M.weekRange(monday)}. Le remplacer par celui lu sur la photo ?`, 'Remplacer'))) return;
    const w = M.fromSheet({ people: review.people.map((p) => ({ name: p.name, id: p.id, contract: p.contract, days: p.days.map((d) => d.slots) })), totals: review.totals, pages: review.pages.length }, monday, st.me);
    review = null;
    setAddState('intro');
    week = monday;
    day = monday === currentMonday() ? todayIdx() : 0;
    mode = 'week';
    commitWeek(w);
    showPage('plan');
    toast(`Planning ${M.weekRange(monday)} enregistré`);
  };

  // Extrait de la photo correspondant à la ligne.
  let rrIndex = -1;
  function openReviewRow(i) {
    rrIndex = i;
    const p = review.people[i];
    $('rr-title').textContent = p.name || 'Ligne';
    $('rr-sub').textContent = p.planned ? `Total imprimé : ${M.fmtDur(M.toMin(p.planned))}${p.contract ? ` · contrat ${M.fmtDur(M.toMin(p.contract))}` : ''}` : 'Total imprimé illisible';
    $('rr-name').value = p.name;
    $('rr-contract').value = p.contract || '';
    $('rr-days').replaceChildren(...p.days.map((d, k) => {
      const li = el('li', d.status === 'ok' ? '' : 'doubt');
      const input = el('input');
      input.value = d.status === 'missing' ? '' : M.slotsText(d.slots);
      input.placeholder = d.status === 'missing' ? 'Case illisible' : 'Repos';
      input.dataset.day = String(k);
      input.autocapitalize = 'off';
      input.oninput = reviewCheck;
      li.append(el('b', '', M.DAYS_SHORT[k]), input);
      return li;
    }));
    const sg = p.suggest;
    $('rr-suggest').hidden = !sg;
    if (sg) $('rr-suggest').textContent = `Mettre « ${sg.value} » le ${M.DAYS[sg.day]} (heures manquantes)`;
    reviewCheck();
    drawCrop(p);
    openSheet('sh-review');
  }
  $('rr-suggest').onclick = () => {
    const p = review.people[rrIndex];
    const input = $('rr-days').querySelector(`input[data-day="${p.suggest.day}"]`);
    input.value = p.suggest.value;
    reviewCheck();
  };
  function reviewInputs() {
    const out = [];
    for (const input of $('rr-days').querySelectorAll('input')) {
      const r = M.parseText(input.value);
      out.push(r);
    }
    return out;
  }
  function reviewCheck() {
    const p = review.people[rrIndex];
    const parsed = reviewInputs();
    const bad = parsed.findIndex((r) => r.error);
    if (bad >= 0) { $('rr-check').textContent = `${M.DAYS_SHORT[bad]} : ${parsed[bad].error}`; return; }
    const sum = parsed.reduce((t, r) => t + M.dayMinutes(r.slots), 0);
    if (!p.planned) $('rr-check').textContent = `Total lu : ${M.fmtDur(sum)}`;
    else if (sum === M.toMin(p.planned)) $('rr-check').textContent = `✓ ${M.fmtDur(sum)} : correspond au total imprimé`;
    else $('rr-check').textContent = `Total lu ${M.fmtDur(sum)} ≠ imprimé ${M.fmtDur(M.toMin(p.planned))} (écart ${M.fmtDur(M.toMin(p.planned) - sum)})`;
  }
  $('rr-ok').onclick = () => {
    const p = review.people[rrIndex];
    const parsed = reviewInputs();
    const bad = parsed.findIndex((r) => r.error);
    if (bad >= 0) { toast(`${M.DAYS_SHORT[bad]} : ${parsed[bad].error}`, 3500); return; }
    const name = $('rr-name').value.trim();
    if (!name) { toast('Indique le nom'); return; }
    const contract = normContract($('rr-contract').value);
    if (contract === null) { toast('Contrat : écris par ex. 24:00'); return; }
    if (review.people.some((x, k) => k !== rrIndex && M.norm(x.name) === M.norm(name))) { toast('Ce nom est déjà dans la liste'); return; }
    p.name = name;
    p.contract = contract;
    p.days = parsed.map((r) => ({ slots: r.slots, status: 'ok', raw: '' }));
    p.fixed = true;
    closeSheet('sh-review');
    renderReview();
  };
  $('rr-drop').onclick = () => {
    review.dropped.add(review.people[rrIndex].uid);
    review.people.splice(rrIndex, 1);
    closeSheet('sh-review');
    renderReview();
  };

  function drawCrop(p) {
    const canvas = $('rr-crop');
    const pg = review.pages[p.page];
    const wrap = $('rr-crop-wrap');
    if (!pg || !pg.src || !p.box) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const img = new Image();
    img.onload = () => {
      const s = pg.scale;
      const [x0, y0, x1, y1] = p.box.map((v) => v * s);
      const padY = Math.max(10, (y1 - y0) * 0.25);
      const sx = Math.max(0, x0 - 10);
      const sy = Math.max(0, y0 - padY);
      const sw = Math.min(img.naturalWidth - sx, x1 - x0 + 20);
      const sh = Math.min(img.naturalHeight - sy, y1 - y0 + 2 * padY);
      const cssH = 110;
      const ratio = window.devicePixelRatio || 1;
      const cssW = Math.round((sw / sh) * cssH);
      canvas.width = Math.round(cssW * ratio);
      canvas.height = Math.round(cssH * ratio);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    };
    img.onerror = () => { wrap.hidden = true; };
    img.src = pg.src;
  }

  /* ----- Saisie à la main ----- */

  function openManual() {
    const target = nextMondayGuess();
    $('mn-week').value = st.doc.weeks[week] ? target : week;
    manualInfo();
    showError('mn-error', '');
    openSheet('sh-manual');
  }
  function previousWeekWithPeople(monday) {
    return Object.keys(st.doc.weeks).filter((k) => k < monday).sort().reverse().map((k) => st.doc.weeks[k]).find((w) => w.people.length) || null;
  }
  function manualInfo() {
    const v = $('mn-week').value;
    if (!v) { $('mn-info').textContent = ''; return; }
    const monday = M.iso(M.mondayOf(M.parseDate(v)));
    const from = previousWeekWithPeople(monday);
    $('mn-info').textContent = `Semaine ${M.weekRange(monday)}. ${from ? `Les ${from.people.length} personnes de la semaine ${M.weekRange(from.week)} sont reprises (sans horaires).` : 'Ajoute ensuite les personnes une par une.'}`;
  }
  $('mn-week').onchange = manualInfo;
  $('add-manual').onclick = openManual;
  $('empty-manual').onclick = openManual;
  $('mn-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('mn-week').value;
    if (!v) return;
    const monday = M.iso(M.mondayOf(M.parseDate(v)));
    if (st.doc.weeks[monday]) return showError('mn-error', 'Cette semaine existe déjà.');
    commitWeek(M.blankWeek(monday, previousWeekWithPeople(monday), st.me));
    closeSheet('sh-manual');
    week = monday;
    mode = 'week';
    showPage('plan');
  };

  /* ----- Réglages ----- */

  let codeVisible = false;
  function renderSettings() {
    if (!st) return;
    $('set-resto').textContent = st.resto || 'Restaurant';
    $('set-code').textContent = codeVisible ? st.code : '••••-••••-••••-••••';
    $('sync-state').textContent = !st.token ? 'Non activé' : sync.busy ? 'Synchronisation…' : sync.error ? 'En attente' : st.dirty ? 'Modifications à envoyer' : 'Actif';
    $('sync-detail').textContent = !st.token ? 'Le planning reste sur ce téléphone.' : sync.error || (st.lastSync ? `Dernière synchro ${ago(st.lastSync)}` : '');
    $('token-detail').textContent = st.token ? 'Configurée et partagée avec les managers (chiffrée).' : 'À coller une seule fois, par l\'administrateur.';
    if (document.activeElement !== $('me-name')) $('me-name').value = st.me || '';
    $('ms-val').textContent = String(st.doc.settings.minStaff || 0);
    $('min-staff-detail').textContent = st.doc.settings.minStaff ? `Alerte quand il y a moins de ${st.doc.settings.minStaff} personnes au restaurant.` : 'Désactivé (seuls les trous sans personne sont signalés).';
    $('lock-toggle').checked = !!st.lock;
    renderThemes();
    $('upd-detail').textContent = native && native.appVersion ? `Version ${native.appVersion()}` : 'Version web';
  }
  function renderThemes() {
    const cur = Themes.get();
    $('themes').replaceChildren(...Themes.LIST.map((t) => {
      const b = el('button', `theme-opt${t.id === cur ? ' active' : ''}`);
      const sw = el('span', 'sw');
      sw.style.setProperty('--a', t.a);
      sw.style.setProperty('--b', t.b);
      sw.append(el('i'), el('i'));
      b.append(sw, el('span', '', t.label));
      b.setAttribute('aria-pressed', String(t.id === cur));
      b.onclick = () => { Themes.set(t.id); renderThemes(); };
      return b;
    }));
    $('theme-detail').textContent = cur === 'auto' ? 'Automatique : clair ou sombre comme le téléphone.' : `Thème ${Themes.LIST.find((t) => t.id === cur).label}.`;
  }
  $('code-show').onclick = () => { codeVisible = !codeVisible; renderSettings(); };
  $('code-copy').onclick = () => copyText(st.code);
  $('code-share').onclick = () => shareText(inviteText());
  $('sync-now').onclick = () => sync.run(true);
  $('me-name').onchange = (e) => { st.me = e.target.value.trim().slice(0, 30); save(); toast('Prénom enregistré'); };
  const setMinStaff = (n) => {
    st.doc.settings = { ...st.doc.settings, minStaff: Math.max(0, Math.min(20, n)), updated: new Date().toISOString() };
    st.dirty = true;
    save();
    renderSettings();
    renderBadge();
    sync.soon();
  };
  $('ms-minus').onclick = () => setMinStaff((st.doc.settings.minStaff || 0) - 1);
  $('ms-plus').onclick = () => setMinStaff((st.doc.settings.minStaff || 0) + 1);

  $('lock-toggle').onchange = (e) => {
    const on = e.target.checked;
    if (!on) { st.lock = false; save(); return; }
    if (!native || !native.authenticate) { e.target.checked = false; toast('Disponible dans l\'appli Android'); return; }
    const status = native.authStatus ? native.authStatus() : 'ok';
    if (status !== 'ok') { e.target.checked = false; toast('Aucun verrouillage d\'écran (code, empreinte) sur ce téléphone', 3800); return; }
    authWanted = (ok) => {
      st.lock = !!ok;
      e.target.checked = !!ok;
      save();
      if (ok) toast('L\'appli sera verrouillée à l\'ouverture');
    };
    native.authenticate('Confirmer le verrouillage');
  };

  $('token-btn').onclick = () => {
    $('tk-repo').textContent = Vault.REPO;
    $('tk-input').value = '';
    showError('tk-error', '');
    openSheet('sh-token');
  };
  $('tk-form').onsubmit = async (e) => {
    e.preventDefault();
    const token = $('tk-input').value.trim();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) return showError('tk-error', 'La clé commence par « github_pat_ » (copie-la en entier).');
    showError('tk-error', '');
    const btn = $('tk-save');
    btn.disabled = true;
    btn.lastChild.textContent = 'Vérification…';
    try {
      await Vault.checkToken(token);
      await Vault.publishToken(room, token);
      st.token = token;
      st.dirty = true;
      save();
      closeSheet('sh-token');
      toast('Envoi automatique activé');
      sync.run(true);
    } catch (err) {
      const msg = {
        'token-bad': 'GitHub refuse cette clé (mal copiée ou expirée).',
        'repo-missing': `Dépôt ${Vault.REPO} introuvable, ou la clé n'y a pas accès.`,
        'token-readonly': 'La clé n\'a pas le droit d\'écrire : choisis « Contents : Read and write ».',
        'token-denied': 'La clé n\'a pas le droit d\'écrire : choisis « Contents : Read and write ».',
      }[err.code] || syncError(err);
      showError('tk-error', msg);
    } finally {
      btn.disabled = false;
      btn.lastChild.textContent = 'Activer';
    }
  };

  $('leave-btn').onclick = async () => {
    if (!(await confirmBox('Quitter ce restaurant', 'Le planning et le code seront effacés de ce téléphone. Les autres managers gardent tout. Pour revenir, il faudra le code.', 'Quitter'))) return;
    try { localStorage.removeItem(STORE); } catch { /* rien */ }
    st = null;
    room = null;
    location.reload();
  };

  /* ----- Mises à jour ----- */

  let updateReady = false;
  $('upd-btn').onclick = () => {
    if (!native || !native.checkUpdate) { toast('Mises à jour depuis l\'appli Android'); return; }
    if (updateReady) native.installUpdate();
    else { toast('Recherche de mise à jour…'); native.checkUpdate(true); }
  };
  $('update-banner').onclick = () => native && native.installUpdate();
  window.bkUpdate = (event, payload) => {
    if (event === 'available') {
      updateReady = true;
      $('update-text').textContent = `Version ${payload} disponible`;
      $('update-banner').hidden = false;
      $('upd-detail').textContent = `Version ${payload} disponible — toucher pour installer`;
    } else if (event === 'none') toast('L\'appli est à jour');
    else if (event === 'progress') $('update-text').textContent = `Téléchargement… ${payload} %`;
    else if (event === 'installing') $('update-text').textContent = 'Installation…';
    else if (event === 'permission') toast('Autorise l\'installation pour Planning BK, puis touche à nouveau Installer', 4500);
    else if (event === 'error' && payload !== 'cancel') toast(payload, 4000);
  };

  start();
})();
