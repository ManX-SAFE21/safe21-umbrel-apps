'use strict';
/*
 * Invio email (SMTP) e pulizia della casella (IMAP), senza dipendenze.
 * - SMTP: porta 465 = cifrato da subito; 25/587/2525 = STARTTLS obbligatorio.
 *   La password non parte MAI su un collegamento non cifrato.
 * - IMAP (solo cifrato, porta 993): sposta nel Cestino e cancella le copie degli avvisi che Gmail
 *   tiene in «Posta inviata» e le risposte arrivate in Posta in arrivo che citano un link.
 * Certificati sempre controllati. Per le prove: MAIL_CA_FILE (certificato in più di cui fidarsi),
 * SMTP_PORT_OVERRIDE e IMAP_PORT_OVERRIDE (porta vera dei finti server).
 */
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TIMEOUT = 20000;       // nessun dato per 20 s: collegamento chiuso
const DEADLINE = 60000;      // un invio o una pulizia non durano mai più di 60 s in tutto
const MAX_LINE = 64 * 1024;  // un server che manda righe infinite non riempie la memoria
const MAX_LINES = 20000;     // né troppe righe per un solo comando
let extraCa = null;
if (process.env.MAIL_CA_FILE) {
  try { extraCa = [...tls.rootCertificates, fs.readFileSync(process.env.MAIL_CA_FILE, 'utf8')]; } catch (e) { console.error('MAIL_CA_FILE non leggibile:', e.message); }
}
const tlsOpts = (host) => ({ host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true, ...(extraCa ? { ca: extraCa } : {}) });

class MailError extends Error {
  // permanent: il destinatario è rifiutato (inutile riprovare); global: il problema è del server o
  // delle impostazioni, non di questo avviso (non conta come tentativo dell'avviso)
  constructor(message, { code = 0, permanent = false, global = false } = {}) { super(message); this.code = code; this.permanent = permanent; this.global = global; }
}

/* ---------- lettura a righe su un collegamento (anche dopo il passaggio a TLS) ---------- */
function lineReader(sock) {
  let buf = '';
  const waiting = [];
  const lines = [];
  let ended = null;
  let current = null;
  const feed = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (waiting.length) waiting.shift().ok(line); else lines.push(line);
    }
    if (buf.length > MAX_LINE || lines.length > MAX_LINES) {
      fail(new MailError('il server manda risposte troppo lunghe', { global: true }));
      if (current) current.destroy();
    }
  };
  const fail = (e) => { ended = e; while (waiting.length) waiting.shift().ko(e); };
  const attach = (s) => {
    current = s;
    s.on('data', feed);
    s.on('error', (e) => fail(new MailError(`collegamento: ${e.code || e.message}`)));
    s.on('close', () => fail(new MailError('collegamento chiuso dal server')));
  };
  attach(sock);
  return {
    attach,
    detach: (s) => {
      s.removeAllListeners('data'); s.removeAllListeners('error'); s.removeAllListeners('close');
      s.on('error', () => {}); // il collegamento sotto TLS: un suo errore non deve far cadere il server
    },
    // dati già arrivati e non letti (dopo STARTTLS non ce ne devono essere)
    pending: () => buf.length > 0 || lines.length > 0,
    next: () => new Promise((ok, ko) => {
      if (lines.length) return ok(lines.shift());
      if (ended) return ko(ended);
      waiting.push({ ok, ko });
    }),
  };
}

function connect(host, port, secure) {
  return new Promise((ok, ko) => {
    const s = secure ? tls.connect({ ...tlsOpts(host), port }) : net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); ko(new MailError(`il server ${host}:${port} non risponde`)); }, TIMEOUT);
    s.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(t); s.setTimeout(TIMEOUT, () => s.destroy(new Error('tempo scaduto'))); ok(s); });
    s.once('error', (e) => { clearTimeout(t); ko(new MailError(`collegamento a ${host}:${port}: ${e.code || e.message}`, { global: true })); });
  });
}

/* ---------- SMTP ---------- */
async function smtpReply(r) {
  const lines = [];
  for (;;) {
    if (lines.length > 200) throw new MailError('risposta del server troppo lunga', { global: true });
    const l = await r.next();
    lines.push(l);
    if (!/^\d{3}-/.test(l)) break;
  }
  return { code: Number(lines[lines.length - 1].slice(0, 3)), lines };
}

