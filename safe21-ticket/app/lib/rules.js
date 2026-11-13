'use strict';
/*
 * Regole comuni sui valori: le usano il modulo pubblico, le impostazioni del pannello e il
 * ripristino della copia di sicurezza (un file di copia può essere stato preparato da altri).
 */

// indirizzi email solo con caratteri semplici: l'indirizzo finirà nelle intestazioni dell'email
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const validEmail = (v) => typeof v === 'string' && v.length <= 200 && EMAIL_RE.test(v);
const noCtl = (v) => !/[\u0000-\u001f\u007f]/.test(v);

// Impostazioni modificabili: chiave -> controllo. Nessun'altra chiave entra da un modulo o da una copia.
const SMTP_PORTS = ['25', '465', '587', '2525'];
const SETTINGS = {
  smtp_host: (v) => v === '' || /^[A-Za-z0-9.-]{1,253}$/.test(v),
  smtp_port: (v) => v === '' || SMTP_PORTS.includes(v),
  smtp_user: (v) => v.length <= 200 && noCtl(v),
  smtp_pass: (v) => v.length <= 200 && noCtl(v),
  smtp_from: (v) => v.length <= 200 && noCtl(v),
  public_url: (v) => v === '' || /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d{1,5})?\/?$/.test(v),
  autoclose_days: (v) => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 90,
  tg_token: (v) => v === '' || /^\d+:[A-Za-z0-9_-]{20,}$/.test(v),
  tg_chat: (v) => v === '' || /^-?\d{1,20}$/.test(v),
  // pulizia delle copie in Gmail (vuoto = spenta): server IMAP, sempre cifrato sulla porta 993
  imap_host: (v) => v === '' || /^[A-Za-z0-9.-]{1,253}$/.test(v),
};
// segreti: mai mostrati nelle pagine, mai nella copia di sicurezza, mai presi da una copia
const SECRET_KEYS = ['smtp_pass', 'tg_token'];

const LIMITS = { name: 80, topic: 100, body: 10000 };

module.exports = { EMAIL_RE, validEmail, noCtl, SETTINGS, SECRET_KEYS, SMTP_PORTS, LIMITS };
