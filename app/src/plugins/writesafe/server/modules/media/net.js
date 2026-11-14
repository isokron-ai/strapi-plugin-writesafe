'use strict';

// The remote Content-Type is kept only as a bare MIME type (1.0 hardening item 4; fourth review N20): it is remote text.
const { mimeOnly } = require('../../reply');

/**
 * Network guard for ws_media_import: URL allowlist, SSRF guard and a bounded, pinned download.
 *
 * Rules (every hop, the first request and every redirect):
 *  1. Only http: and https:. No credentials in the URL.
 *  2. The URL must match an allowlist entry from the plugin config (default: none, so nothing can be fetched).
 *  3. The host is resolved ONCE per hop. If ANY resolved address is private, loopback, link-local (cloud metadata),
 *     CGNAT, multicast, reserved, or an IPv6 form that embeds one of those, the hop is refused.
 *  4. The connection goes to exactly the address that was checked (a pinned `lookup`), so a DNS answer that changes
 *     between the check and the connect (DNS rebinding) cannot redirect it.
 *  5. Redirects are followed by hand, up to maxRedirects, and each target goes through 1 to 4 again.
 *  6. One deadline covers every hop and the whole body; the body is capped at maxBytes while it streams.
 *
 * Test override (never from config): see testOverride() below and docs/tools-media.md.
 */
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');

class NetError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- blocked address ranges
const V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// IPv6: only global unicast (2000::/3) is ever allowed (an allowlist of one range, so new special ranges outside it
// are blocked by default), minus the special-purpose ranges inside it. IPv4-mapped (::ffff:a.b.c.d) and NAT64
// (64:ff9b::/96) addresses are judged by their embedded IPv4 address, so DNS64 hosts keep working.
const V6_GLOBAL = new net.BlockList();
V6_GLOBAL.addSubnet('2000::', 3, 'ipv6');
const V6 = [
  ['2001::', 23], // IETF protocol assignments: Teredo, benchmarking 2001:2::/48, ORCHID, AMT, ...
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], // documentation, 6to4, documentation (RFC 9637)
];
// Two lists: one BlockList holding both families matches every IPv4 address against ::ffff:0:0/96.
const BLOCK4 = new net.BlockList();
const BLOCK6 = new net.BlockList();
for (const [a, p] of V4) BLOCK4.addSubnet(a, p, 'ipv4');
for (const [a, p] of V6) BLOCK6.addSubnet(a, p, 'ipv6');

