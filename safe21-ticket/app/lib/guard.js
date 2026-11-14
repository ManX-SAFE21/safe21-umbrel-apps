'use strict';
/*
 * Difese comuni (riprese dall'app dei corsi, già provate su Umbrel):
 * indirizzo del visitatore, limiti ai tentativi, password, sessioni, riconoscimento
 * dell'icona di Umbrel, controllo che i moduli arrivino dalla stessa pagina.
 */
const crypto = require('node:crypto');
const net = require('node:net');
const dns = require('node:dns');

function isPrivateIp(ip) {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || /^f[cd]/.test(l) || l.startsWith('fe80');
}

/*
 * Indirizzo del visitatore della pagina PUBBLICA.
 * Dietro il tunnel vale CF-Connecting-IP, che Cloudflare scrive sempre al posto di quello mandato
 * dal visitatore: è affidabile perché la porta pubblica non è aperta verso la rete di casa né verso
 * internet, ci arriva solo il tunnel. Senza quell'intestazione si usa la logica dei corsi:
 * X-Forwarded-For letto da destra (i proxy aggiungono in coda), primo indirizzo pubblico.
 */
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf && net.isIP(cf)) return cf;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter((s) => net.isIP(s.replace(/^::ffff:/i, '')));
  chain.push(req.socket.remoteAddress || '');
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i] && !isPrivateIp(chain[i])) return chain[i];
  return chain[chain.length - 2] || chain[chain.length - 1] || 'unknown';
}

/*
 * Indirizzo per il blocco dei tentativi di accesso al PANNELLO.
 * CF-Connecting-IP vale solo se la richiesta ha la firma valida di Cloudflare Access (cfTrusted):
 * allora è passata davvero da Cloudflare, che scrive quell'intestazione. Altrimenti l'indirizzo vero
 * della connessione. Mai X-Forwarded-For: cambiandolo si aggirerebbe il blocco.
 */
function adminIp(req, cfTrusted = false) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cfTrusted && cf && net.isIP(cf)) return cf;
  return req.socket.remoteAddress || 'unknown';
}

/*
 * Chiave per i limiti: un indirizzo IPv4 intero, oppure i primi 64 bit di un IPv6.
 * Una casa o un server IPv6 ricevono di solito un intero blocco /64 (miliardi di indirizzi):
 * contare il singolo indirizzo permetterebbe di cambiare indirizzo a ogni richiesta.
 */
function netKey(ip) {
  const a = String(ip || '').replace(/^::ffff:/i, '');
  if (net.isIPv4(a) || !net.isIPv6(a)) return a;
  const [head, tail = ''] = a.toLowerCase().split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = a.includes('::') ? (tail ? tail.split(':') : []) : [];
  const full = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => x.padStart(4, '0')).join(':') + '::/64';
}
const visitorKey = (req) => netKey(clientIp(req));

// limiti in memoria (l'indirizzo IP non viene mai salvato nel database)
const hits = new Map();
const MAX_KEYS = 100000;
function trim() {
  // tetto alla memoria: oltre MAX_KEYS si buttano le chiavi più vecchie
  if (hits.size <= MAX_KEYS) return;
  let n = hits.size - MAX_KEYS + 1000;
  for (const k of hits.keys()) { if (n-- <= 0) break; hits.delete(k); }
}
function rateLimit(key, max, windowMs) {
  trim();
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(t); hits.set(key, arr); return true;
}
// come rateLimit, ma in due tempi: overLimit guarda senza contare, addHit conta (es. solo i tentativi sbagliati)
function overLimit(key, max, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  hits.set(key, arr);
  return arr.length >= max;
}
function addHit(key) {
  trim();
  const arr = hits.get(key) || [];
  arr.push(Date.now()); hits.set(key, arr);
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 86400000)) hits.delete(k); }, 600000).unref();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
// controllo della password senza bloccare il server (scrypt lavora in un altro thread)
async function checkPassword(pw, stored) {
  if (typeof stored !== 'string' || !/^[0-9a-f]{32}:[0-9a-f]{64}$/.test(stored)) return false;
  const [s, h] = stored.split(':');
  const a = await new Promise((ok, ko) => crypto.scrypt(String(pw), Buffer.from(s, 'hex'), 32, (e, k) => (e ? ko(e) : ok(k))));
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// sessioni del pannello (in memoria: un riavvio chiede di rientrare)
const SESSION_MS = 12 * 3600 * 1000;
const sessions = new Map();
function newSession() {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, Date.now() + SESSION_MS);
  return sid;
}
function sessionOf(req) {
  const m = /(?:^|;\s*)sid=([0-9a-f]{48})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) { sessions.delete(m[1]); return null; }
  return m[1];
}
const endSession = (sid) => sessions.delete(sid);
// dopo un cambio di password: fuori tutte le altre sessioni (una sessione rubata smette di valere)
function endOtherSessions(keep) { for (const k of sessions.keys()) if (k !== keep) sessions.delete(k); }
// Secure quando la richiesta è arrivata in https (dal tunnel Cloudflare): il cookie non viaggia mai in chiaro
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(String(req.headers['cf-visitor'] || ''));
const sessionCookie = (v, maxAge, req) => `sid=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req && isHttps(req) ? '; Secure' : ''}`;

