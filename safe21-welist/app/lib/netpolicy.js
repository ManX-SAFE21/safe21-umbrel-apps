'use strict';
/*
 * URL policy and address classes (security-critical).
 *
 * Accepted executor URLs are canonical origins only: https://host[:port]
 *  - lowercase DNS name, at least two labels, TLD not starting with a digit (so no IPv4 literal)
 *  - no path, query, fragment, userinfo, trailing slash or explicit default port; length <= 256
 *  - no localhost, .localhost, .local, .internal, .home.arpa, .arpa, .lan, .invalid
 *  - .onion gets its own error code (not supported yet)
 * The test-only switch allowPrivate also accepts http:// (for the fake executors of the tests).
 */
const net = require('node:net');

const CHAINS = ['bitcoin', 'testnet4'];
const MAX_URL = 256;
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.lan', '.invalid'];

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function isDnsName(host) {
  if (host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  for (const l of labels) {
    if (l.length < 1 || l.length > 63) return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l)) return false;
  }
  // TLD must start with a letter: rejects 1.2.3.4, 0x7f.1 and similar numeric tricks
  return /^[a-z]/.test(labels[labels.length - 1]);
}

function isLocalName(host) {
  return host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

function checkUrl(raw, { allowPrivate = false } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL) return fail('bad_url');
  // onion first, in any form, so the user gets the specific message
  const loose = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(raw);
  if (loose && /\.onion\.?$/i.test(loose[1])) return fail('onion');
  if (/^http:\/\//i.test(raw) && !allowPrivate) return fail('https_only');
  const m = /^(https?):\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(raw);
  if (!m) return fail('bad_url');
  const [, scheme, host, portStr] = m;
  const defPort = scheme === 'https' ? 443 : 80;
  const port = portStr ? Number(portStr) : defPort;
  if (port > 65535) return fail('bad_url');
  if (portStr && port === defPort) return fail('bad_url'); // explicit default port is not canonical
  if (!isDnsName(host)) return fail('bad_host');
  if (isLocalName(host)) return fail('local_host');
  return { ok: true, url: raw, scheme, host, port, authority: portStr ? `${host}:${port}` : host };
}

/* ---------- address classes ---------- */
function parseV4(s) {
  if (!net.isIPv4(s)) return null;
  return s.split('.').map(Number);
}

function v4Blocked([a, b, c]) {
  return a === 0 // "this network", unspecified
    || a === 10 // private
    || a === 127 // loopback
    || (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64.0.0/10
    || (a === 169 && b === 254) // link-local
    || (a === 172 && b >= 16 && b <= 31) // private
    || (a === 192 && b === 168) // private
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF protocol assignments, TEST-NET-1
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) // TEST-NET-2
    || (a === 203 && b === 0 && c === 113) // TEST-NET-3
    || a >= 224; // multicast 224/4, reserved 240/4, broadcast
}

// 8 words of 16 bit, or null; zone ids (fe80::1%eth0) are refused
function parseV6(s) {
  if (typeof s !== 'string' || s.includes('%') || !net.isIPv6(s)) return null;
  let str = s.toLowerCase();
  const lastColon = str.lastIndexOf(':');
  const last = str.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (!v4) return null;
    str = str.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const parts = str.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length > 1 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const words = [...head, ...Array(fill).fill('0'), ...tail].map((h) => parseInt(h, 16));
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
  return words;
}

const embeddedV4 = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function v6Blocked(w) {
  const zero = (from, to) => w.slice(from, to).every((x) => x === 0);
  // ::/96: unspecified, loopback, deprecated IPv4-compatible
  if (zero(0, 6)) return true;
  // ::ffff:0:0/96 IPv4-mapped: judge the embedded IPv4
  if (zero(0, 5) && w[5] === 0xffff) return v4Blocked(embeddedV4(w[6], w[7]));
  // 64:ff9b::/96 NAT64 well-known prefix: judge the embedded IPv4; 64:ff9b:1::/48 local-use: blocked
  if (w[0] === 0x64 && w[1] === 0xff9b) return zero(2, 6) ? v4Blocked(embeddedV4(w[6], w[7])) : true;
  // only global unicast 2000::/3 is allowed from here on (refuses fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64 ...)
  if ((w[0] & 0xe000) !== 0x2000) return true;
  if (w[0] === 0x2001 && w[1] === 0) return true; // Teredo 2001::/32
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
  if (w[0] === 0x2002) return v4Blocked(embeddedV4(w[1], w[2])); // 6to4: embedded IPv4
  return false;
}

// true = never connect to this address (anything unparseable counts as blocked)
function isBlockedAddress(ip) {
  const v4 = parseV4(String(ip));
  if (v4) return v4Blocked(v4);
  const v6 = parseV6(String(ip));
  if (v6) return v6Blocked(v6);
  return true;
}

module.exports = { CHAINS, MAX_URL, checkUrl, isBlockedAddress, isDnsName, parseV6 };
