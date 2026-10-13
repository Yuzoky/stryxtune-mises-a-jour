// Chiffrement du coffre : PBKDF2-SHA256 (600 000 itérations) -> AES-256-GCM.
// Rien n'est jamais stocké en clair : seul le blob chiffré est conservé.
'use strict';

const VaultCrypto = (() => {
  const ITERATIONS = 600000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  async function deriveKey(password, salt, iterations = ITERATIONS) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // Crée une nouvelle clé (nouveau sel) à partir d'un mot de passe.
  async function newKey(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    return { key, salt: toB64(salt), iterations: ITERATIONS };
  }

  async function encrypt(session, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.key, enc.encode(JSON.stringify(data)));
    return { app: 'stryx-vault', v: 1, kdf: 'PBKDF2-SHA256', iterations: session.iterations, salt: session.salt, iv: toB64(iv), data: toB64(ct) };
  }

  // Lève une erreur si le mot de passe est faux (échec d'authentification GCM).
  async function open(password, blob) {
    if (!blob || blob.app !== 'stryx-vault' || !blob.salt || !blob.iv || !blob.data) throw new Error('format');
    const iterations = blob.iterations || ITERATIONS;
    const key = await deriveKey(password, fromB64(blob.salt), iterations);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.data));
    return { session: { key, salt: blob.salt, iterations }, data: JSON.parse(dec.decode(pt)) };
  }

  // Générateur sans biais modulo.
  function randomInt(max) {
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    do crypto.getRandomValues(buf); while (buf[0] >= limit);
    return buf[0] % max;
  }

  function generate(length, sets) {
    const pools = [];
    if (sets.upper) pools.push('ABCDEFGHJKLMNPQRSTUVWXYZ');
    if (sets.lower) pools.push('abcdefghijkmnopqrstuvwxyz');
    if (sets.digits) pools.push('23456789');
    if (sets.symbols) pools.push('!@#$%^&*-_=+?.:;~');
    if (!pools.length) pools.push('abcdefghijkmnopqrstuvwxyz');
    const all = pools.join('');
    // Au moins un caractère de chaque famille choisie, puis mélange.
    const out = pools.map((p) => p[randomInt(p.length)]);
    while (out.length < length) out.push(all[randomInt(all.length)]);
    for (let i = out.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out.slice(0, length).join('');
  }

  // Score 0..4 basé sur l'entropie estimée.
  function strength(pw) {
    if (!pw) return 0;
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
    let bits = pw.length * Math.log2(pool || 1);
    if (/^(.)\1+$/.test(pw) || /^(?:123|abc|azerty|qwerty|password|motdepasse)/i.test(pw)) bits = Math.min(bits, 20);
    if (bits < 35) return 1;
    if (bits < 60) return 2;
    if (bits < 85) return 3;
    return 4;
  }

  return { newKey, encrypt, open, generate, strength };
})();
