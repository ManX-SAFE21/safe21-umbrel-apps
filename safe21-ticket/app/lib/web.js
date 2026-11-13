'use strict';
/*
 * Pezzi comuni delle pagine: risposte con le intestazioni di sicurezza, lettura dei moduli,
 * caratteri inclusi nell'app, icone, grafica (colori di safe21.io) e scheletro della pagina.
 * Tutto il testo scritto da clienti o dal gestore passa da esc(): mai HTML.
 */
const fs = require('node:fs');
const path = require('node:path');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  // nessuna pagina dello sportello deve finire nei motori di ricerca (soprattutto quelle dei ticket)
  'X-Robots-Tag': 'noindex, nofollow',
};
function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(body);
}
const sendText = (res, status, text) => send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8' });
const redirect = (res, to, extra = {}) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra }); res.end(); };

// moduli semplici (application/x-www-form-urlencoded): nessun allegato nella prima versione
const MAX_FORM = 64 * 1024;
async function readForm(req, limit = MAX_FORM) {
  return new URLSearchParams((await readBody(req, limit)).toString('utf8'));
}
// modulo con un file (multipart/form-data), solo per il ripristino della copia di sicurezza:
// i campi di testo vanno in fields, i file in files[nome] = { filename, data }
async function readMultipart(req, limit) {
  const m = /^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(req.headers['content-type'] || '');
  if (!m) { const e = new Error('Modulo non valido'); e.status = 400; throw e; }
  const buf = await readBody(req, limit);
  const fields = new URLSearchParams();
  const files = {};
  const delim = Buffer.from('--' + (m[1] || m[2]));
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // "--": fine
    pos += 2; // a capo
    const hEnd = buf.indexOf('\r\n\r\n', pos);
    if (hEnd === -1) break;
    const next = buf.indexOf(delim, hEnd + 4);
    if (next === -1) break;
    const headers = buf.subarray(pos, hEnd).toString('utf8');
    const data = buf.subarray(hEnd + 4, Math.max(hEnd + 4, next - 2));
    const name = /\bname="([^"]*)"/i.exec(headers)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(headers)?.[1];
    if (name !== undefined) {
      if (filename !== undefined) files[name] = { filename, data };
      else fields.append(name, data.toString('utf8'));
    }
    pos = next;
  }
  return { fields, files };
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    const tooBig = () => { const e = new Error('Richiesta troppo grande'); e.status = 413; return e; };
    if (Number(req.headers['content-length']) > limit) { req.resume(); reject(tooBig()); return; }
    req.on('data', (c) => {
      if (!chunks) return; // già rifiutata: il resto si scarta (il tempo massimo della richiesta la chiude)
      size += c.length;
      if (size > limit) { chunks = null; reject(tooBig()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (chunks) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (chunks) reject(e); });
  });
}
// testo libero con lunghezza massima; gli a capo restano
const field = (f, k, max) => (f.get(k) || '').replace(/\r\n?/g, '\n').trim().slice(0, max);

/* ---------- caratteri inclusi nell'app: nessuna chiamata a servizi esterni ---------- */
const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONTS = new Map();
try {
  for (const f of fs.readdirSync(FONT_DIR)) if (f.endsWith('.woff2')) FONTS.set(f, fs.readFileSync(path.join(FONT_DIR, f)));
} catch (e) { console.error('caratteri non trovati, uso quelli di sistema:', e.message); }
function serveFont(res, p) {
  const m = p.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/);
  const buf = m && FONTS.get(m[1]);
  if (!buf) return false;
  res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
  return true;
}

let ICON_SVG = null;
try { ICON_SVG = fs.readFileSync(path.join(__dirname, '..', '..', 'icon.svg')); } catch { /* sull'Umbrel l'icona arriva dallo store */ }
function serveIcon(res, p) {
  if (p !== '/icon.svg' || !ICON_SVG) return false;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', ...SEC_HEADERS });
  res.end(ICON_SVG);
  return true;
}

