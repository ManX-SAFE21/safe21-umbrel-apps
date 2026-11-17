'use strict';
/*
 * Will Executor List (welist) - public directory of Bitcoin Will Executors.
 * Node >= 22, zero npm dependencies.
 *  - public server  PORT       (default 3000): page, JSON API, signed list
 *  - admin panel    ADMIN_PORT (default 3001): never expose it to the internet
 *
 * Environment:
 *  DATA_DIR (./data)   WELIST_PAYMENT=core|fake (core)   WELIST_SEED=1 (fake only: example rows)
 *  BITCOIN_RPC_URL, BITCOIN_RPC_USER + BITCOIN_RPC_PASS or BITCOIN_RPC_COOKIE
 *  TRUST_PROXY=1 (read CF-Connecting-IP / X-Forwarded-For)   WELIST_ALLOW_PRIVATE=1 (TESTS ONLY)
 */
const { createApp } = require('./lib/app.js');

const VERSION = '0.1.0';
const env = process.env;
const paymentMode = env.WELIST_PAYMENT === 'fake' ? 'fake' : 'core';
const allowPrivate = env.WELIST_ALLOW_PRIVATE === '1';

if (allowPrivate) {
  console.warn('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.warn('!!! WELIST_ALLOW_PRIVATE=1: http and PRIVATE/LOOPBACK addresses are accepted. !!!');
  console.warn('!!! SSRF protection is OFF. Test use only - never in production.             !!!');
  console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
}
if (paymentMode === 'fake') {
  console.warn('\n!!! WELIST_PAYMENT=fake: payments are SIMULATED, addresses are invented. Preview/tests only. !!!\n');
}

const app = createApp({
  dataDir: env.DATA_DIR || './data',
  paymentMode,
  seed: paymentMode === 'fake' && env.WELIST_SEED === '1',
  allowPrivate,
  trustProxy: env.TRUST_PROXY === '1',
  rpcConfig: {
    url: env.BITCOIN_RPC_URL || 'http://127.0.0.1:8332',
    user: env.BITCOIN_RPC_USER || '',
    pass: env.BITCOIN_RPC_PASS || '',
    cookieFile: env.BITCOIN_RPC_COOKIE || '',
  },
});

process.on('uncaughtException', (e) => console.error('unhandled error:', e));
process.on('unhandledRejection', (e) => console.error('unhandled error:', e));

const port = Number(env.PORT || 3000);
const adminPort = Number(env.ADMIN_PORT || 3001);
app.listen(port, adminPort).then(() => {
  console.log(`welist ${VERSION}: public on :${port}, admin panel on :${adminPort}, payments=${paymentMode}`);
  console.log(`signing key fingerprint (sha256 of raw Ed25519 key): ${app.listing.fingerprint}`);
  app.startTimers();
}).catch((e) => { console.error('start failed:', e.code || e.message); process.exit(1); });