// codifica dell'oggetto (RFC 2047): sempre UTF-8 in base64
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const addrOf = (from) => { const m = /<([^<>]+)>\s*$/.exec(from); return (m ? m[1] : from).trim(); };
const nameOf = (from) => { const m = /^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/.exec(from); return m ? m[1].trim() : ''; };

function buildMessage({ from, to, subject, text, headers = {} }) {
  const fromAddr = addrOf(from);
  const fromName = nameOf(from);
  const domain = fromAddr.split('@')[1] || 'localhost';
  const head = {
    From: fromName ? `${encWord(fromName)} <${fromAddr}>` : fromAddr,
    To: to,
    Subject: encWord(subject),
    Date: new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID': `<${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version': '1.0',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Transfer-Encoding': 'base64',
    ...headers,
  };
  for (const v of Object.values(head)) if (/[\r\n]/.test(v)) throw new MailError('a capo in un\'intestazione', { permanent: true });
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Object.entries(head).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

/*
 * Manda un'email. cfg = { host, port (stringa, decide il tipo di cifratura), user, pass, from, helo }
 * Errori: MailError con permanent = true se il server rifiuta il destinatario (5xx).
 */
// tempo massimo in tutto: un server lentissimo non blocca la coda per sempre
function withDeadline(promise, sockRef, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, ko) => { t = setTimeout(() => { if (sockRef.s) sockRef.s.destroy(); ko(new MailError(`${what}: tempo scaduto`, { global: true })); }, DEADLINE); t.unref(); }),
  ]).finally(() => clearTimeout(t));
}

