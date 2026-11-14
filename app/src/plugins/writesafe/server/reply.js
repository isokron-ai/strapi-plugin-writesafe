'use strict';

/**
 * Reply contract (1.0 hardening, phase 1 item 1; fourth review N1, N2, N4, Design C and I).
 *
 * Every error object a ws_* tool returns carries two flags, so an agent never has to guess what a code means:
 *   retryable        true when the SAME request, sent again unchanged, may succeed (the database was busy, another
 *                    call with the same idempotency_key was still running, a download timed out).
 *   requires_reread  true when the document (or job) must be read again before any new attempt: the state the caller
 *                    worked from is no longer current, or a write may have landed (write_failed).
 * A site that knows better sets either flag itself; this table only fills in what is missing.
 *
 * Server text and content are kept apart: `message` and `hint` hold text written by this plugin only. Field values,
 * remote headers and other agents' labels appear only in data fields (data, current, before, after, document, units,
 * samples, preview), never inside a message.
 */
const TYPES = {
  busy: [true, false],
  in_progress: [true, false],
  timeout: [true, false],
  // media: the remote server failed or did not resolve; the same request may succeed later (phase 1 review, item 11)
  fetch_failed: [true, false],
  dns_failed: [true, false],
  version_conflict: [false, true],
  precondition_required: [false, true],
  row_not_found: [false, true],
  // 1.0 hardening item 16b: the row is there, but the key no longer matches it (edited since, another database, a
  // reused id, an rc.2 key without a MAC). Read again; the error never carries the row's new key.
  stale_row_key: [false, true],
  // 1.0 hardening item 15: a version token of rc.2 / Phase 1 ("<updatedAt>~<hash>"); read again for a "v2." token
  version_format: [false, true],
  count_changed: [false, true],
  // bulk jobs (1.0 hardening item 17): the planned set changed, or the plan is old: dry-run again before a new start
  plan_mismatch: [false, true],
  plan_expired: [false, true],
  write_failed: [false, true],
};

/** The error payload with retryable/requires_reread filled in (unknown codes: false/false). */
function typed(err) {
  if (!err || typeof err !== 'object' || Array.isArray(err) || typeof err.code !== 'string') return err;
  const [retryable, reread] = TYPES[err.code] || [false, false];
  return { ...err, retryable: err.retryable ?? retryable, requires_reread: err.requires_reread ?? reread };
}

/**
 * Types every error object in a reply: the top-level `error`, its `cause` and `conflicts`, and the errors of
 * `items`, `failures` and `preview` entries. Content fields (data, current, before, after, document, ...) are never
 * walked, so a field value that happens to look like an error is left as it is.
 */
const WALK = new Set(['error', 'cause', 'conflicts', 'items', 'failures', 'preview']);
function typeReply(sc, depth = 0) {
  if (!sc || typeof sc !== 'object' || depth > 4) return sc;
  if (Array.isArray(sc)) return sc.map((x) => typeReply(x, depth + 1));
  let out = sc;
  for (const k of Object.keys(sc)) {
    if (!WALK.has(k) || sc[k] == null || typeof sc[k] !== 'object') continue;
    let v = typeReply(sc[k], depth + 1);
    if ((k === 'error' || k === 'cause') && !Array.isArray(v)) v = typed(v);
    if (k === 'conflicts' && Array.isArray(v)) v = v.map(typed);
    if (v !== sc[k]) out = out === sc ? { ...sc, [k]: v } : Object.assign(out, { [k]: v });
  }
  return out;
}

/** A remote Content-Type reduced to a bare MIME type, or null (N20: no remote text in server-voice messages). */
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const mimeOnly = (v) => {
  const s = String(v || '').split(';')[0].trim().toLowerCase();
  return MIME_RE.test(s) ? s : null;
};

/** Agent labels (history module) are slugs: letters, digits, '.', '_' and '-', up to 80 characters (N20). */
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const agentSlug = (v) => (typeof v === 'string' && AGENT_RE.test(v) ? v : null);

module.exports = { TYPES, typed, typeReply, mimeOnly, MIME_RE, AGENT_RE, agentSlug };
