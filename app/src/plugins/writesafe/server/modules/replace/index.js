'use strict';

/**
 * ws_replace: search and replace text in one content type, including text inside single components, repeatable
 * components, dynamic-zone rows and blocks (rich text) nodes.
 *
 * - Scope: `filters` (Strapi filter syntax) and `fields` (paths such as "title", "seo.metaTitle", "items.label",
 *   "sections.body", "body"; default every text path the token can read).
 * - literal (default) or regex. Regexes run in a separate V8 context with a time limit per document
 *   (config replace.regexTimeoutMs), so a catastrophic pattern is stopped (`regex_timeout`) instead of blocking Strapi.
 *   Patterns that match empty text are refused.
 * - dry_run returns the number of matching documents and matches, per path, and samples (before/after).
 * - Running it starts a ws_bulk job over the documents that matched. Each document is re-read under lock in its chunk
 *   and the replacement is computed again from its current text, then written with that version as the precondition.
 *   Component and zone rows are updated by key (ids kept); a document whose text no longer matches is "unchanged".
 */
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { z } = require('@strapi/utils');
const E = require('../../engine');
const M = require('../../model');
const U = require('../_bulk/util');
const B = require('../_bulk/jobs');

const { WsError } = E;
const TEXT = new Set(['string', 'text', 'richtext']);