/** The IPv4 address embedded in an IPv6 address (mapped, compatible, NAT64, 6to4), or null. */
function embeddedV4(addr) {
  const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (m) return m[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** Why an address must not be contacted, or null when it is a public unicast address. */
function blockedReason(address) {
  const fam = net.isIP(address);
  if (!fam) return 'not an IP address';
  if (fam === 4) return BLOCK4.check(address, 'ipv4') ? 'private, loopback, link-local or reserved IPv4 address' : null;
  const v4 = embeddedV4(address);
  if (v4) return BLOCK4.check(v4, 'ipv4') ? 'IPv6 form of a private, loopback or link-local IPv4 address' : null;
  if (!V6_GLOBAL.check(address, 'ipv6')) return 'not a global unicast IPv6 address';
  return BLOCK6.check(address, 'ipv6') ? 'special-purpose IPv6 address' : null;
}

// ---------------------------------------------------------------- allowlist
/**
 * Allowlist entries (config writesafe.media.allow):
 *   "images.example.com"            host, any path, https only, default port
 *   "*.cdn.example.com"             any subdomain (not the bare domain), https only
 *   "https://images.example.com/products/"   scheme + host (+ port) + path prefix
 *   "http://127.0.0.1:2047/files/"  explicit http and port (http is only allowed when an entry says so)
 * A path prefix matches on the normalised path (the URL parser resolves "..", "%2e%2e" and duplicate dots first).
 */
function parseAllowEntry(entry) {
  if (typeof entry !== 'string' || !entry.trim()) throw new Error('allowlist entries must be non-empty strings');
  const s = entry.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`allowlist entry ${s}: only http and https`);
    if (u.username || u.password) throw new Error(`allowlist entry ${s}: no credentials`);
    if (u.search || u.hash) throw new Error(`allowlist entry ${s}: no query or fragment`);
    const wildcard = u.hostname.startsWith('*.');
    return {
      entry: s, protocol: u.protocol, wildcard,
      host: wildcard ? u.hostname.slice(2) : u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      path: u.pathname || '/',
    };
  }
  if (/[/?#@\s]/.test(s)) throw new Error(`allowlist entry ${s}: a bare host may not carry a path; write the full URL prefix`);
  const wildcard = s.startsWith('*.');
  const host = new URL(`https://${wildcard ? s.slice(2) : s}`).hostname;
  return { entry: s, protocol: 'https:', wildcard, host, port: '443', path: '/' };
}

const portOf = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');

function matchAllow(u, rules) {
  const host = u.hostname.toLowerCase();
  for (const r of rules) {
    if (r.protocol !== u.protocol || r.port !== portOf(u)) continue;
    const hostOk = r.wildcard ? host.endsWith(`.${r.host}`) : host === r.host;
    if (!hostOk) continue;
    const p = u.pathname || '/';
    // Below a path prefix, refuse encoded separators and dots and ";" path parameters: some servers and proxies decode
    // %2F or drop ";..." and would serve a path outside the prefix ("/public/..%2fprivate/x").
    // %25 too: a double-encoded separator (%252f) becomes %2f on a server that decodes twice.
    if (r.path !== '/' && /%2f|%5c|%2e|%25|;/i.test(p)) continue;
    if (r.path === '/' || p === r.path || p.startsWith(r.path.endsWith('/') ? r.path : `${r.path}/`)) return r.entry;
  }
  return null;
}

/** Parse and check one URL for scheme, credentials and the allowlist. Returns the URL object. */
function checkUrl(raw, rules, base) {
  let u;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new NetError('invalid_url', `Not a valid absolute URL: ${String(raw).slice(0, 200)}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new NetError('invalid_url', `Only http and https URLs can be imported (got ${u.protocol}).`);
  if (u.username || u.password) throw new NetError('invalid_url', 'URLs with credentials (user:password@) are refused.');
  if (!u.hostname) throw new NetError('invalid_url', 'The URL has no host.');
  const hit = matchAllow(u, rules);
  if (!hit) {
    throw new NetError('host_not_allowed', `${u.protocol}//${u.host}${u.pathname} is not on the media import allowlist (config writesafe.media.allow). An admin must add it.`, { url: redact(u) });
  }
  u.allowedBy = hit;
  return u;
}

/** URL without query, fragment or credentials: what is stored and echoed (a query can carry a signature). */
function redact(u) {
  return `${u.protocol}//${u.host}${u.pathname}`;
}

// ---------------------------------------------------------------- resolution
/**
 * The test override, read from the environment only, never from config:
 *   NODE_ENV=test
 *   WRITESAFE_MEDIA_TEST_LOOPBACK_PORTS=2047,2050   loopback (127.0.0.1, ::1) on exactly these ports is treated as public
 *   WRITESAFE_MEDIA_TEST_DNS=127.0.0.1:2049          names ending in .ws-test are resolved by this DNS server
 * With any other NODE_ENV (production, development, unset) both variables are ignored and a warning is logged.
 * Only loopback is ever exempted: private ranges, link-local and metadata addresses are blocked in every mode.
 */
function testOverride(env = process.env) {
  const wantPorts = env.WRITESAFE_MEDIA_TEST_LOOPBACK_PORTS;
  const wantDns = env.WRITESAFE_MEDIA_TEST_DNS;
  if (!wantPorts && !wantDns) return null;
  if (env.NODE_ENV !== 'test') return { ignored: true, reason: `NODE_ENV is ${env.NODE_ENV || 'unset'}, not test` };
  const ports = new Set(String(wantPorts || '').split(',').map((s) => s.trim()).filter((s) => /^\d{1,5}$/.test(s)));
  let dnsServer = null;
  if (wantDns) {
    const m = /^(127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(wantDns.trim());
    if (m) dnsServer = `${m[1]}:${m[2]}`;
  }
  return { ignored: false, ports, dnsServer };
}

const LOOPBACK_EXACT = new Set(['127.0.0.1', '::1']);

async function resolveAll(host, override) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return [{ address: bare, family: net.isIP(bare) }];
  if (override && !override.ignored && override.dnsServer && bare.endsWith('.ws-test')) {
    const r = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    r.setServers([override.dnsServer]);
    const v4 = await r.resolve4(bare).catch(() => []);
    if (!v4.length) throw new NetError('dns_failed', `Could not resolve ${bare}.`);
    return v4.map((address) => ({ address, family: 4 }));
  }
  try {
    const out = await dns.promises.lookup(bare, { all: true, verbatim: true });
    if (!out.length) throw new Error('no addresses');
    return out;
  } catch (e) {
    throw new NetError('dns_failed', `Could not resolve ${bare}: ${e.code || e.message}`);
  }
}

/**
 * Resolve a hop's host and pick the address to connect to. Refuses the hop if any address is blocked (a name that
 * answers with both a public and a private address is refused, not filtered).
 */
async function pinAddress(u, override, log, signal) {
  const addrs = await withSignal(resolveAll(u.hostname, override), signal);
  const port = portOf(u);
  for (const a of addrs) {
    const why = blockedReason(a.address);
    if (!why) continue;
    const exempt = override && !override.ignored && LOOPBACK_EXACT.has(a.address) && override.ports.has(port);
    if (!exempt) {
      // The resolved address stays in the server log only, so the tool cannot be used to map internal DNS.
      if (log) log(`ssrf_blocked: ${u.hostname} -> ${a.address} (${why})`);
      throw new NetError('ssrf_blocked', `Refused: ${u.hostname} does not resolve to a public address. Only public addresses can be fetched.`);
    }
  }
  // Every address was checked; all of them are offered to the connect (Happy Eyeballs), none other.
  return { addrs, address: addrs[0].address, family: addrs[0].family, testExempt: addrs.some((a) => Boolean(blockedReason(a.address))) };
}

/** DNS cannot be cancelled, but the deadline still applies to it. */
function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new NetError('timeout', 'Timed out.'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new NetError('timeout', 'Timed out while resolving the host.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

// ---------------------------------------------------------------- download
/**
 * Download one URL into `destPath`, following redirects by hand. Returns
 * { finalUrl, status, bytes, sha256, declaredType, hops, testExempt }.
 */
async function download(rawUrl, destPath, opts) {
  const { rules, maxBytes, maxRedirects, timeoutMs, override } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const hops = [];
  let testExempt = false;
  try {
    let u = checkUrl(rawUrl, rules);
    for (let hop = 0; ; hop += 1) {
      const pin = await pinAddress(u, override, opts.log, ac.signal);
      testExempt = testExempt || pin.testExempt;
      hops.push(redact(u));
      const res = await request(u, pin, ac.signal);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy(); // never drain an abandoned body: it would not be bounded by the cap or the deadline
        if (hop >= maxRedirects) throw new NetError('too_many_redirects', `More than ${maxRedirects} redirects.`, { hops });
        try {
          u = checkUrl(res.headers.location, rules, u);
        } catch (e) {
          // Do not echo the redirect target: it may name an internal host. The server log has it.
          if (e instanceof NetError && e.code === 'host_not_allowed') {
            opts.log?.(`redirect from ${redact(u)} to a URL not on the allowlist: ${e.extra.url}`);
            throw new NetError('host_not_allowed', `${redact(u)} redirected to a URL that is not on the media import allowlist.`, { redirected: true });
          }
          throw e;
        }
        continue;
      }
      if (res.statusCode !== 200) {
        res.destroy();
        throw new NetError('fetch_failed', `The server answered HTTP ${res.statusCode}.`, { status: res.statusCode, url: redact(u) });
      }
      const len = Number(res.headers['content-length']);
      if (Number.isFinite(len) && len > maxBytes) {
        res.destroy();
        throw new NetError('too_large', `The file is ${len} bytes; the limit is ${maxBytes} (config writesafe.media.maxBytes).`, { bytes: len, max_bytes: maxBytes });
      }
      const { bytes, sha256 } = await saveBody(res, destPath, maxBytes, ac.signal);
      return { finalUrl: redact(u), bytes, sha256, declaredType: mimeOnly(res.headers['content-type']), hops, testExempt };
    }
  } catch (e) {
    if (ac.signal.aborted && !(e instanceof NetError && e.code !== 'fetch_failed')) {
      throw new NetError('timeout', `The download did not finish within ${timeoutMs} ms (config writesafe.media.timeoutMs).`);
    }
    if (e instanceof NetError) throw e;
    throw new NetError('fetch_failed', `Download failed: ${e.code || e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function request(u, pin, signal) {
  const lib = u.protocol === 'https:' ? https : http;
  const isIpHost = net.isIP(u.hostname.replace(/^\[|\]$/g, ''));
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: portOf(u),
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: { 'user-agent': 'strapi-plugin-writesafe-media-import', accept: '*/*', 'accept-encoding': 'identity' },
      // A fresh agent: no keep-alive reuse, and no proxy picked up from the environment.
      agent: new lib.Agent({ keepAlive: false }),
      // Pinned: connect to the address that passed the check, never to a second DNS answer.
      lookup: (_host, options, cb) => {
        const fam = options && options.family;
        const list = pin.addrs.filter((a) => !fam || a.family === fam);
        if (!list.length) { cb(Object.assign(new Error('no checked address of the requested family'), { code: 'ENOTFOUND' })); return; }
        if (options && options.all) cb(null, list.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, list[0].address, list[0].family);
      },
      ...(u.protocol === 'https:' && !isIpHost ? { servername: u.hostname } : {}),
      signal,
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

function saveBody(res, destPath, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(destPath, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    let failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      res.destroy();
      out.destroy();
      reject(e);
    };
    res.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new NetError('too_large', `The file is larger than ${maxBytes} bytes (config writesafe.media.maxBytes); the download was stopped.`, { max_bytes: maxBytes }));
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) res.pause();
    });
    out.on('drain', () => res.resume());
    res.on('error', fail);
    res.on('aborted', () => fail(new NetError('fetch_failed', 'The connection closed before the file was complete.')));
    out.on('error', fail);
    signal.addEventListener('abort', () => fail(new NetError('timeout', 'Timed out.')), { once: true });
    res.on('end', () => {
      if (failed) return;
      if (!res.complete) { fail(new NetError('fetch_failed', 'The connection closed before the file was complete.')); return; }
      out.end(() => resolve({ bytes, sha256: hash.digest('hex') }));
    });
  });
}

/**
 * Dry run of the network checks for one URL: scheme, credentials, allowlist and the first hop's resolution.
 * Does not connect. Redirect targets are only known by fetching, so they are checked during the real import.
 */
async function precheck(rawUrl, opts) {
  const u = checkUrl(rawUrl, opts.rules);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  let pin;
  try { pin = await pinAddress(u, opts.override, opts.log, ac.signal); } finally { clearTimeout(timer); }
  return { url: redact(u), allowed_by: u.allowedBy, address_ok: true, test_exempt: pin.testExempt || undefined };
}

module.exports = { NetError, blockedReason, embeddedV4, parseAllowEntry, matchAllow, checkUrl, redact, testOverride, pinAddress, download, precheck };
