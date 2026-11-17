'use strict';
/*
 * Service logic: check, registration, crediting, check cycle, cleanup, admin actions.
 *
 * Crediting rule (idempotent, one transaction per executor):
 *   total = received(address, minConf); new = total - seen_total (never negative; seen_total never goes down)
 *   credit += new; every full `price` in credit extends listed_until by `period` months starting from
 *   max(now, listed_until); the remainder stays as credit.
 */
const { checkUrl, CHAINS } = require('./netpolicy.js');
const { probe: realProbe } = require('./probe.js');

const DAY = 86400000;
const PENDING_CAP = 500;
const PENDING_MAX_AGE = 14 * DAY;

// add months in UTC, clamping to the last day of the target month (31 Jan + 1 = 28/29 Feb)
function addMonths(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

const err = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

function createRegistry({ store, payments, listing, now = Date.now, probeOpts = {}, probe = realProbe, log = console }) {
  const doProbe = (url, chain) => probe(url, chain, probeOpts);
  const allowPrivate = !!probeOpts.allowPrivate;

  function isListed(row, t = now()) { return row.listed_until > t && !row.suspended; }

  function publicStatus(row) {
    const s = store.settings();
    const t = now();
    return {
      public_id: row.public_id, url: row.url, chain: row.chain,
      pay_address: row.pay_address, price: s.price[row.chain], period_months: s.period_months, min_conf: s.min_conf,
      listed: isListed(row, t), listed_until: row.listed_until ? new Date(row.listed_until).toISOString() : null,
      suspended: !!row.suspended, credit: row.credit, paid_total: row.paid_total,
      status: row.status,
      values: { chain: row.chain, base_fee: row.base_fee, daily_fee: row.daily_fee, version: row.version, info: row.info, address: row.exec_address },
    };
  }

  function validInput(body) {
    if (typeof body.chain !== 'string' || !CHAINS.includes(body.chain)) return err(400, 'bad_chain');
    const u = checkUrl(body.url, { allowPrivate });
    if (!u.ok) return err(400, u.error);
    return { ok: true, u, chain: body.chain };
  }

  function offer(u, chain) {
    const s = store.settings();
    const existing = store.byHostChain(u.authority, chain);
    return {
      price: s.price[chain], period_months: s.period_months, min_conf: s.min_conf,
      free_first: s.free_first && s.price[chain] > 0 && !store.freeUsed(u.authority, chain),
      registered: !!existing,
    };
  }

  async function check(body) {
    const v = validInput(body);
    if (!v.ok) return v;
    const r = await doProbe(v.u.url, v.chain);
    if (!r.ok) return err(422, r.error, { status_code: r.status, field: r.field, detail: r.detail });
    return { ok: true, url: v.u.url, chain: v.chain, values: r.values, offer: offer(v.u, v.chain) };
  }

  function probeFields(values, t) {
    return {
      base_fee: values.base_fee, daily_fee: values.daily_fee, version: values.version, info: values.info,
      exec_address: values.address, status: 'online', last_check: t, last_ok: t, fails: 0,
    };
  }

  async function register(body) {
    const v = validInput(body);
    if (!v.ok) return v;
    const { u, chain } = v;
    const r = await doProbe(u.url, chain);
    if (!r.ok) return err(422, r.error, { status_code: r.status, field: r.field, detail: r.detail });
    const s = store.settings();
    const price = s.price[chain];
    let t = now();

    const existing = store.byHostChain(u.authority, chain);
    if (existing) {
      const f = probeFields(r.values, t);
      // free chain: renewed for free on request (listed until now + one period, never shortened)
      if (price === 0 && !existing.suspended) f.listed_until = Math.max(existing.listed_until, addMonths(t, s.period_months));
      // row created while the chain was free and the chain now has a price: it needs an address to renew
      if (price > 0 && !existing.pay_address) {
        try { f.pay_address = await payments.newAddress(`welist ${u.authority} ${chain}`); } catch (e) { log.error('newAddress failed:', e.message); }
      }
      store.update(existing.id, f);
      if (f.listed_until !== undefined) listing.publish();
      return { ok: true, created: false, ...publicStatus(store.byId(existing.id)) };
    }

    if (store.pendingCount() >= PENDING_CAP) return err(503, 'too_many_pending');
    let pay = '';
    if (price > 0) {
      try {
        pay = await payments.newAddress(`welist ${u.authority} ${chain}`);
      } catch (e) {
        log.error('newAddress failed:', e.message);
        return err(503, 'payments_unavailable');
      }
    }
    t = now();
    let listedUntil = 0;
    let created = true;
    const row = store.tx(() => {
      // a parallel request may have created it while we were waiting for the address
      const again = store.byHostChain(u.authority, chain);
      if (again) { created = false; return again; }
      if (price === 0) listedUntil = addMonths(t, s.period_months);
      else if (s.free_first && !store.freeUsed(u.authority, chain)) {
        listedUntil = addMonths(t, s.period_months);
        store.markFreeUsed(u.authority, chain, t);
      }
      return store.insert({ url: u.url, host: u.authority, chain, pay_address: pay, created_at: t, listed_until: listedUntil, ...probeFieldsInsert(r.values, t) });
    });
    if (created && listedUntil) listing.publish();
    return { ok: true, created, ...publicStatus(row) };
  }

  function probeFieldsInsert(values, t) {
    const f = probeFields(values, t);
    return { base_fee: f.base_fee, daily_fee: f.daily_fee, version: f.version, info: f.info, exec_address: f.exec_address, status: 'online', last_check: t, last_ok: t };
  }

  /* ---------- crediting ---------- */
  function applyReceived(id, total) {
    return store.tx(() => {
      const row = store.byId(id);
      if (!row) return null;
      const s = store.settings();
      const price = s.price[row.chain];
      const t = now();
      let { credit, seen_total: seen, paid_total: paid, listed_until: until } = row;
      let added = 0;
      let periods = 0;
      if (Number.isSafeInteger(total) && total > seen) {
        added = total - seen;
        credit += added;
        paid += added;
        seen = total;
      }
      if (price > 0 && credit >= price) {
        periods = Math.floor(credit / price);
        until = addMonths(Math.max(t, until), periods * s.period_months);
        credit -= periods * price;
      }
      if (added || periods) store.update(id, { credit, seen_total: seen, paid_total: paid, listed_until: until, last_credit_check: t });
      else store.update(id, { last_credit_check: t });
      return { added, periods, listed_until: until };
    });
  }

  async function creditOne(row) {
    if (!row.pay_address) return null;
    const total = await payments.received(row.pay_address, store.settings().min_conf);
    return applyReceived(row.id, total);
  }

  let crediting = false;
  async function creditAll() {
    if (crediting) return { skipped: true };
    crediting = true;
    let changed = 0;
    try {
      for (const row of store.all()) {
        if (!row.pay_address || row.seed) continue;
        try {
          const r = await creditOne(row);
          if (r && (r.added || r.periods)) changed++;
        } catch (e) { log.error(`credit check failed for ${row.url}:`, e.message); }
      }
      const removed = store.deleteStalePending(now() - PENDING_MAX_AGE);
      if (changed || removed) listing.publish();
      return { changed, removed };
    } finally { crediting = false; }
  }

  // registration page polling: refresh this one row at most every 30 s (a cache, not a limit)
  async function status(publicId) {
    if (typeof publicId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(publicId)) return err(404, 'not_found');
    let row = store.byPublicId(publicId);
    if (!row) return err(404, 'not_found');
    if (row.pay_address && !row.seed && now() - row.last_credit_check > 30000) {
      store.update(row.id, { last_credit_check: now() }); // claim the slot before the slow call
      try {
        const r = await creditOne(row);
        if (r && (r.added || r.periods)) listing.publish();
      } catch (e) { log.error('credit check failed:', e.message); }
      row = store.byId(row.id) || row;
    }
    return { ok: true, ...publicStatus(row) };
  }

  /* ---------- check cycle ---------- */
  let checking = false;
  async function checkAll({ concurrency = 4 } = {}) {
    if (checking) return { skipped: true };
    checking = true;
    try {
      const rows = store.listed(now()).filter((r) => !r.seed);
      let i = 0;
      let okCount = 0;
      const worker = async () => {
        while (i < rows.length) {
          const row = rows[i++];
          let r;
          try { r = await doProbe(row.url, row.chain); } catch (e) { r = { ok: false, error: 'internal' }; log.error(e); }
          const t = now();
          if (!store.byId(row.id)) continue; // removed meanwhile
          if (r.ok) { okCount++; store.update(row.id, probeFields(r.values, t)); }
          else store.update(row.id, { status: 'offline', last_check: t, fails: (store.byId(row.id).fails || 0) + 1 });
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
      listing.publish();
      return { checked: rows.length, online: okCount };
    } finally { checking = false; }
  }

  /* ---------- admin ---------- */
  function adminAction(id, op) {
    const row = store.byId(id);
    if (!row) return false;
    if (op === 'suspend') store.update(id, { suspended: 1 });
    else if (op === 'restore') store.update(id, { suspended: 0 });
    else if (op === 'remove') store.remove(id);
    else return false;
    listing.publish();
    return true;
  }

  return { check, register, status, creditAll, creditOne, applyReceived, checkAll, adminAction, publicStatus, isListed, offer };
}

module.exports = { createRegistry, addMonths, PENDING_CAP, PENDING_MAX_AGE };
