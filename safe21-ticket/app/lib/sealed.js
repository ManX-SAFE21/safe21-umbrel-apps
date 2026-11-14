'use strict';
/*
 * Copia di sicurezza protetta da password.
 * La password scelta dal gestore diventa una chiave con scrypt (lento apposta: provare password a
 * raffica costa molto); la copia si cifra con AES-256-GCM, che si accorge anche di ogni modifica al file.
 * La password non viene mai salvata: se si perde, la copia non si apre più.
 */
const crypto = require('node:crypto');

const KDF = { N: 2 ** 15, r: 8, p: 1 }; // circa 32 MB e una frazione di secondo per ogni tentativo
const MIN_PW = 12; // come la password del pannello
const MAX_PW = 200;

function deriveKey(pw, salt, { N, r, p }) {
  return new Promise((ok, ko) => crypto.scrypt(String(pw).normalize('NFC'), salt, 32, { N, r, p, maxmem: 128 * N * r * 2 }, (e, k) => (e ? ko(e) : ok(k))));
}

// oggetto -> busta cifrata (anche lei JSON, così il file resta un .json)
async function seal(obj, pw) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(pw, salt, KDF);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const head = { app: 'safe21-ticket', format: 2, kdf: 'scrypt', ...KDF };
  c.setAAD(Buffer.from(JSON.stringify(head))); // anche i parametri sono protetti: cambiarli rompe la copia
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { ...head, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

const isSealed = (d) => !!d && typeof d === 'object' && d.app === 'safe21-ticket' && d.format === 2;

// busta cifrata -> oggetto; errore con messaggio chiaro se la password è sbagliata o il file è rovinato
async function open(env, pw) {
  const fail = (why) => { throw new Error(why); };
  const b64 = (v, len) => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) fail('File non valido: copia protetta rovinata.');
    const b = Buffer.from(v, 'base64');
    if (len !== undefined && b.length !== len) fail('File non valido: copia protetta rovinata.');
    return b;
  };
  // solo i parametri scritti da questa app: un file preparato non può chiedere uno scrypt enorme
  if (env.kdf !== 'scrypt' || env.N !== KDF.N || env.r !== KDF.r || env.p !== KDF.p) fail('File non valido: copia protetta con parametri sconosciuti.');
  const salt = b64(env.salt, 16); const iv = b64(env.iv, 12); const tag = b64(env.tag, 16); const data = b64(env.data);
  const key = await deriveKey(pw, salt, KDF);
  const head = { app: 'safe21-ticket', format: 2, kdf: 'scrypt', N: env.N, r: env.r, p: env.p };
  let text;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.from(JSON.stringify(head)));
    d.setAuthTag(tag);
    text = Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch { fail('Password sbagliata, oppure il file è stato modificato.'); }
  try { return JSON.parse(text); } catch { return fail('File non valido: contenuto non leggibile.'); }
}

module.exports = { seal, open, isSealed, MIN_PW, MAX_PW, KDF };
