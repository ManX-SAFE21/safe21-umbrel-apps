'use strict';
/*
 * Pannello del proprietario (server PANNELLO), dopo l'accesso:
 *  /                    lista dei ticket (?vista=open|waiting|closed|all)
 *  /ticket/<numero>     conversazione con note interne; rispondi, nota, chiudi/riapri, nuovo link, elimina
 *  /impostazioni        posta in uscita, Telegram, indirizzo pubblico, chiusura automatica
 *  /backup, /ripristina copia di sicurezza (senza la password della posta)
 * Gli avvisi email vanno solo in coda (invio al passo 4): mai testo dei messaggi, mai nome del cliente.
 */
const fs = require('node:fs');
const path = require('node:path');
const W = require('./web.js');
const { ticketNumber } = require('./db.js');

const { esc, send, redirect, readForm, readMultipart, field, page, icon, msg } = W;

const MAX_STAFF = 10000;
const MAX_ADMIN_FORM = 256 * 1024;
const MAX_RESTORE = 10 * 1024 * 1024; // una copia vera pesa molto meno
const VIEWS = { open: 'Da rispondere', waiting: 'In attesa del cliente', closed: 'Chiusi', all: 'Tutti' };
const STATUS = {
  open: ['p-open', 'Da rispondere'],
  waiting: ['p-waiting', 'In attesa del cliente'],
  closed: ['p-closed', 'Chiuso'],
};
// regole delle impostazioni e dei segreti in lib/rules.js (le stesse valgono per il ripristino)
const { SETTINGS, SECRET_KEYS, validEmail } = require('./rules.js');
// messaggi dopo un'azione: nell'indirizzo va solo un codice, il testo è fisso (nessuno può far
// comparire nel pannello un avviso scritto da lui con un link preparato)
const FLASH = {
  saved: 'Impostazioni salvate.',
  passcleared: 'Impostazioni salvate. Hai cambiato server, utente o chat: per sicurezza reinserisci la password della posta o il token di Telegram.',
  note: 'Nota salvata.',
  reply: 'Risposta inviata. Il ticket è «in attesa del cliente».',
  closed: 'Ticket chiuso.',
  reopened: 'Ticket riaperto.',
  newlink: 'Link nuovo fatto: il vecchio non funziona più, il nuovo arriva al cliente per email.',
  deleted: 'Ticket eliminato.',
  testok: 'Email di prova mandata: controlla la casella di destinazione.',
  testfail: 'Email di prova NON partita: guarda il motivo qui sotto e controlla le impostazioni della posta.',
  retry: 'L\'avviso riparte al prossimo giro della coda.',
  removed: 'Avviso tolto dalla coda.',
  restored: 'Ripristino fatto. Reinserisci nelle impostazioni la password della posta e il token di Telegram, se servono.',
};
const KEEP_COPIES_DAYS = 7; // copie automatiche fatte prima di un ripristino: cancellate dopo 7 giorni

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' }) : '');

