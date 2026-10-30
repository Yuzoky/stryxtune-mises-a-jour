// Import de mots de passe depuis un fichier CSV exporté par un autre gestionnaire
// (Google / Chrome, Samsung Internet, Firefox, Edge, Bitwarden, LastPass, 1Password,
// Dashlane, Proton Pass, KeePass…). Les colonnes sont reconnues d'après leur nom.
'use strict';

const CsvImport = (() => {
  // Noms de colonnes reconnus (en minuscules), par champ.
  const COLUMNS = {
    title: ['name', 'title', 'account', 'nom', 'titre', 'site', 'service'],
    url: ['url', 'login_uri', 'website', 'web site', 'uri', 'urls', 'adresse', 'site web', 'origin', 'login_url'],
    user: ['username', 'login_username', 'login name', 'login', 'user', 'user name', 'email', 'e-mail', 'identifiant', 'utilisateur', 'username1'],
    pass: ['password', 'login_password', 'pass', 'mot de passe', 'motdepasse', 'pwd'],
    notes: ['note', 'notes', 'extra', 'comments', 'comment', 'commentaire', 'commentaires'],
  };

  const CATEGORY_HINTS = [
    ['jeux', /steam|epic ?games|epicgames|riot|valorant|league ?of ?legends|battle\.?net|blizzard|ubisoft|\bea\b|origin|xbox|playstation|psn|nintendo|fortnite|roblox|minecraft|mojang|rockstar|gog|twitch|faceit|garena|supercell|hoyoverse|mihoyo/i],
    ['social', /facebook|instagram|tiktok|snapchat|twitter|x\.com|discord|reddit|youtube|whatsapp|telegram|linkedin|pinterest|threads|bereal|messenger/i],
    ['mail', /gmail|google|outlook|hotmail|live\.com|yahoo|proton(mail)?|icloud|orange\.fr|sfr|free\.fr|laposte|mail/i],
    ['banque', /bank|banque|paypal|revolut|boursorama|lcl|bnp|soci[eé]t[eé] ?g[eé]n[eé]rale|cr[eé]dit|caisse|n26|lydia|wise|binance|coinbase|kraken|fortuneo|hello ?bank|ma ?french ?bank/i],
    ['travail', /slack|teams|office|microsoft|notion|trello|asana|jira|atlassian|github|gitlab|zoom|indeed|pole-?emploi|france ?travail/i],
  ];

  // Lecture CSV (RFC 4180) : guillemets, retours à la ligne dans les champs, séparateur , ou ;
  function parse(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';'
      : (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((v) => v !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((v) => v !== '')) rows.push(row);
    return rows;
  }

  function hostOf(url) {
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, '');
    } catch { return ''; }
  }

  function guessCategory(text) {
    for (const [cat, re] of CATEGORY_HINTS) if (re.test(text)) return cat;
    return 'autre';
  }

  // Renvoie { items, total, skipped } ; lève une erreur si le fichier n'est pas reconnu.
  function read(text) {
    const rows = parse(text);
    if (rows.length < 2) throw new Error('vide');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    // Pour chaque champ, toutes les colonnes possibles ; on prend la première non vide.
    const col = {};
    for (const [key, names] of Object.entries(COLUMNS)) {
      col[key] = names.map((n) => header.indexOf(n)).filter((i) => i !== -1);
    }
    if (!col.pass.length) throw new Error('colonnes');

    const items = [];
    let skipped = 0;
    for (const r of rows.slice(1)) {
      const get = (k) => {
        for (const i of col[k]) if ((r[i] || '').trim()) return r[i].trim();
        return '';
      };
      const pass = col.pass.map((i) => r[i] || '').find((v) => v) || '';
      const user = get('user');
      const url = get('url');
      if (!pass && !user) { skipped++; continue; }
      let title = get('title') || hostOf(url) || user || 'Sans nom';
      if (/^https?:\/\//i.test(title)) title = hostOf(title) || title;
      title = title.slice(0, 100);
      items.push({
        title,
        user: user.slice(0, 200),
        pass: pass.slice(0, 500),
        url: url.slice(0, 300),
        notes: get('notes').slice(0, 2000),
        cat: guessCategory(`${title} ${url}`),
      });
    }
    return { items, total: rows.length - 1, skipped };
  }

  return { read };
})();
