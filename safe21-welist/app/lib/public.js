'use strict';
/*
 * Public server routes. The page itself is static (static/index.html + app.js + style.css) and reads
 * everything from the JSON API; executor values are inserted with textContent only, never as HTML.
 */
const W = require('./web.js');
const G = require('./guard.js');

const MIN = 60000;

function createPublic({ store, registry, listing, limiter, trustProxy = false, preview = false, now = Date.now, maxConcurrentProbes = 8 }) {
  let probesInFlight = 0;

  const ipKey = (req) => G.netKey(G.clientIp(req, trustProxy));

  function listPayload() {
    const t = now();
    return {
      preview,
      fingerprint: listing.fingerprint,
      prices: store.settings().price,
      period_months: store.settings().period_months,
      executors: store.listed(t).map((r) => ({
        url: r.url, chain: r.chain, base_fee: r.base_fee, daily_fee: r.daily_fee, version: r.version, info: r.info,
        status: r.status, last_check: r.last_check ? new Date(r.last_check).toISOString() : null,
        last_ok: r.last_ok ? new Date(r.last_ok).toISOString() : null,
        listed_until: new Date(r.listed_until).toISOString(),
      })),
    };
  }

  async function withProbeSlot(res, fn) {
    if (probesInFlight >= maxConcurrentProbes) return W.sendJson(res, 503, { ok: false, error: 'busy' });
    probesInFlight++;
    try { return await fn(); } finally { probesInFlight--; }
  }

  function reply(res, r) {
    if (!r.ok) {
      const { status, ...rest } = r;
      return W.sendJson(res, status || 400, rest);
    }
    return W.sendJson(res, 200, r);
  }

  return async function handlePublic(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' || m === 'HEAD') {
      if (p === '/health') return W.sendText(res, 200, 'ok');
      if (p === '/list.json') return W.send(res, 200, listing.current().body, { 'Content-Type': 'application/json; charset=utf-8', ...W.CORS });
      if (p === '/list.json.sig') return W.send(res, 200, listing.current().sig, { 'Content-Type': 'text/plain; charset=utf-8', ...W.CORS });
      if (p === '/pubkey.pem') return W.send(res, 200, listing.pubkeyPem, { 'Content-Type': 'text/plain; charset=utf-8', ...W.CORS });
      if (p === '/api/list') {
        if (!limiter.hit('list:' + ipKey(req), 300, 10 * MIN)) return W.sendJson(res, 429, { ok: false, error: 'rate_limited' }, W.CORS);
        const chain = url.searchParams.get('chain');
        const data = listPayload();
        if (chain) {
          if (chain !== 'bitcoin' && chain !== 'testnet4') return W.sendJson(res, 400, { ok: false, error: 'bad_chain' }, W.CORS);
          data.executors = data.executors.filter((e) => e.chain === chain);
        }
        return W.sendJson(res, 200, data, W.CORS);
      }
      const sm = /^\/api\/status\/([^/]{1,64})$/.exec(p);
      if (sm) {
        if (!limiter.hit('status:' + ipKey(req), 120, 10 * MIN)) return W.sendJson(res, 429, { ok: false, error: 'rate_limited' });
        return reply(res, await registry.status(sm[1]));
      }
      if (p === '/' || p === '/index.html') {
        if (p === '/index.html') return W.redirect(res, '/');
        return W.serveStatic(res, '/') || W.sendText(res, 404, 'Not found');
      }
      if (W.serveStatic(res, p)) return;
      return W.sendText(res, 404, 'Not found');
    }

    if (m === 'POST' && (p === '/api/check' || p === '/api/register')) {
      const kind = p === '/api/check' ? 'check' : 'register';
      // limits by client address only: nobody can use up a quota tied to an executor named in the request
      const ok = kind === 'check'
        ? limiter.hit('check:' + ipKey(req), 10, 10 * MIN)
        : limiter.hit('register:' + ipKey(req), 5, 60 * MIN);
      if (!ok) { req.resume(); return W.sendJson(res, 429, { ok: false, error: 'rate_limited' }); }
      const body = await W.readJson(req, 1024);
      return withProbeSlot(res, async () => reply(res, await registry[kind](body)));
    }

    if (m === 'OPTIONS' && ['/list.json', '/list.json.sig', '/pubkey.pem', '/api/list'].includes(p)) return W.send(res, 204, '', { ...W.CORS, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' });
    return W.sendText(res, 405, 'Method not allowed', { Allow: 'GET, POST' });
  };
}

module.exports = { createPublic };
