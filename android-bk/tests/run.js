// Tests de Planning BK (lancés par GitHub Actions avant de fabriquer l'APK).
// Données entièrement inventées : aucun vrai planning ni vrai nom dans le dépôt.
'use strict';

const assert = require('assert');
const path = require('path');
const R = require(path.join(__dirname, '../../bkplanning/ocr.js'));
const M = require(path.join(__dirname, '../../bkplanning/model.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`ÉCHEC ${name}\n     ${e.message}`); }
}

/* ---------- Feuille de planning inventée, transformée en « texte reconnu » ---------- */

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const hh = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function fakeSheet(n) {
  const people = [];
  for (let i = 0; i < n; i++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const r = rnd();
      if (r < 0.3) days.push([]);
      else if (r < 0.55) days.push([`${hh(pick([9, 11, 12]) * 60)}-${hh(pick([14, 15]) * 60 + pick([0, 30]))}`, `${hh(pick([17, 18, 19]) * 60)}-${hh(22 * 60)}`]);
      else if (r < 0.65) { const a = pick([21, 22]) * 60; const b = a + pick([180, 240, 270]); days.push([`${hh(a)}-${M.hhmm(b)}${b >= 1440 ? '*' : ''}`]); } else if (r < 0.7) days.push(['CP 04:00']);
      else days.push([`${hh(pick([9, 10, 11, 12, 15, 18]) * 60)}-${hh(pick([14, 15, 16, 21, 22]) * 60 + pick([0, 30]))}`].filter((s) => M.validSlot(s) && M.dayMinutes([s]) <= 11 * 60));
    }
    const planned = days.reduce((t, d) => t + M.dayMinutes(d), 0);
    people.push({ name: `PERSONNE ${String.fromCharCode(65 + i)}${String.fromCharCode(65 + ((i * 7) % 26))}`, id: String(10 + i), days, planned, contract: 24 * 60 });
  }
  return people;
}

// Disposition « nouvelle feuille » : nom à gauche, 7 colonnes, « Plan / Contrat » à droite.
function toOcr(people, { angle = 0, persp = 0 } = {}) {
  const lines = [];
  const W = 2000;
  const H = 1400;
  const T = ([x, y]) => {
    const a = (angle * Math.PI) / 180;
    let X = x * Math.cos(a) - y * Math.sin(a) + 100;
    let Y = x * Math.sin(a) + y * Math.cos(a) + 60;
    const d = 1 + (persp * X) / W;
    X /= d; Y /= d;
    return [X, Y];
  };
  const word = (t, x, y, h = 20) => {
    const w = t.length * 10.5;
    const q = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(T);
    const xs = q.map((p) => p[0]); const ys = q.map((p) => p[1]);
    return { t, b: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round), c: q.flat().map(Math.round) };
  };
  const line = (words) => {
    const xs = words.flatMap((w) => [w.b[0], w.b[2]]); const ys = words.flatMap((w) => [w.b[1], w.b[3]]);
    const c = [...words[0].c.slice(0, 2), ...words[words.length - 1].c.slice(2, 6), ...words[0].c.slice(6, 8)];
    return { t: words.map((w) => w.t).join(' '), b: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], c, e: words };
  };
  const text = (t, x, y) => { let cx = x; const ws = []; for (const p of t.split(' ')) { ws.push(word(p, cx, y)); cx += p.length * 10.5 + 8; } return line(ws); };
  lines.push(text('Planning hebdomadaire', 700, 0));
  lines.push(text('du 02/11/2026 Au 08/11/2026', 720, 30));
  lines.push(text('NOM PRÉNOM', 60, 90));
  ['Lundi 02/11', 'Mardi 03/11', 'Mercredi 04/11', 'Jeudi 05/11', 'Vendredi 06/11', 'Samedi 07/11', 'Dimanche 08/11'].forEach((d, i) => lines.push(text(d, 330 + i * 175, 90)));
  lines.push(text('PLAN / CONTRAT', 1560, 90));
  let y = 140;
  for (const p of people) {
    const rows = Math.max(1, ...p.days.map((d) => d.length));
    const top = y;
    lines.push(text(`${p.name} (${p.id})`, 30, top + (rows - 1) * 11));
    p.days.forEach((d, i) => {
      const x = 330 + i * 175;
      if (!d.length) { lines.push(text('Repos', x + 20, top + (rows - 1) * 11 + 6)); return; }
      d.forEach((s, k) => {
        const dy = top + (rows - d.length) * 11 + k * 22;
        if (s.startsWith('CP')) { lines.push(text(`CP (${s.slice(3)})`, x + 5, dy)); return; }
        const pp = M.parseSlot(s);
        lines.push(text(`${hh(pp.a)} - ${hh(pp.b)}${pp.b > 1440 || (pp.b === 1440) ? ' (*)' : ''}`, x, dy));
      });
    });
    lines.push(text(`${M.hhmm(p.planned)} / ${M.hhmm(p.contract)}`, 1570, top + (rows - 1) * 11));
    y += Math.max(46, rows * 22 + 10);
  }
  lines.push(text('Total', 60, y + 4));
  for (let d = 0; d < 7; d++) lines.push(text(M.hhmm(people.reduce((t, p) => t + M.dayMinutes(p.days[d]), 0)), 350 + d * 175, y));
  return { w: W, h: H, lines };
}

