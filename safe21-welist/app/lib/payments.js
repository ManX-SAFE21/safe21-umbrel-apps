'use strict';
/*
 * Payment backends. Interface:
 *   newAddress(label) -> Promise<string>          a fresh receiving address
 *   received(address, minConf) -> Promise<number>  total sats received with >= minConf confirmations
 *   setXpub(xpub) -> Promise<string>               (core) prepare the watch-only wallet, returns the stored xpub
 *
 * No private key exists anywhere: `core` uses a watch-only descriptor wallet in Bitcoin Core,
 * `fake` invents addresses (preview and tests only).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

/* ---------- extended public key: base58check only (no BIP32, no bech32 here) ---------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha256d = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();

function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
function b58encode(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = '1' + out; }
  return out;
}

// version bytes: zpub/vpub (BIP84 notation) are rewritten to xpub/tpub, which is what Core accepts;
// ypub/upub (nested segwit) are refused because the wallet derives native segwit wpkh() addresses
const VERSIONS = {
  '0488b21e': 'xpub', '04b24746': 'xpub', // xpub, zpub -> xpub
  '043587cf': 'tpub', '045f1cc6': 'tpub', // tpub, vpub -> tpub
};
const TARGET = { xpub: '0488b21e', tpub: '043587cf' };

function normalizeXpub(input) {
  const s = String(input || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{100,120}$/.test(s)) return { ok: false, error: 'xpub_format' };
  const raw = b58decode(s);
  if (!raw || raw.length !== 82) return { ok: false, error: 'xpub_format' };
  const payload = raw.subarray(0, 78);
  if (!sha256d(payload).subarray(0, 4).equals(raw.subarray(78))) return { ok: false, error: 'xpub_checksum' };
  const ver = payload.subarray(0, 4).toString('hex');
  const kind = VERSIONS[ver];
  if (!kind) return { ok: false, error: 'xpub_type' };
  const key = payload[45];
  if (key !== 2 && key !== 3) return { ok: false, error: 'xpub_format' }; // must be a compressed public key
  const out = Buffer.from(payload);
  Buffer.from(TARGET[kind], 'hex').copy(out, 0);
  return { ok: true, xpub: b58encode(Buffer.concat([out, sha256d(out).subarray(0, 4)])), kind };
}

/* ---------- Bitcoin Core JSON-RPC ---------- */
class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function rpcClient({ url, user = '', pass = '', cookieFile = '', timeoutMs = 15000 }) {
  if (!url) throw new Error('BITCOIN_RPC_URL is not set');
  const base = new URL(url);
  let id = 0;
  function auth() {
    if (cookieFile) return fs.readFileSync(cookieFile, 'utf8').trim(); // re-read: Core rewrites it at every start
    return `${user}:${pass}`;
  }
  return function call(method, params = [], wallet = '') {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '1.0', id: ++id, method, params });
      const mod = base.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: base.hostname, port: base.port || (base.protocol === 'https:' ? 443 : 80), method: 'POST', agent: false,
        path: wallet ? `/wallet/${encodeURIComponent(wallet)}` : '/',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          Authorization: 'Basic ' + Buffer.from(auth()).toString('base64'),
        },
      });
      const timer = setTimeout(() => { req.destroy(new Error('rpc timeout')); }, timeoutMs);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size > 1 << 20) req.destroy(new Error('rpc answer too big')); else chunks.push(c); });
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new RpcError(-401, 'rpc authentication failed'));
          let j;
          try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new RpcError(-1, `rpc http ${res.statusCode}`)); }
          if (j && j.error) return reject(new RpcError(j.error.code, String(j.error.message || 'rpc error')));
          resolve(j ? j.result : null);
        });
      });
      req.end(body);
    });
  };
}

const WALLET = 'welist';

function coreBackend({ rpc, getXpub }) {
  async function ensureLoaded() {
    const loaded = await rpc('listwallets');
    if (Array.isArray(loaded) && loaded.includes(WALLET)) return;
    try {
      await rpc('loadwallet', [WALLET]);
    } catch (e) {
      if (e.code === -35) return; // already loaded
      if (e.code !== -18) throw e; // -18: not found -> create it
      // name, disable_private_keys, blank, passphrase, avoid_reuse, descriptors, load_on_startup
      await rpc('createwallet', [WALLET, true, true, '', false, true, true]);
    }
  }
  return {
    kind: 'core',
    async setXpub(input) {
      const n = normalizeXpub(input);
      if (!n.ok) { const e = new Error(n.error); e.code = n.error; throw e; }
      await ensureLoaded();
      const desc = `wpkh(${n.xpub}/0/*)`;
      const info = await rpc('getdescriptorinfo', [desc]);
      if (!info || typeof info.checksum !== 'string') throw new Error('getdescriptorinfo: no checksum');
      const r = await rpc('importdescriptors', [[{ desc: `${desc}#${info.checksum}`, active: true, range: [0, 999], timestamp: 'now', internal: false }]], WALLET);
      if (!Array.isArray(r) || !r[0] || r[0].success !== true) {
        throw new Error('importdescriptors failed: ' + JSON.stringify(r && r[0] && r[0].error ? r[0].error.message : r).slice(0, 200));
      }
      return n.xpub;
    },
    async newAddress(label = '') {
      if (!getXpub()) { const e = new Error('no xpub configured'); e.code = 'no_xpub'; throw e; }
      await ensureLoaded();
      const a = await rpc('getnewaddress', [String(label).slice(0, 60), 'bech32'], WALLET);
      if (typeof a !== 'string' || a.length > 100) throw new Error('getnewaddress: bad answer');
      // Listings are paid in real bitcoin: an address of any other network (a node running on
      // testnet/signet/regtest) must never be handed out, or worthless coins would buy a listing.
      if (!/^bc1[a-z0-9]{20,80}$/.test(a)) { const e = new Error('node is not on mainnet: refusing address'); e.code = 'not_mainnet'; throw e; }
      return a;
    },
    async received(address, minConf) {
      await ensureLoaded();
      const btc = await rpc('getreceivedbyaddress', [address, minConf], WALLET);
      if (typeof btc !== 'number' || !Number.isFinite(btc) || btc < 0) throw new Error('getreceivedbyaddress: bad answer');
      return Math.round(btc * 1e8);
    },
  };
}

function fakeBackend({ store }) {
  return {
    kind: 'fake',
    async setXpub(input) {
      const n = normalizeXpub(input);
      if (!n.ok) { const e = new Error(n.error); e.code = n.error; throw e; }
      return n.xpub;
    },
    async newAddress() { return 'bc1qfake' + crypto.randomBytes(16).toString('hex'); },
    async received(address) { return store.fakeReceived(address); },
  };
}

module.exports = { normalizeXpub, rpcClient, coreBackend, fakeBackend, RpcError, WALLET, b58encode, b58decode, sha256d };