/** Every text path of a content type. */
function textTargets(strapi, uid) {
  const out = [];
  for (const [name, a] of Object.entries(M.attrsOf(strapi, uid))) {
    if (M.SKIP_KEYS.has(name)) continue;
    if (TEXT.has(a.type)) out.push({ path: name, kind: 'scalar', field: name });
    else if (a.type === 'blocks') out.push({ path: name, kind: 'blocks', field: name });
    else if (a.type === 'component') {
      for (const [sub, sa] of Object.entries(M.attrsOf(strapi, a.component))) {
        if (TEXT.has(sa.type)) out.push({ path: `${name}.${sub}`, kind: a.repeatable ? 'rows' : 'component', field: name, sub, components: [a.component] });
      }
    } else if (a.type === 'dynamiczone') {
      const subs = new Map();
      for (const c of a.components) {
        for (const [sub, sa] of Object.entries(M.attrsOf(strapi, c))) if (TEXT.has(sa.type)) subs.set(sub, [...(subs.get(sub) || []), c]);
      }
      for (const [sub, comps] of subs) out.push({ path: `${name}.${sub}`, kind: 'zone', field: name, sub, components: comps });
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const VM_CODE = `(function () {
  var re = new RegExp(P, F);
  var expand = function (args) {
    var m = args[0];
    var named = typeof args[args.length - 1] === 'object' ? args[args.length - 1] : undefined;
    var nG = args.length - 3 - (named ? 1 : 0);
    var off = args[nG + 1], str = args[nG + 2];
    return R.replace(/\\$(\\$|&|\`|'|\\d{1,2}|<[^>]*>)/g, function (t, k) {
      if (k === '$') return '$';
      if (k === '&') return m;
      if (k === '\`') return str.slice(0, off);
      if (k === "'") return str.slice(off + m.length);
      if (k[0] === '<') { var g = named && named[k.slice(1, -1)]; return g == null ? '' : g; }
      var i = +k;
      return i >= 1 && i <= nG ? (args[i] == null ? '' : args[i]) : t;
    });
  };
  var t0 = CLOCK();
  try {
    OUT = S.map(function (s) {
      var n = 0;
      var r = s.replace(re, function () { n++; return L ? R : expand(arguments); });
      if (r.length > MAXOUT) throw new Error('output too large');
      return [r, n];
    });
  } finally {
    MS = CLOCK() - t0;
  }
})();`;

/** A replacer: strings -> [[new, count]], run in its own V8 context with a timeout. */
function makeReplacer(spec, cfg) {
  if (typeof spec.find !== 'string' || !spec.find.length) throw new WsError({ code: 'invalid', message: 'find must be a non-empty string.' });
  if (spec.find.length > cfg.maxPatternLength) throw new WsError({ code: 'invalid', message: `find is longer than ${cfg.maxPatternLength} characters.` });
  if (typeof spec.replace !== 'string') throw new WsError({ code: 'invalid', message: 'replace must be a string (use "" to delete the matches).' });
  if (spec.replace.length > cfg.maxReplaceLength) throw new WsError({ code: 'invalid', message: `replace is longer than ${cfg.maxReplaceLength} characters.` });
  const userFlags = spec.regex ? String(spec.flags || '') : '';
  if (/[^imsu]/.test(userFlags)) throw new WsError({ code: 'invalid', message: 'flags may only contain i, m, s and u.' });
  const flags = `g${spec.case_sensitive === false && !userFlags.includes('i') ? 'i' : ''}${[...new Set(userFlags)].join('')}`;
  const source = spec.regex ? spec.find : escapeRe(spec.find);
  try {
    // eslint-disable-next-line no-new
    new RegExp(source, flags);
  } catch (e) {
    throw new WsError({ code: 'invalid', message: `find is not a valid regular expression: ${e.message}` });
  }
  const script = new vm.Script(VM_CODE);
  // Time limits: per document (regexTimeoutMs, the vm's own timeout) and for all documents one replacer handles, e.g. a
  // whole dry-run scan (totalRegexMs). The vm runs synchronously, so without the total a slow pattern over thousands of
  // documents would hold the server for minutes (review finding).
  // One V8 context per replacer, and only the time spent in the regex work counts against the total (second review of
  // PR #16, M1): a new context per call cost about 0.35 ms, so setup alone used up 5 s after about 21,000 documents.
  // The clock is the host's performance.now (fractional ms): only the fixed VM_CODE ever runs in this context; the
  // pattern and the replacement are data (a RegExp and a string), so no caller code can reach the host function.
  const context = vm.createContext({ P: source, F: flags, R: spec.replace, L: !spec.regex, MAXOUT: cfg.maxOutputLength, CLOCK: () => performance.now(), S: null, OUT: null, MS: 0 });
  let spent = 0;
  const run = (strings) => {
    context.S = strings;
    context.OUT = null;
    context.MS = 0;
    const left = Math.max(1, Math.min(cfg.regexTimeoutMs, cfg.totalRegexMs - spent));
    const t0 = performance.now();
    try {
      script.runInContext(context, { timeout: left });
      spent += context.MS;
    } catch (e) {
      // a timeout used its whole allowance; any other failure counts the regex time it measured (or the call's time)
      spent += /timed out/i.test(e.message) ? left : (context.MS || performance.now() - t0);
      if (/timed out/i.test(e.message)) {
        throw new WsError({ code: 'regex_timeout', message: left < cfg.regexTimeoutMs
          ? `The pattern used up its total time (${cfg.totalRegexMs} ms) across the documents and was stopped. Nothing was written. Use a simpler pattern or a narrower filter.`
          : `The pattern ran longer than ${cfg.regexTimeoutMs} ms on one document and was stopped. Nothing was written. Use a simpler pattern (avoid nested quantifiers such as (a+)+).` });
      }
      if (/output too large/.test(e.message)) throw new WsError({ code: 'invalid', message: `A replaced text would be longer than ${cfg.maxOutputLength} characters. Nothing was written.` });
      throw new WsError({ code: 'invalid', message: `find/replace failed: ${e.message}` });
    } finally {
      context.S = null;
    }
    const out = context.OUT.map((x) => [String(x[0]), Number(x[1])]);
    context.OUT = null;
    return out;
  };
  if (run([''])[0][1] > 0) throw new WsError({ code: 'invalid', message: 'find matches empty text; give a pattern that matches at least one character.' });
  spent = 0; // the empty-text probe does not count against the budget
  // Time left in this replacer's total budget (1.0 hardening item 22: a job chunk keeps ONE replacer and ends before a
  // document could find less than its own per-document limit left).
  run.left = () => cfg.totalRegexMs - spent;
  return run;
}

/** Text leaves of blocks nodes: [{node index, path in node, text}]. */
function blockTexts(nodes) {
  const out = [];
  const walk = (n, i, path) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') out.push({ i, path, text: n.text });
    (n.children || []).forEach((c, j) => walk(c, i, [...path, j]));
  };
  (nodes || []).forEach((n, i) => walk(n, i, []));
  return out;
}

/**
 * Replacement for one document (normalized, as the token may read it).
 * `full` is the full RAW draft: row keys bind the full row content (1.0 hardening item 16b) with relations' linked
 * locales (re-review N5), so the update
 * ops carry the keys the engine computes for the current rows (without it, the keys come from `doc`).
 * Returns {count, perPath, set, ops, samples}.
 */
function compute(strapi, uid, doc, targets, replacer, sampleMax = 0, full = null) {
  const attrs = M.attrsOf(strapi, uid);
  const sc = (f) => M.keyScope(uid, doc.documentId, doc.locale || null, f);
  const fullRow = (f, row, i) => {
    const l = full && Array.isArray(full[f]) ? full[f] : null;
    return (l && l[i] && l[i].id === row.id ? l[i] : null) || (l && l.find((x) => x && x.id === row.id && x.__component === row.__component)) || row;
  };
  const slots = [];
  for (const t of targets) {
    if (!(t.field in doc)) continue;
    const v = doc[t.field];
    if (t.kind === 'scalar') { if (typeof v === 'string') slots.push({ t, text: v }); }
    else if (t.kind === 'component') { if (v && typeof v[t.sub] === 'string') slots.push({ t, text: v[t.sub] }); }
    else if (t.kind === 'rows' || t.kind === 'zone') {
      (v || []).forEach((row, i) => {
        if (t.kind === 'zone' && !t.components.includes(row.__component)) return;
        if (typeof row[t.sub] === 'string') slots.push({ t, text: row[t.sub], row, key: M.rowHandle(strapi, t.kind === 'zone' ? 'dynamiczone' : 'repeatable', attrs[t.field], fullRow(t.field, row, i), i, sc(t.field)) });
      });
    } else if (t.kind === 'blocks') {
      for (const leaf of blockTexts(v)) slots.push({ t, text: leaf.text, leaf, key: M.rowKey('blocks', attrs[t.field], v[leaf.i], leaf.i, sc(t.field)) });
    }
  }
  const res = slots.length ? replacer(slots.map((s) => s.text)) : [];
  const set = {};
  const rowData = new Map(); // `${field}|${key}` -> {field, key, data}
  const blockNodes = new Map(); // `${field}|${i}` -> {field, key, node}
  const perPath = {};
  const samples = [];
  let count = 0;
  slots.forEach((s, j) => {
    const [after, n] = res[j];
    if (!n) return;
    count += n;
    perPath[s.t.path] = (perPath[s.t.path] || 0) + n;
    if (samples.length < sampleMax) samples.push({ path: s.t.path, ...(s.key ? { key: s.key } : {}), count: n, before: U.truncate(s.text, 160), after: U.truncate(after, 160) });
    const { t } = s;
    if (t.kind === 'scalar') set[t.field] = after;
    else if (t.kind === 'component') set[t.field] = { ...(set[t.field] || {}), [t.sub]: after };
    else if (t.kind === 'rows' || t.kind === 'zone') {
      const k = `${t.field}|${s.key}`;
      const cur = rowData.get(k) || { field: t.field, key: s.key, data: {} };
      cur.data[t.sub] = after;
      rowData.set(k, cur);
    } else if (t.kind === 'blocks') {
      const k = `${t.field}|${s.leaf.i}`;
      const cur = blockNodes.get(k) || { field: t.field, key: s.key, node: JSON.parse(JSON.stringify(doc[t.field][s.leaf.i])) };
      let n2 = cur.node;
      for (const p of s.leaf.path) n2 = n2.children[p];
      n2.text = after;
      blockNodes.set(k, cur);
    }
  });
  const ops = [
    ...[...rowData.values()].map((r) => ({ op: 'update', field: r.field, key: r.key, data: r.data })),
    ...[...blockNodes.values()].map((b) => ({ op: 'update', field: b.field, key: b.key, data: b.node })),
  ];
  return { count, perPath, set, ops, samples };
}

/** The permission field of a text target: zones and blocks are permitted per field, components per leaf. */
const permPath = (t) => (t.kind === 'zone' || t.kind === 'blocks' ? t.field : t.path);

function resolveTargets(strapi, uid, fields) {
  const all = textTargets(strapi, uid);
  if (!fields || !fields.length) return all;
  const byPath = new Map(all.map((t) => [t.path, t]));
  const out = [];
  for (const f of fields) {
    if (byPath.has(f)) { out.push(byPath.get(f)); continue; }
    const whole = all.filter((t) => t.field === f);
    if (!whole.length) throw new WsError({ code: 'invalid', message: `fields: ${f} is not a text path of ${uid}.`, allowed: all.map((t) => t.path) });
    out.push(...whole);
  }
  return out;
}

const replaceCfg = { current: null };

/**
 * The replacer of one job chunk (1.0 hardening item 22; fourth review N12). rc.2 built a new replacer per document, so
 * the total regex budget never accumulated: a pattern just under the per-document limit could block the event loop
 * for regexTimeoutMs x chunk size while the chunk held its row locks. Now one replacer serves the whole chunk with a
 * budget of replace.chunkRegexMs, and the chunk ends (commits; the next chunk goes on) before a document could get less
 * than its full per-document limit.
 */
function chunkReplacer(chunk, spec) {
  if (!chunk.replacer) chunk.replacer = makeReplacer(spec, { ...replaceCfg.current, totalRegexMs: replaceCfg.current.chunkRegexMs });
  return chunk.replacer;
}

B.registerAction('replace', {
  permission: 'update',
  events: ['entry.update'],
  validate() {},
  chunkFull(chunk) {
    return Boolean(chunk.replacer) && chunk.replacer.left() < replaceCfg.current.regexTimeoutMs;
  },
  async apply(strapi, ctx, job, documentId, raw, version, preview, chunk = {}) {
    const pc = E.permissionChecker(strapi, ctx, job.uid);
    const visible = { ...M.normalize(strapi, job.uid, await pc.sanitizeOutput(raw)), documentId: raw.documentId, locale: raw.locale };
    const replacer = chunkReplacer(chunk, job.spec);
    const r = compute(strapi, job.uid, visible, resolveTargets(strapi, job.uid, job.spec.fields), replacer, 0, raw);
    if (!r.count) return { documentId, status: 'unchanged', version };
    const w = await E.applyPatch(strapi, ctx, {
      _tool: job.tool, uid: job.uid, documentId, locale: job.locale, expected_version: version,
      ...(Object.keys(r.set).length ? { set: r.set } : {}), ...(r.ops.length ? { ops: r.ops } : {}),
    });
    return { documentId, status: 'ok', version: w.version, replaced: r.count };
  },
});

/**
 * Describe the job (cheap checks: the pattern, the fields and their permissions, the locale) and how to collect its
 * documents: scan the filtered documents (as the token reads them) and keep those with a match.
 * The scan is limited by replace.maxScanDocuments (1.0 hardening item 23; rc.2 `scanMax`), separately from
 * bulk.maxDocuments, which limits how many documents the job may change.
 */
async function describe(strapi, ctx, a, cfg) {
  if (!a.uid) throw new WsError({ code: 'invalid', message: 'uid is required to plan a job (or give job_id to resume one).' });
  E.checkUid(strapi, a.uid);
  const rcfg = cfg.replace;
  const spec = { find: a.find, replace: a.replace, regex: Boolean(a.regex), flags: a.flags, case_sensitive: a.case_sensitive, fields: a.fields };
  makeReplacer(spec, rcfg); // refuses a bad pattern before anything is read
  const pcw = E.permissionChecker(strapi, ctx, a.uid);
  let targets = resolveTargets(strapi, a.uid, a.fields);
  if (!a.fields || !a.fields.length) {
    // Default scope: the text paths this token may write, so one read-only field does not fail the job.
    targets = targets.filter((t) => !pcw.cannot.update(null, permPath(t)));
    spec.fields = targets.map((t) => t.path);
  } else {
    // Explicit fields are checked up front (1.0 hardening item 6; Gemini review): before, the dry run passed and then
    // every document of the job failed with forbidden.
    const denied = [...new Set(targets.filter((t) => pcw.cannot.update(null, permPath(t))).map((t) => t.path))];
    if (denied.length) {
      throw new WsError({ code: 'forbidden', message: `This token cannot write field(s): ${denied.join(', ')}. Leave them out of fields (or leave fields out to search every text field it may write). Nothing was written.`, fields: denied });
    }
  }
  const locale = await E.resolveLocale(strapi, a.uid, a.locale);
  const collect = async () => {
    const scanMax = rcfg.maxScanDocuments;
    const m = await B.match(strapi, ctx, a.uid, locale, a.filters, 'replace', scanMax);
    if (!m.ids) {
      throw new WsError({ code: 'too_many_documents', match_count: m.count, scan_limit: scanMax, message: `${m.count} documents match the filter; ws_replace scans at most ${scanMax} for the text (config writesafe.replace.maxScanDocuments; an admin may raise it up to ${U.HARD_MAX_DOCUMENTS}). Narrow the filter. Nothing was written.` });
    }
    const replacer = makeReplacer(spec, rcfg); // one budget (totalRegexMs) for the whole scan
    const pc = E.permissionChecker(strapi, ctx, a.uid);
    const hits = [];
    const perPath = {};
    const samples = [];
    let matches = 0;
    for (let i = 0; i < m.ids.length; i += 50) {
      const batch = m.ids.slice(i, i + 50);
      const docs = await strapi.documents(a.uid).findMany({
        filters: { documentId: { $in: batch } }, ...(locale ? { locale } : {}), ...(E.hasDP(strapi, a.uid) ? { status: 'draft' } : {}),
        populate: M.populateFor(strapi, a.uid), limit: batch.length,
      });
      for (const raw of docs) {
        const visible = { ...M.normalize(strapi, a.uid, await pc.sanitizeOutput(raw)), documentId: raw.documentId, locale: raw.locale };
        const r = compute(strapi, a.uid, visible, targets, replacer, Math.max(0, rcfg.samples - samples.length), raw);
        if (!r.count) continue;
        hits.push(raw.documentId);
        matches += r.count;
        for (const [p, n] of Object.entries(r.perPath)) perPath[p] = (perPath[p] || 0) + n;
        samples.push(...r.samples.map((s) => ({ documentId: raw.documentId, ...s })));
      }
    }
    const order = new Map(m.ids.map((id, i) => [id, i]));
    hits.sort((x, y) => order.get(x) - order.get(y));
    return {
      count: hits.length, ids: hits, qfilters: m.qfilters,
      extra: { scanned: m.ids.length, scan_limit: scanMax, documents_matched: hits.length, matches, matches_by_path: perPath, samples: samples.slice(0, rcfg.samples) },
    };
  };
  return { uid: a.uid, locale, action: 'replace', spec, filters: a.filters || {}, collect };
}

function toolDef(strapi, h, cfg) {
  replaceCfg.current = cfg.replace;
  const L = h.lenient;
  return {
    name: 'ws_replace',
    title: 'Write-safe: search and replace text, including inside components, zones and rich text',
    description: 'Find and replace text across the drafts of one content type, also inside components, dynamic-zone rows and blocks (rich text). '
      + 'Scope it with filters (Strapi filter syntax) and fields (paths like "title", "seo.metaTitle", "items.label", "sections.body", "body"). '
      + 'Literal by default; regex: true for a regular expression ($1 in replace refers to groups). Run dry_run first: it returns the matching documents, '
      + 'match counts per path, before/after samples and a plan_token. Then send the same call without dry_run, with plan_token: it runs as a resumable ws_bulk job on exactly the documents the dry run found; '
      + 'each document is re-read under lock and replaced in its current text with a version precondition, rows keep their ids. Continue with {job_id} if status is "running".',
    auth: h.policies(strapi, 'plugin::content-manager.explorer.update'),
    resolveInputSchema: () => z.object({
      uid: h.uidSchema(strapi).optional().describe('Content type UID (not needed with job_id).'),
      locale: h.localeSchema,
      find: z.string().optional().describe('Text to find (literal), or a regular expression with regex: true.'),
      replace: z.string().optional().describe('Replacement text. With regex, $1, $<name> and $& are expanded.'),
      regex: L.bool(z.boolean()).optional().describe('Treat find as a regular expression (default: literal text).'),
      flags: z.string().optional().describe('Regex flags besides g: any of i, m, s, u.'),
      case_sensitive: L.bool(z.boolean()).optional().describe('Default true.'),
      fields: L.arr(z.array(z.string())).optional().describe('Text paths to search, e.g. ["title", "sections.body", "items.label", "body"]. A top-level name covers all its text paths. Default: all.'),
      filters: L.obj(z.object({}).catchall(z.any())).optional().describe('Strapi filters narrowing the documents scanned.'),
      ...B.jobArgs(L),
    }).strict(),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args, extra }) => {
      try {
        if (!args.job_id && (args.find === undefined || args.replace === undefined)) throw new WsError({ code: 'invalid', message: 'find and replace are required (or give job_id to resume a job).' });
        const r = await B.handle(strapi, context, extra, 'ws_replace', args, cfg.bulk, (st, ctx, a) => describe(st, ctx, a, cfg));
        return r.ok === false ? h.fail(r) : h.ok(r);
      } catch (e) { return h.fail(h.errorOf(e)); }
    },
  };
}

module.exports = {
  name: 'replace',
  tools: (strapi, api) => [toolDef(strapi, U.helpers(api), U.settings(strapi))],
  toolDef, makeReplacer, compute, textTargets, describe, chunkReplacer, resolveTargets, permPath,
  _setConfig: (c) => { replaceCfg.current = c; }, // tests
};
