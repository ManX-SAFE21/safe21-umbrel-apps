'use strict';
/*
 * Regole comuni sui valori: le usano il modulo pubblico, le impostazioni del pannello e il
 * ripristino della copia di sicurezza (un file di copia può essere stato preparato da altri).
 */

// indirizzi email solo con caratteri semplici: l'indirizzo finirà nelle intestazioni dell'email
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const validEmail = (v) => typeof v === 'string' && v.length <= 200 && EMAIL_RE.test(v);
const noCtl = (v) => !/[\u0000-\u001f\u007f]/.test(v);

/*
 * Argomenti del modulo pubblico: li sceglie il gestore nelle impostazioni (uno per riga).
 * Ogni ticket salva il NOME dell'argomento: cambiare o togliere un argomento non tocca i ticket vecchi.
 * Impostazione vuota = argomenti di partenza.
 */
const DEFAULT_TOPICS = ["Àncòra — plugin per l'eredità", 'Easy Heirs', 'Schèi wallet', 'Corsi ed eventi', 'Altro'];
const TOPICS_MAX = 15;
const TOPIC_LEN = 60;
// caratteri invisibili o che girano il testo: un argomento deve essere quello che si vede
const INVISIBLE = /[\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
// testo della casella -> righe pulite (spazi tolti, righe vuote saltate), unite da un solo a capo
const normTopics = (v) => String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join('\n');
function validTopics(v) {
  if (v === '') return true;
  const a = v.split('\n');
  return a.length <= TOPICS_MAX && a.every((x) => x.length >= 1 && x.length <= TOPIC_LEN && x === x.trim() && noCtl(x) && !INVISIBLE.test(x))
    && new Set(a.map((x) => x.toLowerCase())).size === a.length;
}
const topicsOf = (getSetting) => { const v = getSetting('topics', ''); return v && validTopics(v) ? v.split('\n') : DEFAULT_TOPICS; };

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
  topics: validTopics,
  // pannello da fuori casa (Cloudflare Access): nome del team e codice AUD dell'applicazione
  access_team: (v) => v === '' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v),
  access_aud: (v) => v === '' || /^[0-9a-f]{64}$/.test(v),
};
// nomi dei campi da mostrare negli errori (mai la chiave tecnica)
const SETTING_LABELS = {
  smtp_host: 'Server', smtp_port: 'Porta', smtp_user: 'Utente', smtp_pass: 'Password', smtp_from: 'Mittente',
  public_url: 'Indirizzo pubblico', autoclose_days: 'Chiusura automatica', tg_token: 'Token del bot', tg_chat: 'Chat id',
  imap_host: 'Server IMAP', topics: 'Argomenti', access_team: 'Team di Cloudflare', access_aud: 'Codice AUD',
};
// impostazioni che si cambiano solo dall'icona di Umbrel: mai da fuori casa, mai da una copia di sicurezza
// (chi avesse rubato una sessione non deve poter spostare la serratura di Cloudflare Access)
const LOCAL_KEYS = ['access_team', 'access_aud'];
// segreti: mai mostrati nelle pagine, mai nella copia di sicurezza, mai presi da una copia
const SECRET_KEYS = ['smtp_pass', 'tg_token'];

const LIMITS = { name: 80, topic: 100, body: 10000 };

module.exports = {
  EMAIL_RE, validEmail, noCtl, SETTINGS, SETTING_LABELS, SECRET_KEYS, LOCAL_KEYS, SMTP_PORTS, LIMITS,
  DEFAULT_TOPICS, TOPICS_MAX, TOPIC_LEN, normTopics, validTopics, topicsOf,
};
