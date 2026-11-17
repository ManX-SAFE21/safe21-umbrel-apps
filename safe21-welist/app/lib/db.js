'use strict';
/*
 * Database (SQLite built into Node, no dependencies). All times are milliseconds since epoch.
 * One row per (host, chain); host = URL authority (name plus port when not the default one).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULTS = {
  price_bitcoin: '120000',
  price_testnet4: '0',
  period_months: '12',
  free_first: '0',
  min_conf: '1',
  check_minutes: '10',
  xpub: '',
  list_sequence: '0',
};

function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'welist.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_size_limit = 1048576;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS executors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      host TEXT NOT NULL,
      chain TEXT NOT NULL CHECK (chain IN ('bitcoin', 'testnet4')),
      pay_address TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      listed_until INTEGER NOT NULL DEFAULT 0,
      suspended INTEGER NOT NULL DEFAULT 0,
      credit INTEGER NOT NULL DEFAULT 0,
      seen_total INTEGER NOT NULL DEFAULT 0,
      paid_total INTEGER NOT NULL DEFAULT 0,
      base_fee INTEGER,
      daily_fee INTEGER,
      version TEXT NOT NULL DEFAULT '',
      info TEXT NOT NULL DEFAULT '',
      exec_address TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
      last_check INTEGER NOT NULL DEFAULT 0,
      last_ok INTEGER NOT NULL DEFAULT 0,
      fails INTEGER NOT NULL DEFAULT 0,
      last_credit_check INTEGER NOT NULL DEFAULT 0,
      seed INTEGER NOT NULL DEFAULT 0,
      UNIQUE (host, chain)
    );
    -- a (host, chain) that already had its free first period: kept forever, also after removal
    CREATE TABLE IF NOT EXISTS free_used (host TEXT NOT NULL, chain TEXT NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY (host, chain));
    -- fake payment backend only (preview and tests)
    CREATE TABLE IF NOT EXISTS fake_received (address TEXT PRIMARY KEY, sats INTEGER NOT NULL);
  `);

  const q = (sql) => db.prepare(sql);
  const sGet = q('SELECT value FROM settings WHERE key = ?');
  const sSet = q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const getSetting = (k) => { const r = sGet.get(k); return r ? r.value : (DEFAULTS[k] ?? ''); };
  const setSetting = (k, v) => sSet.run(k, String(v));
  const num = (k) => Number(getSetting(k));

  let depth = 0;
  function tx(fn) {
    if (depth > 0) return fn(); // already inside a transaction
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const r = fn();
      depth--;
      db.exec('COMMIT');
      return r;
    } catch (e) {
      depth--;
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  const store = {
    db, tx, getSetting, setSetting,
    settings() {
      return {
        price: { bitcoin: num('price_bitcoin'), testnet4: num('price_testnet4') },
        period_months: num('period_months'),
        free_first: getSetting('free_first') === '1',
        min_conf: num('min_conf'),
        check_minutes: num('check_minutes'),
        xpub: getSetting('xpub'),
      };
    },
    nextSequence() {
      return tx(() => {
        const n = Number(getSetting('list_sequence')) + 1;
        setSetting('list_sequence', n);
        return n;
      });
    },
    byId: (id) => q('SELECT * FROM executors WHERE id = ?').get(id),
    byPublicId: (pid) => q('SELECT * FROM executors WHERE public_id = ?').get(pid),
    byHostChain: (host, chain) => q('SELECT * FROM executors WHERE host = ? AND chain = ?').get(host, chain),
    all: () => q('SELECT * FROM executors ORDER BY chain, url').all(),
    listed: (now) => q('SELECT * FROM executors WHERE listed_until > ? AND suspended = 0 ORDER BY chain, url').all(now),
    pendingCount: () => q('SELECT COUNT(*) AS n FROM executors WHERE listed_until = 0 AND paid_total = 0').get().n,
    insert(row) {
      const pid = crypto.randomBytes(16).toString('base64url');
      const r = q(`INSERT INTO executors (public_id, url, host, chain, pay_address, created_at, listed_until, base_fee, daily_fee, version, info, exec_address, status, last_check, last_ok, fails, seed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
        pid, row.url, row.host, row.chain, row.pay_address || '', row.created_at, row.listed_until || 0,
        row.base_fee ?? null, row.daily_fee ?? null, row.version || '', row.info || '', row.exec_address || '',
        row.status || 'offline', row.last_check || 0, row.last_ok || 0, row.seed ? 1 : 0);
      return store.byId(Number(r.lastInsertRowid));
    },
    update(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new Error('bad column');
      q(`UPDATE executors SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    },
    remove: (id) => q('DELETE FROM executors WHERE id = ?').run(id),
    freeUsed: (host, chain) => !!q('SELECT 1 AS x FROM free_used WHERE host = ? AND chain = ?').get(host, chain),
    markFreeUsed: (host, chain, now) => q('INSERT OR IGNORE INTO free_used (host, chain, used_at) VALUES (?, ?, ?)').run(host, chain, now),
    deleteStalePending: (before) => q('DELETE FROM executors WHERE listed_until = 0 AND paid_total = 0 AND created_at < ?').run(before).changes,
    fakeReceived: (addr) => (q('SELECT sats FROM fake_received WHERE address = ?').get(addr) || { sats: 0 }).sats,
    fakeAdd: (addr, sats) => q('INSERT INTO fake_received (address, sats) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET sats = sats + excluded.sats').run(addr, sats),
    close: () => db.close(),
  };
  return store;
}

module.exports = { openDb, DEFAULTS };