module.exports = function makePanel({ store, mailer, jobs, publicUrl = '', dataDir, isUmbrel = () => true }) {
  const { getSetting, setSetting } = store;
  const base = () => (getSetting('public_url') || publicUrl || 'https://ticket.safe21.io').replace(/\/+$/, '');
  const linkOf = (token) => `${base()}/t/${token}`;
  const back = (res, to, code) => redirect(res, `${to}${to.includes('?') ? '&' : '?'}m=${code}`);
  const flash = (url) => {
    const code = url.searchParams.get('m');
    const m = FLASH[code];
    return m ? msg(code === 'testfail' ? 'err' : 'ok', esc(m)) : '';
  };
  let testError = ''; // motivo dell'ultima email di prova non partita (già ripulito dalla password)

  /* ---------- avvisi email ---------- */
  const KIND = { opened: 'Ticket aperto', reply: 'Nuova risposta', closed: 'Ticket chiuso', lost_link: 'Link rimandato', new_link: 'Link nuovo' };
  const mailWaiting = () => { const n = mailer.pending().length; return n ? ` <b class="mono">${n}</b>` : ''; };
  function mailPage(url) {
    const rows = mailer.pending().map((m) => {
      const failed = m.attempts >= mailer.FAILED;
      return `<tr><td class="n">${m.number ? ticketNumber(m.number) : '—'}</td><td>${esc(KIND[m.kind] || m.kind)}</td><td>${esc(m.to_addr)}</td>
        <td>${failed ? '<span class="pill p-waiting">fermo</span>' : `in coda (tentativi: ${m.attempts})`}</td>
        <td>${esc(m.last_error || '')}</td>
        <td><div class="btns" style="margin:0">
          <form method="post" action="/avvisi/riprova"><input type="hidden" name="id" value="${m.id}"><button class="ghost">${icon('refresh')}Riprova adesso</button></form>
          <form method="post" action="/avvisi/elimina"><input type="hidden" name="id" value="${m.id}"><button class="danger">${icon('trash')}Togli</button></form>
        </div></td></tr>`;
    }).join('');
    const imapErr = getSetting('imap_last_error');
    const imapOk = getSetting('imap_last_ok');
    return page('Avvisi email', `<h1>Avvisi email</h1>${nav('mail')}${flash(url)}
      ${mailer.configured() ? '' : msg('warn', 'La posta in uscita non è configurata: gli avvisi aspettano in coda. <a href="/impostazioni">Vai alle impostazioni</a>.')}
      ${getSetting('imap_host') ? (imapErr ? msg('err', 'Pulizia di Gmail non riuscita: ' + esc(imapErr)) : (imapOk ? msg('ok', 'Ultima pulizia di Gmail: ' + fmtDate(imapOk)) : '')) : ''}
      <p class="sub">Qui compaiono solo gli avvisi che aspettano o non sono partiti. Quelli partiti spariscono subito, insieme al loro link.</p>
      ${rows ? `<table class="list"><thead><tr><th>Ticket</th><th>Avviso</th><th>A</th><th>Stato</th><th>Motivo</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">Nessun avviso in attesa.</p>'}`, { admin: true, wide: true });
  }

  const nav = (on) => `<nav class="adm-nav">
    <a class="btn${on === 'list' ? '' : ' ghost'}" href="/">${icon('list')}Ticket</a>
    <a class="btn${on === 'settings' ? '' : ' ghost'}" href="/impostazioni">${icon('settings')}Impostazioni</a>
    <a class="btn${on === 'mail' ? '' : ' ghost'}" href="/avvisi">${icon('mail')}Avvisi email${mailWaiting()}</a>
    <a class="btn${on === 'backup' ? '' : ' ghost'}" href="/copia">${icon('download')}Copia di sicurezza</a>
    ${isUmbrel() ? '' : `<form method="post" action="/logout"><button class="ghost">${icon('logout')}Esci</button></form>`}
  </nav>
  ${getSetting('admin_hash') ? '' : msg('warn', 'Non hai ancora scelto la password per entrare da fuori casa. <a href="/password">Sceglila ora</a>.')}`;

  /* ---------- lista ---------- */
  function listPage(url, extra = '') {
    const view = VIEWS[url.searchParams.get('vista')] ? url.searchParams.get('vista') : 'open';
    const c = store.counts();
    const n = { ...c, all: c.open + c.waiting + c.closed };
    const tabs = Object.entries(VIEWS).map(([k, l]) => `<a class="tab${k === view ? ' on' : ''}" href="/?vista=${k}">${l}<b>${n[k]}</b></a>`).join('');
    const rows = store.listTickets(view).map((t) => {
      const [cls, label] = STATUS[t.status];
      return `<tr><td class="n">${t.unread ? '<span class="dot" title="Messaggi nuovi"></span>' : ''}<a href="/ticket/${t.number}">${ticketNumber(t.number)}</a></td>
        <td><a href="/ticket/${t.number}">${esc(t.topic)}</a></td><td>${esc(t.name)}</td>
        <td><span class="pill ${cls}">${label}</span></td><td>${fmtDate(t.updated_at)}</td></tr>`;
    }).join('');
    let last = null;
    try { last = JSON.parse(getSetting('jobs_last', 'null')); } catch { last = null; }
    const jobsLine = last && last.at
      ? `<p class="hint">Controlli automatici: ultimo giro ${fmtDate(last.at)} · ${Number(last.closed) || 0} chiusi da soli · ${Number(last.deleted) || 0} cancellati. Chiusura dopo ${jobs.autocloseDays()} giorni senza risposta del cliente, cancellazione ${jobs.KEEP_DAYS} giorni dopo la chiusura.</p>`
      : '';
    return page('Ticket', `<h1>Sportello ticket</h1>${nav('list')}${flash(url)}${extra}${jobsLine}
      <div class="tabs">${tabs}</div>
      ${rows ? `<table class="list"><thead><tr><th>Numero</th><th>Argomento</th><th>Nome</th><th>Stato</th><th>Ultimo movimento</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="empty">Nessun ticket in «${VIEWS[view]}».</p>`}`, { admin: true, wide: true });
  }

  /* ---------- ticket ---------- */
  // date degli automatismi: quando si chiude da solo o quando verrà cancellato
  const plus = (iso, days) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t + days * 86400000).toISOString() : ''; };
  function when(t) {
    if (t.status === 'waiting') { const d = plus(t.updated_at, jobs.autocloseDays()); return d ? `<span>si chiude da solo il ${fmtDate(d)} se il cliente non risponde</span>` : ''; }
    if (t.status === 'closed') { const d = plus(t.closed_at, jobs.KEEP_DAYS); return d ? `<span>verrà cancellato il ${fmtDate(d)}</span>` : ''; }
    return '';
  }
  function ticketPage(t, url, err = '') {
    const [cls, label] = STATUS[t.status];
    const num = ticketNumber(t.number);
    const act = `/ticket/${t.number}`;
    const thread = store.messagesOf(t.id, { withNotes: true }).map((m) => {
      const who = { customer: esc(t.name), staff: 'SAFE21 (tu)', note: 'Nota interna' }[m.author];
      const c = { customer: '', staff: ' us', note: ' note' }[m.author];
      return `<div class="m${c}"><div class="who"><b>${who}</b> · ${fmtDate(m.created_at)}${m.author === 'note' ? ' · il cliente non la vede' : ''}</div><div class="txt">${esc(m.body)}</div></div>`;
    }).join('');
    const closed = t.status === 'closed';
    return page(num, `${nav('list')}
      <h1>${num}</h1>
      <div class="meta"><span class="pill ${cls}">${label}</span><span>${esc(t.topic)}</span><span>Aperto il ${fmtDate(t.created_at)}</span>${when(t)}</div>
      ${flash(url)}${err ? msg('err', esc(err)) : ''}
      <div class="split">
        <div>
          <div class="thread">${thread}</div>
          <form method="post" action="${act}/rispondi" class="card">
            <label for="body">Rispondi al cliente</label>
            <textarea id="body" name="body" required maxlength="${MAX_STAFF}"></textarea>
            <p class="hint">Il cliente riceve un'email «c'è una nuova risposta» con il link, senza il testo.</p>
            <div class="btns"><button>${icon('send')}Invia risposta</button></div>
          </form>
          <form method="post" action="${act}/nota" class="card" style="margin-top:14px">
            <label for="note">Nota interna</label>
            <textarea id="note" name="body" required maxlength="${MAX_STAFF}" style="min-height:80px"></textarea>
            <p class="hint">Solo per te: il cliente non la vede e non parte nessuna email.</p>
            <div class="btns"><button class="ghost">${icon('note')}Salva nota</button></div>
          </form>
        </div>
        <aside class="side">
          <div class="card"><h2>Cliente</h2>
            <p class="kv"><span>Nome:</span> ${esc(t.name)}</p>
            <p class="kv"><span>Email:</span> ${esc(t.email)}</p>
            <p class="kv"><span>Ultimo messaggio del cliente:</span> ${fmtDate(t.last_customer_at)}</p>
          </div>
          <div class="card"><h2>Stato</h2>
            <form method="post" action="${act}/stato" class="btns" style="margin-top:0">
              ${closed ? `<input type="hidden" name="action" value="reopen"><button class="ghost">${icon('refresh')}Riapri</button>`
    : `<input type="hidden" name="action" value="close"><button class="ghost">${icon('archive')}Chiudi il ticket</button>`}
            </form>
            ${closed ? '' : '<p class="hint">Chiudendo, il cliente riceve l\'avviso «ticket chiuso».</p>'}
          </div>
          <div class="card"><h2>Link del cliente</h2>
            <p class="hint">Se il cliente dice che il link è finito in mani sbagliate: il vecchio smette di funzionare e il nuovo gli arriva per email.</p>
            <form method="post" action="${act}/nuovo-link" class="btns"><button class="ghost">${icon('refresh')}Fai un link nuovo</button></form>
          </div>
          <div class="card"><h2>Elimina</h2>
            <form method="post" action="${act}/elimina">
              <label class="check"><input type="checkbox" name="sure" value="on" required> Sì, elimina per sempre questo ticket e i suoi messaggi</label>
              <button class="danger">${icon('trash')}Elimina ticket</button>
            </form>
          </div>
        </aside>
      </div>`, { admin: true, wide: true });
  }

  /* ---------- impostazioni ---------- */
  function settingsPage(url, err = '', typed = null) {
    const v = (k, d = '') => esc(typed && typed[k] !== undefined ? typed[k] : getSetting(k, d));
    const secret = (k, label, hint) => {
      const has = !!getSetting(k);
      return `<label for="${k}">${label}</label><input type="password" id="${k}" name="${k}" autocomplete="new-password" placeholder="${has ? 'salvata: lascia vuoto per non cambiarla' : 'non ancora inserita'}">
        <p class="hint">${hint}</p>`;
    };
    return page('Impostazioni', `<h1>Impostazioni</h1>${nav('settings')}${flash(url)}${err ? msg('err', esc(err)) : ''}
      <form method="post" action="/impostazioni">
        <div class="card"><h2>${icon('mail')}Posta in uscita</h2>
          <p class="hint">Per Gmail: server smtp.gmail.com, porta 465, utente l'indirizzo Gmail, password = password per le app.</p>
          <div class="row2">
            <div><label for="smtp_host">Server</label><input id="smtp_host" name="smtp_host" value="${v('smtp_host')}" placeholder="smtp.gmail.com"></div>
            <div><label for="smtp_port">Porta</label><input id="smtp_port" name="smtp_port" inputmode="numeric" value="${v('smtp_port')}" placeholder="465"></div>
          </div>
          <label for="smtp_user">Utente</label><input id="smtp_user" name="smtp_user" autocomplete="off" value="${v('smtp_user')}" placeholder="safe21.ticket@gmail.com">
          ${secret('smtp_pass', 'Password', 'Salvata solo su questo Umbrel. Non entra nella copia di sicurezza: dopo un ripristino va reinserita.')}
          <label for="smtp_from">Mittente</label><input id="smtp_from" name="smtp_from" value="${v('smtp_from')}" placeholder="SAFE21 Ticket &lt;safe21.ticket@gmail.com&gt;">
          <label for="imap_host">Cancella da Gmail le copie degli avvisi (server IMAP)</label>
          <input id="imap_host" name="imap_host" value="${v('imap_host')}" placeholder="imap.gmail.com">
          <p class="hint">Con imap.gmail.com, dopo ogni invio l'app toglie dalla «Posta inviata» e dal Cestino le copie degli avvisi
            (contengono i link dei clienti), e dalla Posta in arrivo le risposte che citano un link. Vuoto = pulizia spenta.</p>
        </div>
        <div class="card" style="margin-top:14px"><h2>${icon('send')}Avvisi su Telegram</h2>
          <p class="hint">Lo stesso bot dei corsi: ti arrivano solo numero e argomento, mai il testo.</p>
          ${secret('tg_token', 'Token del bot', 'Lo trovi nelle impostazioni dei corsi o da BotFather.')}
          <label for="tg_chat">Chat id</label><input id="tg_chat" name="tg_chat" value="${v('tg_chat')}">
        </div>
        <div class="card" style="margin-top:14px"><h2>${icon('settings')}Sportello</h2>
          <label for="public_url">Indirizzo pubblico</label><input id="public_url" name="public_url" value="${v('public_url')}" placeholder="https://ticket.safe21.io">
          <p class="hint">Serve per i link nelle email.</p>
          <label for="autoclose_days">Chiusura automatica dopo quanti giorni senza risposta del cliente</label>
          <input id="autoclose_days" name="autoclose_days" inputmode="numeric" value="${v('autoclose_days', '14')}">
        </div>
        <div class="btns"><button>${icon('checkc')}Salva le impostazioni</button><a class="btn ghost" href="/password">${icon('lock')}Password del pannello</a></div>
      </form>
      <form method="post" action="/prova-email" class="card" style="margin-top:14px">
        <h2>${icon('send')}Email di prova</h2>
        ${testError ? msg('err', 'Motivo: ' + esc(testError)) : ''}
        <label for="to">Manda una email di prova a</label>
        <input id="to" name="to" type="email" required maxlength="200" value="${esc(getSetting('smtp_user'))}">
        <div class="btns"><button class="ghost">${icon('send')}Manda un'email di prova</button></div>
      </form>`, { admin: true, wide: true });
  }

  /* ---------- copia di sicurezza ---------- */
  function backupPage(url, err = '') {
    const c = store.counts();
    return page('Copia di sicurezza', `<h1>Copia di sicurezza</h1>${nav('backup')}${flash(url)}${err ? msg('err', esc(err)) : ''}
      <div class="card"><h2>${icon('download')}Scarica</h2>
        <p>Un file con tutti i ticket (${c.open + c.waiting + c.closed}), i messaggi, i link dei clienti e le impostazioni.
          Non contiene la password della posta, il token di Telegram né la password del pannello.</p>
        ${msg('warn', 'Il file contiene i messaggi e i link dei clienti: chi lo ha può leggere i ticket. Tienilo poco, in un posto sicuro, e cancellalo quando non serve più.')}
        <div class="btns"><a class="btn" href="/backup">${icon('download')}Scarica copia di sicurezza</a></div>
      </div>
      <form method="post" action="/ripristina" enctype="multipart/form-data" class="card" style="margin-top:14px">
        <h2>${icon('upload')}Ripristina</h2>
        <p>Rimette i dati com'erano nel file: i ticket di adesso vengono sostituiti. Prima l'app salva da sola una copia dei dati attuali.</p>
        <label for="file">File della copia (.json)</label><input type="file" id="file" name="file" accept=".json,application/json" required>
        <label class="check"><input type="checkbox" name="sure" value="on" required> Sì, sostituisci i dati di adesso con quelli del file</label>
        <div class="btns"><button class="danger">${icon('upload')}Ripristina</button></div>
      </form>`, { admin: true, wide: true });
  }

  const copiesDir = path.join(dataDir, 'copie');
  // copie automatiche più vecchie di 7 giorni: cancellate (anche i ticket eliminati devono sparire)
  function cleanCopies() {
    let names = [];
    try { names = fs.readdirSync(copiesDir); } catch { return; }
    for (const n of names) {
      const f = path.join(copiesDir, n);
      try { if (Date.now() - fs.statSync(f).mtimeMs > KEEP_COPIES_DAYS * 86400000) fs.rmSync(f, { force: true }); } catch { /* già sparita */ }
    }
  }
  cleanCopies();
  setInterval(cleanCopies, 6 * 3600 * 1000).unref();
  function saveBeforeRestore() {
    cleanCopies();
    const dir = copiesDir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `prima-del-ripristino-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(store.exportAll()), { mode: 0o600 });
    return file;
  }

  /* ---------- richieste (l'accesso è già stato controllato) ---------- */
  return async function panelRoutes(req, res, url) {
    const p = url.pathname;
    const GET = req.method === 'GET';
    const POST = req.method === 'POST';

    if (p === '/' && GET) return send(res, 200, listPage(url));

    if (p === '/impostazioni') {
      if (GET) return send(res, 200, settingsPage(url));
      if (!POST) return false;
      const f = await readForm(req, MAX_ADMIN_FORM);
      const typed = {};
      for (const k of Object.keys(SETTINGS)) typed[k] = (f.get(k) || '').trim();
      const bad = Object.keys(SETTINGS).find((k) => !(SECRET_KEYS.includes(k) && typed[k] === '') && !SETTINGS[k](typed[k]));
      if (bad) {
        for (const k of SECRET_KEYS) delete typed[k]; // i segreti non tornano mai nella pagina
        return send(res, 400, settingsPage(url, `Controlla il campo «${bad}».`, typed));
      }
      // se cambiano server o utente della posta senza una password nuova, la vecchia si cancella:
      // la password salvata non deve poter partire verso un altro server
      // lo stesso per il server IMAP (riceve la stessa password) e per la chat di Telegram (col token)
      const moved = ['smtp_host', 'smtp_user', 'imap_host'].some((k) => typed[k] !== getSetting(k));
      const clearPass = moved && typed.smtp_pass === '' && !!getSetting('smtp_pass');
      const clearTg = typed.tg_chat !== getSetting('tg_chat') && typed.tg_token === '' && !!getSetting('tg_token');
      store.tx(() => {
        for (const [k, val] of Object.entries(typed)) {
          if (SECRET_KEYS.includes(k) && val === '') continue; // vuoto = non cambiare
          setSetting(k, val);
        }
        if (clearPass) setSetting('smtp_pass', '');
        if (clearTg) setSetting('tg_token', '');
      });
      return back(res, '/impostazioni', clearPass || clearTg ? 'passcleared' : 'saved');
    }

    if (p === '/copia' && GET) return send(res, 200, backupPage(url));

    if (p === '/avvisi' && GET) return send(res, 200, mailPage(url));
    if ((p === '/avvisi/riprova' || p === '/avvisi/elimina') && POST) {
      const id = Number((await readForm(req, MAX_ADMIN_FORM)).get('id'));
      if (!Number.isSafeInteger(id) || id < 1) return send(res, 400, mailPage(url));
      if (p === '/avvisi/riprova') { mailer.retry(id); return back(res, '/avvisi', 'retry'); }
      mailer.remove(id);
      return back(res, '/avvisi', 'removed');
    }
    if (p === '/prova-email' && POST) {
      const to = field((await readForm(req, MAX_ADMIN_FORM)), 'to', 201);
      if (!validEmail(to)) return send(res, 400, settingsPage(url, 'Indirizzo per la prova non valido.'));
      try {
        await mailer.sendTest(to);
        testError = '';
        return back(res, '/impostazioni', 'testok');
      } catch (e) {
        testError = String(e.message || e).slice(0, 300);
        return back(res, '/impostazioni', 'testfail');
      }
    }
    if (p === '/backup' && GET) {
      const body = JSON.stringify(store.exportAll(), null, 1);
      const day = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        ...W.SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="sportello-copia-${day}.json"`,
      });
      res.end(body);
      return true;
    }
    if (p === '/ripristina' && POST) {
      const { fields, files } = await readMultipart(req, MAX_RESTORE);
      if (fields.get('sure') !== 'on') return send(res, 400, backupPage(url, 'Spunta la conferma prima di ripristinare.'));
      const file = files.file;
      if (!file || !file.data.length) return send(res, 400, backupPage(url, 'Scegli il file della copia.'));
      let data;
      try { data = JSON.parse(file.data.toString('utf8')); } catch { return send(res, 400, backupPage(url, 'Il file non è leggibile (non è una copia dello sportello).')); }
      try { store.checkBackup(data); } catch (e) { return send(res, 400, backupPage(url, e.message)); }
      saveBeforeRestore();
      store.importAll(data);
      return back(res, '/?vista=all', 'restored');
    }

    const m = /^\/ticket\/(\d{1,9})(\/[a-z-]+)?$/.exec(p);
    if (!m) return false;
    const t = store.ticketByNumber(Number(m[1]));
    if (!t) return false;
    const sub = m[2] || '';
    const here = `/ticket/${t.number}`;

    if (!sub && GET) {
      if (t.unread) store.markRead(t.id);
      return send(res, 200, ticketPage({ ...t, unread: 0 }, url));
    }
    if (!POST) return false;

    if (sub === '/rispondi' || sub === '/nota') {
      const f = await readForm(req, MAX_ADMIN_FORM);
      const body = field(f, 'body', MAX_STAFF + 1);
      if (!body) return send(res, 400, ticketPage(t, url, 'Il testo è vuoto.'));
      if (body.length > MAX_STAFF) return send(res, 400, ticketPage(t, url, `Testo troppo lungo (massimo ${MAX_STAFF} caratteri).`));
      if (sub === '/nota') {
        store.addMessage(t.id, 'note', body);
        return back(res, here, 'note');
      }
      store.tx(() => {
        store.addMessage(t.id, 'staff', body);
        store.setStatus(t.id, 'waiting');
        store.queueMail(t.id, t.email, 'reply', linkOf(store.tokenOf(t.id)));
      });
      return back(res, here, 'reply');
    }

    if (sub === '/stato') {
      const a = (await readForm(req, MAX_ADMIN_FORM)).get('action');
      if (a === 'close') {
        if (t.status !== 'closed') {
          store.tx(() => {
            store.setStatus(t.id, 'closed');
            store.queueMail(t.id, t.email, 'closed', linkOf(store.tokenOf(t.id)));
          });
        }
        return back(res, here, 'closed');
      }
      if (a === 'reopen') {
        store.setStatus(t.id, 'open');
        return back(res, here, 'reopened');
      }
      return send(res, 400, ticketPage(t, url, 'Azione non valida.'));
    }

    if (sub === '/nuovo-link') {
      await readForm(req, MAX_ADMIN_FORM);
      store.tx(() => {
        const token = store.rotateToken(t.id);
        store.queueMail(t.id, t.email, 'new_link', linkOf(token));
      });
      return back(res, here, 'newlink');
    }

    if (sub === '/elimina') {
      if ((await readForm(req, MAX_ADMIN_FORM)).get('sure') !== 'on') return redirect(res, here);
      store.deleteTicket(t.id);
      store.purgeDisk();
      return back(res, '/', 'deleted');
    }
    return false;
  };
};