async function sendMail(cfg, msgData) {
  const ref = {};
  return withDeadline(sendMailInner(cfg, msgData, ref), ref, 'invio');
}
async function sendMailInner(cfg, { to, subject, text, headers }, ref) {
  const implicit = String(cfg.port) === '465';
  const realPort = Number(process.env.SMTP_PORT_OVERRIDE || cfg.port);
  const helo = cfg.helo || 'localhost';
  const fromAddr = addrOf(cfg.from || cfg.user);
  const msg = buildMessage({ from: cfg.from || cfg.user, to, subject, text, headers });
  let sock = await connect(cfg.host, realPort, implicit);
  ref.s = sock;
  const r = lineReader(sock);
  const cmd = async (line, okCodes, what) => {
    if (line !== null) sock.write(line + '\r\n');
    const res = await smtpReply(r);
    if (!okCodes.includes(res.code)) {
      const text = res.lines.join(' ').slice(0, 200);
      const early = ['saluto del server', 'EHLO', 'STARTTLS'].includes(what);
      throw new MailError(`${what}: ${text}`, { code: res.code, permanent: res.code >= 500 && what === 'destinatario', global: early });
    }
    return res;
  };
  try {
    await cmd(null, [220], 'saluto del server');
    let ehlo = await cmd(`EHLO ${helo}`, [250], 'EHLO');
    if (!implicit) {
      // senza cifratura non si va avanti: la password non deve viaggiare in chiaro
      if (!ehlo.lines.some((l) => /^250[ -]STARTTLS/i.test(l))) throw new MailError('il server non offre STARTTLS: invio fermato per non mandare la password in chiaro', { global: true });
      await cmd('STARTTLS', [220], 'STARTTLS');
      // righe arrivate in chiaro subito dopo il 220: qualcuno sta manomettendo il collegamento
      if (r.pending()) throw new MailError('dati inattesi prima della cifratura: invio fermato', { global: true });
      r.detach(sock);
      sock = await new Promise((ok, ko) => {
        const s = tls.connect({ ...tlsOpts(cfg.host), socket: sock });
        s.once('secureConnect', () => ok(s));
        s.once('error', (e) => ko(new MailError(`cifratura: ${e.code || e.message}`, { global: true })));
      });
      ref.s = sock;
      r.attach(sock);
      ehlo = await cmd(`EHLO ${helo}`, [250], 'EHLO');
    }
    try {
      await cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf8').toString('base64')}`, [235], 'autenticazione');
    } catch (e) { throw new MailError(`autenticazione rifiutata (controlla utente e password per le app) [${e.code}]`, { code: e.code, global: true }); }
    await cmd(`MAIL FROM:<${fromAddr}>`, [250], 'mittente');
    await cmd(`RCPT TO:<${to}>`, [250, 251], 'destinatario');
    await cmd('DATA', [354], 'DATA');
    sock.write(msg.split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n') + '.\r\n');
    await cmd(null, [250], 'invio');
    sock.write('QUIT\r\n');
  } finally {
    setTimeout(() => sock.destroy(), 500).unref();
  }
}

/* ---------- IMAP: pulizia della casella ---------- */
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function imapCleanup(cfg, opts) {
  const ref = {};
  return withDeadline(imapInner(cfg, opts, ref), ref, 'pulizia della casella');
}
async function imapInner(cfg, { linkText }, ref) {
  // il testo del link deve essere lungo e preciso: niente ricerche che prendano altra posta
  if (typeof linkText !== 'string' || linkText.length < 20 || !/^https:\/\/[^/\s"]+\.[^/\s"]+\/t\/$/.test(linkText)) {
    throw new MailError('indirizzo pubblico non adatto alla pulizia della casella');
  }
  const realPort = Number(process.env.IMAP_PORT_OVERRIDE || 993);
  const sock = await connect(cfg.host, realPort, true);
  ref.s = sock;
  const r = lineReader(sock);
  let n = 0;
  const run = async (command) => {
    const tag = `A${++n}`;
    sock.write(`${tag} ${command}\r\n`);
    const untagged = [];
    for (;;) {
      if (untagged.length > MAX_LINES) throw new MailError('IMAP: risposta troppo lunga');
      const l = await r.next();
      if (l.startsWith(tag + ' ')) {
        if (!/^\S+ OK/i.test(l)) throw new MailError(`IMAP ${command.split(' ')[0]}: ${l.slice(tag.length + 1, 200)}`);
        return untagged;
      }
      untagged.push(l);
    }
  };
  const searchUids = (lines) => lines.filter((l) => /^\* SEARCH/i.test(l)).flatMap((l) => l.replace(/^\* SEARCH/i, '').trim().split(/\s+/)).filter((x) => /^\d+$/.test(x));
  let moved = 0;
  try {
    const greet = await r.next();
    if (!/^\* (OK|PREAUTH)/i.test(greet)) throw new MailError('IMAP: saluto strano');
    try { await run(`LOGIN ${q(cfg.user)} ${q(cfg.pass)}`); } catch { throw new MailError('IMAP: accesso rifiutato (controlla utente e password per le app)'); }
    const list = await run('LIST "" "*"');
    const folder = (flag) => {
      const l = list.find((x) => new RegExp(`^\\* LIST \\([^)]*\\\\${flag}\\b`, 'i').test(x));
      const m = l && /"((?:[^"\\]|\\.)*)"\s*$/.exec(l);
      return m ? m[1].replace(/\\(.)/g, '$1') : null;
    };
    const sent = folder('Sent');
    const trash = folder('Trash');
    if (!trash) throw new MailError('IMAP: cartella Cestino non trovata');
    // nel Cestino si cancellano per sempre SOLO gli avvisi dell'app (intestazione X-Safe21-Ticket)
    // e i messaggi spostati da questo stesso giro (UID nuovi detti dal server con COPYUID)
    const movedToTrash = [];
    const jobs = [[sent, 'HEADER X-Safe21-Ticket "1"'], ['INBOX', `BODY ${q(linkText)}`]];
    for (const [box, criteria] of jobs) {
      if (!box || box === trash) continue;
      await run(`SELECT ${q(box)}`);
      const uids = searchUids(await run(`UID SEARCH ${criteria}`));
      if (uids.length) {
        const out = await run(`UID MOVE ${uids.join(',')} ${q(trash)}`);
        for (const l of out) {
          const m = /\[COPYUID \d+ [\d,:]+ ([\d,:]+)\]/i.exec(l);
          if (m) for (const part of m[1].split(',')) {
            const [a, b] = part.split(':').map(Number);
            for (let u = a; u <= (b || a) && movedToTrash.length < 100000; u++) movedToTrash.push(String(u));
          }
        }
        moved += uids.length;
      }
    }
    await run(`SELECT ${q(trash)}`);
    const own = searchUids(await run('UID SEARCH HEADER X-Safe21-Ticket "1"'));
    const t = [...new Set([...own, ...movedToTrash])];
    if (t.length) {
      await run(`UID STORE ${t.join(',')} +FLAGS.SILENT (\\Deleted)`);
      await run('EXPUNGE');
    }
    try { await run('LOGOUT'); } catch { /* chiuso dal server */ }
    return { moved, deleted: t.length };
  } finally {
    setTimeout(() => sock.destroy(), 300).unref();
  }
}

module.exports = { sendMail, imapCleanup, buildMessage, MailError, addrOf };
