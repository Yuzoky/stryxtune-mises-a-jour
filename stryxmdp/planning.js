// Page Planning : affiche planning.json semaine par semaine.
// Format : { "updated": "AAAA-MM-JJ", "weeks": [{ "start": "AAAA-MM-JJ" (lundi), "contract": "HH:MM" }], "entries": [
//   { "date": "AAAA-MM-JJ", "start": "HH:MM", "end": "HH:MM", "label": "…", "place": "…", "note": "…" },
//   { "date": "AAAA-MM-JJ", "off": true, "label": "Repos" } ] }
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
  const fmtTime = (hhmm) => hhmm.replace(':', 'h');

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

  async function load() {
    if (data) return data;
    try {
      const res = await fetch('planning.json', { cache: 'no-store' });
      data = await res.json();
    } catch {
      data = { entries: [] };
    }
    data.entries = (data.entries || []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date || ''));
    return data;
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

  async function show() {
    await load();
    const empty = !data.entries.length;
    $('plan-empty').hidden = !empty;
    $('days').hidden = empty;
    document.querySelector('#tab-plan .week-nav').hidden = empty;
    if (empty) { $('plan-next').hidden = true; $('week-today').hidden = true; $('plan-foot').textContent = ''; return; }
    if (!weekStart) {
      // Semaine en cours, ou la première semaine du planning si celui-ci commence plus tard.
      const first = data.entries.map((e) => e.date).sort()[0];
      weekStart = mondayOf(new Date());
      if (iso(addDays(weekStart, 6)) < first) weekStart = mondayOf(parseDate(first));
    }
    renderNext();
    renderWeek();
    $('plan-foot').textContent = (data.updated ? `Planning mis à jour le ${parseDate(data.updated).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}. ` : '')
      + 'Nouvelle photo ? Envoie-la à Claude.';
  }

  $('week-prev').onclick = () => { weekStart = addDays(weekStart, -7); renderWeek(); };
  $('week-next').onclick = () => { weekStart = addDays(weekStart, 7); renderWeek(); };
  $('week-today').onclick = () => { weekStart = mondayOf(new Date()); renderWeek(); };

  return { show };
})();
