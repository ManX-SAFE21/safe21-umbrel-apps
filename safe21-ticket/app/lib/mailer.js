'use strict';
/*
 * Coda degli avvisi email, avvisi Telegram al proprietario, pulizia della casella Gmail.
 * Regole: nelle email solo numero del ticket e link (mai nome, mai testo dei messaggi);
 * su Telegram solo numero e argomento. Un avviso partito viene cancellato dalla coda.
 */
const { sendMail, imapCleanup, MailError } = require('./smtp.js');
const { ticketNumber } = require('./db.js');
const { validEmail } = require('./rules.js');

const FAILED = 99; // attempts = 99: non riprova più da solo (destinatario rifiutato o troppi tentativi)
const MAX_TRIES = 10;
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720, 1440, 1440, 1440];
const SIGN = '\n\n—\nSAFE21 · Sportello di assistenza\nPer proteggerti, questa email non contiene il testo dei messaggi.\nLe risposte a questa email non vengono lette: scrivi sempre dal link del tuo ticket.\n';

// testi fissi: l'unica parte variabile è il numero del ticket e il link
const TEMPLATES = {
  opened: (n, link) => [`[${n}] Ticket aperto`, `Ciao,\n\nabbiamo ricevuto il tuo ticket ${n}.\nPuoi seguirlo e rispondere da qui:\n\n${link}\n\nSalva questo link: è la chiave del tuo ticket, non condividerlo.\nSe non hai aperto tu questo ticket, ignora questa email: qualcuno ha scritto il tuo indirizzo per sbaglio.`],
  reply: (n, link) => [`[${n}] Nuova risposta al tuo ticket`, `Ciao,\n\nc'è una nuova risposta al tuo ticket ${n}.\nLeggila e rispondi da qui:\n\n${link}`],
  closed: (n, link) => [`[${n}] Ticket chiuso`, `Ciao,\n\nil tuo ticket ${n} è stato chiuso.\nTra 30 giorni verrà cancellato insieme a tutti i messaggi. Se ti serve ancora, scrivi dal link e si riapre:\n\n${link}`],
  lost_link: (n, link) => [`[${n}] Ecco il link del tuo ticket`, `Ciao,\n\nci hai chiesto di nuovo il link del ticket ${n}:\n\n${link}\n\nSe non sei stato tu, puoi ignorare questa email.`],
  new_link: (n, link) => [`[${n}] Il tuo nuovo link`, `Ciao,\n\nabbiamo fatto un nuovo link per il tuo ticket ${n}. Quello vecchio non funziona più:\n\n${link}`],
};

const dayKey = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const cleanErr = (e, pass, user = '') => {
  let s = String((e && e.message) || e).replace(/[\r\n]+/g, ' ').slice(0, 300);
  if (pass) {
    // la password non finisce mai negli errori: né in chiaro né dentro il blocco AUTH PLAIN
    for (const x of [pass, Buffer.from(`\0${user}\0${pass}`).toString('base64'), Buffer.from(pass).toString('base64')]) s = s.split(x).join('***');
  }
  return s;
};
// stesso dominio principale (smtp.gmail.com e imap.gmail.com): la password va solo lì
const mainDomain = (h) => String(h || '').toLowerCase().split('.').slice(-2).join('.');

