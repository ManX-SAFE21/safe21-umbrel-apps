'use strict';
/*
 * Pagine per i clienti (server PUBBLICO, raggiungibile solo dal tunnel Cloudflare).
 *  /            modulo «Apri un ticket»          POST /apri      -> conferma con numero e link
 *  /t/<codice>  pagina privata del ticket        POST .../rispondi, POST .../chiudi
 *  /link        «Ho perso il link»               POST /link      -> link nuovi via email
 *  /privacy     informativa
 * Regole: aprire una pagina non cambia mai niente (i programmi delle email aprono i link da soli);
 * tutto il testo dei clienti è mostrato come testo (esc); le email contengono solo il link.
 */
const crypto = require('node:crypto');
const G = require('./guard.js');
const W = require('./web.js');
const { ticketNumber } = require('./db.js');

const { esc, send, sendText, redirect, readForm, field, page, icon, msg } = W;

// argomenti: li sceglie il gestore nelle impostazioni (lib/rules.js, topicsOf)
const { EMAIL_RE, topicsOf } = require('./rules.js'); // EMAIL_RE: solo caratteri semplici, l'indirizzo va nelle intestazioni dell'email
const MAX_BODY = 5000;
const MAX_MESSAGES = 200; // per ticket: oltre, il cliente apre un ticket nuovo (niente disco riempito)
const KEEP_DAYS = 30; // giorni dopo la chiusura, poi il ticket si cancella (D3)
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// pulsante «Copia il link»: l'unico script dell'app, permesso solo dalla sua impronta (CSP)
const COPY_JS = "document.getElementById('copy').addEventListener('click',function(){var i=document.getElementById('link'),s=this.querySelector('span');i.select();function ok(){s.textContent='Copiato'}if(navigator.clipboard){navigator.clipboard.writeText(i.value).then(ok,function(){document.execCommand('copy');ok()})}else{document.execCommand('copy');ok()}});";
const COPY_CSP = `${W.SEC_HEADERS['Content-Security-Policy']}; script-src 'sha256-${crypto.createHash('sha256').update(COPY_JS).digest('base64')}'`;

const fmtDate = (iso) => new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'long', year: 'numeric' });

