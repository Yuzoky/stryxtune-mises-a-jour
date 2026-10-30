// Données du planning partagé entre managers, et tous les calculs (heures, alertes, échanges).
//
// Document (chiffré avant d'être publié) :
//   { app: 'bkplanning', v: 1, name, weeks: { 'AAAA-MM-JJ' (lundi): Semaine }, deleted: { lundi: date ISO }, settings }
// Semaine : { week, updated (ISO), by, people: [Personne], swaps: [Échange], log: [{ at, by, what }], totals? }
// Personne : { name, id, contract: 'HH:MM', days: [7 × [créneaux]] }
// Créneau : 'HH:MM-HH:MM' (fin après minuit : 24:00 et plus, suivi de '*') ou 'CP HH:MM' (congé).
// Échange : { day: 0-6, a: nom, b: nom, at, by }
'use strict';

const Model = (() => {
  const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  const DAYS_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const SLOT_RE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\*?$/;
  const CP_RE = /^CP (\d{1,2}):(\d{2})$/;
  const HHMM_RE = /^\d{1,3}:\d{2}$/;
  const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

  /* ---------- Heures et dates ---------- */

  const pad = (n) => String(n).padStart(2, '0');
  const toMin = (s) => { const m = String(s || '').match(/^(\d{1,3}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
  const hhmm = (min) => { const m = Math.max(0, Math.round(min)); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  // 270 → « 4h30 », 240 → « 4h », −90 → « −1h30 »
  const fmtDur = (min) => {
    const sign = min < 0 ? '−' : '';
    const m = Math.abs(Math.round(min));
    return `${sign}${Math.floor(m / 60)}h${m % 60 ? pad(m % 60) : ''}`;
  };
  // Heure d'horloge : 1530 min (25:30) → « 1h30 »
  const fmtClock = (min) => `${Math.floor(min / 60) % 24}h${pad(min % 60)}`;
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const mondayOf = (d) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const dayNum = (d) => (d.getDate() === 1 ? '1er' : String(d.getDate()));
  const monthName = (d) => d.toLocaleDateString('fr-FR', { month: 'long' });
  // « 2 – 8 novembre » / « 26 oct. – 1er nov. »
  function weekRange(monday) {
    const start = parseDate(monday);
    const end = addDays(start, 6);
    if (start.getMonth() === end.getMonth()) return `${dayNum(start)} – ${dayNum(end)} ${monthName(end)}`;
    const short = (d) => d.toLocaleDateString('fr-FR', { month: 'short' });
    return `${dayNum(start)} ${short(start)} – ${dayNum(end)} ${short(end)}`;
  }
  // « jeudi 5 novembre »
  function dayLabel(monday, day) {
    const d = addDays(parseDate(monday), day);
    return `${DAYS[day]} ${dayNum(d)} ${monthName(d)}`;
  }

  /* ---------- Créneaux ---------- */

  function parseSlot(s) {
    const cp = String(s).match(CP_RE);
    if (cp) return { cp: Number(cp[1]) * 60 + Number(cp[2]) };
    const m = String(s).match(SLOT_RE);
    if (!m) return null;
    return { a: Number(m[1]) * 60 + Number(m[2]), b: Number(m[3]) * 60 + Number(m[4]) };
  }
  const slotText = (a, b) => `${hhmm(a)}-${hhmm(b)}${b >= 24 * 60 ? '*' : ''}`;
  const validSlot = (s) => {
    const p = parseSlot(s);
    if (!p) return false;
    if (p.cp !== undefined) return p.cp > 0 && p.cp <= 14 * 60;
    return p.a < 30 * 60 && p.b > p.a && p.b - p.a <= 16 * 60 && p.b <= 32 * 60;
  };

  const work = (slots) => (slots || []).map(parseSlot).filter((p) => p && p.cp === undefined).sort((x, y) => x.a - y.a);
  const leave = (slots) => (slots || []).map(parseSlot).filter((p) => p && p.cp !== undefined).reduce((t, p) => t + p.cp, 0);
  const dayMinutes = (slots) => work(slots).reduce((t, p) => t + p.b - p.a, 0) + leave(slots);
  const personMinutes = (p) => p.days.reduce((t, d) => t + dayMinutes(d), 0);
  const personWork = (p) => p.days.reduce((t, d) => t + work(d).reduce((u, s) => u + s.b - s.a, 0), 0);

  // Texte saisi → créneaux. « 9h-12h 13:00-17:00 », « Repos », « CP 4:48 », « 22h - 2h30 ».
  function parseText(text) {
    const t = String(text || '').trim();
    if (!t || /^(repos|r|rh|-|—)$/i.test(t)) return { slots: [] };
    const cp = t.match(/^(?:cp|cong[ée]s?)\s*\(?\s*(\d{1,2})(?:[:hH.](\d{1,2}))?\s*\)?$/i);
    if (cp) {
      const min = Number(cp[1]) * 60 + Number(cp[2] || 0);
      if (min <= 0 || min > 14 * 60) return { error: 'Durée de congé invalide.' };
      return { slots: [`CP ${hhmm(min)}`] };
    }
    const times = [...t.matchAll(/(?<!\d)(\d{1,2})(?:[:hH.](\d{2})|[hH])?(?!\d)/g)].map((m) => Number(m[1]) * 60 + Number(m[2] || 0));
    if (!times.length || times.length % 2) return { error: 'Écris les horaires deux par deux, par ex. « 9:00-12:00 13:00-17:00 ».' };
    const slots = [];
    let prev = -1;
    for (let i = 0; i < times.length; i += 2) {
      let a = times[i];
      let b = times[i + 1];
      if (a >= 24 * 60 || b > 24 * 60) return { error: 'Heure invalide.' };
      if (prev > 18 * 60 && a < 12 * 60) { a += 24 * 60; b += 24 * 60; } // 2e créneau après minuit
      if (b <= a) b += 24 * 60;
      if (b - a > 16 * 60) return { error: 'Créneau trop long.' };
      slots.push({ a, b });
      prev = b;
    }
    slots.sort((x, y) => x.a - y.a);
    for (let i = 1; i < slots.length; i++) if (slots[i].a < slots[i - 1].b) return { error: 'Deux créneaux se chevauchent.' };
    return { slots: slots.map((s) => slotText(s.a, s.b)) };
  }

  function slotsText(slots) {
    if (!slots || !slots.length) return 'Repos';
    return slots.map((s) => {
      const p = parseSlot(s);
      if (!p) return s;
      if (p.cp !== undefined) return `CP ${hhmm(p.cp)}`;
      return `${hhmm(p.a % (24 * 60))}-${hhmm(p.b % (24 * 60) || (p.b >= 24 * 60 ? 0 : p.b))}`;
    }).join(' ');
  }

  // Affichage court : « 9h–12h30 · 13h–17h », « Congé 4h48 », « Repos »
  function slotsShort(slots) {
    const w = work(slots);
    const l = leave(slots);
    if (!w.length && !l) return 'Repos';
    const parts = w.map((s) => `${fmtClock(s.a)}–${fmtClock(s.b)}`);
    if (l) parts.push(`Congé ${fmtDur(l)}`);
    return parts.join(' · ');
  }

  /* ---------- Nettoyage (une donnée abîmée ne doit jamais casser l'appli) ---------- */

  function cleanPerson(p) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim()) return null;
    const start = (s) => { const x = parseSlot(s); return x.cp !== undefined ? 1e9 : x.a; };
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => (Array.isArray(p.days) && Array.isArray(p.days[i]) ? p.days[i] : [])
      .filter((s) => typeof s === 'string' && validSlot(s)).slice(0, 6).sort((x, y) => start(x) - start(y)));
    return {
      name: p.name.trim().slice(0, 60),
      id: typeof p.id === 'string' ? p.id.slice(0, 10) : '',
      contract: HHMM_RE.test(p.contract || '') ? p.contract : '',
      days,
    };
  }

  function cleanWeek(w, key) {
    if (!w || typeof w !== 'object') return null;
    const week = WEEK_RE.test(w.week || '') ? w.week : key;
    if (!WEEK_RE.test(week || '')) return null;
    const people = (Array.isArray(w.people) ? w.people : []).map(cleanPerson).filter(Boolean).slice(0, 120);
    const swaps = (Array.isArray(w.swaps) ? w.swaps : [])
      .filter((s) => s && Number.isInteger(s.day) && s.day >= 0 && s.day <= 6 && typeof s.a === 'string' && typeof s.b === 'string')
      .map((s) => ({ day: s.day, a: s.a.slice(0, 60), b: s.b.slice(0, 60), at: String(s.at || ''), by: String(s.by || '').slice(0, 40) }))
      .slice(-50);
    const log = (Array.isArray(w.log) ? w.log : []).filter((l) => l && typeof l.what === 'string')
      .map((l) => ({ at: String(l.at || ''), by: String(l.by || '').slice(0, 40), what: l.what.slice(0, 160) })).slice(-40);
    const totals = Array.isArray(w.totals) ? w.totals.slice(0, 7).map((t) => (HHMM_RE.test(t || '') ? t : '')) : null;
    return { week, updated: String(w.updated || ''), by: String(w.by || '').slice(0, 40), people, swaps, log, totals };
  }

  function emptyDoc(name) {
    return { app: 'bkplanning', v: 1, name: name || 'BK Claye-Souilly', weeks: {}, deleted: {}, settings: { minStaff: 0 } };
  }

  function cleanDoc(doc) {
    const out = emptyDoc(doc && typeof doc.name === 'string' ? doc.name.slice(0, 60) : '');
    if (!doc || typeof doc !== 'object') return out;
    for (const [k, w] of Object.entries(doc.weeks || {})) {
      const c = cleanWeek(w, k);
      if (c && c.week === k) out.weeks[k] = c;
    }
    for (const [k, at] of Object.entries(doc.deleted || {})) if (WEEK_RE.test(k) && typeof at === 'string') out.deleted[k] = at;
    const ms = doc.settings && Number(doc.settings.minStaff);
    out.settings.minStaff = Number.isInteger(ms) && ms >= 0 && ms <= 20 ? ms : 0;
    if (doc.settings && typeof doc.settings.updated === 'string') out.settings.updated = doc.settings.updated;
    return out;
  }

  /* ---------- Fusion (plusieurs managers modifient en même temps) ---------- */

  // Semaine par semaine, la version la plus récente l'emporte ; une suppression plus récente
  // qu'une modification retire la semaine.
  function merge(a, b) {
    const A = cleanDoc(a);
    const B = cleanDoc(b);
    const out = emptyDoc(B.name || A.name);
    const keys = new Set([...Object.keys(A.weeks), ...Object.keys(B.weeks), ...Object.keys(A.deleted), ...Object.keys(B.deleted)]);
    for (const k of keys) {
      const wa = A.weeks[k];
      const wb = B.weeks[k];
      const w = !wa ? wb : !wb ? wa : (wb.updated >= wa.updated ? wb : wa);
      const del = [A.deleted[k], B.deleted[k]].filter(Boolean).sort().pop();
      if (del && (!w || del >= w.updated)) out.deleted[k] = del;
      else if (w) out.weeks[k] = w;
    }
    const sa = A.settings.updated || '';
    const sb = B.settings.updated || '';
    out.settings = sb >= sa ? B.settings : A.settings;
    return out;
  }

  // Fusion à trois : base = dernière version synchronisée, local = ce téléphone, remote = en ligne.
  // Ce qui n'a changé que d'un côté est repris tel quel ; si une même semaine a changé des deux
  // côtés, on fusionne case par case (personne × jour) : la modification faite ici l'emporte
  // seulement sur la case qu'elle touche. Ne dépend pas de l'heure des téléphones.
  const content = (w) => (w ? stable({ people: w.people, swaps: w.swaps }) : '');
  function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
  }

  function mergeWeek3(b, l, r) {
    const byName = (w) => new Map((w ? w.people : []).map((p) => [norm(p.name), p]));
    const B = byName(b);
    const L = byName(l);
    const R = byName(r);
    const order = [...r.people.map((p) => norm(p.name)), ...l.people.map((p) => norm(p.name)).filter((k) => !R.has(k))];
    const people = [];
    for (const k of order) {
      const pb = B.get(k);
      const pl = L.get(k);
      const pr = R.get(k);
      const same = (x, y) => stable(x) === stable(y);
      if (!pl) { if (pr && !(pb && same(pr, pb))) people.push(pr); continue; } // retiré ici
      if (!pr) { if (!(pb && same(pl, pb))) people.push(pl); continue; } // retiré en ligne
      const days = pl.days.map((dl, i) => (pb && same(dl, pb.days[i]) ? pr.days[i] : dl));
      const contract = pb && pl.contract === pb.contract ? pr.contract : pl.contract;
      people.push({ ...pr, contract, days });
    }
    const key = (x) => `${x.at}|${x.day ?? ''}|${x.a ?? ''}|${x.b ?? ''}|${x.what ?? ''}`;
    const union = (xs, ys, n) => {
      const seen = new Map();
      for (const x of [...(xs || []), ...(ys || [])]) seen.set(key(x), x);
      return [...seen.values()].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).slice(-n);
    };
    const later = l.updated > r.updated ? l : r;
    return { ...r, people, swaps: union(r.swaps, l.swaps, 50), log: union(r.log, l.log, 40), updated: later.updated, by: later.by };
  }

  function merge3(base, local, remote) {
    const B = cleanDoc(base || emptyDoc());
    const L = cleanDoc(local);
    const R = cleanDoc(remote);
    const out = emptyDoc(R.name || L.name);
    const keys = new Set([B, L, R].flatMap((d) => [...Object.keys(d.weeks), ...Object.keys(d.deleted)]));
    for (const k of keys) {
      const b = B.weeks[k] || null;
      const l = L.weeks[k] || null;
      const r = R.weeks[k] || null;
      const lChanged = content(l) !== content(b);
      const rChanged = content(r) !== content(b);
      let w;
      if (!lChanged) w = r;
      else if (!rChanged) w = l;
      else if (l && r && b) w = mergeWeek3(b, l, r);
      else if (l && r) w = l.updated >= r.updated ? l : r; // créée des deux côtés
      else w = l || r; // supprimée d'un côté, modifiée de l'autre : on garde la modification
      if (w) out.weeks[k] = w;
      else {
        const del = [L.deleted[k], R.deleted[k]].filter(Boolean).sort().pop();
        if (del) out.deleted[k] = del;
      }
    }
    out.settings = stable(L.settings) === stable(B.settings) ? R.settings : L.settings;
    return out;
  }

  // Les suppressions de plus de 6 mois sont oubliées ; les semaines de plus d'un an aussi.
  function prune(doc, now = new Date()) {
    const out = cleanDoc(doc);
    const oldWeek = iso(addDays(now, -370));
    const oldDel = new Date(now.getTime() - 183 * 86400000).toISOString();
    for (const k of Object.keys(out.weeks)) if (k < oldWeek) delete out.weeks[k];
    for (const [k, at] of Object.entries(out.deleted)) if (at < oldDel) delete out.deleted[k];
    return out;
  }

  /* ---------- Modifications ---------- */

  const stamp = (week, by, what, now = new Date()) => {
    const at = now.toISOString();
    week.updated = at;
    week.by = by || '';
    week.log = [...(week.log || []), { at, by: by || '', what }].slice(-40);
    return week;
  };
  const copyWeek = (w) => JSON.parse(JSON.stringify(w));

  function setDay(week, person, day, slots, by) {
    const w = copyWeek(week);
    const p = w.people.find((x) => x.name === person);
    if (!p) throw new Error('person');
    const before = slotsShort(p.days[day]);
    p.days[day] = slots.filter(validSlot);
    return stamp(w, by, `${p.name} · ${DAYS[day]} : ${before} → ${slotsShort(p.days[day])}`);
  }

  // Échange de journée : chacun prend les horaires de l'autre ce jour-là.
  function swapDay(week, nameA, nameB, day, by) {
    const w = copyWeek(week);
    const a = w.people.find((x) => x.name === nameA);
    const b = w.people.find((x) => x.name === nameB);
    if (!a || !b || a === b) throw new Error('person');
    [a.days[day], b.days[day]] = [b.days[day], a.days[day]];
    const now = new Date().toISOString();
    w.swaps = [...(w.swaps || []), { day, a: a.name, b: b.name, at: now, by: by || '' }].slice(-50);
    return stamp(w, by, `Échange du ${DAYS[day]} : ${a.name} ⇄ ${b.name}`);
  }

  function addPerson(week, name, contract, by) {
    const w = copyWeek(week);
    const n = String(name || '').trim().slice(0, 60);
    if (!n) throw new Error('name');
    if (w.people.some((p) => norm(p.name) === norm(n))) throw new Error('exists');
    w.people.push({ name: n, id: '', contract: HHMM_RE.test(contract || '') ? contract : '', days: [[], [], [], [], [], [], []] });
    return stamp(w, by, `${n} ajouté(e) au planning`);
  }

  function removePerson(week, name, by) {
    const w = copyWeek(week);
    w.people = w.people.filter((p) => p.name !== name);
    return stamp(w, by, `${name} retiré(e) du planning`);
  }

  function editPerson(week, name, changes, by) {
    const w = copyWeek(week);
    const p = w.people.find((x) => x.name === name);
    if (!p) throw new Error('person');
    const what = [];
    if (changes.name !== undefined) {
      const n = String(changes.name).trim().slice(0, 60);
      if (!n) throw new Error('name');
      if (n !== p.name && w.people.some((x) => x !== p && norm(x.name) === norm(n))) throw new Error('exists');
      if (n !== p.name) {
        what.push(`${p.name} renommé(e) ${n}`);
        for (const s of w.swaps || []) { if (s.a === p.name) s.a = n; if (s.b === p.name) s.b = n; }
        p.name = n;
      }
    }
    if (changes.contract !== undefined && changes.contract !== p.contract) {
      if (changes.contract && !HHMM_RE.test(changes.contract)) throw new Error('contract');
      what.push(`${p.name} : contrat ${changes.contract ? fmtDur(toMin(changes.contract)) : 'non renseigné'}`);
      p.contract = changes.contract;
    }
    return what.length ? stamp(w, by, what.join(' · ')) : w;
  }

  // Semaine vide à partir de la précédente (mêmes personnes et contrats), pour une saisie à la main.
  function blankWeek(monday, from, by) {
    const people = from ? from.people.map((p) => ({ name: p.name, id: p.id, contract: p.contract, days: [[], [], [], [], [], [], []] })) : [];
    return stamp({ week: monday, updated: '', by: '', people, swaps: [], log: [], totals: null }, by, 'Semaine créée à la main');
  }

  // Semaine issue de la lecture des photos (après vérification par le manager).
  function fromSheet(sheet, monday, by) {
    const people = sheet.people.map((p) => cleanPerson({
      name: p.name, id: p.id || '', contract: p.contract || '', days: p.days.map((d) => (Array.isArray(d) ? d : d.slots)),
    })).filter(Boolean);
    const w = { week: monday, updated: '', by: '', people, swaps: [], log: [], totals: sheet.totals && Array.isArray(sheet.totals.days) ? sheet.totals.days : null };
    return stamp(cleanWeek(w, monday), by, `Planning lu depuis ${sheet.pages || 1} photo${(sheet.pages || 1) > 1 ? 's' : ''}`);
  }

  // Personne avec qui `name` a échangé ce jour-là ('' sinon).
  function swapWith(week, name, day) {
    const s = [...(week.swaps || [])].reverse().find((x) => x.day === day && (x.a === name || x.b === name));
    return s ? (s.a === name ? s.b : s.a) : '';
  }

  /* ---------- Effectif ---------- */

  // Nombre de personnes présentes, par quart d'heure, entre la première arrivée et le dernier départ.
  function coverage(week, day) {
    const all = week.people.flatMap((p) => work(p.days[day]).map((s) => ({ ...s, name: p.name })));
    if (!all.length) return null;
    const from = Math.floor(Math.min(...all.map((s) => s.a)) / 15) * 15;
    const to = Math.ceil(Math.max(...all.map((s) => s.b)) / 15) * 15;
    const counts = [];
    for (let m = from; m < to; m += 15) counts.push(all.filter((s) => s.a <= m && s.b >= m + 15).length);
    return { from, to, step: 15, counts, max: Math.max(...counts) };
  }

  /* ---------- Alertes ---------- */

  // Règles du Code du travail (durées maximales et repos minimaux) + contrat + effectif.
  //  - 10 h de travail effectif maximum par jour (L3121-18)
  //  - pause de 20 min dès 6 h de travail d'affilée (L3121-16)
  //  - 11 h de repos entre deux journées (L3131-1)
  //  - 35 h de repos d'affilée dans la semaine (24 h + 11 h, L3132-2)
  //  - 48 h maximum sur la semaine (L3121-20)
  function alerts(doc, monday) {
    const week = doc.weeks[monday];
    if (!week) return [];
    const prev = doc.weeks[iso(addDays(parseDate(monday), -7))];
    const next = doc.weeks[iso(addDays(parseDate(monday), 7))];
    const out = [];
    const add = (level, kind, text, person, day) => out.push({ level, kind, text, person: person || '', day: day ?? null });

    for (const p of week.people) {
      // Créneaux de la semaine en minutes depuis lundi 0 h (+ dimanche précédent / lundi suivant).
      const abs = [];
      const pushDay = (slots, offsetDays, own) => work(slots).forEach((s) => abs.push({ a: s.a + offsetDays * 1440, b: s.b + offsetDays * 1440, own, day: offsetDays }));
      const pp = prev && prev.people.find((x) => norm(x.name) === norm(p.name));
      if (pp) pushDay(pp.days[6], -1, false);
      p.days.forEach((d, i) => pushDay(d, i, true));
      const np = next && next.people.find((x) => norm(x.name) === norm(p.name));
      if (np) pushDay(np.days[0], 7, false);
      abs.sort((x, y) => x.a - y.a);

      p.days.forEach((d, i) => {
        const w = work(d);
        const total = w.reduce((t, s) => t + s.b - s.a, 0);
        if (total > 600) add('warn', 'jour', `Plus de 10 h de travail le ${DAYS[i]} (${fmtDur(total)})`, p.name, i);
        // Blocs continus : une coupure de moins de 20 min ne compte pas comme une pause.
        let start = null;
        let end = null;
        const flush = () => {
          if (start !== null && end - start > 360) add('warn', 'pause', `Plus de 6 h d'affilée sans pause de 20 min le ${DAYS[i]} (${fmtClock(start)}–${fmtClock(end)})`, p.name, i);
        };
        for (const s of w) {
          if (start === null || s.a - end >= 20) { flush(); start = s.a; end = s.b; } else end = Math.max(end, s.b);
        }
        flush();
      });

      // Repos entre deux journées travaillées consécutives.
      const daysWorked = [];
      for (let i = -1; i <= 7; i++) {
        const list = abs.filter((s) => s.day === i); // un créneau après minuit compte pour la veille
        if (list.length) daysWorked.push({ i, first: Math.min(...list.map((s) => s.a)), last: Math.max(...list.map((s) => s.b)), own: list.some((s) => s.own) });
      }
      for (let k = 1; k < daysWorked.length; k++) {
        const x = daysWorked[k - 1];
        const y = daysWorked[k];
        if (y.i !== x.i + 1 || (!x.own && !y.own)) continue;
        const rest = y.first - x.last;
        if (rest < 660 && y.i <= 6 && (x.own || y.own)) {
          const dayA = x.i < 0 ? 'dimanche (semaine précédente)' : DAYS[x.i];
          const dayB = y.i > 6 ? 'lundi suivant' : DAYS[y.i];
          add('warn', 'repos', `Moins de 11 h de repos entre ${dayA} et ${dayB} (${fmtDur(Math.max(0, rest))})`, p.name, y.i <= 6 ? y.i : x.i);
        }
      }

      // Repos hebdomadaire : le plus long repos d'affilée dans la semaine. Sans la semaine
      // précédente / suivante, on suppose que le repos commence lundi 0 h / finit dimanche 24 h.
      const own = abs.filter((s) => s.own);
      if (own.length) {
        const before = abs.filter((s) => s.a < 0);
        let cursor = before.length ? Math.max(...before.map((s) => s.b)) : (pp ? -1440 : 0);
        let longest = 0;
        for (const s of own) { longest = Math.max(longest, s.a - cursor); cursor = Math.max(cursor, s.b); }
        const after = abs.filter((s) => s.a >= 7 * 1440);
        const end = after.length ? Math.min(...after.map((s) => s.a)) : (np ? 8 * 1440 : 7 * 1440);
        longest = Math.max(longest, end - cursor);
        if (longest < 2100) add('warn', 'hebdo', `Pas de repos de 35 h d'affilée dans la semaine (au plus ${fmtDur(longest)})`, p.name, null);
      }

      const wk = personWork(p);
      if (wk > 48 * 60) add('warn', 'semaine', `Plus de 48 h dans la semaine (${fmtDur(wk)})`, p.name, null);

      if (p.contract) {
        const diff = personMinutes(p) - toMin(p.contract);
        if (diff > 0) add('info', 'contrat', `${fmtDur(diff)} de plus que le contrat (${fmtDur(personMinutes(p))} / ${fmtDur(toMin(p.contract))})`, p.name, null);
        else if (diff < 0) add('info', 'contrat', `${fmtDur(-diff)} de moins que le contrat (${fmtDur(personMinutes(p))} / ${fmtDur(toMin(p.contract))})`, p.name, null);
      }
    }

    // Effectif : trous dans la journée, et minimum choisi dans les réglages.
    const min = (doc.settings && doc.settings.minStaff) || 0;
    for (let d = 0; d < 7; d++) {
      const cov = coverage(week, d);
      if (!cov) continue;
      const runs = [];
      cov.counts.forEach((n, k) => {
        const kind = n === 0 ? 'zero' : n < min ? 'low' : null;
        const last = runs[runs.length - 1];
        if (kind && last && last.kind === kind && last.end === k) { last.end = k + 1; last.n = Math.min(last.n, n); } else if (kind) runs.push({ kind, start: k, end: k + 1, n });
      });
      for (const r of runs) {
        const a = fmtClock(cov.from + r.start * cov.step);
        const b = fmtClock(cov.from + r.end * cov.step);
        if (r.kind === 'zero') add('warn', 'effectif', `Personne au restaurant le ${DAYS[d]} de ${a} à ${b}`, '', d);
        else add('info', 'effectif', `Seulement ${r.n} personne${r.n > 1 ? 's' : ''} le ${DAYS[d]} de ${a} à ${b} (minimum ${min})`, '', d);
      }
    }
    return out;
  }

  /* ---------- Totaux ---------- */

  function dayTotal(week, day) {
    return week.people.reduce((t, p) => t + dayMinutes(p.days[day]), 0);
  }
  function weekTotals(week) {
    const planned = week.people.reduce((t, p) => t + personMinutes(p), 0);
    const contract = week.people.reduce((t, p) => t + toMin(p.contract), 0);
    return { planned, contract, days: [0, 1, 2, 3, 4, 5, 6].map((d) => dayTotal(week, d)) };
  }

  return {
    DAYS, DAYS_SHORT, toMin, hhmm, fmtDur, fmtClock, iso, parseDate, addDays, mondayOf, norm, weekRange, dayLabel,
    parseSlot, validSlot, work, leave, dayMinutes, personMinutes, personWork, parseText, slotsText, slotsShort,
    cleanWeek, cleanDoc, emptyDoc, merge, merge3, stable, prune, setDay, swapDay, addPerson, removePerson, editPerson, blankWeek, fromSheet,
    swapWith, coverage, alerts, dayTotal, weekTotals,
  };
})();

if (typeof module !== 'undefined') module.exports = Model;