function compare(people, res) {
  let bad = 0;
  for (const p of people) {
    const got = res.people.find((x) => x.id === p.id);
    if (!got) { bad++; continue; }
    p.days.forEach((d, i) => { if (JSON.stringify(got.days[i].slots) !== JSON.stringify(d)) bad++; });
    if (got.planned !== M.hhmm(p.planned)) bad++;
  }
  return bad;
}

const people = fakeSheet(16);
for (const [label, opts] of [['droite', {}], ['penchée 6°', { angle: 6 }], ['penchée -9°', { angle: -9 }], ['perspective', { persp: 0.18 }], ['penchée + perspective', { angle: 4, persp: -0.15 }]]) {
  test(`lecture d'une feuille ${label}`, () => {
    const res = R.read(toOcr(people, opts), new Date(2026, 9, 29));
    assert.ok(res.ok, res.error);
    assert.strictEqual(res.week, '2026-11-02');
    assert.strictEqual(res.people.length, people.length, `personnes ${res.people.length}`);
    assert.strictEqual(compare(people, res), 0, 'cases différentes');
    assert.ok(res.people.every((p) => p.ok), 'toutes les lignes vérifiées');
    assert.ok(res.totals && res.totals.days.every(Boolean), 'totaux du jour lus');
  });
}

test('une case illisible est signalée, pas inventée', () => {
  const ocr = toOcr(people);
  const victim = ocr.lines.findIndex((l) => /^\d\d:\d\d - \d\d:\d\d$/.test(l.t));
  ocr.lines.splice(victim, 1);
  const res = R.read(ocr, new Date(2026, 9, 29));
  assert.ok(res.people.some((p) => !p.ok), 'au moins une ligne à vérifier');
});

test('cases lues : erreurs de lecture courantes', () => {
  assert.deepStrictEqual(R.parseCell('22:00 - 02:30 (*)').slots, ['22:00-26:30*']);
  assert.deepStrictEqual(R.parseCell('19:00 - 00:00 (*)').slots, ['19:00-24:00*']);
  assert.deepStrictEqual(R.parseCell('15:30-19-30').slots, ['15:30-19:30']);
  assert.deepStrictEqual(R.parseCell('23:00-0230(*)').slots, ['23:00-26:30*']);
  assert.deepStrictEqual(R.parseCell('CP (04:48)').slots, ['CP 04:48']);
  assert.strictEqual(R.parseCell('Repas').status, 'ok');
  assert.strictEqual(R.parseCell('12:0O-14:39').status, 'unsure');
  assert.strictEqual(R.parsePlan('21:0/20:00').planned, '21:00');
});

/* ---------- Modèle ---------- */

const week = (people2) => M.cleanWeek({ week: '2026-11-02', updated: '2026-10-30T10:00:00.000Z', people: people2, swaps: [], log: [] }, '2026-11-02');
const P = (name, days, contract = '24:00') => ({ name, contract, days });

