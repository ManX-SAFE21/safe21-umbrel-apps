'use strict';
/*
 * Database dei ticket (SQLite incluso in Node, nessuna dipendenza).
 *
 * Il link privato del cliente (/t/<codice>): per cercare il ticket si usa la sua impronta SHA-256;
 * il link stesso (serve per metterlo negli avvisi email) è salvato CIFRATO, con una chiave che sta in
 * un file a parte (link.key). Chi avesse solo il file del database non potrebbe ricostruire i link.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const R = require('./rules.js');

// stati del ticket: open = da rispondere, waiting = in attesa del cliente, closed = chiuso
const STATUSES = ['open', 'waiting', 'closed'];
// autori dei messaggi: note = nota interna, il cliente non la vede mai
const AUTHORS = ['customer', 'staff', 'note'];
// tipi di avviso email (il testo delle email è fisso: mai nome né messaggio del cliente)
const MAIL_KINDS = ['opened', 'reply', 'closed', 'lost_link', 'new_link'];

const TOKEN_BYTES = 16; // 128 bit
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/; // 16 byte in base64url = 22 caratteri

const nowIso = () => new Date().toISOString();
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const ticketNumber = (n) => `SAFE21-${String(n).padStart(4, '0')}`;

function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'ticket.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    -- i dati cancellati vengono sovrascritti, non restano nel file (privacy)
    PRAGMA secure_delete = ON;
    -- il diario WAL non cresce oltre 1 MB (dopo uno svuotamento torna piccolo)
    PRAGMA journal_size_limit = 1048576;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      token_enc TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      topic TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'closed')),
      unread INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_customer_at TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT '',
      auto_closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tickets_status ON tickets (status, updated_at);
    CREATE INDEX IF NOT EXISTS tickets_email ON tickets (email);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author TEXT NOT NULL CHECK (author IN ('customer', 'staff', 'note')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_ticket ON messages (ticket_id, id);
    -- coda degli avvisi email: il link (con il codice segreto) resta qui solo finché l'email
    -- non parte, poi viene cancellato
    CREATE TABLE IF NOT EXISTS mail_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
      to_addr TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('opened', 'reply', 'closed', 'lost_link', 'new_link')),
      link TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS mail_queue_due ON mail_queue (sent_at, next_try_at);
  `);

  // chiave per cifrare i link (AES-256-GCM), in un file a parte: creata al primo avvio
  const keyFile = path.join(dir, 'link.key');
  let linkKey;
  // scrittura sicura: prima un file temporaneo, poi lo scambio (mai una chiave scritta a metà)
  const writeKey = (hex) => {
    fs.writeFileSync(keyFile + '.tmp', hex, { mode: 0o600 });
    fs.renameSync(keyFile + '.tmp', keyFile);
  };
  const loadKey = () => {
    if (!fs.existsSync(keyFile)) writeKey(crypto.randomBytes(32).toString('hex'));
    const hex = fs.readFileSync(keyFile, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`chiave dei link rovinata in ${keyFile}`);
    linkKey = Buffer.from(hex, 'hex');
  };
  loadKey();
  // database creati prima della versione 0.3.0: aggiunge la colonna del link cifrato
  if (!db.prepare('PRAGMA table_info(tickets)').all().some((c) => c.name === 'token_enc')) {
    db.exec("ALTER TABLE tickets ADD COLUMN token_enc TEXT NOT NULL DEFAULT ''");
  }
  function seal(token) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', linkKey, iv);
    const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  function open(enc) {
    try {
      const b = Buffer.from(enc, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', linkKey, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch { return null; }
  }

  const getSetting = (k, d = '') => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? r.value : d;
  };
  const setSetting = (k, v) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

  // segreto dell'app (firme dei moduli): creato al primo avvio
  let secret = getSetting('secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setSetting('secret', secret); }

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

  // Nuovo ticket con il primo messaggio. Restituisce il ticket e il codice segreto, che si mostra
  // una volta sola al cliente (e va nell'email): nel database resta solo l'impronta.
  function createTicket({ name, email, topic, body }) {
    return tx(() => {
      // numeri sempre crescenti: un ticket cancellato non lascia il suo numero a un altro
      const number = Number(getSetting('next_number', '1'));
      setSetting('next_number', number + 1);
      const token = newToken();
      const t = nowIso();
      const r = db.prepare(`INSERT INTO tickets (number, token_hash, token_enc, name, email, topic, created_at, updated_at, last_customer_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(number, tokenHash(token), seal(token), name, email, topic, t, t, t);
      const id = Number(r.lastInsertRowid);
      db.prepare("INSERT INTO messages (ticket_id, author, body, created_at) VALUES (?, 'customer', ?, ?)").run(id, body, t);
      return { ticket: getTicket(id), token };
    });
  }

  const getTicket = (id) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);

  // Cerca il ticket dal codice del link. Un codice di forma sbagliata non tocca nemmeno il database.
  function ticketByToken(token) {
    if (!TOKEN_RE.test(String(token || ''))) return undefined;
    return db.prepare('SELECT * FROM tickets WHERE token_hash = ?').get(tokenHash(token));
  }

  // Link tutto nuovo (lo decide il gestore, per esempio se il cliente dice che il link è finito
  // in mani sbagliate): il link vecchio smette di funzionare.
  function rotateToken(id) {
    const token = newToken();
    db.prepare('UPDATE tickets SET token_hash = ?, token_enc = ? WHERE id = ?').run(tokenHash(token), seal(token), id);
    return token;
  }

  // Il codice del link senza mai cambiarlo: null se non si può decifrare (usato dagli automatismi).
  function peekToken(id) {
    const t = getTicket(id);
    const token = t && t.token_enc ? open(t.token_enc) : null;
    return token && tokenHash(token) === t.token_hash ? token : null;
  }

  // Il codice del link di un ticket, per gli avvisi email («Ho perso il link» rimanda lo stesso link).
  // Se non si può decifrare (per esempio chiave persa), si fa un link nuovo.
  function tokenOf(id) {
    const t = getTicket(id);
    if (!t) return null;
    const token = t.token_enc ? open(t.token_enc) : null;
    return token && tokenHash(token) === t.token_hash ? token : rotateToken(id);
  }

  const messageCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE ticket_id = ?').get(id).n;

  // messaggi: il cliente non vede mai le note interne
  const messagesOf = (id, { withNotes = false } = {}) => db.prepare(
    `SELECT * FROM messages WHERE ticket_id = ? ${withNotes ? '' : "AND author != 'note'"} ORDER BY id`).all(id);

  function addMessage(id, author, body) {
    if (!AUTHORS.includes(author)) throw new Error('autore non valido');
    const t = nowIso();
    db.prepare('INSERT INTO messages (ticket_id, author, body, created_at) VALUES (?, ?, ?, ?)').run(id, author, body, t);
    if (author !== 'note') db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(t, id);
    if (author === 'customer') db.prepare('UPDATE tickets SET last_customer_at = ?, unread = 1 WHERE id = ?').run(t, id);
  }

  function setStatus(id, status) {
    if (!STATUSES.includes(status)) throw new Error('stato non valido');
    db.prepare("UPDATE tickets SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN ? ELSE '' END, auto_closed = 0 WHERE id = ?")
      .run(status, status, nowIso(), id);
  }

  const deleteTicket = (id) => db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  // Dopo una cancellazione: il diario WAL tiene ancora le vecchie pagine (testi compresi).
  // Lo si svuota e azzera, così un ticket cancellato non resta da nessuna parte nei file del database.
  const purgeDisk = () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('svuotamento del diario:', e.message); } };

  // ticket non chiusi di un indirizzo email (maiuscole e minuscole non contano)
  const activeTicketsOf = (email) => db.prepare(
    "SELECT * FROM tickets WHERE email = ? COLLATE NOCASE AND status != 'closed' ORDER BY id").all(email);

  // avviso email in coda: solo indirizzo, tipo e link; il testo dell'email è fisso
  function queueMail(ticketId, to, kind, link = '') {
    if (!MAIL_KINDS.includes(kind)) throw new Error('tipo di avviso non valido');
    const t = nowIso();
    db.prepare('INSERT INTO mail_queue (ticket_id, to_addr, kind, link, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ticketId, to, kind, link, t, t);
  }

  /* ---------- pannello ---------- */
  const ticketByNumber = (n) => db.prepare('SELECT * FROM tickets WHERE number = ?').get(n);
  const markRead = (id) => db.prepare('UPDATE tickets SET unread = 0 WHERE id = ?').run(id);
  // lista per il pannello: i più recenti in alto; view = open | waiting | closed | all
  function listTickets(view) {
    const where = STATUSES.includes(view) ? 'WHERE status = ?' : '';
    return db.prepare(`SELECT * FROM tickets ${where} ORDER BY updated_at DESC, id DESC`).all(...(where ? [view] : []));
  }

  /* ---------- copia di sicurezza ---------- */
  // Nella copia: ticket, messaggi, chiave dei link e le impostazioni normali.
  // Mai: password della posta, token di Telegram, password del pannello, segreto delle firme.
  const IMPORTABLE = Object.keys(R.SETTINGS).filter((k) => !R.SECRET_KEYS.includes(k) && !R.LOCAL_KEYS.includes(k));
  const TICKET_COLS = ['id', 'number', 'token_hash', 'token_enc', 'name', 'email', 'topic', 'status', 'unread', 'created_at', 'updated_at', 'last_customer_at', 'closed_at', 'auto_closed'];
  const MESSAGE_COLS = ['id', 'ticket_id', 'author', 'body', 'created_at'];
  function exportAll() {
    const settings = {};
    for (const k of [...IMPORTABLE, 'next_number']) { const v = getSetting(k, null); if (v !== null) settings[k] = v; }
    return {
      app: 'safe21-ticket',
      format: 1,
      created_at: nowIso(),
      link_key: linkKey.toString('hex'),
      settings,
      tickets: db.prepare(`SELECT ${TICKET_COLS.join(', ')} FROM tickets ORDER BY id`).all(),
      messages: db.prepare(`SELECT ${MESSAGE_COLS.join(', ')} FROM messages ORDER BY id`).all(),
    };
  }
  // Controlla tutto il file PRIMA di toccare i dati: se qualcosa non va non cambia niente.
  // Il file può venire da chiunque: ogni valore deve rispettare le stesse regole del modulo e del pannello.
  function checkBackup(d) {
    const fail = (why) => { throw new Error(`File non valido: ${why}.`); };
    const str = (v, max = 1000) => typeof v === 'string' && v.length <= max;
    const flag = (v) => v === 0 || v === 1;
    const posInt = (v) => Number.isSafeInteger(v) && v > 0;
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
    // data vera: forma giusta e giorno esistente (niente 30 febbraio o mese 13)
    const date = (v) => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v))
      && new Date(Date.parse(v)).toISOString().slice(0, 19) === v.slice(0, 19);
    if (!d || typeof d !== 'object' || d.app !== 'safe21-ticket' || d.format !== 1) fail('non è una copia di sicurezza dello sportello');
    if (typeof d.link_key !== 'string' || !/^[0-9a-f]{64}$/.test(d.link_key)) fail('chiave dei link mancante');
    if (!d.settings || typeof d.settings !== 'object' || Array.isArray(d.settings)) fail('impostazioni mancanti');
    for (const [k, v] of Object.entries(d.settings)) {
      if (k === 'next_number') { if (typeof v !== 'string' || !/^\d{1,9}$/.test(v) || Number(v) < 1) fail('contatore dei ticket strano'); continue; }
      if (!IMPORTABLE.includes(k)) continue; // chiavi sconosciute o segrete: ignorate
      if (typeof v !== 'string' || !R.SETTINGS[k](v)) fail(`impostazione «${k}» non valida`);
    }
    if (!Array.isArray(d.tickets) || !Array.isArray(d.messages)) fail('ticket o messaggi mancanti');
    const ids = new Set(); const nums = new Set(); const hashes = new Set();
    for (const t of d.tickets) {
      if (!t || typeof t !== 'object') fail('ticket strano');
      if (!posInt(t.id) || !posInt(t.number) || ids.has(t.id) || nums.has(t.number)) fail('numero di ticket strano o ripetuto');
      if (typeof t.token_hash !== 'string' || !/^[0-9a-f]{64}$/.test(t.token_hash) || hashes.has(t.token_hash)) fail('link di un ticket strano o ripetuto');
      if (!str(t.token_enc, 200) || !/^[A-Za-z0-9+/=]*$/.test(t.token_enc)) fail('link cifrato strano');
      if (!str(t.name, R.LIMITS.name) || !t.name || !R.noCtl(t.name)) fail('nome strano');
      if (!R.validEmail(t.email)) fail('email strana');
      if (!str(t.topic, R.LIMITS.topic) || !t.topic || !R.noCtl(t.topic)) fail('argomento strano');
      if (!STATUSES.includes(t.status) || !flag(t.unread) || !flag(t.auto_closed)) fail('stato di un ticket strano');
      if (!date(t.created_at) || !date(t.updated_at) || !date(t.last_customer_at) || !(t.closed_at === '' || date(t.closed_at))) fail('data strana');
      if (t.status === 'closed' && t.closed_at === '') fail('ticket chiuso senza data di chiusura');
      ids.add(t.id); nums.add(t.number); hashes.add(t.token_hash);
    }
    const mids = new Set();
    for (const m of d.messages) {
      if (!m || typeof m !== 'object' || !posInt(m.id) || mids.has(m.id) || !ids.has(m.ticket_id)) fail('messaggio strano');
      if (!AUTHORS.includes(m.author) || !str(m.body, R.LIMITS.body) || !date(m.created_at)) fail('messaggio strano');
      mids.add(m.id);
    }
  }
  function importAll(d) {
    checkBackup(d);
    // la chiave nuova si prepara prima e si mette al suo posto solo se il database è andato bene
    fs.writeFileSync(keyFile + '.new', d.link_key, { mode: 0o600 });
    try {
      tx(() => {
        db.exec('DELETE FROM mail_queue; DELETE FROM messages; DELETE FROM tickets;');
        // se la copia porta la posta o Telegram verso altri server/chat, i segreti salvati si cancellano:
        // non devono mai partire verso un indirizzo scritto in un file
        const changes = (k) => typeof d.settings[k] === 'string' && d.settings[k] !== getSetting(k);
        if (['smtp_host', 'smtp_user', 'imap_host'].some(changes)) setSetting('smtp_pass', '');
        if (changes('tg_chat')) setSetting('tg_token', '');
        for (const k of IMPORTABLE) if (typeof d.settings[k] === 'string') setSetting(k, d.settings[k]);
        const ti = db.prepare(`INSERT INTO tickets (${TICKET_COLS.join(', ')}) VALUES (${TICKET_COLS.map(() => '?').join(', ')})`);
        for (const t of d.tickets) ti.run(...TICKET_COLS.map((c) => t[c]));
        const mi = db.prepare(`INSERT INTO messages (${MESSAGE_COLS.join(', ')}) VALUES (${MESSAGE_COLS.map(() => '?').join(', ')})`);
        for (const m of d.messages) mi.run(...MESSAGE_COLS.map((c) => m[c]));
        // il prossimo numero non torna mai indietro: il più alto fra adesso, il file e i ticket ripristinati
        const top = db.prepare('SELECT MAX(number) AS n FROM tickets').get().n || 0;
        const next = Math.max(Number(getSetting('next_number', '1')) || 1, Number(d.settings.next_number || 1), top + 1);
        setSetting('next_number', next);
      });
    } catch (e) {
      fs.rmSync(keyFile + '.new', { force: true });
      throw e;
    }
    fs.renameSync(keyFile + '.new', keyFile);
    loadKey();
    purgeDisk();
    // dopo un ripristino gli automatismi aspettano un giorno: il proprietario ha tempo di guardare
    // prima che ticket vecchi vengano chiusi o cancellati
    setSetting('jobs_hold_until', new Date(Date.now() + 86400000).toISOString());
  }

  function counts() {
    const out = { open: 0, waiting: 0, closed: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all()) out[r.status] = r.n;
    return out;
  }

  return {
    db, getSetting, setSetting, secret, tx,
    createTicket, getTicket, ticketByToken, rotateToken, messagesOf, addMessage, setStatus, deleteTicket, counts,
    activeTicketsOf, queueMail, tokenOf, peekToken, purgeDisk, messageCount,
    ticketByNumber, markRead, listTickets, exportAll, checkBackup, importAll, keyFile,
  };
}

module.exports = { openDb, ticketNumber, tokenHash, STATUSES, AUTHORS, MAIL_KINDS, TOKEN_RE };