module.exports = function makePublic({ store, minFormMs = 3000, publicUrl = '', notifyOwner = () => {} }) {
  const { getSetting } = store;
  const base = () => (getSetting('public_url') || publicUrl || 'https://ticket.safe21.io').replace(/\/+$/, '');
  const linkOf = (token) => `${base()}/t/${token}`;

  /* ---------- modulo firmato col tempo: blocca i robot che inviano subito o riusano moduli vecchi ---------- */
  // la firma comprende il tipo di modulo: un ts preso dal modulo «link perso» non vale per aprire ticket
  const sign = (v, form) => crypto.createHmac('sha256', store.secret).update(`ts:${form}:${v}`).digest('hex').slice(0, 32);
  const timeToken = (form) => { const t = Date.now(); return `${t}.${sign(t, form)}`; };
  function formCheck(f, form) {
    if (f.get('website')) return 'Invio non valido. Riprova.';
    const [t, s] = String(f.get('ts') || '').split('.');
    if (!/^\d{13}$/.test(t || '') || !/^[0-9a-f]{32}$/.test(s || '')
      || !crypto.timingSafeEqual(Buffer.from(sign(t, form)), Buffer.from(s))) return 'Il modulo è scaduto: ricarica la pagina e riprova.';
    const age = Date.now() - Number(t);
    if (!(age >= 0) || age > DAY) return 'Il modulo è scaduto: ricarica la pagina e riprova.';
    if (age < minFormMs) return 'Invio troppo veloce. Aspetta un attimo e riprova.';
    return '';
  }
  const hidden = (form) => `<input type="hidden" name="ts" value="${timeToken(form)}">
    <div class="hp" aria-hidden="true"><label>Lascia vuoto questo campo<input name="website" tabindex="-1" autocomplete="off"></label></div>`;
  const stopBox = '<div class="stop"><b>Non scrivere mai</b> seed (parole di recupero), password o chiavi private. Non serve dirci quanto possiedi.</div>';

  /* ---------- pagine ---------- */
  function homePage(v = {}, err = '') {
    // il valore di ogni scelta è il nome stesso: se il gestore cambia l'ordine mentre il modulo è aperto, l'argomento resta giusto
    const opts = topicsOf(getSetting).map((l) => `<option value="${esc(l)}"${v.topic === l ? ' selected' : ''}>${esc(l)}</option>`).join('');
    return page('Apri un ticket', `<h1>Apri un ticket</h1>
      <p class="sub">Scrivici qui. Il tuo messaggio resta sul server di SAFE21: non passa per una casella di posta.</p>
      ${err ? msg('err', esc(err)) : ''}
      <form method="post" action="/apri" class="card">
        <div class="row2">
          <div><label for="name">Nome</label><input id="name" name="name" required maxlength="80" autocomplete="given-name" value="${esc(v.name)}"></div>
          <div><label for="email">Email (solo per gli avvisi)</label><input id="email" name="email" type="email" required maxlength="200" autocomplete="email" value="${esc(v.email)}"></div>
        </div>
        <label for="topic">Argomento</label>
        <select id="topic" name="topic" required><option value="">Scegli…</option>${opts}</select>
        <label for="body">Messaggio</label>
        <textarea id="body" name="body" required minlength="10" maxlength="${MAX_BODY}">${esc(v.body)}</textarea>
        ${hidden('apri')}
        ${stopBox}
        <div class="btns"><button>${icon('send')}Invia</button></div>
        <p class="note">Ti mandiamo un'email con il link al tuo ticket. L'email non contiene il testo dei messaggi.
          Nome ed email servono solo per questo ticket, che viene cancellato ${KEEP_DAYS} giorni dopo la chiusura.
          <a href="/privacy">Privacy dello sportello</a></p>
      </form>
      <p class="note">Hai già un ticket ma hai perso il link? <a href="/link">Ricevilo di nuovo</a></p>`);
  }

  function confirmPage(t, token) {
    const link = linkOf(token);
    return page('Ticket aperto', `<h1>Ticket aperto</h1>
      <div class="num">${ticketNumber(t.number)}</div>
      <p class="sub">Ti abbiamo mandato un'email con il link. Puoi anche salvarlo adesso: è la chiave del tuo ticket, non condividerlo.</p>
      ${msg('warn', "Non trovi l'email? Guarda anche nella cartella <b>Spam</b> o <b>Promozioni</b>.")}
      <input id="link" class="linkbox" readonly value="${esc(link)}" aria-label="Link privato del ticket">
      <div class="btns">
        <a class="btn" href="/t/${esc(token)}">${icon('ticket')}Apri il tuo ticket</a>
        <button type="button" id="copy" class="ghost">${icon('copy')}<span>Copia il link</span></button>
      </div>
      <p class="note">Di solito rispondiamo entro un giorno lavorativo. Quando rispondiamo ti arriva un avviso via email.</p>
      <script>${COPY_JS}</script>`);
  }

  const STATUS = {
    open: ['p-open', 'Aperto: tocca a noi'],
    waiting: ['p-waiting', 'Ti abbiamo risposto'],
    closed: ['p-closed', 'Chiuso'],
  };
  function ticketPage(t, token, { ok = false, err = '', body = '' } = {}) {
    const [cls, label] = STATUS[t.status];
    const thread = store.messagesOf(t.id).map((m) => {
      const us = m.author === 'staff';
      return `<div class="m${us ? ' us' : ''}"><div class="who"><b>${us ? 'SAFE21' : 'Tu'}</b> · ${fmtDate(m.created_at)}</div><div class="txt">${esc(m.body)}</div></div>`;
    }).join('');
    const closed = t.status === 'closed';
    const until = closed && t.closed_at ? fmtDay(new Date(Date.parse(t.closed_at) + KEEP_DAYS * DAY).toISOString()) : '';
    const action = `/t/${esc(token)}`;
    return page(`Ticket ${ticketNumber(t.number)}`, `<h1>Ticket ${ticketNumber(t.number)}</h1>
      <div class="meta"><span class="pill ${cls}">${label}</span><span>${esc(t.topic)}</span><span>Aperto il ${fmtDate(t.created_at)}</span></div>
      ${ok ? msg('ok', 'Messaggio inviato. Ti avvisiamo via email quando rispondiamo.') : ''}
      ${closed ? msg('warn', `Questo ticket è chiuso. Verrà cancellato ${KEEP_DAYS} giorni dopo la chiusura${until ? ` (il ${until})` : ''}. Se ti serve ancora, scrivi qui sotto e si riapre.`) : ''}
      <div class="thread">${thread}</div>
      ${closed ? '' : `<form method="post" action="${action}/chiudi" class="solved">
        <div><b>${icon('checkc')}Il problema è risolto?</b><span>Se la risposta ti basta, chiudi il ticket. Potrai sempre riaprirlo scrivendo.</span></div>
        <button>${icon('checkc')}Sì, è risolto: chiudi il ticket</button>
      </form>`}
      ${err ? msg('err', esc(err)) : ''}
      <form method="post" action="${action}/rispondi" class="card">
        <label for="body">${closed ? 'Scrivi per riaprire il ticket' : 'La tua risposta'}</label>
        <textarea id="body" name="body" required maxlength="${MAX_BODY}">${esc(body)}</textarea>
        ${hidden('rispondi')}
        ${stopBox}
        <div class="btns"><button>${icon('send')}Invia</button></div>
      </form>
      <p class="note">Questo link è la chiave del tuo ticket: non condividerlo.</p>`);
  }

  const notFound = () => page('Ticket non trovato', `<h1>Ticket non trovato</h1>
    <p class="sub">Il link non è giusto oppure il ticket è stato cancellato (i ticket chiusi si cancellano ${KEEP_DAYS} giorni dopo la chiusura).</p>
    <div class="btns"><a class="btn" href="/link">${icon('mail')}Ricevi di nuovo i link</a><a class="btn ghost" href="/">Apri un nuovo ticket</a></div>`);

  function linkPage(err = '', email = '') {
    return page('Ho perso il link', `<h1>Ho perso il link</h1>
      <p class="sub">Scrivi l'email che hai usato. Se hai ticket aperti, ti rimandiamo il link di ognuno.</p>
      ${err ? msg('err', esc(err)) : ''}
      <form method="post" action="/link" class="card">
        <label for="email">Email</label><input id="email" name="email" type="email" required maxlength="200" autocomplete="email" value="${esc(email)}">
        ${hidden('link')}
        <div class="btns"><button>${icon('mail')}Mandami i link</button></div>
      </form>`);
  }
  // risposta sempre uguale: non deve far capire se un indirizzo ha ticket oppure no
  const linkSentPage = () => page('Controlla la posta', `<h1>Controlla la posta</h1>
    <p class="sub">Se ci sono ticket aperti con questa email, ti abbiamo rimandato i link. Controlla anche lo spam.</p>
    <p><a href="/">Torna allo sportello</a></p>`);

  const privacyPage = () => page('Privacy dello sportello', `<h1>Privacy dello sportello</h1>
    <h2>Chi tratta i dati</h2><p>SAFE21 (safe21.io). Contatto: <a href="mailto:info@safe21.io">info@safe21.io</a>.</p>
    <h2>Quali dati e perché</h2><p>Nome, email, argomento, messaggi e date, solo per rispondere alla tua richiesta di assistenza.
      L'email serve solo per mandarti gli avvisi con il link al ticket: gli avvisi non contengono il testo dei messaggi.
      Il tuo indirizzo IP non viene salvato: si usa solo per pochi minuti, in memoria, per fermare lo spam.</p>
    <h2>Dove stanno</h2><p>Su un server di SAFE21, non presso servizi di posta o di assistenza esterni. Il traffico passa da
      Cloudflare (che non conserva i ticket); gli avvisi email passano da Google (che vede solo il tuo indirizzo, il numero del ticket e il link).</p>
    <h2>Per quanto tempo</h2><p>Un ticket senza tue risposte per 14 giorni si chiude da solo. Ogni ticket chiuso viene cancellato
      ${KEEP_DAYS} giorni dopo la chiusura, insieme a tutti i suoi messaggi. Se scrivi prima, il ticket si riapre.
      Le copie di sicurezza fatte dall'app prima di un ripristino si cancellano da sole entro 7 giorni.</p>
    <h2>I tuoi diritti</h2><p>Puoi chiedere in qualsiasi momento di vedere, correggere o cancellare i tuoi dati: scrivi nel ticket
      oppure a <a href="mailto:info@safe21.io">info@safe21.io</a>.</p>`);

  /* ---------- richieste ---------- */
  return async function handlePublic(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/health') return sendText(res, 200, 'ok');
    if (req.method === 'GET' && (W.serveFont(res, p) || W.serveIcon(res, p))) return;
    if (req.method === 'POST' && !G.sameOrigin(req)) return sendText(res, 403, 'Origine non consentita');
    const ip = G.visitorKey(req); // indirizzo IPv4, o blocco /64 se IPv6

    if (p === '/' && req.method === 'GET') return send(res, 200, homePage());
    if (p === '/privacy' && req.method === 'GET') return send(res, 200, privacyPage());

    if (p === '/apri' && req.method === 'POST') {
      const f = await readForm(req);
      // si legge un carattere in più del massimo: un testo troppo lungo si rifiuta, non si taglia
      const v = { name: field(f, 'name', 81), email: field(f, 'email', 201), topic: f.get('topic') || '', body: field(f, 'body', MAX_BODY + 1) };
      const bad = formCheck(f, 'apri')
        || (!v.name ? 'Scrivi il tuo nome.' : '')
        || (v.name.length > 80 ? 'Il nome è troppo lungo (massimo 80 caratteri).' : '')
        || (v.email.length > 200 || !EMAIL_RE.test(v.email) ? "Controlla l'indirizzo email." : '')
        || (!topicsOf(getSetting).includes(v.topic) ? "Scegli l'argomento." : '')
        || (v.body.length < 10 ? 'Il messaggio è troppo corto.' : '')
        || (v.body.length > MAX_BODY ? `Il messaggio è troppo lungo (massimo ${MAX_BODY} caratteri).` : '');
      if (bad) return send(res, 400, homePage(v, bad));
      if (!G.rateLimit('open:ip:' + ip, 5, HOUR) || !G.rateLimit('open:mail:' + v.email.toLowerCase(), 3, DAY)) {
        return send(res, 429, homePage(v, 'Hai già aperto diversi ticket. Aspetta una risposta, oppure riprova più tardi.'));
      }
      // al massimo 3 ticket aperti per indirizzo: prima si chiudono quelli vecchi
      if (store.activeTicketsOf(v.email).length >= 3) {
        return send(res, 429, homePage(v, 'Con questa email ci sono già 3 ticket aperti. Rispondi da quelli, oppure chiudine uno.'));
      }
      if (!G.rateLimit('open:all', 200, DAY)) {
        console.error('sportello: raggiunto il tetto giornaliero di ticket nuovi');
        return send(res, 429, homePage(v, 'Lo sportello oggi ha ricevuto troppe richieste. Riprova domani.'));
      }
      const { ticket, token } = store.createTicket({ name: v.name, email: v.email, topic: v.topic, body: v.body });
      // un solo avviso «ticket aperto» al giorno per indirizzo: chi apre ticket con l'email di un altro
      // non può riempirgli la casella (il link resta comunque sulla pagina di conferma)
      if (G.rateLimit('mail:opened:' + v.email.toLowerCase(), 1, DAY)) store.queueMail(ticket.id, v.email, 'opened', linkOf(token));
      notifyOwner(`\u{1F4E9} Nuovo ticket ${ticketNumber(ticket.number)} — ${v.topic}`);
      return send(res, 200, confirmPage(ticket, token), { 'Content-Security-Policy': COPY_CSP });
    }

    if (p === '/link') {
      if (req.method !== 'POST') return send(res, 200, linkPage());
      const f = await readForm(req);
      const email = field(f, 'email', 201);
      const bad = formCheck(f, 'link') || (email.length > 200 || !EMAIL_RE.test(email) ? "Controlla l'indirizzo email." : '');
      if (bad) return send(res, 400, linkPage(bad, email));
      if (!G.rateLimit('link:ip:' + ip, 5, HOUR)) return send(res, 429, linkPage('Troppe richieste. Riprova tra un\'ora.', email));
      // prima la risposta, sempre uguale; il lavoro sul database dopo, così nemmeno il tempo di
      // risposta fa capire se l'indirizzo ha dei ticket
      send(res, 200, linkSentPage());
      if (G.rateLimit('link:mail:' + email.toLowerCase(), 3, DAY)) {
        setImmediate(() => {
          try {
            for (const t of store.activeTicketsOf(email)) {
              // si contano le email, non le richieste: al massimo 3 «ecco il tuo link» al giorno per indirizzo
              if (!G.rateLimit('mail:lost:' + email.toLowerCase(), 3, DAY)) break;
              store.queueMail(t.id, t.email, 'lost_link', linkOf(store.tokenOf(t.id)));
            }
          } catch (e) { console.error('link perso:', e); }
        });
      }
      return;
    }

    const m = /^\/t\/([^/]+)(\/rispondi|\/chiudi)?$/.exec(p);
    if (m) {
      // troppi link sbagliati dallo stesso indirizzo: stop anche per quelli giusti (niente tentativi a raffica)
      if (G.overLimit('tbad:' + ip, 30, HOUR)) return send(res, 429, page('Troppi tentativi', '<h1>Troppi tentativi</h1><p class="sub">Riprova tra un\'ora.</p>'));
      const token = m[1];
      const t = store.ticketByToken(token);
      if (!t) { G.addHit('tbad:' + ip); return send(res, 404, notFound()); }
      const sub = m[2] || '';

      if (!sub && req.method === 'GET') return send(res, 200, ticketPage(t, token, { ok: url.searchParams.get('ok') === '1' }));

      if (sub === '/rispondi' && req.method === 'POST') {
        const f = await readForm(req);
        const body = field(f, 'body', MAX_BODY + 1);
        const bad = formCheck(f, 'rispondi') || (!body ? 'Scrivi il messaggio.' : '') || (body.length > MAX_BODY ? `Il messaggio è troppo lungo (massimo ${MAX_BODY} caratteri).` : '');
        if (bad) return send(res, 400, ticketPage(t, token, { err: bad, body }));
        if (!G.rateLimit('reply:ip:' + ip, 20, HOUR)) return send(res, 429, ticketPage(t, token, { err: 'Troppi messaggi in poco tempo. Riprova più tardi.', body }));
        if (store.messageCount(t.id) >= MAX_MESSAGES) return send(res, 400, ticketPage(t, token, { err: 'Questo ticket ha già troppi messaggi: per continuare apri un ticket nuovo.', body }));
        store.tx(() => {
          store.setStatus(t.id, 'open'); // una risposta del cliente riapre il ticket ed è di nuovo «da rispondere»
          store.addMessage(t.id, 'customer', body);
        });
        // avviso a te: al massimo uno ogni 10 minuti per ticket e 30 all'ora in tutto (niente raffiche su Telegram)
        if (G.rateLimit('notify:t:' + t.id, 1, 600000) && G.rateLimit('notify:reply', 30, HOUR)) {
          notifyOwner(`\u{1F4AC} Nuova risposta del cliente su ${ticketNumber(t.number)} — ${t.topic}`);
        }
        return redirect(res, `/t/${token}?ok=1`);
      }

      if (sub === '/chiudi' && req.method === 'POST') {
        if (t.status !== 'closed') store.setStatus(t.id, 'closed');
        return redirect(res, `/t/${token}`);
      }
    }

    return send(res, 404, page('Non trovato', '<h1>Pagina non trovata</h1><p><a href="/">Torna allo sportello</a></p>'));
  };
};
