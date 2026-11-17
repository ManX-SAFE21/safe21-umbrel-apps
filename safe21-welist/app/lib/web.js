'use strict';
/*
 * Response helpers with strict security headers, body readers with size limits, static files.
 * Every value that comes from an executor or a visitor goes through esc() before any HTML.
 */
const fs = require('node:fs');
const path = require('node:path');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
const CSP_PUBLIC = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CSP_ADMIN = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...BASE_HEADERS, ...headers });
  res.end(body);
}
const sendHtml = (res, status, html, csp = CSP_PUBLIC, extra = {}) => send(res, status, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, ...extra });
const sendJson = (res, status, obj, extra = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...extra });
const sendText = (res, status, text, extra = {}) => send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8', ...extra });
const redirect = (res, to, extra = {}) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...BASE_HEADERS, ...extra }); res.end(); };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooBig = () => { const e = new Error('Request too large'); e.status = 413; return e; };
    if (Number(req.headers['content-length']) > limit) { req.resume(); reject(tooBig()); return; }
    let size = 0;
    let chunks = [];
    req.on('data', (c) => {
      if (!chunks) return;
      size += c.length;
      if (size > limit) { chunks = null; reject(tooBig()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (chunks) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (chunks) reject(e); });
  });
}
async function readJson(req, limit = 1024) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { const e = new Error('Content-Type must be application/json'); e.status = 415; throw e; }
  const buf = await readBody(req, limit);
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch { const e = new Error('Invalid JSON'); e.status = 400; throw e; }
}
const readForm = async (req, limit = 8192) => new URLSearchParams((await readBody(req, limit)).toString('utf8'));

/* ---------- static files of the public page (read once at start) ---------- */
const STATIC_DIR = path.join(__dirname, '..', 'static');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const STATIC = new Map();
for (const f of fs.readdirSync(STATIC_DIR)) {
  const ext = path.extname(f);
  if (TYPES[ext]) STATIC.set('/' + f, { type: TYPES[ext], data: fs.readFileSync(path.join(STATIC_DIR, f)) });
}
function serveStatic(res, p, csp) {
  const f = STATIC.get(p === '/' ? '/index.html' : p);
  if (!f || p === '/index.html') return false;
  const h = { 'Content-Type': f.type, 'Cache-Control': 'no-cache' };
  if (f.type.startsWith('text/html')) h['Content-Security-Policy'] = csp || CSP_PUBLIC;
  send(res, 200, f.data, h);
  return true;
}

module.exports = { esc, send, sendHtml, sendJson, sendText, redirect, readBody, readJson, readForm, serveStatic, CORS, CSP_PUBLIC, CSP_ADMIN, BASE_HEADERS };