module.exports = function makeMailer({ store, publicUrl = '', intervalMs = 30000 }) {
  const { db, getSetting, setSetting } = store;
  const base = () => (getSetting('public_url') || publicUrl || 'https://ticket.safe21.io').replace(/\/+$/, '');

  const smtpCfg = () => {
    const c = { host: getSetting('smtp_host'), port: getSetting('smtp_port') || '465', user: getSetting('smtp_user'), pass: getSetting('smtp_pass'), from: getSetting('smtp_from') };
    if (!c.from && c.user) c.from = `SAFE21 Ticket <${c.user}>`;
    try { c.helo = new URL(base()).hostname; } catch { c.helo = 'localhost'; }
    return c.host && c.user && c.pass ? c : null;
  };

  /* ---------- Telegram (solo numero e argomento) ---------- */
  async function telegram(text) {
    const token = getSetting('tg_token');
    const chat = getSetting('tg_chat');
    if (!token || !chat) return false;
    const api = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
    try {
      const r = await fetch(`${api}/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
      return !!(await r.json()).ok;
    } catch (e) {
      console.error('telegram:', cleanErr(e, token));
      return false;
    }
  }
  const notifyOwner = (text) => { telegram(text).catch(() => {}); };

  /* ---------- tetto giornaliero ---------- */
  const cap = () => { const n = Number(getSetting('mail_daily_cap', '300')); return Number.isInteger(n) && n > 0 ? n : 300; };
  const sentToday = () => Number(getSetting(`mail_count_${dayKey()}`, '0'));
  function countSent() {
    const k = `mail_count_${dayKey()}`;
    setSetting(k, sentToday() + 1);
    // contatori dei giorni passati: inutili
    db.prepare("DELETE FROM settings WHERE key LIKE 'mail_count_%' AND key != ?").run(k);
  }

  /* ---------- pulizia della casella Gmail ---------- */
  let cleanupTimer = null;
  let cleaning = false;
  function scheduleCleanup(delay = 3000) {
    if (!getSetting('imap_host') || cleanupTimer) return;
    cleanupTimer = setTimeout(async () => {
      cleanupTimer = null;
      await cleanupNow();
    }, delay);
    cleanupTimer.unref();
  }
  async function cleanupNow() {
    const host = getSetting('imap_host');
    const user = getSetting('smtp_user');
    const pass = getSetting('smtp_pass');
    if (!host || !user || !pass || cleaning) return null;
    if (mainDomain(host) !== mainDomain(getSetting('smtp_host'))) {
      setSetting('imap_last_error', 'il server IMAP deve essere dello stesso servizio della posta in uscita (es. imap.gmail.com con smtp.gmail.com)');
      return null;
    }
    cleaning = true;
    try {
      const r = await imapCleanup({ host, user, pass }, { linkText: `${base()}/t/` });
      setSetting('imap_last_error', '');
      setSetting('imap_last_ok', new Date().toISOString());
      return r;
    } catch (e) {
      setSetting('imap_last_error', cleanErr(e, pass, user));
      return null;
    } finally {
      cleaning = false;
    }
  }

  /* ---------- coda ---------- */
  let running = false;
  async function processQueue() {
    if (running) return;
    running = true;
    try {
      const cfg = smtpCfg();
      if (!cfg) return;
      // avvisi fermi da più di 7 giorni: via il link dal database (se si riprova, si rifà dal ticket)
      db.prepare("UPDATE mail_queue SET link = '' WHERE attempts >= ? AND created_at < ?").run(FAILED, new Date(Date.now() - 7 * 86400000).toISOString());
      // gli avvisi «chiuso» per ultimi: non fanno aspettare risposte e link
      const due = db.prepare(`SELECT q.*, t.number FROM mail_queue q LEFT JOIN tickets t ON t.id = q.ticket_id
        WHERE q.sent_at = '' AND q.attempts < ? AND q.next_try_at <= ?
        ORDER BY CASE q.kind WHEN 'closed' THEN 1 ELSE 0 END, q.id LIMIT 20`).all(FAILED, new Date().toISOString());
      let sentSome = false;
      for (const row of due) {
        if (sentToday() >= cap()) {
          if (getSetting('cap_warned') !== dayKey()) {
            setSetting('cap_warned', dayKey());
            notifyOwner(`⚠️ Sportello: raggiunto il limite di ${cap()} email per oggi. Gli altri avvisi partono domani.`);
          }
          break;
        }
        if (!row.number || !TEMPLATES[row.kind] || !validEmail(row.to_addr)) {
          db.prepare('UPDATE mail_queue SET attempts = ?, last_error = ? WHERE id = ?').run(FAILED, 'avviso non valido', row.id);
          continue;
        }
        const link = row.link || `${base()}/t/${store.tokenOf(row.ticket_id)}`;
        const [subject, text] = TEMPLATES[row.kind](ticketNumber(row.number), link);
        try {
          await sendMail(cfg, { to: row.to_addr, subject, text: text + SIGN, headers: { 'X-Safe21-Ticket': '1' } });
          db.prepare('DELETE FROM mail_queue WHERE id = ?').run(row.id); // partito: via anche il link
          countSent();
          sentSome = true;
        } catch (e) {
          if (e instanceof MailError && e.global) {
            // problema del server o delle impostazioni: non è colpa di questo avviso, non conta come
            // tentativo; tutta la coda riprova fra 5 minuti
            db.prepare("UPDATE mail_queue SET last_error = ?, next_try_at = ? WHERE sent_at = '' AND attempts < ?")
              .run(cleanErr(e, cfg.pass, cfg.user), new Date(Date.now() + 5 * 60000).toISOString(), FAILED);
            break;
          }
          const attempts = e instanceof MailError && e.permanent ? FAILED : row.attempts + 1;
          const wait = BACKOFF_MIN[Math.min(row.attempts, BACKOFF_MIN.length - 1)] * 60000;
          db.prepare('UPDATE mail_queue SET attempts = ?, last_error = ?, next_try_at = ? WHERE id = ?')
            .run(attempts >= MAX_TRIES ? FAILED : attempts, cleanErr(e, cfg.pass, cfg.user), new Date(Date.now() + wait).toISOString(), row.id);
        }
      }
      if (sentSome) scheduleCleanup();
    } catch (e) {
      console.error('coda email:', cleanErr(e, getSetting('smtp_pass'), getSetting('smtp_user')));
    } finally {
      running = false;
    }
  }
  const timer = setInterval(processQueue, intervalMs);
  timer.unref();
  // giro di pulizia anche ogni ora (copie rimaste da un tentativo fallito, risposte dei clienti)
  setInterval(() => scheduleCleanup(0), 3600000).unref();
  const kick = () => setImmediate(processQueue);

  /* ---------- per il pannello ---------- */
  async function sendTest(to) {
    const cfg = smtpCfg();
    if (!cfg) throw new MailError('posta in uscita non configurata (server, utente e password)');
    try {
      await sendMail(cfg, {
        to, subject: 'Email di prova dello sportello',
        text: 'Questa è una email di prova dello sportello ticket SAFE21: la posta in uscita funziona.' + SIGN,
        headers: { 'X-Safe21-Ticket': '1' },
      });
      countSent();
      scheduleCleanup();
    } catch (e) { throw new MailError(cleanErr(e, cfg.pass, cfg.user)); }
  }
  const pending = () => db.prepare(`SELECT q.id, q.kind, q.to_addr, q.attempts, q.last_error, q.next_try_at, t.number
    FROM mail_queue q LEFT JOIN tickets t ON t.id = q.ticket_id WHERE q.sent_at = '' ORDER BY q.id`).all();
  function retry(id) { db.prepare('UPDATE mail_queue SET attempts = 0, next_try_at = ? WHERE id = ?').run(new Date().toISOString(), id); kick(); }
  const remove = (id) => db.prepare('DELETE FROM mail_queue WHERE id = ?').run(id);

  return {
    kick, processQueue, notifyOwner, telegram, sendTest, pending, retry, remove, cleanupNow, FAILED,
    configured: () => !!smtpCfg(),
  };
};
