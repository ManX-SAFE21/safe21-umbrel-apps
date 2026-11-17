'use strict';
/*
 * Defences: client address, per-IP rate limits (in memory, never stored), admin password (scrypt),
 * admin sessions, CSRF token of the panel forms. Same approach as the SAFE21 ticket app, rewritten here.
 */
const crypto = require('node:crypto');
const net = require('node:net');
const { isBlockedAddress } = require('./netpolicy.js');

const strip4 = (ip) => String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/*
 * Client address of the PUBLIC server. Proxy headers are trusted only when TRUST_PROXY=1
 * (the app sits behind a reverse proxy or tunnel that overwrites them); otherwise the real socket address.
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf && net.isIP(cf)) return strip4(cf);
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter((s) => net.isIP(s));
    if (xff.length) return strip4(xff[xff.length - 1]); // the address added by OUR proxy (rightmost)
  }
  return strip4(req.socket.remoteAddress) || 'unknown';
}

// IPv4 whole address; IPv6 its /64 (a home or a server usually owns a whole /64)
function netKey(ip) {
  const a = strip4(ip);
  if (!net.isIPv6(a)) return a;
  const [head, tail = ''] = a.toLowerCase().split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = a.includes('::') ? (tail ? tail.split(':') : []) : [];
  const full = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => x.padStart(4, '0')).join(':') + '::/64';
}

function createLimiter({ maxKeys = 100000 } = {}) {
  const hits = new Map();
  function hit(key, max, windowMs, t = Date.now()) {
    if (hits.size > maxKeys) { let n = hits.size - maxKeys + 1000; for (const k of hits.keys()) { if (n-- <= 0) break; hits.delete(k); } }
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(t);
    hits.set(key, arr);
    return true;
  }
  const sweep = () => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 86400000)) hits.delete(k); };
  return { hit, sweep, clear: () => hits.clear() };
}

/* ---------- admin password and sessions ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
async function checkPassword(pw, stored) {
  if (typeof stored !== 'string' || !/^[0-9a-f]{32}:[0-9a-f]{64}$/.test(stored)) return false;
  const [s, h] = stored.split(':');
  const a = await new Promise((ok, ko) => crypto.scrypt(String(pw), Buffer.from(s, 'hex'), 32, (e, k) => (e ? ko(e) : ok(k))));
  return crypto.timingSafeEqual(a, Buffer.from(h, 'hex'));
}

const SESSION_MS = 12 * 3600 * 1000;
function createSessions() {
  const sessions = new Map();
  return {
    create() { const sid = crypto.randomBytes(24).toString('hex'); sessions.set(sid, Date.now() + SESSION_MS); return sid; },
    of(req) {
      const m = /(?:^|;\s*)wsid=([0-9a-f]{48})(?:;|$)/.exec(req.headers.cookie || '');
      if (!m) return null;
      const exp = sessions.get(m[1]);
      if (!exp || exp < Date.now()) { sessions.delete(m[1]); return null; }
      return m[1];
    },
    end: (sid) => sessions.delete(sid),
    endOthers: (keep) => { for (const k of sessions.keys()) if (k !== keep) sessions.delete(k); },
  };
}
const sessionCookie = (v, maxAge, secure) => `wsid=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

/* ---------- CSRF of the panel forms: Sec-Fetch-Site when the browser sends it, else an HMAC token ---------- */
const csrfSlot = () => Math.floor(Date.now() / (12 * 3600 * 1000));
const csrfFor = (secret, slot) => crypto.createHmac('sha256', secret).update(`csrf:${slot}`).digest('hex').slice(0, 32);
const csrfToken = (secret) => csrfFor(secret, csrfSlot());
function csrfValid(secret, tok) {
  if (typeof tok !== 'string' || !/^[0-9a-f]{32}$/.test(tok)) return false;
  return [csrfSlot(), csrfSlot() - 1].some((s) => crypto.timingSafeEqual(Buffer.from(csrfFor(secret, s)), Buffer.from(tok)));
}
function adminFormOk(req, secret, tok) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false; // never from another site, even with a token
  return csrfValid(secret, tok);
}

// the very first admin password may only be chosen from a local / private network connection
const fromPrivateNet = (req) => isBlockedAddress(strip4(req.socket.remoteAddress));

module.exports = {
  clientIp, netKey, createLimiter, hashPassword, checkPassword, SESSION_MS, createSessions, sessionCookie,
  csrfToken, csrfValid, adminFormOk, fromPrivateNet,
};
