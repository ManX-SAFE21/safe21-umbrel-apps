'use strict';
/*
 * Pannello da fuori casa: controllo della firma di Cloudflare Access.
 * Cloudflare Access (davanti a ticket-admin.safe21.io) chiede il codice via email e poi aggiunge a ogni
 * richiesta l'intestazione Cf-Access-Jwt-Assertion: un "biglietto" firmato da Cloudflare (JWT, RS256).
 * L'app controlla firma, emittente (il tuo team), destinatario (la tua applicazione Access) e scadenza.
 * Così, anche se un giorno il tunnel portasse al pannello senza Access, da fuori non si entra.
 * Le chiavi pubbliche si scaricano da https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
 * (solo dati pubblici; nessuna dipendenza esterna).
 */
const crypto = require('node:crypto');

const TEAM_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const AUD_RE = /^[0-9a-f]{64}$/;
const MAX_TOKEN = 16384; // i biglietti con molti gruppi possono essere lunghi (Node accetta intestazioni fino a 16 KB)
const MAX_CERTS = 64 * 1024;
const KEYS_TTL = 3600 * 1000; // chiavi tenute un'ora
const MIN_REFETCH = 60 * 1000; // al massimo uno scaricamento al minuto (una firma con chiave sconosciuta non deve far partire richieste a raffica)
const SKEW = 60; // secondi di tolleranza sull'orologio

// quello che si incolla dal pannello Cloudflare -> solo il nome del team
// ("https://safe21.cloudflareaccess.com/", "safe21.cloudflareaccess.com" e "safe21" danno tutti "safe21")
const normTeam = (v) => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.cloudflareaccess\.com$/, '');

const b64u = (s) => Buffer.from(s, 'base64url');
const B64U_RE = /^[A-Za-z0-9_-]+$/;

module.exports = function makeAccess({ getSetting, certsUrl = '', fetchImpl = globalThis.fetch } = {}) {
  let cache = { team: '', at: 0, tried: 0, keys: new Map() };

  const config = () => {
    const team = getSetting('access_team', '');
    const aud = getSetting('access_aud', '');
    return TEAM_RE.test(team) && AUD_RE.test(aud) ? { team, aud } : null;
  };

  async function loadKeys(team) {
    const now = Date.now();
    if (cache.team === team && now - cache.tried < MIN_REFETCH) return cache.keys;
    cache.tried = now;
    const url = certsUrl || `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!r.ok) throw new Error('risposta ' + r.status);
      const text = await r.text();
      if (text.length > MAX_CERTS) throw new Error('risposta troppo grande');
      const keys = new Map();
      for (const k of (JSON.parse(text).keys || []).slice(0, 20)) {
        if (!k || k.kty !== 'RSA' || (k.alg && k.alg !== 'RS256') || typeof k.kid !== 'string' || k.kid.length > 200) continue;
        try { keys.set(k.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' })); } catch { /* chiave rovinata: saltata */ }
      }
      cache = { team, at: now, tried: now, keys };
    } catch (e) {
      console.error('Cloudflare Access: chiavi non scaricate:', e.message);
      if (cache.team !== team) cache = { team, at: 0, tried: now, keys: new Map() };
    }
    return cache.keys;
  }

  // controlla il biglietto; restituisce { email } se valido, altrimenti null (mai un'eccezione)
  async function verify(token) {
    const cfg = config();
    if (!cfg || typeof token !== 'string' || token.length > MAX_TOKEN) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => B64U_RE.test(p))) return null;
    let head; let body;
    try { head = JSON.parse(b64u(parts[0]).toString('utf8')); body = JSON.parse(b64u(parts[1]).toString('utf8')); } catch { return null; }
    if (!head || head.alg !== 'RS256' || typeof head.kid !== 'string' || !body || typeof body !== 'object') return null;

    let keys = cache.team === cfg.team && Date.now() - cache.at < KEYS_TTL ? cache.keys : await loadKeys(cfg.team);
    if (!keys.has(head.kid)) keys = await loadKeys(cfg.team); // Cloudflare cambia chiave ogni tanto
    const key = keys.get(head.kid);
    if (!key) return null;
    let good = false;
    try { good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64u(parts[2])); } catch { good = false; }
    if (!good) return null;

    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(body.aud) ? body.aud : [body.aud];
    if (body.iss !== `https://${cfg.team}.cloudflareaccess.com`) return null;
    if (!auds.includes(cfg.aud)) return null;
    if (!Number.isFinite(body.exp) || body.exp + SKEW < now) return null;
    if (body.nbf !== undefined && (!Number.isFinite(body.nbf) || body.nbf - SKEW > now)) return null;
    if (body.iat !== undefined && (!Number.isFinite(body.iat) || body.iat - SKEW > now)) return null;
    return { email: typeof body.email === 'string' ? body.email : '' };
  }

  const check = (req) => verify(req.headers['cf-access-jwt-assertion']);
  return { check, verify, configured: () => !!config() };
};
module.exports.TEAM_RE = TEAM_RE;
module.exports.AUD_RE = AUD_RE;
module.exports.normTeam = normTeam;