/* ---------- icone a tratto (stile Lucide), inline ---------- */
const ICONS = {
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  checkc: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  send: '<path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.02.94l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  note: '<path d="M12 20h9M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85z"/>',
  trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const msg = (kind, html) => `<div class="msg ${kind}">${icon({ ok: 'checkc', err: 'alert', warn: 'info' }[kind])}<div>${html}</div></div>`;

/* ---------- grafica: colori e misure di safe21.io (tema scuro, chiaro se il sistema lo chiede) ---------- */
const CSS = `
@font-face{font-family:Roboto;src:url(/fonts/roboto-latin-wght-normal.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Space Mono';src:url(/fonts/space-mono-latin-400-normal.woff2) format('woff2');font-weight:400;font-display:swap}
:root{--ink:#0A0F1C;--ink-2:#0E1525;--panel:#111B2E;--line:#1F2B44;--light:#F5F7FA;--body:#DDE4EE;--muted:#95A1B5;
--teal:#2DD4BF;--teal-d:#0D9488;--orange:#F7931A;--danger:#F26D6D;--btn-text:#04201C;--accent-hover:#45e0cd;
--tint-teal-bg:rgba(45,212,191,.07);--tint-teal-bd:rgba(45,212,191,.28);color-scheme:dark}
@media (prefers-color-scheme:light){:root{--ink:#F4F6F9;--ink-2:#E8EDF4;--panel:#FFFFFF;--line:#D3DBE6;--light:#0A0F1C;--body:#1F2A3C;
--muted:#5A6678;--teal:#0D9488;--teal-d:#0B7C72;--danger:#C93C3C;--btn-text:#FFFFFF;--accent-hover:#0B7C72;
--tint-teal-bg:rgba(13,148,136,.07);--tint-teal-bd:rgba(13,148,136,.3);color-scheme:light}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--ink);color:var(--body);font:16px/1.55 Roboto,'Segoe UI',Arial,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:28px 16px 64px}
.wrap.wide{max-width:1040px}
.top{display:flex;align-items:center;gap:12px;margin-bottom:26px}
.brand{font-weight:700;letter-spacing:3px;font-size:18px;color:var(--light);text-decoration:none}
.brand span{color:var(--teal)}
.top .tag{font-family:'Space Mono',monospace;font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px}
.top .right{margin-left:auto;display:flex;gap:8px;align-items:center}
h1{color:var(--light);font-size:26px;line-height:1.25;margin:0 0 8px}
h2{color:var(--light);font-size:19px;margin:26px 0 10px;display:flex;gap:8px;align-items:center}
p{margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 20px}
a{color:var(--teal)}
a:hover{color:var(--accent-hover)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px}
label{display:block;font-size:14px;color:var(--muted);margin:14px 0 6px}
input,select,textarea{width:100%;font:inherit;color:var(--light);background:var(--ink-2);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
textarea{min-height:140px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid var(--teal);outline-offset:1px}
button,.btn{display:inline-flex;align-items:center;gap:8px;font:inherit;font-weight:600;cursor:pointer;border-radius:10px;padding:10px 18px;
border:1px solid var(--teal);background:var(--teal);color:var(--btn-text);text-decoration:none}
button:hover,.btn:hover{background:var(--accent-hover);color:var(--btn-text)}
button.ghost,.btn.ghost{background:transparent;color:var(--teal)}
.i{width:18px;height:18px;flex:none}
.msg{display:flex;gap:10px;align-items:flex-start;border-radius:12px;padding:12px 14px;margin:0 0 16px;border:1px solid var(--line);background:var(--panel)}
.msg.ok{border-color:var(--tint-teal-bd);background:var(--tint-teal-bg)}
.msg.err{border-color:var(--danger)}
.msg.err .i{color:var(--danger)}
.msg.ok .i,.msg.warn .i{color:var(--teal)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.stat b{display:block;font-family:'Space Mono',monospace;font-size:28px;color:var(--light)}
.stat span{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:14px}
.foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13.5px}
.foot p{display:flex;gap:8px;align-items:flex-start}
.mono{font-family:'Space Mono',monospace}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
@media (max-width:560px){.row2{grid-template-columns:1fr}}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.stop{border:1px solid var(--danger);border-radius:12px;padding:12px 14px;margin:16px 0;font-size:15px}
.stop b{color:var(--danger)}
.note{font-size:14px;color:var(--muted);margin:12px 0 0}
.btns{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:16px}
.btns form{margin:0}
.num{font-family:'Space Mono',monospace;font-size:26px;color:var(--teal);letter-spacing:1px;margin:6px 0 14px}
.linkbox{font-family:'Space Mono',monospace;font-size:13.5px;background:var(--tint-teal-bg);border-color:var(--tint-teal-bd)}
.meta{display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:var(--muted);font-size:14px;margin:0 0 18px}
.pill{display:inline-block;font-size:12.5px;font-weight:600;padding:3px 10px;border-radius:999px}
.p-open{background:var(--tint-teal-bg);color:var(--teal);border:1px solid var(--tint-teal-bd)}
.p-waiting{background:rgba(247,147,26,.12);color:var(--orange);border:1px solid rgba(247,147,26,.35)}
.p-closed{background:rgba(149,161,181,.14);color:var(--muted);border:1px solid var(--line)}
.thread{display:flex;flex-direction:column;gap:12px;margin:0 0 22px}
.m{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--panel)}
.m.us{border-color:var(--tint-teal-bd);background:var(--tint-teal-bg)}
.m .who{font-size:13px;color:var(--muted);margin-bottom:4px}
.m .who b{color:var(--light)}
.m .txt{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--body)}
.solved{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:0 0 18px;padding:16px 18px;
border:2px solid var(--teal);border-radius:14px;background:var(--tint-teal-bg)}
.solved b{display:flex;gap:8px;align-items:center;color:var(--light);font-size:17px;margin-bottom:4px}
.solved b .i{color:var(--teal)}
.solved span{display:block;color:var(--muted);font-size:14px}
.solved button{font-size:16px;padding:12px 20px}
.m.note{border-style:dashed;border-color:var(--orange);background:rgba(247,147,26,.06)}
.m.note .who b{color:var(--orange)}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 16px}
.tab{border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:14px;color:var(--muted);text-decoration:none}
.tab b{font-family:'Space Mono',monospace;margin-left:4px}
.tab.on{border-color:var(--teal);color:var(--teal)}
.list{width:100%;border-collapse:collapse;font-size:15px}
.list th{text-align:left;font-weight:500;color:var(--muted);font-size:13px;padding:8px 10px;border-bottom:1px solid var(--line)}
.list td{padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.list td.n{font-family:'Space Mono',monospace;white-space:nowrap}
.list a{text-decoration:none}
.list tr:hover td{background:var(--tint-teal-bg)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--teal);display:inline-block;margin-right:6px}
.empty{color:var(--muted);padding:18px 0}
.adm-nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}
.split{display:grid;grid-template-columns:2fr 1fr;gap:18px;align-items:start}
@media (max-width:820px){.split{grid-template-columns:1fr}}
.side .card{margin-bottom:14px}
.side h2{margin-top:0}
.kv{font-size:14px;margin:0 0 6px;overflow-wrap:anywhere}
.kv span{color:var(--muted)}
button.danger{background:transparent;border-color:var(--danger);color:var(--danger)}
button.danger:hover{background:var(--danger);color:#fff}
.check{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--body);margin:10px 0}
.check input{width:auto}
.hint{font-size:13px;color:var(--muted);margin:4px 0 0}
`;

// gettone dei moduli del pannello: server.js dice come farlo; page() lo aggiunge a ogni modulo
let adminToken = null;
const setAdminToken = (fn) => { adminToken = fn; };
const withToken = (html) => (adminToken
  ? html.replace(/(<form\b[^>]*\baction=")([^"]*)(")/g, (m, a, act, z) => `${a}${act}${act.includes('?') ? '&amp;' : '?'}csrf=${adminToken()}${z}`)
  : html);

function page(title, body, { admin = false, wide = false } = {}) {
  if (admin) body = withToken(body);
  const right = admin ? '<div class="right"><span class="tag">pannello</span></div>' : '';
  return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · SAFE21 Ticket</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>${CSS}</style></head><body><div class="wrap${wide ? ' wide' : ''}">
<header class="top"><a class="brand" href="/">SAFE<span>21</span></a><span class="tag">ticket</span>${right}</header>
<main>${body}</main>
${admin ? '' : `<footer class="foot"><p>${icon('shield')}<span>I messaggi restano sul server di SAFE21: per email arrivano solo avvisi con il link, mai il testo.</span></p></footer>`}
</div></body></html>`;
}

module.exports = { setAdminToken, esc, SEC_HEADERS, send, sendText, redirect, readForm, readMultipart, field, serveFont, serveIcon, icon, msg, page };
