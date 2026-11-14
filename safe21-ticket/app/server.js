'use strict';
/*
 * Sportello ticket SAFE21 - app self-hosted per Umbrel, zero dipendenze (solo Node >= 22.13).
 *  - Server PUBBLICO (PUBLIC_PORT, default 3000): pagine per i clienti. Solo per il tunnel Cloudflare.
 *  - Server PANNELLO (ADMIN_PORT,  default 3001): pannello del proprietario. Dall'icona di Umbrel
 *    (login di Umbrel) o, da fuori casa, con la password dell'app dietro Cloudflare Access.
 * Il server pubblico non conosce nessun indirizzo del pannello: le due parti non si toccano.
 */
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { openDb } = require('./lib/db.js');
const G = require('./lib/guard.js');
const W = require('./lib/web.js');

const VERSION = '0.5.2';
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 3000);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3001);
const DATA_DIR = process.env.DATA_DIR || '/data';
const TRUSTED_PROXY_HOST = process.env.TRUSTED_PROXY_HOST || '';

const store = openDb(DATA_DIR);
const { getSetting, setSetting } = store;
const { esc, send, sendText, redirect, readForm, page, icon, msg } = W;

/* ---------- avvisi: coda email, Telegram, pulizia di Gmail (lib/mailer.js) ---------- */
const mailer = require('./lib/mailer.js')({
  store, publicUrl: process.env.PUBLIC_URL || '', intervalMs: Number(process.env.MAIL_INTERVAL_MS || 30000),
});
// ogni avviso messo in coda parte subito (se la posta è configurata), senza aspettare il giro della coda
const queueMail = store.queueMail;
store.queueMail = (...a) => { queueMail(...a); mailer.kick(); };

/* ---------- automatismi: chiusura dopo N giorni, cancellazione 30 giorni dopo (lib/jobs.js) ---------- */
const jobs = require('./lib/jobs.js')({
  store, publicUrl: process.env.PUBLIC_URL || '', intervalMs: Number(process.env.JOBS_INTERVAL_MS || 3600000),
});

/* ---------- pagine pubbliche (lib/public.js) ---------- */
const handlePublic = require('./lib/public.js')({
  store, notifyOwner: mailer.notifyOwner,
  minFormMs: Number(process.env.MIN_FORM_MS || 3000),
  publicUrl: process.env.PUBLIC_URL || '',
});

/* ---------- pannello (accesso qui, pagine in lib/panel.js) ---------- */
const panelRoutes = require('./lib/panel.js')({
  store, mailer, jobs, publicUrl: process.env.PUBLIC_URL || '', dataDir: DATA_DIR, isUmbrel: () => !!adminCtx.getStore()?.umbrel,
});
const MIN_PW = 12;
W.setAdminToken(() => G.csrfToken(store.secret));
const fromUmbrel = G.umbrelProxyCheck(TRUSTED_PROXY_HOST);
const adminCtx = new AsyncLocalStorage();

function loginPage(err = '') {
  if (!getSetting('admin_hash')) {
    // la prima password si sceglie solo dall'icona di Umbrel: da internet nessuno può impostarla
    return page('Accesso', `<h1>Pannello non ancora attivo</h1>
      <p class="sub">La password del pannello non è ancora stata scelta. Aprila dall'icona dell'app su Umbrel, poi da lì scegli la password.</p>`, { admin: true });
  }
  return page('Accesso', `<h1>Accesso al pannello</h1>
    ${err ? msg('err', esc(err)) : ''}
    <form method="post" action="/login" class="card">
      <label for="pw">Password</label><input type="password" id="pw" name="pw" required autofocus autocomplete="current-password">
      <p style="margin-top:16px"><button>${icon('lock')}Entra</button></p></form>`, { admin: true });
}

function passwordPage(err = '', ok = '') {
  const has = !!getSetting('admin_hash');
  return page('Password', `<h1>${has ? 'Cambia la password' : 'Scegli la password del pannello'}</h1>
    <p class="sub">Serve per entrare nel pannello da fuori casa. Dall'icona di Umbrel non viene chiesta. Almeno ${MIN_PW} caratteri.</p>
    ${err ? msg('err', esc(err)) : ''}${ok ? msg('ok', esc(ok)) : ''}
    <form method="post" action="/password" class="card">
      ${has && !adminCtx.getStore()?.umbrel ? '<label for="old">Password attuale</label><input type="password" id="old" name="old" required autocomplete="current-password">' : ''}
      <label for="pw">Nuova password</label><input type="password" id="pw" name="pw" required minlength="${MIN_PW}" autocomplete="new-password">
      <label for="pw2">Ripeti la password</label><input type="password" id="pw2" name="pw2" required minlength="${MIN_PW}" autocomplete="new-password">
      <p style="margin-top:16px"><button>${icon('lock')}Salva</button> <a class="btn ghost" href="/">Annulla</a></p></form>`, { admin: true });
}

