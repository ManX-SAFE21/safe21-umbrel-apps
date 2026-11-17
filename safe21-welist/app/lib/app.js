'use strict';
/*
 * Builds the whole service; server.js starts it from environment variables, the tests start it directly.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { openDb } = require('./db.js');
const { createListing } = require('./listing.js');
const { createRegistry, addMonths } = require('./registry.js');
const { createPublic } = require('./public.js');
const { createPanel } = require('./panel.js');
const P = require('./payments.js');
const G = require('./guard.js');
const W = require('./web.js');

const MIN = 60000;

function wrap(handler, log, csp) {
  return (req, res) => {
    handler(req, res).catch((e) => {
      if (!e.status) log.error(e);
      if (!res.headersSent) {
        const status = e.status || 500;
        if (req.url.startsWith('/api/')) W.sendJson(res, status, { ok: false, error: status === 413 ? 'too_large' : status === 415 ? 'bad_content_type' : status === 400 ? 'bad_json' : 'internal' });
        else W.sendHtml(res, status, status === 413 ? 'Request too large' : 'Error', csp);
      } else res.end();
      if (e.status === 413) res.on('finish', () => req.destroy());
    });
  };
}

// a few example executors so the preview page is not empty (fake payment mode only; never probed)
function seedPreview(store, now) {
  if (store.all().length) return;
  const t = now();
  const ex = [
    ['https://we.alfa-nodo.example', 'bitcoin', 1500, 20, '0.3.2', 'online', 3, 200],
    ['https://will.montagna.example', 'bitcoin', 1000, 10, '0.3.2', 'online', 5, 120],
    ['https://eredita.rete-sicura.example', 'bitcoin', 800, 25, '0.3.2', 'online', 12, 22],
    ['https://lascito.nordic-btc.example', 'bitcoin', 1200, null, '0.3.2', 'online', 4, 160],
    ['https://we.ponte-vecchio.example', 'bitcoin', 1800, 30, '0.3.1', 'offline', 75, 12],
    ['https://we.testlab.example', 'testnet4', 100, 1, '0.3.2', 'online', 2, 300],
    ['https://tn4.sviluppo.example', 'testnet4', 0, null, '0.3.0', 'offline', 190, 60],
  ];
  for (const [url, chain, base, daily, version, status, minAgo, days] of ex) {
    const last = t - minAgo * MIN;
    store.insert({
      url, host: url.slice(8), chain, pay_address: chain === 'bitcoin' ? 'bc1qfake' + crypto.randomBytes(16).toString('hex') : '',
      created_at: t, listed_until: t + days * 86400000, base_fee: base, daily_fee: daily, version, info: 'Esempio di anteprima',
      exec_address: '', status, last_check: last, last_ok: status === 'online' ? last : last - 3 * 86400000, seed: true,
    });
  }
}

function createApp(opts = {}) {
  const log = opts.log || console;
  const now = opts.now || Date.now;
  const dataDir = opts.dataDir || './data';
  const store = openDb(dataDir);
  if (!store.getSetting('secret')) store.setSetting('secret', crypto.randomBytes(32).toString('hex'));
  const secret = store.getSetting('secret');

  let payments;
  if (opts.payments) payments = opts.payments;
  else if (opts.paymentMode === 'fake') payments = P.fakeBackend({ store });
  else {
    const rpc = opts.rpc || P.rpcClient(opts.rpcConfig || {});
    payments = P.coreBackend({ rpc, getXpub: () => store.getSetting('xpub') });
  }
  if (payments.kind === 'fake' && opts.seed) seedPreview(store, now);

  const listing = createListing({ store, dataDir, now });
  const probeOpts = { allowPrivate: !!opts.allowPrivate, lookup: opts.lookup, timeoutMs: opts.probeTimeoutMs || 10000 };
  if (!probeOpts.lookup) delete probeOpts.lookup;
  const registry = createRegistry({ store, payments, listing, now, probeOpts, log, ...(opts.probe ? { probe: opts.probe } : {}) });
  const limiter = G.createLimiter();
  const sessions = G.createSessions();
  const handlePublic = createPublic({ store, registry, listing, limiter, trustProxy: !!opts.trustProxy, preview: payments.kind === 'fake', now });
  const handleAdmin = createPanel({ store, registry, listing, payments, limiter, sessions, secret, now, log });
  listing.publish();

  const pub = http.createServer(wrap(handlePublic, log, W.CSP_PUBLIC));
  const adm = http.createServer(wrap(handleAdmin, log, W.CSP_ADMIN));
  for (const s of [pub, adm]) { s.headersTimeout = 15000; s.requestTimeout = 20000; }

  /* ---------- timers ---------- */
  const timers = [];
  let stopped = false;
  function startTimers() {
    const loop = (fn, delayFn) => {
      const run = async () => {
        if (stopped) return;
        try { await fn(); } catch (e) { log.error(e); }
        if (!stopped) timers.push(setTimeout(run, delayFn()).unref());
      };
      return run;
    };
    timers.push(setTimeout(loop(() => registry.creditAll(), () => 5 * MIN), 20000).unref());
    timers.push(setTimeout(loop(() => registry.checkAll(), () => Math.max(1, store.settings().check_minutes) * MIN), 5000).unref());
    timers.push(setInterval(() => limiter.sweep(), 10 * MIN).unref());
  }

  function listen(port, adminPort, host = '0.0.0.0') {
    const l = (s, p) => new Promise((ok, ko) => { s.once('error', ko); s.listen(p, host, () => { s.off('error', ko); ok(s.address().port); }); });
    return Promise.all([l(pub, port), l(adm, adminPort)]);
  }

  async function close() {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    await Promise.all([pub, adm].map((s) => new Promise((ok) => { if (!s.listening) return ok(); s.closeAllConnections?.(); s.close(() => ok()); })));
    store.close();
  }

  return { store, registry, listing, payments, limiter, sessions, secret, pub, adm, listen, startTimers, close, addMonths };
}

module.exports = { createApp };
