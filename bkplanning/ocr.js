// Lecture d'une photo de planning, entièrement sur le téléphone.
//
// Le téléphone (ML Kit, hors ligne) donne des lignes de texte avec leur position.
// Ce module reconstruit le tableau : 7 colonnes de jours + « Plan / Contrat », une ligne par
// personne (repérée par son nom dans la 1re colonne), puis lit chaque case
// (« 19:00 - 00:00 (*) », « Repos », « CP (04:00) »…).
// Chaque ligne est vérifiée avec le total imprimé (Plan) : une ligne qui ne tombe pas juste
// est signalée pour que le manager la corrige avant d'enregistrer.
//
// Entrée : { w, h, lines: [{ t, b: [x0, y0, x1, y1], c?: [8 coins], e?: [{ t, b }] }] }
// Sortie : voir read().
'use strict';

const SheetReader = (() => {
  const DAY_NAMES = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

  /* ---------- Outils ---------- */

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

  // Caractères souvent confondus avec des chiffres par la reconnaissance de texte.
  const DIGITISH = { O: '0', o: '0', Q: '0', D: '0', U: '0', I: '1', l: '1', '|': '1', i: '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2', g: '9', q: '9', b: '6' };
  const DG = '[0-9OoQDUIl|i!SsBZzgqb]';
  const fixDigits = (s) => s.replace(/[^0-9]/g, (c) => DIGITISH[c] ?? c);

  const clean = (t) => String(t || '').normalize('NFKC').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
  const letters = (t) => (t.match(/\p{L}/gu) || []).length;
  const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Heures dans un texte : « 19:00 », « 9h30 », « 534:48 » (totaux), chiffres mal lus corrigés.
  const TIME_RE = new RegExp(`(?<![0-9])(${DG}{1,3})\\s?[:hH.,;]\\s?(${DG}{2})(?![0-9])`, 'g');
  function timesIn(text) {
    const out = [];
    for (const m of text.matchAll(TIME_RE)) {
      const raw = m[0];
      // Évite de prendre un mot (« Bloc », « Is ») pour une heure : il faut au moins 2 vrais chiffres.
      if ((raw.match(/[0-9]/g) || []).length < 2) continue;
      const h = Number(fixDigits(m[1]));
      const mm = Number(fixDigits(m[2]));
      if (!Number.isFinite(h) || !Number.isFinite(mm) || mm > 59) continue;
      out.push({ min: h * 60 + mm, index: m.index, end: m.index + raw.length });
    }
    return out;
  }

  const RE = {
    repos: /\b(r[eéèêa][pb][oa0][s5]|repo|rh|repos\s*hebdo)\b/i,
    leave: /\b(cp|c\.p\.?|cong[ée]s?|absen\w*|malad\w*|arr[eê]t|formation|[ée]cole|f[ée]ri[ée]|rtt|css|ma|at)\b/i,
    total: /^\W*t[o0]ta[l1]\b/i,
    header: /(nom\s*pr[ée]?nom|pr[ée]nom|plan\s*\/?\s*cont|planning|hebdo|employ|page\s*\d|imprim|temps\s*de\s*pause|signature)/i,
    week: new RegExp(`du\\s*(${DG}{1,2})\\s*[/.-]\\s*(${DG}{1,2})\\s*[/.-]\\s*(${DG}{4})`, 'i'),
    date: new RegExp(`(?<![0-9])(${DG}{1,2})\\s?[/.]\\s?(${DG}{2})(?![0-9:])`),
    dayName: /\b(lun|mar|mer|jeu|ven|sam|dim)\w*/i,
    id: /\(\s*([0-9OoIl]{1,5})\s*\)?\s*$/,
  };

  /* ---------- 1. Fragments : morceaux de texte d'une même case ---------- */

  // Une ligne reconnue peut couvrir plusieurs cases voisines (« 22:00 - 02:30 (*) Repos ») :
  // on la découpe en unités (plage horaire, « Repos », « CP (04:00) », « 20:00 / 20:00 », texte),
  // chacune avec sa position, calculée lettre par lettre à partir des mots.
  const T_SRC = `${DG}{1,3}\\s?[:hH.,;]\\s?${DG}{2}`;
  const UNIT_RE = new RegExp([
    `${T_SRC}\\s*[/|]\\s*${T_SRC}`, // Plan / Contrat
    `${T_SRC}\\s*[-~_.,:;=>»·•aà\\u02CE]{0,2}\\s*${T_SRC}(?:\\s*\\(\\s*[*xX\\u00D7]?\\s*\\)*|\\s*\\*\\s*\\)?|\\s*\\))?`, // plage
    `\\b(?:C\\.?P\\.?|Cong[ée]s?(?:\\s*pay[ée]s?)?)\\s*\\(?\\s*(?:${T_SRC})?\\s*\\)?`, // congé
    `\\b[Rr][eéèêa][pb][oa0][s5]\\b`, // Repos
    T_SRC, // heure seule
  ].map((x) => `(?:${x})`).join('|'), 'g');

  // Quadrilatère d'un mot : coins (haut-gauche, haut-droite, bas-droite, bas-gauche) donnés par
  // le téléphone, sinon ceux du rectangle.
  function quadOf(e) {
    if (Array.isArray(e.c) && e.c.length === 8) return [[e.c[0], e.c[1]], [e.c[2], e.c[3]], [e.c[4], e.c[5]], [e.c[6], e.c[7]]];
    const [x0, y0, x1, y1] = e.b;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  const lerp = (p, q, k) => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
  const dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

  function fragmentsOf(ocr) {
    const frags = [];
    for (const line of ocr.lines || []) {
      if (!line.b && !line.c) continue;
      const raw = line.e && line.e.length ? line.e : [{ t: line.t, b: line.b, c: line.c }];
      const els = raw.map((e) => ({ t: clean(e.t), q: e.b || e.c ? quadOf(e) : null })).filter((e) => e.q && e.t);
      if (!els.length) continue;
      // Sens de la ligne (photo de travers : la ligne n'est pas horizontale).
      const lq = line.c ? quadOf(line) : null;
      const ang = lq ? Math.atan2(lq[1][1] - lq[0][1], lq[1][0] - lq[0][0])
        : median(els.map((e) => Math.atan2(e.q[1][1] - e.q[0][1], e.q[1][0] - e.q[0][0])));
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const along = (pt) => pt[0] * dx + pt[1] * dy;
      els.forEach((e) => { e.s0 = along(e.q[0]); e.s1 = along(e.q[1]); e.h = (dist(e.q[0], e.q[3]) + dist(e.q[1], e.q[2])) / 2; });
      els.sort((x, y) => x.s0 - y.s0);
      const h = Math.max(4, median(els.map((e) => e.h)));
      const angle = lq || els.some((e) => e.q && raw.some((r) => r.c)) ? ang : null;
      // a) grands espaces : morceaux clairement séparés
      const chunks = [];
      let cur = null;
      for (const e of els) {
        if (cur && e.s0 - cur[cur.length - 1].s1 > 1.6 * h) { chunks.push(cur); cur = null; }
        if (!cur) cur = [];
        cur.push(e);
      }
      if (cur) chunks.push(cur);
      // b) unités dans chaque morceau, positionnées lettre par lettre
      for (const chunk of chunks) {
        let text = '';
        const pos = [];
        chunk.forEach((e, k) => {
          if (k) { text += ' '; pos.push(null); }
          const L = e.t.length;
          for (let i = 0; i < L; i++) {
            text += e.t[i];
            pos.push({ e, a: i / L, z: (i + 1) / L });
          }
        });
        const pieces = [];
        let last = 0;
        for (const m of text.matchAll(UNIT_RE)) {
          if (m.index > last) pieces.push([last, m.index]);
          pieces.push([m.index, m.index + m[0].length]);
          last = m.index + m[0].length;
        }
        if (last < text.length) pieces.push([last, text.length]);
        for (const [s0, s1] of pieces) {
          const t = text.slice(s0, s1).trim();
          if (!t || !/[\p{L}\p{N}]/u.test(t)) continue;
          const ps = pos.slice(s0, s1).filter(Boolean);
          if (!ps.length) continue;
          const first = ps[0];
          const lastP = ps[ps.length - 1];
          const q0 = first.e.q;
          const q1 = lastP.e.q;
          // Coins de l'unité : début de la 1re lettre, fin de la dernière.
          const tl = lerp(q0[0], q0[1], first.a);
          const bl = lerp(q0[3], q0[2], first.a);
          const tr = lerp(q1[0], q1[1], lastP.z);
          const br = lerp(q1[3], q1[2], lastP.z);
          const xs = [tl[0], bl[0], tr[0], br[0]];
          const ys = [tl[1], bl[1], tr[1], br[1]];
          frags.push({
            t,
            b: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
            cx: xs.reduce((u, v) => u + v, 0) / 4,
            cy: ys.reduce((u, v) => u + v, 0) / 4,
            w: dist(lerp(tl, bl, 0.5), lerp(tr, br, 0.5)),
            dir: (() => { const p = lerp(tl, bl, 0.5); const q = lerp(tr, br, 0.5); const n = dist(p, q) || 1; return [(q[0] - p[0]) / n, (q[1] - p[1]) / n]; })(),
            h: (dist(tl, bl) + dist(tr, br)) / 2,
            conf: line.s ?? 1,
            angle,
          });
        }
      }
    }
    return frags;
  }

  function classify(f) {
    const t = f.t;
    f.times = timesIn(t);
    f.isWeek = RE.week.test(t);
    f.isDayName = RE.dayName.test(deaccent(t)) && RE.date.test(t) && !f.times.length;
    f.isHeader = RE.header.test(deaccent(t)) && !f.times.length;
    f.isTotal = RE.total.test(t);
    f.isRepos = RE.repos.test(deaccent(t));
    f.isLeave = RE.leave.test(deaccent(t)) && !f.isHeader;
    const L = letters(t);
    const idOnly = /^\(?\s*[0-9OoIl]{1,5}\s*\)?$/.test(t) && /\(|\)/.test(t);
    f.isIdOnly = idOnly;
    f.isName = !f.times.length && !f.isWeek && !f.isDayName && !f.isHeader && !f.isTotal && !f.isRepos
      && (L >= 2 || idOnly) && (idOnly || L / t.replace(/\s/g, '').length > 0.5);
    f.isCell = f.times.length > 0 || f.isRepos || (f.isLeave && L <= 12);
    return f;
  }

  /* ---------- 2. Redressement (photo prise de travers) ---------- */

  function deskew(frags, ocr) {
    const angles = frags.filter((f) => f.angle !== null && f.w > 2.5 * f.h).map((f) => f.angle);
    const a = angles.length >= 5 ? median(angles) : 0;
    const cos = Math.cos(-a);
    const sin = Math.sin(-a);
    for (const f of frags) {
      f.x = f.cx * cos - f.cy * sin;
      f.y = f.cx * sin + f.cy * cos;
      f.d = [f.dir[0] * cos - f.dir[1] * sin, f.dir[0] * sin + f.dir[1] * cos];
    }
    const persp = rectify(frags, Math.max(ocr.w || 0, ocr.h || 0, 1000));
    return { angle: a, persp, w: ocr.w, h: ocr.h };
  }

  // Valeurs / vecteurs propres d'une matrice symétrique 3×3 (méthode de Jacobi).
  function eigenSym3(A) {
    const a = A.map((r) => [...r]);
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 60; sweep++) {
      const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
      if (off < 1e-24) break;
      for (let p = 0; p < 2; p++) {
        for (let q = p + 1; q < 3; q++) {
          if (Math.abs(a[p][q]) < 1e-300) continue;
          const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const sn = t * c;
          for (let k = 0; k < 3; k++) { const x = a[k][p]; const y = a[k][q]; a[k][p] = c * x - sn * y; a[k][q] = sn * x + c * y; }
          for (let k = 0; k < 3; k++) { const x = a[p][k]; const y = a[q][k]; a[p][k] = c * x - sn * y; a[q][k] = sn * x + c * y; }
          for (let k = 0; k < 3; k++) { const x = v[k][p]; const y = v[k][q]; v[k][p] = c * x - sn * y; v[k][q] = sn * x + c * y; }
        }
      }
    }
    return [0, 1, 2].map((i) => ({ val: a[i][i], vec: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => x.val - y.val);
  }

  // Point (homogène) le plus proche de toutes les droites [p, q] : point de fuite.
  function vanishing(segs, S) {
    let use = segs;
    let V = null;
    for (let pass = 0; pass < 3 && use.length >= 6; pass++) {
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      const lines = use.map((sg) => {
        const [px, py] = [sg.p[0] / S, sg.p[1] / S];
        const [qx, qy] = [sg.q[0] / S, sg.q[1] / S];
        const l = [py - qy, qx - px, px * qy - py * qx];
        const n = Math.hypot(l[0], l[1]) || 1;
        return { sg, l: l.map((x) => x / n) };
      });
      for (const { sg, l } of lines) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += sg.w * l[i] * l[j];
      V = eigenSym3(M)[0].vec;
      // Écart angulaire de chaque droite avec la direction du point de fuite : on écarte les pires.
      const err = lines.map(({ sg }) => {
        const mx = (sg.p[0] + sg.q[0]) / (2 * S);
        const my = (sg.p[1] + sg.q[1]) / (2 * S);
        const to = Math.abs(V[2]) > 1e-9 ? [V[0] / V[2] - mx, V[1] / V[2] - my] : [V[0], V[1]];
        const dir = [sg.q[0] - sg.p[0], sg.q[1] - sg.p[1]];
        const cr = Math.abs(to[0] * dir[1] - to[1] * dir[0]) / ((Math.hypot(...to) * Math.hypot(...dir)) || 1);
        return Math.asin(Math.min(1, cr));
      });
      const lim = Math.max(0.004, 2.5 * median(err));
      const next = use.filter((_, i) => err[i] <= lim);
      if (next.length === use.length) break;
      use = next;
    }
    return V;
  }

  // Redresse la perspective : chaque morceau est ramené, le long de sa ligne du tableau, sur la
  // verticale de référence (y), et le long de sa colonne sur l'horizontale de référence (x).
  // Lignes et colonnes deviennent ainsi droites, même sur une photo prise de biais.
  function rectify(frags, S) {
    const xs = frags.map((f) => f.x).sort((a, b) => a - b);
    const ys = frags.map((f) => f.y).sort((a, b) => a - b);
    if (xs.length < 20) return null;
    const xRef = xs[Math.floor(xs.length * 0.15)];
    const yRef = ys[Math.floor(ys.length * 0.5)];
    // Point de fuite hors de la photo (sinon estimation douteuse : on ne redresse pas).
    const cxN = (xs[0] + xs[xs.length - 1]) / (2 * S);
    const cyN = (ys[0] + ys[ys.length - 1]) / (2 * S);
    const far = (V) => !V || Math.abs(V[2]) < 1e-9 || Math.hypot(V[0] / V[2] - cxN, V[1] / V[2] - cyN) > 1.2;
    // Lignes : sens d'écriture des morceaux assez longs.
    const rowSegs = frags.filter((f) => f.w > 2.5 * f.h).map((f) => ({
      p: [f.x - f.d[0] * f.w / 2, f.y - f.d[1] * f.w / 2], q: [f.x + f.d[0] * f.w / 2, f.y + f.d[1] * f.w / 2], w: f.w / S,
    }));
    const V1 = rowSegs.length >= 8 ? vanishing(rowSegs, S) : null;
    const V1ok = V1 && far(V1) && Math.abs(V1[0]) > 3 * Math.abs(V1[1]);
    const projY = (x, y) => {
      if (!V1ok) return y;
      const c = [x / S, y / S, 1];
      const L = [V1[1] * c[2] - V1[2] * c[1], V1[2] * c[0] - V1[0] * c[2], V1[0] * c[1] - V1[1] * c[0]];
      // Intersection avec la verticale x = xRef : (1, 0, -xRef)
      const M = [1, 0, -xRef / S];
      const P = [L[1] * M[2] - L[2] * M[1], L[2] * M[0] - L[0] * M[2], L[0] * M[1] - L[1] * M[0]];
      return Math.abs(P[2]) > 1e-12 ? (P[1] / P[2]) * S : y;
    };
    for (const f of frags) f.ry = projY(f.x, f.y);
    // Colonnes : deux cases de même largeur l'une sous l'autre donnent une droite de colonne.
    const cells = frags.filter((f) => (f.isCell || f.times.length) && f.w > 1.5 * f.h);
    const unit = median(cells.map((f) => f.w)) || 50;
    const lh = median(cells.map((f) => f.h)) || 20;
    const colSegs = [];
    for (const f of cells) {
      let best = null;
      for (const g of cells) {
        const dy = g.ry - f.ry;
        if (dy < 0.8 * lh || dy > 6 * lh) continue;
        if (Math.abs(g.w - f.w) > 0.12 * f.w || Math.abs(g.x - f.x) > 0.35 * unit) continue;
        if (!best || dy < best.ry - f.ry) best = g;
      }
      if (best) colSegs.push({ p: [f.x, f.y], q: [best.x, best.y], w: 1 });
    }
    const V2 = colSegs.length >= 8 ? vanishing(colSegs, S) : null;
    const V2ok = V2 && far(V2) && Math.abs(V2[1]) > 3 * Math.abs(V2[0]);
    for (const f of frags) {
      let x = f.x;
      if (V2ok) {
        const c = [f.x / S, f.y / S, 1];
        const L = [V2[1] * c[2] - V2[2] * c[1], V2[2] * c[0] - V2[0] * c[2], V2[0] * c[1] - V2[1] * c[0]];
        const M = [0, 1, -yRef / S];
        const P = [L[1] * M[2] - L[2] * M[1], L[2] * M[0] - L[0] * M[2], L[0] * M[1] - L[1] * M[0]];
        if (Math.abs(P[2]) > 1e-12) x = (P[0] / P[2]) * S;
      }
      f.x = x;
      f.y = f.ry;
    }
    return { rows: V1ok, cols: V2ok };
  }

  /* ---------- 3. Colonnes ---------- */

  // Ligne d'en-tête (« Lun 12/10 … Plan/Contr ») : tout ce qui est au-dessus est ignoré
  // (titre, « Temps de pause minimum : 00:30 », date d'impression…).
  function headerLine(frags) {
    const days = frags.filter((f) => f.isDayName);
    const hs = days.length >= 2 ? days : frags.filter((f) => f.isHeader && /nom|plan\s*\/?\s*cont/i.test(deaccent(f.t)));
    return hs.length ? median(hs.map((f) => f.y)) : -Infinity;
  }

  function findColumns(frags, headerY = -Infinity) {
    const cells = frags.filter((f) => f.isCell && f.y > headerY);
    if (cells.length < 7) return null;
    const widths = cells.filter((f) => f.times.length >= 2).map((f) => f.w);
    const unit = median(widths.length ? widths : cells.map((f) => f.w)) || 50;
    const xs = cells.map((f) => ({ x: f.x, f })).sort((a, b) => a.x - b.x);
    const groups = [];
    let g = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i].x - xs[i - 1].x > 0.45 * unit) { groups.push(g); g = []; }
      g.push(xs[i]);
    }
    groups.push(g);
    const counts = groups.map((x) => x.length);
    const big = Math.max(...counts);
    let cols = groups.filter((x) => x.length >= Math.max(3, 0.3 * big)).map((x) => ({ x: median(x.map((p) => p.x)), members: x.map((p) => p.f) }));
    if (cols.length < 2) return null;

    // Colonne Plan / Contrat : « 20:00 / 20:00 ».
    const planScore = (c) => c.members.filter((f) => /\d\s*[/|]\s*\d|\d{2,3}:\d{2}\s*[/|1l]?\s*\d{2,3}:\d{2}/.test(fixDigits(f.t)) || (f.times.length === 2 && /\//.test(f.t))).length / c.members.length;
    let plan = null;
    const last = cols[cols.length - 1];
    if (planScore(last) >= 0.4) { plan = last; cols = cols.slice(0, -1); }

    // On garde les 7 colonnes de jours les plus fournies, dans l'ordre.
    while (cols.length > 7) {
      let worst = 0;
      cols.forEach((c, i) => { if (c.members.length < cols[worst].members.length) worst = i; });
      cols.splice(worst, 1);
    }
    // Pas des colonnes (écart typique) pour combler une colonne non trouvée.
    const diffs = cols.slice(1).map((c, i) => c.x - cols[i].x);
    const pitch = median(diffs.filter((d) => d > 0)) || unit * 2;
    const index = cols.map(() => null);
    if (cols.length < 7) {
      // Positions relatives : on suppose la 1re colonne trouvée = lundi, sauf indice contraire (en-têtes).
      let k = 0;
      cols.forEach((c, i) => {
        if (i > 0) k += Math.max(1, Math.round((c.x - cols[i - 1].x) / pitch));
        index[i] = k;
      });
    } else cols.forEach((c, i) => { index[i] = i; });
    cols.forEach((c, i) => { c.day = index[i]; });
    cols = cols.filter((c) => c.day <= 6);
    // Ajustement de chaque colonne : x = a + b·y (perspective).
    for (const c of [...cols, ...(plan ? [plan] : [])]) fitColumn(c, pitch);
    return { days: cols, plan, pitch, unit };
  }

  function fitColumn(c, pitch) {
    let pts = c.members.map((f) => [f.y, f.x]);
    let a = median(pts.map((p) => p[1]));
    let b = 0;
    // Deux passes : la 2e écarte les morceaux trop loin de la droite (texte parasite).
    for (let pass = 0; pass < 2; pass++) {
      const n = pts.length;
      if (n < 2) break;
      const my = pts.reduce((s, p) => s + p[0], 0) / n;
      const mx = pts.reduce((s, p) => s + p[1], 0) / n;
      let num = 0;
      let den = 0;
      for (const [y, x] of pts) { num += (y - my) * (x - mx); den += (y - my) ** 2; }
      b = den > 0 ? num / den : 0;
      if (Math.abs(b) > 0.2) b = 0; // pente aberrante : on garde une colonne droite
      a = b ? mx - b * my : median(pts.map((p) => p[1]));
      const keep = pts.filter(([y, x]) => Math.abs(x - (a + b * y)) < 0.25 * pitch);
      if (keep.length === pts.length || keep.length < 3) break;
      pts = keep;
    }
    c.a = a;
    c.b = b;
    c.xAt = (y) => c.a + c.b * y;
  }

  /* ---------- 4. Lignes (personnes) ---------- */

  // Interligne réel : distance entre deux textes l'un sous l'autre dans une même colonne.
  // (La hauteur des boîtes ne suffit pas : le téléphone les serre autour des lettres.)
  function lineStep(frags, lh) {
    const cells = frags.filter((f) => f.isCell);
    const unit = median(cells.map((f) => f.w)) || 50;
    const d = [];
    for (const f of cells) {
      let best = Infinity;
      for (const g of cells) {
        const dy = g.y - f.y;
        if (dy > 0.5 * lh && dy < best && Math.abs(g.x - f.x) < 0.4 * unit) best = dy;
      }
      if (best < 8 * lh) d.push(best);
    }
    d.sort((a, b) => a - b);
    return d.length >= 6 ? d[Math.floor(d.length * 0.2)] : 1.15 * lh;
  }

  function findRows(frags, cols, headerY) {
    const lh = median(frags.filter((f) => f.isCell).map((f) => f.h)) || 20;
    const step = lineStep(frags.filter((f) => f.y > headerY), lh);
    const midY = median(frags.filter((f) => f.isCell && f.y > headerY).map((f) => f.y));
    const firstX = Math.min(...cols.days.map((c) => c.xAt(midY)));
    const nameLimit = firstX - 0.55 * cols.pitch;
    let names = frags
      .filter((f) => f.x + f.w / 2 < nameLimit + 0.25 * cols.pitch && f.x < nameLimit && f.y > headerY + 0.5 * lh)
      .filter((f) => f.isName || f.isTotal)
      .sort((a, b) => a.y - b.y);

    const withId = names.filter((f) => RE.id.test(f.t)).length;
    const idMode = withId >= Math.max(2, 0.5 * names.filter((f) => !f.isTotal && !f.isIdOnly).length * 0.6);
    const rows = [];
    let cur = null;
    for (const f of names) {
      if (f.isTotal) {
        if (cur) { rows.push(cur); cur = null; }
        rows.push({ total: true, frags: [f], y: f.y, top: f.y });
        continue;
      }
      const startNew = !cur
        || (idMode ? RE.id.test(cur.frags[cur.frags.length - 1].t) : (f.y - cur.frags[cur.frags.length - 1].y) > 1.3 * step)
        || (f.y - cur.frags[cur.frags.length - 1].y) > 1.7 * step;
      if (startNew) { if (cur) rows.push(cur); cur = { frags: [f] }; } else cur.frags.push(f);
    }
    if (cur) rows.push(cur);
    for (const r of rows) {
      r.top = r.frags[0].y;
      r.y = (r.frags[0].y + r.frags[r.frags.length - 1].y) / 2;
      if (!r.total) Object.assign(r, nameOf(r.frags.map((f) => f.t).join(' ')));
    }
    // Rien après la ligne Total (feuilles en dessous, texte vu par transparence…).
    const ti = rows.findIndex((r) => r.total);
    return { rows: ti >= 0 ? rows.slice(0, ti + 1) : rows, headerY, lh, step };
  }

  // « SARA CHAN-BOUSSOURRA (25) » → { name: 'Sara Chan-Boussourra', id: '25' }
  function nameOf(text) {
    let t = clean(text);
    let id = '';
    const m = t.match(/\(\s*([0-9OoIl]{1,5})\s*\)?/);
    if (m) { id = fixDigits(m[1]); t = t.replace(m[0], ' '); }
    t = t.replace(/[^\p{L}\s'’-]/gu, ' ').replace(/\s+/g, ' ').trim();
    const name = t.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
    return { name, id };
  }

  /* ---------- 5. Attribution des cases aux lignes ---------- */

  // Chaque ligne du tableau occupe la hauteur comprise entre le haut de son nom et le haut du
  // nom suivant : une case sur 2 ou 3 lignes de texte reste ainsi dans sa ligne.
  // T(r) = décalage + échelle · haut(r) corrige la perspective, colonne par colonne.
  // Limites entre les lignes du tableau, dans une colonne :
  //  - feuille « noms sur plusieurs lignes » (cases alignées en haut) : un demi-interligne
  //    au-dessus du haut du nom suivant ;
  //  - feuille « noms sur une ligne » (cases centrées sur le nom) : à mi-chemin entre deux noms.
  function bands(members, T, step, rowPitch, centers) {
    const cuts = T.map((t, r) => {
      if (!centers) return t - 0.55 * step;
      const c = t + centers[r];
      if (r === 0) return c - Math.max(1.5 * step, rowPitch / 2);
      return (T[r - 1] + centers[r - 1] + c) / 2;
    });
    const out = T.map(() => []);
    for (const f of members) {
      let r = -1;
      for (let i = 0; i < cuts.length; i++) { if (f.y >= cuts[i]) r = i; else break; }
      if (r < 0) continue; // au-dessus du tableau
      const limit = r + 1 < T.length ? cuts[r + 1]
        : centers ? T[r] + centers[r] + Math.max(1.5 * step, rowPitch / 2) : T[r] + Math.max(2.6 * step, rowPitch);
      if (f.y < limit) out[r].push(f);
    }
    return out;
  }

  // Suit la dérive verticale d'une colonne de haut en bas (feuille un peu bombée ou photo
  // en biais) : pour chaque ligne, le haut attendu de la case est recalé sur la case la plus proche.
  function track(members, tops, offset, step) {
    let off = offset;
    return tops.map((t) => {
      const exp = t + off;
      let near = null;
      for (const f of members) if (!near || Math.abs(f.y - exp) < Math.abs(near.y - exp)) near = f;
      if (near && Math.abs(near.y - exp) < 0.45 * step) off += 0.4 * (near.y - exp);
      return t + off;
    });
  }

  function assignAll(frags, cols, rows, lh, step) {
    const columns = [...cols.days, ...(cols.plan ? [cols.plan] : [])];
    // Chaque morceau du tableau va dans la colonne la plus proche (à sa hauteur).
    const firstY = rows.length ? rows[0].top - 1.1 * step : -Infinity;
    const lastY = rows.length ? rows[rows.length - 1].top + 3.5 * step : Infinity;
    for (const c of columns) c.cellFrags = [];
    for (const f of frags) {
      if (f.y < firstY || f.y > lastY) continue;
      if (f.isHeader || f.isDayName || f.isWeek) continue;
      if (!(f.isCell || f.times.length || letters(f.t) <= 14)) continue;
      let best = null;
      let bd = Infinity;
      for (const c of columns) {
        const d = Math.abs(f.x - c.xAt(f.y));
        if (d < bd) { bd = d; best = c; }
      }
      if (best && bd < 0.5 * cols.pitch) best.cellFrags.push(f);
    }
    const tops = rows.map((r) => r.top);
    const rowPitch = median(tops.slice(1).map((t, i) => t - tops[i])) || 2 * step;

    const result = rows.map(() => ({ days: [[], [], [], [], [], [], []], plan: [] }));
    // Noms sur plusieurs lignes (« BAUER » / « AKTAS (47) ») → cases alignées en haut ;
    // sinon cases centrées sur le nom.
    const people = rows.filter((r) => !r.total);
    const multi = people.filter((r) => r.frags.length > 1).length;
    const centers = multi >= 0.3 * people.length ? null : rows.map((r) => r.y - r.top);
    // Recale une colonne sur des hauts de ligne de référence (noms, ou colonne voisine).
    const fit = (members, ref, firstRows) => {
      let offset = 0;
      let bestScore = -Infinity;
      for (let off = -0.8 * step; off <= 0.8 * step; off += Math.max(0.5, step / 12)) {
        let score = 0;
        for (const t of ref.slice(0, firstRows)) {
          let d = Infinity;
          for (const f of members) { const x = Math.abs(f.y - (t + off)); if (x < d) d = x; }
          score += Math.max(0, 1 - d / (0.4 * step));
        }
        score -= 0.15 * (off / step) ** 2;
        if (score > bestScore) { bestScore = score; offset = off; }
      }
      const T = track(members, ref, offset, step);
      // Qualité : lignes dont le haut tombe sur une case.
      let q = 0;
      for (const t of T) if (members.some((f) => Math.abs(f.y - t) < 0.35 * step)) q++;
      return { T, q };
    };
    // De gauche à droite : chaque colonne est recalée sur les noms (5 premières lignes, puis suivi)
    // ou sur la colonne voisine déjà recalée ; on garde le meilleur alignement.
    let prevT = tops;
    for (const c of [...columns].sort((x, y) => x.xAt(0) - y.xAt(0))) {
      const members = c.cellFrags.sort((u, v) => u.y - v.y || u.x - v.x);
      const fromNames = fit(members, tops, 5);
      const fromLeft = prevT === tops ? fromNames : fit(members, prevT, rows.length);
      const best = fromLeft.q > fromNames.q ? fromLeft : fromNames;
      const assigned = bands(members, best.T, step, rowPitch, centers);
      if (members.length >= 3) prevT = best.T;
      assigned.forEach((list, ri) => {
        const target = c === cols.plan ? result[ri].plan : result[ri].days[c.day];
        target.push(...list);
      });
    }
    return result;
  }

  /* ---------- 6. Lecture des cases ---------- */

  // Texte d'une case → créneaux. Les heures sont lues dans l'ordre et prises deux par deux.
  // Corrections quand le nombre d'heures est impair : « 19-30 » (deux-points lu « - »),
  // « 0230 » (deux-points perdu).
  function looseTimes(t) {
    let x = t.replace(/(?<![\d:])(\d{1,2}) ?- ?(\d{2})(?![\d:])/g, '$1:$2');
    let times = timesIn(x);
    if (times.length % 2) {
      x = x.replace(/(?<![\d:])([0-2]\d)([0-5]\d)(?![\d:])/g, '$1:$2');
      times = timesIn(x);
    }
    return times;
  }

  function parseCell(text) {
    const t = clean(text);
    if (!t) return { slots: [], status: 'missing', raw: '' };
    const d = deaccent(t);
    let times = timesIn(t);
    if (times.length % 2) { const alt = looseTimes(t); if (alt.length % 2 === 0) times = alt; }
    if (!times.length && RE.repos.test(d)) return { slots: [], status: 'ok', raw: t };
    if (RE.leave.test(d) && times.length <= 1) {
      if (times.length === 1 && times[0].min > 0 && times[0].min <= 12 * 60) return { slots: [`CP ${hhmm(times[0].min)}`], status: 'ok', raw: t };
      return { slots: [], status: 'leave', raw: t };
    }
    if (!times.length) {
      // Repos mal lu (« Repas », « Rep0s ») : un mot court commençant par R.
      if (/^r\w{2,5}$/i.test(d.replace(/\W/g, ''))) return { slots: [], status: 'ok', raw: t, guess: true };
      return { slots: [], status: 'unsure', raw: t };
    }
    const slots = [];
    let status = times.length % 2 ? 'partial' : 'ok';
    let prevEnd = -1;
    for (let i = 0; i + 1 < times.length; i += 2) {
      let a = times[i].min;
      let b = times[i + 1].min;
      if (a >= 24 * 60) { status = 'unsure'; continue; }
      // Deuxième créneau qui commence après minuit (« 19:00 - 23:00 / 00:00 - 02:30 (*) »).
      if (prevEnd > 18 * 60 && a < 12 * 60 && a + 24 * 60 >= prevEnd) { a += 24 * 60; b += 24 * 60; }
      if (b <= a) b += 24 * 60; // fin après minuit (« 22:00 - 02:00 (*) »)
      if (b - a > 14 * 60 || b > 32 * 60) { status = 'unsure'; continue; }
      slots.push({ a, b });
      prevEnd = b;
    }
    // Ordre chronologique + chevauchements = lecture douteuse.
    slots.sort((x, y) => x.a - y.a);
    for (let i = 1; i < slots.length; i++) if (slots[i].a < slots[i - 1].b) status = 'unsure';
    const out = slots.map(({ a, b }) => `${hhmm(a)}-${hhmm(b)}${b >= 24 * 60 ? '*' : ''}`);
    if (RE.leave.test(d) || RE.repos.test(d)) status = 'unsure';
    // Horaires au quart d'heure : « 14:39 » est presque sûrement un chiffre mal lu.
    if (slots.some(({ a, b }) => a % 15 || b % 15)) status = 'unsure';
    if (times.some((x) => x.min >= 30 * 60)) status = 'unsure';
    return { slots: out, status, raw: t };
  }

  // « 20:30 / 20:00 » ; lecture plus souple si besoin (« 21:0/20:00 », « 00-00/35:00 »).
  function parsePlan(text) {
    const t = clean(text);
    let times = timesIn(t).map((x) => x.min);
    let loose = false;
    if (times.length < 2 && t.includes('/')) {
      const sides = t.split('/').slice(0, 2).map((side) => {
        const m = fixDigits(side).match(/(\d{1,3})\D{1,2}(\d{1,2})/);
        if (!m) return null;
        const mm = m[2].length === 1 ? Number(m[2]) * 10 : Number(m[2]);
        return mm < 60 ? Number(m[1]) * 60 + mm : null;
      });
      if (sides.every((v) => v !== null) && sides.length === 2) { times = sides; loose = true; }
    }
    return {
      planned: times[0] !== undefined ? hhmm(times[0]) : '',
      contract: times[1] !== undefined ? hhmm(times[1]) : '',
      loose,
      raw: t,
    };
  }

  // Texte d'une case dans l'ordre de lecture : ligne par ligne, de gauche à droite.
  function joinText(list) {
    const byY = [...list].sort((a, b) => a.y - b.y);
    const lines = [];
    for (const f of byY) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(f.y - line.y) < 0.5 * Math.max(f.h, line.h)) line.items.push(f);
      else lines.push({ y: f.y, h: f.h, items: [f] });
    }
    return lines.map((l) => l.items.sort((a, b) => a.x - b.x).map((f) => f.t).join(' ')).join(' ');
  }

  function slotMinutes(s) {
    if (/^CP/i.test(s)) return toMin(s.slice(3));
    const [a, b] = s.replace('*', '').split('-');
    return toMin(b) - toMin(a);
  }
  const personMinutes = (days) => days.reduce((t, d) => t + d.slots.reduce((u, s) => u + slotMinutes(s), 0), 0);

  /* ---------- 7. Semaine ---------- */

  function findWeek(frags, cols, now) {
    for (const f of frags) {
      const m = fixDigits(f.t.replace(/\s/g, '')).match(/du(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/i)
        || (f.isWeek && f.t.match(RE.week));
      if (m) {
        const d = new Date(Number(fixDigits(m[3])), Number(fixDigits(m[2])) - 1, Number(fixDigits(m[1])));
        if (!Number.isNaN(d.getTime())) return { week: isoMonday(d), source: 'titre' };
      }
    }
    // En-têtes « Lun 12/10 », « Vendredi 06/11 » : la colonne donne le jour de la semaine.
    const votes = {};
    const topCell = cols ? Math.min(...cols.days.flatMap((c) => c.members.map((f) => f.y))) : Infinity;
    for (const f of frags.filter((x) => x.isDayName || (RE.date.test(x.t) && !x.times.length && x.y < topCell))) {
      const m = f.t.match(RE.date);
      if (!m) continue;
      const day = Number(fixDigits(m[1]));
      const month = Number(fixDigits(m[2]));
      if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) continue;
      let idx = DAY_NAMES.findIndex((n) => deaccent(f.t).toLowerCase().includes(n));
      if (cols) {
        let bd = Infinity;
        for (const c of cols.days) { const d = Math.abs(f.x - c.xAt(f.y)); if (d < bd && d < 0.5 * cols.pitch) { bd = d; idx = c.day; } }
      }
      if (idx < 0) continue;
      const date = nearestDate(day, month, now);
      const monday = isoMonday(new Date(date.getFullYear(), date.getMonth(), date.getDate() - idx));
      votes[monday] = (votes[monday] || 0) + 1;
    }
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    return best ? { week: best[0], source: 'en-têtes' } : { week: null, source: null };
  }

  function nearestDate(day, month, now) {
    const y = now.getFullYear();
    const cands = [y - 1, y, y + 1].map((yy) => new Date(yy, month - 1, day));
    return cands.sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
  }

  function isoMonday(d) {
    const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
  }

  /* ---------- Lecture complète ---------- */

  function read(ocr, now = new Date()) {
    const frags = fragmentsOf(ocr).map(classify);
    const geo = deskew(frags, ocr);
    const headerY = headerLine(frags);
    const cols = findColumns(frags, headerY);
    const week = findWeek(frags, cols, now);
    if (!cols || cols.days.length < 4) return { ok: false, error: 'table', week: week.week, people: [], totals: null, angle: geo.angle };
    const { rows, lh, step } = findRows(frags, cols, headerY);
    if (!rows.filter((r) => !r.total).length) return { ok: false, error: 'names', week: week.week, people: [], totals: null, angle: geo.angle };
    const cells = assignAll(frags, cols, rows, lh, step);

    const people = [];
    let totals = null;
    rows.forEach((r, i) => {
      const c = cells[i];
      if (r.total) {
        totals = {
          days: c.days.map((list) => { const t = timesIn(joinText(list)); return t[0] ? hhmm(t[0].min) : ''; }),
          ...parsePlan(joinText(c.plan)),
        };
        return;
      }
      const days = c.days.map((list) => ({ ...parseCell(joinText(list)), box: boxOf(list) }));
      const found = days.filter((d) => d.status !== 'missing').length;
      if (found < 3 && !c.plan.length) return; // ligne parasite (texte vu par transparence…)
      const plan = parsePlan(joinText(c.plan));
      people.push({ name: r.name, id: r.id, planned: plan.planned, contract: plan.contract, days, box: boxOf(r.frags.concat(...c.days, c.plan)) });
    });
    for (const p of people) check(p);
    return { ok: true, week: week.week, weekSource: week.source, people, totals, angle: geo.angle, persp: geo.persp, columns: cols.days.length, hasPlan: !!cols.plan };
  }

  // Rectangle (coordonnées de la photo) couvrant des morceaux : sert à afficher l'extrait à vérifier.
  function boxOf(list) {
    if (!list.length) return null;
    return [Math.min(...list.map((f) => f.b[0])), Math.min(...list.map((f) => f.b[1])), Math.max(...list.map((f) => f.b[2])), Math.max(...list.map((f) => f.b[3]))];
  }

  // Contrôle d'une ligne : la somme des créneaux doit donner le total « Plan » imprimé.
  function check(p) {
    const sum = personMinutes(p.days);
    const planned = p.planned ? toMin(p.planned) : null;
    p.sum = hhmm(sum);
    p.delta = planned === null ? null : planned - sum;
    const doubtful = p.days.filter((d) => d.status !== 'ok').length;
    p.ok = planned !== null && p.delta === 0 && !doubtful;
    // Une seule case illisible (cachée, « CP » sans durée) et des heures manquantes : on propose la différence.
    p.suggest = null;
    if (planned !== null && p.delta > 0 && p.delta <= 12 * 60) {
      const holes = p.days.map((d, i) => ({ d, i })).filter((x) => x.d.status === 'missing' || x.d.status === 'leave');
      if (holes.length === 1) p.suggest = { day: holes[0].i, value: `CP ${hhmm(p.delta)}`, minutes: p.delta };
    }
    return p;
  }

  // Plusieurs photos de la même semaine (page 1, page 2…) : on réunit les personnes.
  function mergePages(pages) {
    const out = { week: null, people: [], totals: null };
    const key = (p) => deaccent(p.name).toLowerCase().replace(/[^a-z]/g, '') + '#' + (p.id || '');
    const seen = new Map();
    for (const pg of pages) {
      if (!out.week && pg.week) out.week = pg.week;
      if (pg.totals && (!out.totals || pg.totals.days.filter(Boolean).length > out.totals.days.filter(Boolean).length)) out.totals = pg.totals;
      for (const p of pg.people) {
        const k = key(p);
        const prev = seen.get(k);
        if (!prev) { seen.set(k, p); out.people.push(p); } else if (!prev.ok && p.ok) {
          out.people[out.people.indexOf(prev)] = p;
          seen.set(k, p);
        }
      }
    }
    out.dayCheck = out.totals ? out.totals.days.map((t, i) => {
      if (!t) return null;
      const sum = out.people.reduce((s, p) => s + p.days[i].slots.reduce((u, x) => u + slotMinutes(x), 0), 0);
      return { expected: t, sum: hhmm(sum), ok: toMin(t) === sum };
    }) : null;
    return out;
  }

  return { read, parseCell, parsePlan, mergePages, check, nameOf, slotMinutes, timesIn, hhmm, toMin };
})();

if (typeof module !== 'undefined') module.exports = SheetReader;