async function handleAdmin(req, res) {
  const umbrel = await fromUmbrel(req);
  return adminCtx.run({ umbrel }, () => adminRoutes(req, res, umbrel));
}

async function adminRoutes(req, res, umbrel) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'POST' && !G.adminFormOk(req, store.secret, url.searchParams.get('csrf'))) return sendText(res, 403, 'Origine non consentita');
  if (p === '/health') return sendText(res, 200, 'ok');
  if (req.method === 'GET' && (W.serveFont(res, p) || W.serveIcon(res, p))) return;

  if (umbrel && (p === '/login' || p === '/logout')) return redirect(res, '/'); // dall'icona di Umbrel si è già dentro
  if (p === '/login') {
    if (req.method !== 'POST') return send(res, 200, loginPage());
    const stored = getSetting('admin_hash');
    if (!stored) return send(res, 403, loginPage());
    const ip = G.netKey(G.adminIp(req));
    const f = await readForm(req);
    if (!G.rateLimit('login:' + ip, 5, 600000)) return send(res, 429, loginPage('Troppi tentativi. Riprova tra 10 minuti.'));
    if (!(await G.checkPassword(f.get('pw') || '', stored))) return send(res, 401, loginPage('Password errata.'));
    return redirect(res, '/', { 'Set-Cookie': G.sessionCookie(G.newSession(), G.SESSION_MS / 1000, req) });
  }

  const sid = umbrel ? 'umbrel' : G.sessionOf(req);
  if (!sid) return redirect(res, '/login');
  if (p === '/logout' && req.method === 'POST') { G.endSession(sid); return redirect(res, '/login', { 'Set-Cookie': G.sessionCookie('', 0, req) }); }

  if ((await panelRoutes(req, res, url)) !== false) return; // false = pagina che il pannello non conosce

  if (p === '/password') {
    if (req.method !== 'POST') return send(res, 200, passwordPage());
    const f = await readForm(req);
    const pw = f.get('pw') || '';
    // da fuori casa serve anche la password attuale: una sessione rubata non basta a cambiarla
    if (!umbrel) {
      if (!G.rateLimit('login:' + G.netKey(G.adminIp(req)), 5, 600000)) return send(res, 429, passwordPage('Troppi tentativi. Riprova tra 10 minuti.'));
      if (!(await G.checkPassword(f.get('old') || '', getSetting('admin_hash')))) return send(res, 401, passwordPage('La password attuale non è giusta.'));
    }
    if (pw.length < MIN_PW) return send(res, 400, passwordPage(`La password deve avere almeno ${MIN_PW} caratteri.`));
    if (pw !== f.get('pw2')) return send(res, 400, passwordPage('Le due password non coincidono.'));
    setSetting('admin_hash', G.hashPassword(pw));
    G.endOtherSessions(sid);
    return send(res, 200, passwordPage('', 'Password salvata. Le altre sessioni aperte sono state chiuse.'));
  }

  return send(res, 404, page('Non trovato', '<h1>Pagina non trovata</h1><p><a href="/">Torna al pannello</a></p>', { admin: true }));
}

/* ---------- avvio ---------- */
function wrap(handler) {
  return (req, res) => {
    handler(req, res).catch((e) => {
      if (e.status !== 413) console.error(e);
      if (!res.headersSent) send(res, e.status || 500, page('Errore', e.status === 413 ? '<h1>Messaggio troppo lungo</h1>' : '<h1>Si è verificato un errore</h1><p>Riprova tra poco.</p>'));
      else res.end();
      // richiesta troppo grande mandata a pezzi, senza lunghezza dichiarata: dopo la risposta si chiude
      // il collegamento (con la lunghezza dichiarata il resto si scarta fino al tempo massimo di 20 s)
      if (e.status === 413 && !req.headers['content-length']) res.on('finish', () => req.destroy());
    });
  };
}
// ultima difesa: un errore sfuggito non deve spegnere lo sportello (pubblico e pannello sono un solo processo)
process.on('uncaughtException', (e) => console.error('errore non gestito:', e));
process.on('unhandledRejection', (e) => console.error('errore non gestito:', e));

const pub = http.createServer(wrap(handlePublic));
const adm = http.createServer(wrap(handleAdmin));
for (const s of [pub, adm]) {
  s.headersTimeout = 15000; s.requestTimeout = 20000;
  // porta già occupata o altro problema all'avvio: meglio fermarsi (Docker riavvia l'app) che restare mezzi accesi
  s.on('error', (e) => { console.error('avvio non riuscito:', e.code || e.message); process.exit(1); });
}
pub.listen(PUBLIC_PORT, '0.0.0.0', () => console.log(`Sportello ticket ${VERSION}: pubblico su :${PUBLIC_PORT}`));
adm.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`Sportello ticket ${VERSION}: pannello su :${ADMIN_PORT}`));
