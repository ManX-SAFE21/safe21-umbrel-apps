'use strict';
/*
 * Signed list: list.json (exact bytes signed), list.json.sig (base64 Ed25519 signature), pubkey.pem.
 * The key is generated at first start and kept in the data directory (signing-key.pem, mode 0600).
 * Fingerprint = SHA-256 of the raw 32-byte public key.
 * The served copy is kept in memory and swapped as a whole, so list and signature always match.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DAY = 86400000;

function writeAtomic(file, data, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

function loadKey(dir) {
  const keyFile = path.join(dir, 'signing-key.pem');
  let priv;
  if (fs.existsSync(keyFile)) {
    priv = crypto.createPrivateKey(fs.readFileSync(keyFile));
    if (priv.asymmetricKeyType !== 'ed25519') throw new Error('signing-key.pem is not an Ed25519 key');
  } else {
    const kp = crypto.generateKeyPairSync('ed25519');
    priv = kp.privateKey;
    writeAtomic(keyFile, priv.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  }
  try { fs.chmodSync(keyFile, 0o600); } catch { /* not supported on this file system */ }
  const pub = crypto.createPublicKey(priv);
  const pem = pub.export({ type: 'spki', format: 'pem' });
  const raw = Buffer.from(pub.export({ format: 'jwk' }).x, 'base64url');
  const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
  return { priv, pub, pem, raw, fingerprint };
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function createListing({ store, dataDir, now = Date.now }) {
  const key = loadKey(dataDir);
  writeAtomic(path.join(dataDir, 'pubkey.pem'), key.pem);
  let current = null;

  function build() {
    const t = now();
    const rows = store.listed(t).sort((a, b) => (a.chain === b.chain ? (a.url < b.url ? -1 : a.url > b.url ? 1 : 0) : a.chain < b.chain ? -1 : 1));
    const doc = {
      format: 1,
      sequence: store.nextSequence(),
      generated_at: iso(t),
      valid_until: iso(t + DAY),
      executors: rows.map((r) => ({
        url: r.url, chain: r.chain, base_fee: r.base_fee, daily_fee: r.daily_fee, version: r.version, info: r.info,
        status: r.status, last_ok: iso(r.last_ok), listed_until: iso(r.listed_until),
      })),
    };
    return Buffer.from(JSON.stringify(doc, null, 1) + '\n', 'utf8');
  }

  function publish() {
    const body = build();
    const sig = crypto.sign(null, body, key.priv).toString('base64');
    writeAtomic(path.join(dataDir, 'list.json'), body);
    writeAtomic(path.join(dataDir, 'list.json.sig'), sig + '\n');
    current = { body, sig: Buffer.from(sig + '\n') };
    return current;
  }

  return {
    publish,
    current: () => current || publish(),
    pubkeyPem: key.pem,
    fingerprint: key.fingerprint,
    verify: (body, sigB64) => crypto.verify(null, body, key.pub, Buffer.from(String(sigB64).trim(), 'base64')),
  };
}

module.exports = { createListing, loadKey };