test('saisie à la main', () => {
  assert.deepStrictEqual(M.parseText('9h-12h 13:00-17:00').slots, ['09:00-12:00', '13:00-17:00']);
  assert.deepStrictEqual(M.parseText('22:00 - 02:30').slots, ['22:00-26:30*']);
  assert.deepStrictEqual(M.parseText('Repos').slots, []);
  assert.deepStrictEqual(M.parseText('cp 4:48').slots, ['CP 04:48']);
  assert.ok(M.parseText('9:00-12:00 11:00-13:00').error);
});

test('alertes : 10 h, pause, repos de 11 h, effectif', () => {
  const doc = M.emptyDoc();
  doc.weeks['2026-11-02'] = week([
    P('Alice', [['08:00-19:30'], ['09:00-12:00'], [], [], [], [], []]),
    P('Bruno', [['18:00-24:00*'], ['07:00-11:00'], [], [], [], [], []]),
    P('Carla', [[], ['13:00-15:00'], [], [], [], [], []]),
  ]);
  const al = M.alerts(doc, '2026-11-02').map((a) => `${a.person}|${a.kind}`);
  assert.ok(al.includes('Alice|jour'), '10 h');
  assert.ok(al.includes('Alice|pause'), 'pause');
  assert.ok(al.includes('Bruno|repos'), 'repos 11 h');
  assert.ok(al.includes('|effectif'), 'trou sans personne');
});

test('fusion à trois : deux managers modifient la même semaine', () => {
  const base = M.emptyDoc();
  base.weeks['2026-11-02'] = week([P('Alice', [['09:00-12:00'], [], [], [], [], [], []]), P('Bruno', [[], ['14:00-18:00'], [], [], [], [], []])]);
  const local = JSON.parse(JSON.stringify(base));
  local.weeks['2026-11-02'] = M.setDay(local.weeks['2026-11-02'], 'Alice', 2, ['10:00-14:00'], 'Moi');
  const remote = JSON.parse(JSON.stringify(base));
  remote.weeks['2026-11-02'] = M.swapDay(remote.weeks['2026-11-02'], 'Alice', 'Bruno', 1, 'Autre');
  const m = M.merge3(base, local, remote).weeks['2026-11-02'];
  const a = m.people.find((p) => p.name === 'Alice');
  assert.deepStrictEqual(a.days[2], ['10:00-14:00'], 'modif locale gardée');
  assert.deepStrictEqual(a.days[1], ['14:00-18:00'], 'échange distant gardé');
  assert.strictEqual(m.swaps.length, 1);
  assert.strictEqual(m.log.length, 2);
});

test('fusion à trois : suppression et nouvelle semaine', () => {
  const base = M.emptyDoc();
  base.weeks['2026-11-02'] = week([P('Alice', [[], [], [], [], [], [], []])]);
  const local = JSON.parse(JSON.stringify(base));
  delete local.weeks['2026-11-02'];
  local.deleted['2026-11-02'] = '2026-10-30T11:00:00.000Z';
  const remote = JSON.parse(JSON.stringify(base));
  remote.weeks['2026-11-09'] = M.blankWeek('2026-11-09', base.weeks['2026-11-02'], 'Autre');
  const m = M.merge3(base, local, remote);
  assert.ok(!m.weeks['2026-11-02'] && m.deleted['2026-11-02'], 'supprimée');
  assert.ok(m.weeks['2026-11-09'], 'nouvelle semaine gardée');
});

test('données abîmées ignorées', () => {
  const d = M.cleanDoc({ weeks: { x: 1, '2026-01-05': { people: [{ name: 'A', days: [['bad', '09:00-10:00', '25:00-24:00']] }, { nope: 1 }] } }, settings: { minStaff: 999 } });
  assert.deepStrictEqual(Object.keys(d.weeks), ['2026-01-05']);
  assert.deepStrictEqual(d.weeks['2026-01-05'].people[0].days[0], ['09:00-10:00']);
  assert.strictEqual(d.settings.minStaff, 0);
});

if (failures) { console.log(`\n${failures} test(s) en échec`); process.exit(1); }
console.log('\nTous les tests passent');
