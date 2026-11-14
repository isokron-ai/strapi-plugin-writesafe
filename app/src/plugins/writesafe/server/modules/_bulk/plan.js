'use strict';

/**
 * The plan token of a bulk job (1.0 hardening item 17; fourth review N17).
 * Design notes: docs/internals.md, section "server/modules/_bulk/plan.js".
 */
const crypto = require('crypto');
const M = require('../../model');

const PREFIX = 'wsp1';
let PLAN_KEY = crypto.randomBytes(32);
let KEY_FROM_APP = false;

/** The plan key from the app's keys (server.app.keys); read lazily so no bootstrap hook is needed. */
function keyFor(strapi) {
  if (KEY_FROM_APP || !strapi || !strapi.config || typeof strapi.config.get !== 'function') return PLAN_KEY;
  const keys = strapi.config.get('server.app.keys');
  if (Array.isArray(keys) && keys.length) {
    PLAN_KEY = crypto.createHash('sha256').update(`writesafe-plan:${keys.join(',')}`).digest();
    KEY_FROM_APP = true;
  }
  return PLAN_KEY;
}
/** Tests: set the key directly. */
function setKey(secret) {
  PLAN_KEY = crypto.createHash('sha256').update(`writesafe-plan:${secret}`).digest();
  KEY_FROM_APP = true;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Incremental id-list hash: sha256 over "<documentId>\n" (or "<documentId>@<version>\n" for a publish job) in job
 * order. Returns { add(documentId, version?), digest() }.
 */
function idListHasher() {
  const h = crypto.createHash('sha256');
  let n = 0;
  return {
    add(documentId, version) { h.update(version ? `${documentId}@${version}\n` : `${documentId}\n`); n += 1; },
    get count() { return n; },
    digest() { return b64(h.digest()); },
  };
}
function idListHash(entries) {
  const h = idListHasher();
  for (const e of entries) {
    if (typeof e === 'string') h.add(e);
    else h.add(e.documentId, e.version);
  }
  return h.digest();
}

/** The message the MAC covers: every field on its own line, in a fixed order. */
function macInput(f) {
  return [PREFIX, f.owner, f.uid, f.locale || '', M.canonical(f.filters || {}), f.action, f.specHash, String(f.count), f.idHash, f.undoable ? '1' : '0', String(f.exp), f.nonce].join('\n');
}
const macOf = (strapi, f) => crypto.createHmac('sha256', keyFor(strapi)).update(macInput(f)).digest('base64url');

/**
 * Sign a plan. f = { owner, uid, locale, filters, action, specHash, count, idHash, undoable }, ttlSeconds, now (ms).
 * Returns { token, expires_at, exp, mac }.
 */
function sign(strapi, f, ttlSeconds, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const nonce = crypto.randomBytes(12).toString('base64url');
  const full = { ...f, exp, nonce };
  const mac = macOf(strapi, full);
  const payload = b64(JSON.stringify({ e: exp, n: f.count, h: f.idHash, u: f.undoable ? 1 : 0, r: nonce }));
  return { token: `${PREFIX}.${payload}.${mac}`, exp, expires_at: new Date(exp * 1000).toISOString(), mac };
}

/** Parse a token without checking it. Returns { exp, count, idHash, undoable, nonce, mac } or null when malformed. */
function parse(token) {
  if (typeof token !== 'string' || token.length > 400) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!p || !Number.isSafeInteger(p.e) || !Number.isSafeInteger(p.n) || p.n < 0 || typeof p.h !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(p.h) || ![0, 1].includes(p.u)
    || typeof p.r !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(p.r)) return null;
  return { exp: p.e, count: p.n, idHash: p.h, undoable: p.u === 1, nonce: p.r, mac: parts[2] };
}

/**
 * Check the MAC of a parsed token against this request: f = { owner, uid, locale, filters, action, specHash }.
 * Constant-time compare. true when the token was issued for exactly this request and holder.
 */
function verify(strapi, parsed, f) {
  if (!parsed) return false;
  const want = Buffer.from(macOf(strapi, { ...f, count: parsed.count, idHash: parsed.idHash, undoable: parsed.undoable, exp: parsed.exp, nonce: parsed.nonce }));
  const got = Buffer.from(parsed.mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const expired = (parsed, now = Date.now()) => parsed.exp * 1000 <= now;

/** The job id of a plan: "j" + 23 hex characters of sha256 over the MAC (one plan, one job). */
const jobIdOf = (mac) => `j${M.sha(`writesafe-job|${mac}`).slice(0, 23)}`;

module.exports = { PREFIX, sign, parse, verify, expired, jobIdOf, idListHash, idListHasher, macInput, setKey, keyFor };