/*
 * L'icona di Umbrel apre il pannello passando dal suo app_proxy, che chiede il login di Umbrel.
 * Il container del proxy si riconosce dall'indirizzo VERO della connessione, mai da intestazioni.
 */
function umbrelProxyCheck(host) {
  let cache = { at: 0, ips: [] };
  return async function fromUmbrel(req) {
    if (!host) return false;
    if (Date.now() - cache.at > 10000) { // breve: se il proxy si riavvia, il suo vecchio indirizzo non resta fidato a lungo
      try { cache = { at: Date.now(), ips: (await dns.promises.lookup(host, { all: true })).map((a) => a.address) }; } catch { cache = { at: Date.now(), ips: [] }; }
    }
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return cache.ips.includes(ip);
  };
}

/*
 * I moduli (POST) devono arrivare da una pagina dello stesso sito.
 * Sec-Fetch-Site lo manda il browser da solo; se manca si confronta Origin con l'indirizzo.
 * Senza né l'uno né l'altro la richiesta si rifiuta (tutti i browser di oggi mandano almeno uno dei due).
 */
function sameOrigin(req, { behindProxy = false } = {}) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  const host = (behindProxy && req.headers['x-forwarded-host']) || req.headers.host;
  try { return new URL(origin).host === host; } catch { return false; }
}

/*
 * Gettone dei moduli del pannello (contro i moduli mandati da altri siti).
 * Serve quando il browser non manda Sec-Fetch-Site: succede aprendo il pannello in http, come
 * http://umbrel.local:9170 (il browser manda quelle intestazioni solo su https e localhost).
 * Il gettone è un'impronta segreta che cambia ogni 12 ore: un altro sito non può leggerlo
 * dalle pagine del pannello, quindi non può mettere insieme un modulo valido.
 */
function csrfFor(secret, slot) { return crypto.createHmac('sha256', secret).update(`csrf:${slot}`).digest('hex').slice(0, 32); }
const csrfSlot = () => Math.floor(Date.now() / (12 * 3600 * 1000));
const csrfToken = (secret) => csrfFor(secret, csrfSlot());
function csrfValid(secret, tok) {
  if (typeof tok !== 'string' || !/^[0-9a-f]{32}$/.test(tok)) return false;
  return [csrfSlot(), csrfSlot() - 1].some((s) => crypto.timingSafeEqual(Buffer.from(csrfFor(secret, s)), Buffer.from(tok)));
}
// moduli del pannello: mai da un altro sito; dallo stesso sito o con il gettone giusto
function adminFormOk(req, secret, tok) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  return csrfValid(secret, tok);
}

module.exports = {
  csrfToken, csrfValid, adminFormOk,
  isPrivateIp, clientIp, adminIp, netKey, visitorKey, rateLimit, overLimit, addHit, hashPassword, checkPassword,
  SESSION_MS, newSession, sessionOf, endSession, endOtherSessions, sessionCookie, isHttps, umbrelProxyCheck, sameOrigin,
};
