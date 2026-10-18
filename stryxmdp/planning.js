// Page Planning : affiche le planning stocké dans le coffre chiffré, semaine par semaine.
// Il est importé avec un « code planning » (STRYXPLAN:…) fourni par Claude ; rien n'est public.
// Format : { "updated": "AAAA-MM-JJ", "weeks": [{ "start": "AAAA-MM-JJ" (lundi), "contract": "HH:MM" }], "entries": [
//   { "date": "AAAA-MM-JJ", "start": "HH:MM", "end": "HH:MM", "label": "…", "place": "…", "note": "…" },
//   { "date": "AAAA-MM-JJ", "off": true, "label": "Repos" } ],
//   "teams": { "AAAA-MM-JJ" (lundi): { "me": "Nom", "totals": [7 × "HH:MM"],
//              "people": [[ "Nom", "prévu", "contrat", [7 jours × ["HH:MM-HH:MM*" | "CP HH:MM"]] ]] } } }
// Les heures après minuit s'écrivent 24:00 et plus (ex. 22:00-26:30).
// Échanges de créneaux : "swaps": [{ "day": 0-6, "a": "Nom", "b": "Nom" }] (affichés dans les deux vues).
'use strict';

const Planning = (() => {
  const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const DAYS_LONG = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  let data = null;
  let weekStart = null; // lundi de la semaine affichée
  const $ = (id) => document.getElementById(id);

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const mondayOf = (d) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));
  const minutes = (hhmm) => { const [h, m] = (hhmm || '0:0').split(/[:hH]/).map(Number); return h * 60 + (m || 0); };
  const fmtDur = (min) => `${Math.floor(min / 60)}h${min % 60 ? pad(min % 60) : ''}`;
  const fmtMin = (min) => `${pad(Math.floor(min / 60) % 24)}h${pad(min % 60)}`;
  const fmtTime = (hhmm) => fmtMin(minutes(hhmm));
  const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');

  // Durée d'un créneau (gère les nuits qui finissent le lendemain).
  function duration(e) {
    if (e.off || !e.start || !e.end) return 0;
    let d = minutes(e.end) - minutes(e.start);
    if (d < 0) d += 24 * 60;
    return d;
  }

  function startAt(e) {
    const d = parseDate(e.date);
    const m = minutes(e.start);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(m / 60), m % 60);
  }

  const validEntries = (list) => (Array.isArray(list) ? list : []).filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date || ''));

  const fromB64 = (b64) => Uint8Array.from(atob(b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Response(stream).text();
  }

  const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

  // Nom de la personne avec qui `name` a échangé son créneau ce jour-là (ou '').
  function swapWith(team, name, day) {
    const s = (team.swaps || []).find((x) => x.day === day && (norm(x.a) === norm(name) || norm(x.b) === norm(name)));
    if (!s) return '';
    return norm(s.a) === norm(name) ? s.b : s.a;
  }

  // Planning d'équipe (v2) : extrait aussi « mes » créneaux pour la vue personnelle.
  function fromTeam(obj) {
    const swaps = (Array.isArray(obj.swaps) ? obj.swaps : []).filter((s) => s && Number.isInteger(s.day) && s.a && s.b);
    const team = { me: obj.me || '', totals: obj.totals || [], people: Array.isArray(obj.people) ? obj.people : [], swaps };
    const mine = team.people.find((p) => norm(p[0]) === norm(team.me));
    const monday = parseDate(obj.week);
    const entries = [];
    if (mine) {
      mine[3].forEach((slots, i) => {
        const date = iso(addDays(monday, i));
        const work = slots.filter((s) => !/^CP/i.test(s));
        const cp = slots.find((s) => /^CP/i.test(s));
        const swap = swapWith(team, mine[0], i);
        const note = swap ? `Échange avec ${firstName(swap)}` : '';
        if (!work.length) entries.push({ date, off: true, label: cp ? `Congé (${fmtDur(minutes(cp.slice(3)))})` : 'Repos', note });
        work.forEach((s) => {
          const [start, end] = s.replace('*', '').split('-');
          entries.push({ date, start, end, label: 'Burger King', note });
        });
      });
    }
    return {
      updated: obj.updated || '',
      weeks: mine ? [{ start: obj.week, contract: mine[2] }] : [],
      entries,
      teams: { [obj.week]: team },
    };
  }

  // Lit un code planning (STRYXPLAN: JSON en base64, STRYXPLAN2: équipe compressée) ou du JSON brut.
  // Tolérant au copier-coller : texte autour, retours à la ligne, ``` … ; code compressé ou non.
  async function decode(code) {
    let text = code.trim();
    const m = text.match(/STRYXPLAN2?\s*:\s*([A-Za-z0-9+/=_\-\s]+)/i);
    if (m) {
      const bytes = fromB64(m[1]);
      if (bytes[0] === 0x7b) text = new TextDecoder().decode(bytes); // JSON non compressé
      else {
        if (typeof DecompressionStream === 'undefined') throw new Error('inflate');
        try { text = await inflate(bytes); } catch { throw new Error('inflate'); }
      }
    }
    const obj = JSON.parse(text);
    if (Array.isArray(obj.people)) {
      if (!obj.week) throw new Error('format');
      return fromTeam(obj);
    }
    const entries = validEntries(obj.entries);
    if (!entries.length) throw new Error('vide');
    return { updated: obj.updated || '', weeks: Array.isArray(obj.weeks) ? obj.weeks : [], entries, teams: {} };
  }

  // Fusionne : les jours présents dans le nouveau planning remplacent les anciens.
  function merge(old, add) {
    const days = new Set(add.entries.map((e) => e.date));
    const weeks = new Map(((old && old.weeks) || []).map((w) => [w.start, w]));
    add.weeks.forEach((w) => weeks.set(w.start, w));
    return {
      updated: add.updated || (old && old.updated) || '',
      weeks: [...weeks.values()],
      entries: [...validEntries(old && old.entries).filter((e) => !days.has(e.date)), ...add.entries],
      teams: { ...((old && old.teams) || {}), ...(add.teams || {}) },
    };
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderNext() {
    const box = $('plan-next');
    const now = new Date();
    const next = data.entries
      .filter((e) => !e.off && e.start)
      .map((e) => ({ e, at: startAt(e) }))
      .filter((x) => x.at.getTime() + duration(x.e) * 60000 > now.getTime())
      .sort((a, b) => a.at - b.at)[0];
    if (!next) { box.hidden = true; return; }
    const { e, at } = next;
    const ongoing = at <= now;
    const diff = Math.round((at - now) / 60000);
    const when = ongoing ? 'En ce moment'
      : diff < 60 ? `Dans ${diff} min`
        : diff < 24 * 60 ? `Dans ${fmtDur(Math.round(diff / 60) * 60)}`
          : `${DAYS_LONG[(at.getDay() + 6) % 7]} ${at.getDate()} ${at.toLocaleDateString('fr-FR', { month: 'long' })}`;
    box.replaceChildren(
      el('small', '', ongoing ? 'En cours' : 'Prochain créneau'),
      el('b', '', `${when} · ${fmtTime(e.start)} – ${fmtTime(e.end)}`),
      el('span', '', [e.label, e.place].filter(Boolean).join(' · ') || `${fmtDur(duration(e))} de travail`),
    );
    box.hidden = false;
  }

  function renderWeek() {
    const today = iso(new Date());
    const end = addDays(weekStart, 6);
    const sameMonth = weekStart.getMonth() === end.getMonth();
    $('week-title').textContent = sameMonth
      ? `${weekStart.getDate()} – ${end.getDate()} ${end.toLocaleDateString('fr-FR', { month: 'long' })}`
      : `${weekStart.getDate()} ${weekStart.toLocaleDateString('fr-FR', { month: 'short' })} – ${end.getDate()} ${end.toLocaleDateString('fr-FR', { month: 'short' })}`;

    let total = 0;
    let worked = 0;
    const items = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      const key = iso(day);
      const entries = data.entries.filter((e) => e.date === key).sort((a, b) => minutes(a.start) - minutes(b.start));
      const li = el('li', 'day glass' + (key === today ? ' today' : key < today ? ' past' : ''));
      li.style.animationDelay = i * 35 + 'ms';
      const date = el('div', 'day-date');
      date.append(el('small', '', DAYS[i]), el('b', '', String(day.getDate())));
      const body = el('div', 'day-body');
      const shifts = entries.filter((e) => !e.off);
      if (!shifts.length) {
        const off = entries.find((e) => e.off);
        body.append(el('div', 'rest', off && off.label ? off.label : 'Repos'));
      } else {
        worked++;
        for (const e of shifts) {
          const d = duration(e);
          total += d;
          const row = el('div', 'shift');
          const info = el('div', 'shift-info');
          info.append(el('b', '', e.label || 'Travail'));
          const sub = [e.place, e.note].filter(Boolean).join(' · ');
          if (sub) info.append(el('span', '', sub));
          row.append(el('div', 'shift-time', e.start ? `${fmtTime(e.start)} – ${fmtTime(e.end || '')}` : 'Journée'), info);
          if (d) row.append(el('div', 'shift-dur', fmtDur(d)));
          body.append(row);
        }
      }
      li.append(date, body);
      items.push(li);
    }
    $('days').replaceChildren(...items);
    const week = (data.weeks || []).find((w) => w.start === iso(weekStart));
    const contract = week && week.contract ? ` · contrat ${fmtDur(minutes(week.contract))}` : '';
    $('week-sub').textContent = total
      ? `${fmtDur(total)} sur ${worked} jour${worked > 1 ? 's' : ''}${contract}`
      : 'Aucun créneau cette semaine';
    $('week-today').hidden = iso(weekStart) === iso(mondayOf(new Date()));
  }

  /* ----- Vue Équipe : un jour, tout le monde, frise horaire ----- */

  let mode = 'me';
  let teamWeek = null; // clé AAAA-MM-JJ du lundi
  let teamDay = 0;     // 0 = lundi

  const parseSlot = (s) => {
    if (/^CP/i.test(s)) return { cp: minutes(s.slice(3)) };
    const [a, b] = s.replace('*', '').split('-');
    return { start: minutes(a), end: minutes(b), night: s.includes('*') };
  };

  function teamKeys() {
    return Object.keys(data.teams || {}).sort();
  }

  function renderTeam() {
    const keys = teamKeys();
    const team = data.teams[teamWeek];
    const monday = parseDate(teamWeek);
    const day = addDays(monday, teamDay);
    const todayKey = iso(new Date());
    const end = addDays(monday, 6);
    $('team-title').textContent = `${monday.getDate()} – ${end.getDate()} ${end.toLocaleDateString('fr-FR', { month: 'long' })}`;
    $('team-sub').textContent = `${team.people.length} personnes · ${day.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}`;
    $('team-prev').disabled = keys.indexOf(teamWeek) <= 0;
    $('team-next').disabled = keys.indexOf(teamWeek) >= keys.length - 1;

    // Bandeau des jours
    $('day-strip').replaceChildren(...DAYS.map((name, i) => {
      const d = addDays(monday, i);
      const b = el('button', 'day-pill' + (i === teamDay ? ' active' : '') + (iso(d) === todayKey ? ' is-today' : ''));
      b.append(el('small', '', name), el('b', '', String(d.getDate())));
      const meSlots = (team.people.find((p) => norm(p[0]) === norm(team.me)) || [, , , []])[3][i] || [];
      if (meSlots.some((s) => !/^CP/i.test(s))) b.append(el('i', 'me-dot'));
      b.onclick = () => { teamDay = i; renderTeam(); };
      return b;
    }));
    const active = $('day-strip').children[teamDay];
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });

    // Personnes du jour
    const rows = [];
    const resting = [];
    for (const p of team.people) {
      const slots = (p[3][teamDay] || []).map(parseSlot);
      const isMe = norm(p[0]) === norm(team.me);
      const work = slots.filter((s) => s.cp === undefined);
      const leave = slots.find((s) => s.cp !== undefined);
      const cp = leave ? leave.cp : undefined;
      if (!work.length && cp === undefined) { resting.push({ name: p[0], isMe }); continue; }
      work.sort((x, y) => x.start - y.start);
      rows.push({ name: p[0], isMe, work, cp, swap: swapWith(team, p[0], teamDay), first: work.length ? work[0].start : 99999 });
    }
    // Ordre d'arrivée : premier créneau de la journée, puis heure de départ.
    const lastEnd = (r) => (r.work.length ? r.work[r.work.length - 1].end : 99999);
    rows.sort((a, b) => (a.first - b.first) || (lastEnd(a) - lastEnd(b)) || a.name.localeCompare(b.name));

    const all = rows.flatMap((r) => r.work);
    let from = all.length ? Math.floor(Math.min(...all.map((s) => s.start)) / 60) * 60 : 9 * 60;
    let to = all.length ? Math.ceil(Math.max(...all.map((s) => s.end)) / 60) * 60 : 23 * 60;
    if (to - from < 6 * 60) to = from + 6 * 60;
    const span = to - from;
    const pct = (m) => `${((m - from) / span) * 100}%`;
    const total = rows.reduce((t, r) => t + r.work.reduce((a, s) => a + s.end - s.start, 0) + (r.cp || 0), 0);
    const meRow = rows.find((r) => r.isMe);
    $('team-sum').replaceChildren(
      el('span', '', `${rows.length} au travail · ${fmtDur(total)}`),
      el('b', meRow ? 'me-sum' : 'me-sum off', meRow
        ? (meRow.work.length ? `Toi : ${meRow.work.map((s) => `${fmtMin(s.start)}–${fmtMin(s.end)}`).join(' · ')}` : `Toi : congé ${fmtDur(meRow.cp)}`)
        : 'Toi : repos'),
    );

    // Frise
    const tl = $('timeline');
    const head = el('div', 'tl-row tl-head');
    head.append(el('div', 'tl-name'));
    const scale = el('div', 'tl-track');
    const step = span > 12 * 60 ? 180 : 120;
    for (let m = Math.ceil(from / step) * step; m <= to; m += step) {
      const t = el('span', 'tl-tick', `${pad(Math.floor(m / 60) % 24)}h`);
      t.style.left = pct(m);
      scale.append(t);
    }
    head.append(scale);
    const body = [head];
    for (const r of rows) {
      const row = el('div', 'tl-row' + (r.isMe ? ' me' : ''));
      const nameCell = el('div', 'tl-name', r.name);
      if (r.swap) {
        nameCell.append(el('em', 'tl-swap', `⇄ ${firstName(r.swap)}`));
        nameCell.title = `Échange avec ${r.swap}`;
      }
      row.append(nameCell);
      const track = el('div', 'tl-track');
      for (let m = Math.ceil(from / step) * step; m <= to; m += step) {
        const g = el('i', 'tl-grid');
        g.style.left = pct(m);
        track.append(g);
      }
      for (const s of r.work) {
        const bar = el('button', 'tl-bar' + (s.night ? ' night' : ''));
        bar.style.left = pct(s.start);
        bar.style.width = `${((s.end - s.start) / span) * 100}%`;
        const short = (m) => `${Math.floor(m / 60) % 24}h${m % 60 ? pad(m % 60) : ''}`;
        const ratio = (s.end - s.start) / span;
        bar.textContent = ratio > 0.27 ? `${short(s.start)}–${short(s.end)}` : ratio > 0.12 ? short(s.start) : '';
        bar.onclick = () => window.toast && window.toast(`${r.name} · ${fmtMin(s.start)} – ${fmtMin(s.end)} (${fmtDur(s.end - s.start)})`);
        track.append(bar);
      }
      if (r.cp !== undefined && !r.work.length) track.append(el('span', 'tl-cp', `Congé · ${fmtDur(r.cp)}`));
      row.append(track);
      body.push(row);
    }
    // Ligne « maintenant »
    if (iso(day) === todayKey) {
      const now = new Date();
      const m = now.getHours() * 60 + now.getMinutes();
      if (m >= from && m <= to) {
        const line = el('i', 'tl-now');
        line.style.left = `calc(var(--tl-name) + (100% - var(--tl-name)) * ${(m - from) / span})`;
        body.push(line);
      }
    }
    if (!rows.length) body.push(el('p', 'rest', 'Personne ne travaille ce jour-là.'));
    const inner = el('div', 'tl-inner');
    inner.append(...body);
    tl.replaceChildren(inner);

    $('rest-list').replaceChildren(
      ...(resting.length ? [el('small', '', `En repos (${resting.length})`)] : []),
      ...resting.map((r) => el('span', 'rest-chip' + (r.isMe ? ' me' : ''), r.name)),
    );
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#plan-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('plan-me').hidden = m !== 'me';
    $('plan-team').hidden = m !== 'team';
    if (m === 'team') renderTeam();
    updateRemoveBtn();
  }

  function updateRemoveBtn() {
    const wk = currentWeek();
    const btn = $('plan-remove');
    const has = wk && (((data.teams || {})[wk]) || validEntries(data.entries).some((e) => mondayOfIso(e.date) === wk));
    btn.hidden = !has;
    if (has) btn.textContent = `Supprimer la semaine ${weekLabel(wk)}`;
  }
  const mondayOfIso = (d) => iso(mondayOf(parseDate(d)));

  function show(planning) {
    const fresh = planning || { entries: [] };
    if (data !== fresh) { weekStart = null; teamWeek = null; }
    data = fresh;
    data.entries = validEntries(data.entries);
    const empty = !data.entries.length && !teamKeys().length;
    $('plan-empty').hidden = !empty;
    $('plan-me').hidden = empty;
    $('plan-mode').hidden = empty || !teamKeys().length;
    if (empty) { $('plan-team').hidden = true; $('plan-remove').hidden = true; $('plan-foot').textContent = ''; return; }
    if (teamKeys().length && !teamWeek) {
      const current = iso(mondayOf(new Date()));
      teamWeek = teamKeys().includes(current) ? current : teamKeys()[teamKeys().length - 1];
      teamDay = teamWeek === current ? (new Date().getDay() + 6) % 7 : 0;
    }
    if (!teamKeys().length) mode = 'me';
    if (!weekStart) {
      // Semaine en cours, ou la première semaine du planning si celui-ci commence plus tard.
      const first = data.entries.map((e) => e.date).sort()[0];
      weekStart = mondayOf(new Date());
      if (iso(addDays(weekStart, 6)) < first) weekStart = mondayOf(parseDate(first));
    }
    renderNext();
    renderWeek();
    setMode(mode);
    $('plan-foot').textContent = (data.updated ? `Planning mis à jour le ${parseDate(data.updated).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}. ` : '')
      + 'Nouveau planning ? Envoie la photo à Claude.';
    if (window.onPlanningRendered) window.onPlanningRendered();
  }

  $('week-prev').onclick = () => { weekStart = addDays(weekStart, -7); renderWeek(); updateRemoveBtn(); };
  $('week-next').onclick = () => { weekStart = addDays(weekStart, 7); renderWeek(); updateRemoveBtn(); };
  $('week-today').onclick = () => { weekStart = mondayOf(new Date()); renderWeek(); updateRemoveBtn(); };
  document.querySelectorAll('#plan-mode button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  $('team-prev').onclick = () => { const k = teamKeys(); teamWeek = k[Math.max(0, k.indexOf(teamWeek) - 1)]; renderTeam(); updateRemoveBtn(); };
  $('team-next').onclick = () => { const k = teamKeys(); teamWeek = k[Math.min(k.length - 1, k.indexOf(teamWeek) + 1)]; renderTeam(); updateRemoveBtn(); };

  // Glisser à gauche / à droite sur la frise pour changer de jour.
  let touchX = null;
  $('plan-team').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  $('plan-team').addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) < 60) return;
    teamDay = Math.min(6, Math.max(0, teamDay + (dx < 0 ? 1 : -1)));
    renderTeam();
  }, { passive: true });

  // Lundi (AAAA-MM-JJ) de la semaine actuellement affichée, selon la vue.
  function currentWeek() {
    if (mode === 'team' && teamWeek) return teamWeek;
    return weekStart ? iso(weekStart) : null;
  }

  // Retire une semaine (créneaux perso + équipe) ; renvoie null s'il ne reste rien.
  function removeWeek(planning, monday) {
    if (!planning || !monday) return planning;
    const start = parseDate(monday);
    const days = new Set([0, 1, 2, 3, 4, 5, 6].map((i) => iso(addDays(start, i))));
    const teams = { ...(planning.teams || {}) };
    delete teams[monday];
    const out = {
      updated: planning.updated,
      weeks: (planning.weeks || []).filter((w) => w.start !== monday),
      entries: validEntries(planning.entries).filter((e) => !days.has(e.date)),
      teams,
    };
    return out.entries.length || Object.keys(teams).length ? out : null;
  }

  function weekLabel(monday) {
    const start = parseDate(monday);
    const end = addDays(start, 6);
    return `du ${start.getDate()} au ${end.getDate()} ${end.toLocaleDateString('fr-FR', { month: 'long' })}`;
  }

  /* ----- Résumé pour la page d'accueil ----- */

  function dashboard(planning, now = new Date()) {
    const p = planning || {};
    const entries = validEntries(p.entries);
    const teams = p.teams || {};
    const shifts = entries
      .filter((e) => !e.off && e.start && e.end)
      .map((e) => ({ e, at: startAt(e), dur: duration(e) }))
      .sort((a, b) => a.at - b.at);

    // Prochain créneau (ou créneau en cours)
    let next = null;
    const nx = shifts.find((x) => x.at.getTime() + x.dur * 60000 > now.getTime());
    if (nx) {
      const ongoing = nx.at <= now;
      const mins = Math.round((nx.at - now) / 60000);
      const dayDiff = Math.round((parseDate(nx.e.date) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
      const dayLabel = dayDiff === 0 ? 'Aujourd\'hui' : dayDiff === 1 ? 'Demain'
        : `${DAYS_LONG[(nx.at.getDay() + 6) % 7]} ${nx.at.getDate()} ${nx.at.toLocaleDateString('fr-FR', { month: 'long' })}`;
      const later = shifts.filter((x) => x.e.date === nx.e.date && x.at > nx.at);
      next = {
        date: nx.e.date, start: fmtTime(nx.e.start), end: fmtTime(nx.e.end), label: nx.e.label || 'Travail',
        note: nx.e.note || '', ongoing, dayLabel, dur: fmtDur(nx.dur),
        countdown: ongoing ? `fin à ${fmtTime(nx.e.end)}` : mins < 60 ? `dans ${mins} min`
          : mins < 36 * 60 ? `dans ${Math.floor(mins / 60)} h${mins % 60 ? ' ' + pad(mins % 60) : ''}` : `dans ${Math.round(mins / 1440)} jours`,
        progress: ongoing ? Math.min(1, (now - nx.at) / (nx.dur * 60000)) : 0,
        then: later.map((x) => `${fmtTime(x.e.start)} – ${fmtTime(x.e.end)}`),
      };
    }

    // Semaine en cours
    const monday = mondayOf(now);
    const mondayKey = iso(monday);
    const perDay = [0, 0, 0, 0, 0, 0, 0];
    let hasWeek = false;
    for (const e of entries) {
      const d = parseDate(e.date);
      const i = Math.round((d - monday) / 86400000);
      if (i < 0 || i > 6) continue;
      hasWeek = true;
      perDay[i] += duration(e);
    }
    const weekInfo = (p.weeks || []).find((w) => w.start === mondayKey);
    const contract = weekInfo && weekInfo.contract ? minutes(weekInfo.contract) : 0;
    const total = perDay.reduce((a, b) => a + b, 0);
    const todayIdx = (now.getDay() + 6) % 7;
    const doneMin = shifts
      .filter((x) => x.at >= monday && x.at < addDays(monday, 7))
      .reduce((t, x) => t + Math.max(0, Math.min(x.dur, (now - x.at) / 60000)), 0);

    // Aujourd'hui avec l'équipe
    const team = teams[mondayKey];
    let today = null;
    if (team) {
      const mine = team.people.find((q) => norm(q[0]) === norm(team.me));
      const mySlots = mine ? (mine[3][todayIdx] || []).filter((s) => !/^CP/i.test(s)).map(parseSlot) : [];
      const working = team.people.filter((q) => (q[3][todayIdx] || []).some((s) => !/^CP/i.test(s)));
      const withMe = working
        .filter((q) => q !== mine)
        .filter((q) => (q[3][todayIdx] || []).filter((s) => !/^CP/i.test(s)).map(parseSlot)
          .some((s) => mySlots.some((m) => s.start < m.end && m.start < s.end)))
        .map((q) => firstName(q[0]));
      today = { count: working.length, withMe, meWorking: mySlots.length > 0 };
    }

    const anyTeam = team || teams[Object.keys(teams).sort().pop()];
    return {
      name: anyTeam && anyTeam.me ? firstName(anyTeam.me) : '',
      next,
      week: { hasData: hasWeek, perDay, total, contract, todayIdx, done: Math.round(doneMin), fmtTotal: fmtDur(total), fmtContract: contract ? fmtDur(contract) : '' },
      today,
      empty: !entries.length && !Object.keys(teams).length,
    };
  }

  // Ouvre la vue Équipe sur aujourd'hui (depuis l'accueil).
  function openTeamToday() {
    const k = teamKeys();
    const current = iso(mondayOf(new Date()));
    if (!k.length) return;
    teamWeek = k.includes(current) ? current : k[k.length - 1];
    teamDay = teamWeek === current ? (new Date().getDay() + 6) % 7 : 0;
    setMode('team');
  }

  return {
    show, decode, merge, fromTeam, currentWeek, removeWeek, weekLabel, dashboard, openTeamToday,
    fmtDur, fmtTime, firstName,
  };
})();
