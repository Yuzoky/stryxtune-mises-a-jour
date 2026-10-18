// Planning automatique : Claude publie le planning chiffré pour CE téléphone uniquement.
//
// - L'appli crée une paire de clés ECDH P-256. La clé privée reste dans le coffre chiffré ;
//   la clé publique est donnée une seule fois à Claude (« code de liaison » STRYXKEY:…).
// - Claude publie sync/planning.json : enveloppe chiffrée (ECDH éphémère + HKDF-SHA256 + AES-256-GCM).
//   Sans la clé privée du téléphone, le contenu est illisible, même si le fichier est public.
// - L'appli récupère le fichier (pont natif, adresses fixes), le déchiffre et met le planning à jour.
'use strict';

const PlanSync = (() => {
  const INFO = new TextEncoder().encode('stryxhub-sync-v1');

  const toB64u = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64 = (b64) => {
    const clean = String(b64).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(clean + '='.repeat((4 - (clean.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };

  // Empreinte courte de la clé publique (pour vérifier que le fichier est bien pour ce téléphone).
  async function fingerprint(pubRaw) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', pubRaw));
    return Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Nouvelle liaison : { priv (JWK, à garder dans le coffre), pub (base64url), kid, code }.
  async function createLink() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pubRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
    const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const pub = toB64u(pubRaw);
    return { priv, pub, kid: await fingerprint(pubRaw), code: `STRYXKEY:${pub}`, created: Date.now() };
  }

  // Déchiffre l'enveloppe publiée ; lève 'other-key' si elle a été chiffrée pour une autre liaison.
  async function open(envelope, link) {
    if (!envelope || envelope.app !== 'stryxhub-sync' || envelope.v !== 1) throw new Error('format');
    if (envelope.kid && link.kid && envelope.kid !== link.kid) throw new Error('other-key');
    const priv = await crypto.subtle.importKey('jwk', link.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const epk = await crypto.subtle.importKey('raw', fromB64(envelope.epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
    const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: fromB64(envelope.salt), info: INFO },
      hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(envelope.iv), additionalData: INFO }, key, fromB64(envelope.ct),
    );
    const payload = JSON.parse(new TextDecoder().decode(pt));
    if (!payload || payload.app !== 'stryxhub-plan' || !payload.id) throw new Error('format');
    return payload;
  }

  return { createLink, open };
})();
