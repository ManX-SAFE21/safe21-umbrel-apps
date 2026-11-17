'use strict';
/*
 * Admin panel (separate HTTP server, ADMIN_PORT). Server-rendered, no JavaScript.
 * Password chosen at the first access, and only from a local / private network connection.
 * Every form carries an HMAC token (CSRF); requests marked cross-site by the browser are refused.
 */
const W = require('./web.js');
const G = require('./guard.js');

const MIN_PW = 12;
const { esc } = W;

const num = (n) => (n === null || n === undefined ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const truncXpub = (x) => (x ? `${x.slice(0, 10)}…${x.slice(-8)}` : '');

const FLASH = {
  saved: ['ok', 'Impostazioni salvate.'],
  xpub: ['ok', 'Chiave pubblica estesa salvata: il portafoglio di sola lettura è pronto.'],
  done: ['ok', 'Fatto.'],
  checked: ['ok', 'Controllo completato.'],
  paid: ['ok', 'Pagamento simulato registrato.'],
  pw: ['ok', 'Password cambiata. Le altre sessioni sono state chiuse.'],
  bad: ['err', 'Valori non validi: nessuna modifica salvata.'],
  xpub_format: ['err', 'La chiave non è una xpub/zpub/tpub/vpub valida.'],
  xpub_checksum: ['err', 'La chiave ha un errore di battitura (somma di controllo sbagliata).'],
  xpub_type: ['err', 'Tipo di chiave non supportato: servono xpub, zpub, tpub o vpub (segwit nativo).'],
  xpub_rpc: ['err', 'Bitcoin Core non ha accettato la chiave o non risponde. Guarda il registro del server.'],
  notfound: ['err', 'Will Executor non trovato.'],
  confirm: ['err', 'Per rimuovere spunta la casella di conferma.'],
};

function createPanel({ store, registry, listing, payments, limiter, sessions, secret, now = Date.now, log = console }) {
  const token = () => G.csrfToken(secret);
  const withToken = (html) => html.replace(/(<form\b[^>]*\baction=")([^"]*)(")/g, (m, a, act, z) => `${a}${act}?csrf=${token()}${z}`);
  const fake = payments.kind === 'fake';

  function page(title, body, { nav = true } = {}) {
    return withToken(`<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Pannello Will Executor</title><link rel="stylesheet" href="/style.css"></head><body>
${fake ? '<div class="banner">ANTEPRIMA — pagamenti finti (WELIST_PAYMENT=fake)</div>' : ''}
<div class="wrap"><header><div class="mark" aria-hidden="true"></div><h1>Pannello — Lista Will Executor</h1>
${nav ? '<form method="post" action="/logout"><button type="submit" class="btn sec sm">Esci</button></form>' : ''}</header>
${body}</div></body></html>`);
  }
  const msg = (kind, text) => `<div class="${kind === 'ok' ? 'status ok' : 'err'}">${esc(text)}</div>`;

  function setupPage(error = '') {
    return page('Primo accesso', `<div class="card"><h2>Scegli la password del pannello</h2>
<p class="muted">Primo accesso: la password si sceglie solo da un collegamento della rete locale. Almeno ${MIN_PW} caratteri.</p>
${error ? msg('err', error) : ''}
<form method="post" action="/setup"><label for="pw">Nuova password</label><input type="password" id="pw" name="pw" required minlength="${MIN_PW}" autocomplete="new-password">
<label for="pw2">Ripeti la password</label><input type="password" id="pw2" name="pw2" required minlength="${MIN_PW}" autocomplete="new-password">
<p><button type="submit" class="btn">Salva</button></p></form></div>`, { nav: false });
  }
  function loginPage(error = '') {
    return page('Accesso', `<div class="card"><h2>Accesso al pannello</h2>${error ? msg('err', error) : ''}
<form method="post" action="/login"><label for="pw">Password</label><input type="password" id="pw" name="pw" required autofocus autocomplete="current-password">
<p><button type="submit" class="btn">Entra</button></p></form></div>`, { nav: false });
  }

  function rowState(r, t) {
    if (r.suspended) return '<span class="pill susp">sospeso</span>';
    const pill = `<span class="pill ${r.status}">${r.status}</span>`;
    if (r.listed_until > t) return pill + ' <span class="muted">in lista</span>';
    if (r.listed_until === 0) return pill + ' <span class="muted">attende pagamento</span>';
    return pill + ' <span class="muted">scaduto</span>';
  }

  function dashboard(flash) {
    const s = store.settings();
    const t = now();
    const rows = store.all();
    const f = FLASH[flash];
    const body = rows.map((r) => {
      const daysLeft = r.listed_until ? Math.round((r.listed_until - t) / 86400000) : null;
      const exp = r.listed_until ? `${fmtDate(r.listed_until)} (${daysLeft} giorni)` : '—';
      return `<tr>
<td class="addr" data-l="Indirizzo">${esc(r.url)}${r.seed ? ' <span class="muted">(esempio)</span>' : ''}</td>
<td data-l="Rete"><span class="net">${esc(r.chain)}</span></td>
<td data-l="Pagato">${r.paid_total ? num(r.paid_total) + ' sats' : '—'}</td>
<td data-l="Credito">${num(r.credit)} sats</td>
<td data-l="Scadenza">${daysLeft !== null && daysLeft < 15 && daysLeft >= 0 ? `<span class="low">${exp}</span>` : exp}</td>
<td data-l="Stato">${rowState(r, t)}</td>
<td data-l="Ultimo controllo">${fmtTime(r.last_check)}${r.fails ? ` <span class="muted">(${r.fails} errori)</span>` : ''}</td>
<td class="acts"><div class="actions">
<form method="post" action="/action"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="op" value="${r.suspended ? 'restore' : 'suspend'}"><button type="submit" class="btn sec sm">${r.suspended ? 'Ripristina' : 'Sospendi'}</button></form>
<form method="post" action="/action"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="op" value="remove"><label class="inline"><input type="checkbox" name="confirm" value="1" required> conferma</label> <button type="submit" class="btn sec sm danger">Rimuovi</button></form>
${fake && r.pay_address ? `<form method="post" action="/simulate"><input type="hidden" name="id" value="${r.id}"><input type="number" name="sats" class="sm" min="1" max="2100000000000000" value="${s.price[r.chain] || 1000}" aria-label="sats"> <button type="submit" class="btn sec sm">Simula pagamento</button></form>` : ''}
</div>${r.pay_address ? `<div class="muted mono small">${esc(r.pay_address)}</div>` : ''}</td></tr>`;
    }).join('');
    return page('Pannello', `${f ? msg(f[0], f[1]) : ''}
<div class="card"><h2>Impostazioni</h2>
<form method="post" action="/settings">
<div class="grid2">
<div><label for="pb">Prezzo iscrizione bitcoin (sats)</label><input type="number" id="pb" name="price_bitcoin" min="0" max="2100000000000000" required value="${s.price.bitcoin}"></div>
<div><label for="pt">Prezzo iscrizione testnet4 (sats, 0 = gratis)</label><input type="number" id="pt" name="price_testnet4" min="0" max="2100000000000000" required value="${s.price.testnet4}"></div>
<div><label for="dur">Durata (mesi)</label><input type="number" id="dur" name="period_months" min="1" max="120" required value="${s.period_months}"></div>
<div><label for="mc">Conferme minime</label><input type="number" id="mc" name="min_conf" min="1" max="100" required value="${s.min_conf}"></div>
<div><label for="ci">Intervallo controllo (minuti)</label><input type="number" id="ci" name="check_minutes" min="1" max="1440" required value="${s.check_minutes}"></div>
</div>
<p><label class="switch"><input type="checkbox" name="free_first" value="1"${s.free_first ? ' checked' : ''}> <span>Primo periodo gratuito</span></label></p>
<button type="submit" class="btn">Salva impostazioni</button></form></div>

<div class="card"><h2>Chiave pubblica estesa (xpub)</h2>
${s.xpub ? `<div class="addrbox"><code>${esc(truncXpub(s.xpub))}</code></div>` : '<p class="err">Nessuna xpub: le iscrizioni a pagamento non possono ricevere un indirizzo.</p>'}
<p class="muted">Il server vede gli incassi ma non può spendere.</p>
<form method="post" action="/xpub"><label for="xp">${s.xpub ? 'Sostituisci' : 'Inserisci'} xpub / zpub (account, segwit nativo)</label>
<input type="text" id="xp" name="xpub" required maxlength="130" autocomplete="off" spellcheck="false">
<p><button type="submit" class="btn">Salva xpub</button></p></form>
<p class="muted">Pagamenti: ${fake ? '<strong>finti (anteprima)</strong>' : 'Bitcoin Core, portafoglio di sola lettura «welist»'}.</p></div>

<div class="toolbar"><h2>Will Executor (${rows.length})</h2>
<form method="post" action="/check-now"><button type="submit" class="btn sec">Controlla ora</button></form></div>
<table><thead><tr><th>Indirizzo</th><th>Rete</th><th>Pagato</th><th>Credito</th><th>Scadenza</th><th>Stato</th><th>Ultimo controllo</th><th>Azioni</th></tr></thead>
<tbody>${body || '<tr><td colspan="8" class="muted">Nessun Will Executor iscritto.</td></tr>'}</tbody></table>
<div class="card"><h2>Cambia password</h2>
<form method="post" action="/password"><div class="grid2">
<div><label for="old">Password attuale</label><input type="password" id="old" name="old" required autocomplete="current-password"></div><div></div>
<div><label for="np">Nuova password</label><input type="password" id="np" name="pw" required minlength="${MIN_PW}" autocomplete="new-password"></div>
<div><label for="np2">Ripeti</label><input type="password" id="np2" name="pw2" required minlength="${MIN_PW}" autocomplete="new-password"></div></div>
<p><button type="submit" class="btn sec">Cambia password</button></p></form></div>
<p class="muted small">Impronta della chiave che firma l'elenco: <code>${esc(listing.fingerprint)}</code></p>`);
  }

  const intIn = (f, k, min, max) => {
    const v = f.get(k);
    if (v === null || !/^\d{1,16}$/.test(v)) return null;
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
  };
  const ipKey = (req) => G.netKey(String(req.socket.remoteAddress || ''));
  const go = (res, flash) => W.redirect(res, '/?m=' + flash);
  const html = (res, status, h) => W.sendHtml(res, status, h, W.CSP_ADMIN);

  return async function handleAdmin(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const isPost = req.method === 'POST';
    if (req.method === 'GET' && p === '/health') return W.sendText(res, 200, 'ok');
    if (req.method === 'GET' && p === '/style.css') return W.serveStatic(res, p);
    if (isPost && !G.adminFormOk(req, secret, url.searchParams.get('csrf'))) { req.resume(); return W.sendText(res, 403, 'Forbidden'); }
    if (!isPost && req.method !== 'GET') return W.sendText(res, 405, 'Method not allowed');

    const hash = store.getSetting('admin_hash');
    if (!hash) {
      if (!G.fromPrivateNet(req)) { req.resume(); return html(res, 403, page('Pannello non attivo', '<div class="card"><h2>Pannello non ancora attivo</h2><p>La prima password si sceglie solo dalla rete locale.</p></div>', { nav: false })); }
      if (p !== '/setup') return W.redirect(res, '/setup');
      if (!isPost) return html(res, 200, setupPage());
      const f = await W.readForm(req);
      const pw = f.get('pw') || '';
      if (pw.length < MIN_PW) return html(res, 400, setupPage(`La password deve avere almeno ${MIN_PW} caratteri.`));
      if (pw !== f.get('pw2')) return html(res, 400, setupPage('Le due password non coincidono.'));
      store.setSetting('admin_hash', G.hashPassword(pw));
      return W.redirect(res, '/', { 'Set-Cookie': G.sessionCookie(sessions.create(), G.SESSION_MS / 1000, false) });
    }
    if (p === '/setup') return W.redirect(res, '/');

    if (p === '/login') {
      if (!isPost) return html(res, 200, loginPage());
      const f = await W.readForm(req);
      if (!limiter.hit('login:' + ipKey(req), 5, 600000)) return html(res, 429, loginPage('Troppi tentativi. Riprova tra 10 minuti.'));
      if (!(await G.checkPassword(f.get('pw') || '', hash))) return html(res, 401, loginPage('Password errata.'));
      return W.redirect(res, '/', { 'Set-Cookie': G.sessionCookie(sessions.create(), G.SESSION_MS / 1000, false) });
    }

    const sid = sessions.of(req);
    if (!sid) { if (isPost) req.resume(); return W.redirect(res, '/login'); }

    if (!isPost) {
      if (p === '/') return html(res, 200, dashboard(url.searchParams.get('m')));
      return W.sendText(res, 404, 'Not found');
    }

    const f = await W.readForm(req);
    switch (p) {
      case '/logout':
        sessions.end(sid);
        return W.redirect(res, '/login', { 'Set-Cookie': G.sessionCookie('', 0, false) });
      case '/settings': {
        const v = {
          price_bitcoin: intIn(f, 'price_bitcoin', 0, 21e14), price_testnet4: intIn(f, 'price_testnet4', 0, 21e14),
          period_months: intIn(f, 'period_months', 1, 120), min_conf: intIn(f, 'min_conf', 1, 100), check_minutes: intIn(f, 'check_minutes', 1, 1440),
        };
        if (Object.values(v).some((x) => x === null)) return go(res, 'bad');
        store.tx(() => {
          for (const [k, x] of Object.entries(v)) store.setSetting(k, x);
          store.setSetting('free_first', f.get('free_first') === '1' ? '1' : '0');
        });
        listing.publish();
        return go(res, 'saved');
      }
      case '/xpub': {
        try {
          const xpub = await payments.setXpub(f.get('xpub') || '');
          store.setSetting('xpub', xpub);
          return go(res, 'xpub');
        } catch (e) {
          log.error('xpub not saved:', e.message);
          return go(res, FLASH[e.code] ? e.code : 'xpub_rpc');
        }
      }
      case '/action': {
        const id = intIn(f, 'id', 1, Number.MAX_SAFE_INTEGER);
        const op = f.get('op');
        if (op === 'remove' && f.get('confirm') !== '1') return go(res, 'confirm');
        return go(res, id && registry.adminAction(id, op) ? 'done' : 'notfound');
      }
      case '/simulate': {
        if (!fake) return W.sendText(res, 404, 'Not found');
        const id = intIn(f, 'id', 1, Number.MAX_SAFE_INTEGER);
        const sats = intIn(f, 'sats', 1, 21e14);
        const row = id && store.byId(id);
        if (!row || !row.pay_address || !sats) return go(res, 'bad');
        store.fakeAdd(row.pay_address, sats);
        await registry.creditOne(row);
        listing.publish();
        return go(res, 'paid');
      }
      case '/check-now':
        await registry.creditAll();
        await registry.checkAll();
        return go(res, 'checked');
      case '/password': {
        if (!limiter.hit('login:' + ipKey(req), 5, 600000)) return go(res, 'bad');
        if (!(await G.checkPassword(f.get('old') || '', hash))) return go(res, 'bad');
        const pw = f.get('pw') || '';
        if (pw.length < MIN_PW || pw !== f.get('pw2')) return go(res, 'bad');
        store.setSetting('admin_hash', G.hashPassword(pw));
        sessions.endOthers(sid);
        return go(res, 'pw');
      }
      default:
        return W.sendText(res, 404, 'Not found');
    }
  };
}

module.exports = { createPanel, truncXpub };
