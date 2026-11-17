'use strict';
/*
 * Probe of an executor: GET <url>/<chain>/info.
 *
 * SSRF defence: the name is resolved HERE, every resolved address must be public, then the
 * connection goes to the validated address only (custom `lookup`, so a second DNS answer cannot
 * change it) while TLS SNI, certificate check and Host header keep the real name.
 * No redirects, 10 s total, body capped at 4 KB, must be a JSON object with valid fields.
 */
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { CHAINS, checkUrl, isBlockedAddress } = require('./netpolicy.js');

const FEE_MAX = 1e9;
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// control characters, zero-width and bidi overrides are removed from executor strings
const range = (a, b) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const CTRL = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => range(a, b)).join('')}]`, 'gu');
const clean = (s) => s.replace(CTRL, '').trim();

function parseInfo(buf, chain) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return fail('not_json'); }
  let d;
  try { d = JSON.parse(text); } catch { return fail('not_json'); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return fail('not_object');
  const has = (k) => Object.hasOwn(d, k) && d[k] !== null && d[k] !== undefined;
  if (d.chain !== chain) return fail('wrong_chain', { got: typeof d.chain === 'string' ? clean(d.chain).slice(0, 20) : '' });
  const fee = (k) => Number.isInteger(d[k]) && d[k] >= 0 && d[k] <= FEE_MAX;
  if (!has('base_fee') || !fee('base_fee')) return fail('bad_field', { field: 'base_fee' });
  if (has('daily_fee') && !fee('daily_fee')) return fail('bad_field', { field: 'daily_fee' });
  const str = (k, max) => {
    if (!has(k)) return '';
    if (typeof d[k] !== 'string') return null;
    const v = clean(d[k]);
    return v.length <= max ? v : null;
  };
  const version = str('version', 32);
  if (version === null) return fail('bad_field', { field: 'version' });
  const info = str('info', 200);
  if (info === null) return fail('bad_field', { field: 'info' });
  const address = str('address', 100);
  if (address === null) return fail('bad_field', { field: 'address' });
  return {
    ok: true,
    values: { chain, base_fee: d.base_fee, daily_fee: has('daily_fee') ? d.daily_fee : null, version, info, address },
  };
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, ko) => { t = setTimeout(() => ko(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

function tlsError(e) {
  return /^ERR_TLS|CERT|SELF_SIGNED|UNABLE_TO_|ERR_SSL/.test(String(e && e.code));
}

function fetchInfo(u, chain, pick, ms, maxBytes) {
  return new Promise((resolve) => {
    let done = false;
    let req;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(fail('timeout')), Math.max(1, ms));
    const pinned = (hostname, options, cb) => {
      if (typeof options === 'function') { cb = options; options = {}; }
      if (options && options.all) cb(null, [{ address: pick.address, family: pick.family }]);
      else cb(null, pick.address, pick.family);
    };
    const opts = {
      hostname: u.host, port: u.port, path: `/${chain}/info`, method: 'GET', agent: false, lookup: pinned,
      maxHeaderSize: 8192,
      headers: { Accept: 'application/json', 'User-Agent': 'welist-checker/0.1', Connection: 'close' },
    };
    if (u.scheme === 'https') Object.assign(opts, { servername: u.host, minVersion: 'TLSv1.2' });
    try {
      req = (u.scheme === 'https' ? https : http).request(opts);
    } catch (e) {
      finish(fail('connect', { detail: String(e.code || 'error') }));
      return;
    }
    req.on('error', (e) => finish(fail(tlsError(e) ? 'tls' : 'connect', { detail: String(e.code || 'error').slice(0, 40) })));
    req.on('response', (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) return finish(fail('redirect', { status: res.statusCode }));
      if (res.statusCode !== 200) return finish(fail('http_status', { status: res.statusCode }));
      if (Number(res.headers['content-length']) > maxBytes) return finish(fail('too_big'));
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) return finish(fail('too_big'));
        chunks.push(c);
      });
      res.on('end', () => finish(parseInfo(Buffer.concat(chunks), chain)));
      res.on('error', (e) => finish(fail('connect', { detail: String(e.code || 'error').slice(0, 40) })));
    });
    req.end();
  });
}

/*
 * probe(url, chain, opts) -> { ok:true, values } | { ok:false, error, ... }
 * opts.lookup(host, {all:true}) -> Promise<[{address, family}]> (tests inject a fake resolver)
 */
async function probe(rawUrl, chain, { lookup = dns.promises.lookup, allowPrivate = false, timeoutMs = 10000, maxBytes = 4096 } = {}) {
  if (!CHAINS.includes(chain)) return fail('bad_chain');
  const u = checkUrl(rawUrl, { allowPrivate });
  if (!u.ok) return u;
  const start = Date.now();
  let addrs;
  try {
    addrs = await withTimeout(lookup(u.host, { all: true, verbatim: true }), timeoutMs);
  } catch (e) {
    return fail(e && e.message === 'timeout' ? 'timeout' : 'dns');
  }
  if (!Array.isArray(addrs) || addrs.length === 0) return fail('dns');
  if (addrs.some((a) => !a || typeof a.address !== 'string' || (a.family !== 4 && a.family !== 6))) return fail('dns');
  if (!allowPrivate && addrs.some((a) => isBlockedAddress(a.address))) return fail('private_address');
  const left = timeoutMs - (Date.now() - start);
  if (left <= 0) return fail('timeout');
  return fetchInfo(u, chain, addrs[0], left, maxBytes);
}

module.exports = { probe, parseInfo };
