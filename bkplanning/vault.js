// Code du restaurant, chiffrement et envoi automatique.
//
// - Le code du restaurant (16 caractères, 80 bits, tiré au hasard) donne par PBKDF2 :
//   la clé AES-256-GCM qui chiffre le planning, et l'identifiant (anonyme) du fichier en ligne.
// - En ligne (dépôt GitHub public dédié) il n'y a que du chiffré :
//     r/<id>.json      le planning
//     r/<id>.key.json  la clé d'envoi GitHub, pour que chaque manager puisse publier
//   Sans le code, ces fichiers sont illisibles et on ne sait même pas à quel restaurant ils sont.
// - Le réseau passe par l'appli Android (pont natif), limité à ce seul dépôt.
'use strict';

const Vault = (() => {
  const REPO = 'Yuzoky/bk-planning-data';
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // base32 de Crockford (sans I, L, O, U)
  const ITERATIONS = 200000;
  const SALT = new TextEncoder().encode('bkplanning-code-v1');
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b64) => Uint8Array.from(atob(String(b64).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const chars = Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
    return format(chars);
  }
  const format = (c) => c.match(/.{1,4}/g).join('-');

  // Saisie tolérante : minuscules, espaces, tirets, O/0, I/L/1.
  function normCode(input) {
    const c = String(input || '').toUpperCase().replace(/[\s\-_.]/g, '')
      .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
    if (c.length !== 16 || [...c].some((ch) => !ALPHABET.includes(ch))) return null;
    return format(c);
  }

  async function open(code) {
    const c = normCode(code);
    if (!c) throw new Error('code');
    const base = await crypto.subtle.importKey('raw', enc.encode(c.replace(/-/g, '')), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: ITERATIONS }, base, 384));
    const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return { code: c, key, id: hex(bits.slice(32, 44)) };
  }

  const aad = (room, kind) => enc.encode(`bkplanning-v1:${room.id}:${kind}`);

  async function seal(room, kind, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(room, kind) }, room.key, enc.encode(JSON.stringify(obj)));
    return { app: 'bkplanning', v: 1, kind, iv: toB64(iv), ct: toB64(ct) };
  }

  async function unseal(room, kind, env) {
    if (!env || env.app !== 'bkplanning' || env.v !== 1 || env.kind !== kind) throw new Error('format');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(room, kind) }, room.key, fromB64(env.ct));
    return JSON.parse(dec.decode(pt));
  }

  /* ---------- Réseau (pont natif) ---------- */

  const pending = new Map();
  let seq = 0;
  window.bkGithub = (id, status, text) => {
    const done = pending.get(id);
    if (done) { pending.delete(id); done({ status, text }); }
  };

  function call(method, path, token, body) {
    const native = window.BKAndroid;
    if (!native || !native.github) return Promise.reject(Object.assign(new Error('offline'), { code: 'native' }));
    const id = `r${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('timeout'), { code: 'network' })); }, 30000);
      pending.set(id, (res) => {
        clearTimeout(timer);
        if (res.status === 0) reject(Object.assign(new Error(res.text || 'network'), { code: 'network' }));
        else resolve(res);
      });
      native.github(id, method, path, token || '', body ? JSON.stringify(body) : '');
    });
  }

  const docPath = (room) => `r/${room.id}.json`;
  const keyPath = (room) => `r/${room.id}.key.json`;
  const fail = (code, status) => Object.assign(new Error(code), { code, status });

  function fileContent(text) {
    const meta = JSON.parse(text);
    const raw = dec.decode(fromB64(meta.content || ''));
    return { sha: meta.sha, json: JSON.parse(raw) };
  }

  // Vérifie une clé GitHub : accès en écriture au dépôt de données ?
  async function checkToken(token) {
    const res = await call('GET', '', token);
    if (res.status === 401) throw fail('token-bad', 401);
    if (res.status === 404) throw fail('repo-missing', 404);
    if (res.status !== 200) throw fail('http', res.status);
    const info = JSON.parse(res.text);
    if (info.permissions && info.permissions.push === false) throw fail('token-readonly', 403);
    return true;
  }

  // Clé d'envoi publiée (chiffrée) pour ce restaurant ; null si rien n'est encore publié.
  async function fetchToken(room, token) {
    const res = await call('GET', keyPath(room), token);
    if (res.status === 404) return null;
    if (res.status === 401) throw fail('token-bad', 401);
    if (res.status === 403 || res.status === 429) throw fail('rate', res.status);
    if (res.status !== 200) throw fail('http', res.status);
    const { sha, json } = fileContent(res.text);
    const data = await unseal(room, 'key', json);
    return { token: String(data.token || ''), sha };
  }

  async function putFile(path, token, json, sha, message) {
    const content = toB64(enc.encode(JSON.stringify(json)));
    const res = await call('PUT', path, token, { message, content, ...(sha ? { sha } : {}) });
    if (res.status === 200 || res.status === 201) return JSON.parse(res.text).content.sha;
    if (res.status === 409 || res.status === 422) throw fail('conflict', res.status);
    if (res.status === 401) throw fail('token-bad', 401);
    if (res.status === 403 || res.status === 404) throw fail('token-denied', res.status);
    throw fail('http', res.status);
  }

  async function publishToken(room, token) {
    let sha = null;
    try { const cur = await fetchToken(room, token); sha = cur && cur.sha; } catch (e) { if (e.code !== 'format') throw e; }
    const env = await seal(room, 'key', { token, at: new Date().toISOString() });
    return putFile(keyPath(room), token, env, sha, 'Clé');
  }

  // Planning publié : { doc, sha } ; doc null si le restaurant n'a encore rien publié.
  async function pull(room, token) {
    const res = await call('GET', docPath(room), token);
    if (res.status === 404) return { doc: null, sha: null };
    if (res.status === 401) throw fail('token-bad', 401);
    if (res.status === 403 || res.status === 429) throw fail('rate', res.status);
    if (res.status !== 200) throw fail('http', res.status);
    const { sha, json } = fileContent(res.text);
    return { doc: await unseal(room, 'doc', json), sha };
  }

  async function push(room, token, doc, sha) {
    const env = await seal(room, 'doc', doc);
    return putFile(docPath(room), token, env, sha, 'Mise à jour');
  }

  return { REPO, newCode, normCode, open, seal, unseal, checkToken, fetchToken, publishToken, pull, push };
})();
