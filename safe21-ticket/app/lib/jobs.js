'use strict';
/*
 * Automatismi (all'avvio e poi ogni ora):
 *  - chiusura: ticket «in attesa del cliente» senza movimenti da autoclose_days giorni (14) -> chiuso,
 *    con l'avviso «Ticket chiuso». I ticket «da rispondere» (aspettano il gestore) non si toccano mai,
 *    né quelli con una risposta del gestore non ancora partita per email.
 *  - cancellazione: ticket chiusi da più di 30 giorni -> cancellati per sempre con i messaggi (D3),
 *    poi il diario del database viene svuotato.
 * Prudenze: niente lavoro se l'orologio sembra tornato indietro, per un giorno dopo un ripristino,
 * e dopo un periodo da spento il tempo passato da spento non conta per la chiusura.
 * Al massimo 20 chiusure e 200 cancellazioni per giro: il resto al giro dopo.
 */
const DAY = 86400000;
const KEEP_DAYS = 30;
const MAX_CLOSE = 20;
const MAX_DELETE = 200;

const autocloseDays = (getSetting) => {
  const n = Number(getSetting('autoclose_days', '14'));
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 14;
};
const ms = (iso) => (typeof iso === 'string' && iso ? Date.parse(iso) : NaN);

module.exports = function makeJobs({ store, publicUrl = '', intervalMs = 3600000 }) {
  const { db, getSetting, setSetting } = store;
  const base = () => (getSetting('public_url') || publicUrl || 'https://ticket.safe21.io').replace(/\/+$/, '');

  function lastRun() { try { return JSON.parse(getSetting('jobs_last', 'null')); } catch { return null; } }
  const record = (r) => setSetting('jobs_last', JSON.stringify({ at: new Date().toISOString(), ...r }));

  function runNow() {
    const now = Date.now();
    // 1) prudenze sull'orologio e sul ripristino
    const hold = ms(getSetting('jobs_hold_until'));
    if (Number.isFinite(hold) && now < hold) { record({ closed: 0, deleted: 0, skipped: 'ripristino' }); return { closed: 0, deleted: 0, skipped: 'ripristino' }; }
    const last = lastRun();
    const lastAt = ms(last && last.at);
    const newest = ms(db.prepare("SELECT MAX(MAX(updated_at, closed_at)) AS m FROM tickets").get().m);
    if ((Number.isFinite(lastAt) && now < lastAt - 60000) || (Number.isFinite(newest) && now < newest - 60000)) {
      console.error('automatismi: l\'orologio sembra tornato indietro, nessuna chiusura o cancellazione');
      return { closed: 0, deleted: 0, skipped: 'orologio' };
    }
    // giorni passati da spento (oltre 2 ore senza giri): i clienti non potevano rispondere, quindi
    // l'attesa dei ticket «in attesa del cliente» si sposta avanti dello stesso tempo
    const downtime = Number.isFinite(lastAt) && now - lastAt > 2 * 3600000 ? now - lastAt : 0;
    if (downtime) {
      const shift = db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?');
      store.tx(() => {
        for (const t of db.prepare("SELECT id, updated_at FROM tickets WHERE status = 'waiting'").all()) {
          const u = ms(t.updated_at);
          if (Number.isFinite(u)) shift.run(new Date(Math.min(u + downtime, now)).toISOString(), t.id);
        }
      });
    }

    // 2) chiusura automatica
    let closed = 0;
    const limit = new Date(now - autocloseDays(getSetting) * DAY).toISOString();
    const waiting = db.prepare(`SELECT * FROM tickets t WHERE status = 'waiting' AND updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM mail_queue q WHERE q.ticket_id = t.id AND q.kind = 'reply')
      ORDER BY updated_at LIMIT ?`).all(limit, MAX_CLOSE);
    for (const t of waiting) {
      if (!Number.isFinite(ms(t.updated_at))) continue;
      try {
        store.tx(() => {
          store.setStatus(t.id, 'closed');
          db.prepare('UPDATE tickets SET auto_closed = 1 WHERE id = ?').run(t.id);
          // il link non si cambia mai qui: se non si può leggere, il ticket si chiude senza avviso
          const token = store.peekToken(t.id);
          if (token) store.queueMail(t.id, t.email, 'closed', `${base()}/t/${token}`);
        });
        closed++;
      } catch (e) { console.error(`chiusura automatica del ticket ${t.id}:`, e.message); }
    }
    // 3) ticket chiusi senza una data di chiusura leggibile: la data diventa adesso (si cancellano fra 30 giorni)
    db.prepare("UPDATE tickets SET closed_at = ? WHERE status = 'closed' AND (closed_at = '' OR closed_at NOT LIKE '____-__-__T__:__:__%Z')")
      .run(new Date(now).toISOString());

    // 4) cancellazione 30 giorni dopo la chiusura
    let deleted = 0;
    const old = new Date(now - KEEP_DAYS * DAY).toISOString();
    for (const t of db.prepare("SELECT id, closed_at FROM tickets WHERE status = 'closed' AND closed_at < ? ORDER BY closed_at LIMIT ?").all(old, MAX_DELETE)) {
      if (!Number.isFinite(ms(t.closed_at))) continue;
      try { store.deleteTicket(t.id); deleted++; } catch (e) { console.error(`cancellazione del ticket ${t.id}:`, e.message); }
    }
    if (deleted) store.purgeDisk();
    record({ closed, deleted });
    return { closed, deleted };
  }

  const safeRun = () => { try { runNow(); } catch (e) { console.error('automatismi:', e.message); } };
  setTimeout(safeRun, Math.min(2000, intervalMs)).unref();
  setInterval(safeRun, intervalMs).unref();

  return { runNow, autocloseDays: () => autocloseDays(getSetting), KEEP_DAYS };
};
