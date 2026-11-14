'use strict';
// Unit tests for the 1.0 hardening, phase 4 (rest): the ws_job tool, publish: "if_clean" on ws_patch / ws_bulk /
// ws_replace, and per-field if_match on ws_patch and ws_batch patch items. Modules are required inside each test, so a
// missing export fails that test only. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { z } = require('@strapi/utils');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {}, debug() {} } };
const need = (p) => require(p);
const codeOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return (e.payload && e.payload.code) || e.message; } };
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.payload || { message: e.message }; } };

const PAGE = 'api::page.page';
const ART = 'api::article.article';

// ---------------------------------------------------------------- registry helpers (as test/phase4d.test.js)
function registryStrapi(cfg) {
  const defs = [];
  const strapi = {
    contentTypes: {
      [PAGE]: { uid: PAGE, kind: 'collectionType', options: { draftAndPublish: true }, info: { singularName: 'page' }, attributes: { title: { type: 'string' }, items: { type: 'component', repeatable: true, component: 'shared.item' } } },
      [ART]: { uid: ART, kind: 'collectionType', options: { draftAndPublish: true }, info: { singularName: 'article' }, pluginOptions: { i18n: { localized: true } }, attributes: { title: { type: 'string', pluginOptions: { i18n: { localized: true } } } } },
    },
    components: { 'shared.item': { attributes: { label: { type: 'string' } } } },
    config: { get: (k) => (k === 'plugin::writesafe' ? cfg : undefined) },
    log: { warn() {}, info() {}, error() {}, debug() {} },
    ai: { mcp: { registerTool: (d) => defs.push(d), isRunning: () => false, isEnabled: () => true } },
    plugin: () => undefined,
  };
  return { strapi, defs };
}
function registered(cfg) {
  const tools = need('../server/tools');
  const { strapi, defs } = registryStrapi(cfg);
  tools.register(strapi);
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  const schema = (n) => z.toJSONSchema(byName[n].resolveInputSchema({}), { unrepresentable: 'any' });
  const parse = (n, a) => byName[n].resolveInputSchema({}).safeParse(a);
  return { strapi, defs, byName, schema, parse };
}
const resetModules = () => need('../server/modules').load(null, { modules: {} });
const handlerOut = async (def, args) => def.createHandler({}, { userAbility: {}, user: { id: 1 } })({ args, extra: {} });

// ---------------------------------------------------------------- 1. ws_job: registration and schemas

test('ws_job: registered once when bulk or replace is on, never with the default modules', () => {
  try {
    const none = registered({ modules: {} });
    assert.ok(!none.byName.ws_job, 'default modules: no ws_job');
    for (const modules of [{ bulk: true }, { replace: true }, { bulk: true, replace: true }]) {
      const { defs } = registered({ modules });
      assert.strictEqual(defs.filter((d) => d.name === 'ws_job').length, 1, `${JSON.stringify(modules)}: one ws_job`);
    }
    // the tool count: +1 with bulk on (ws_bulk and ws_job), unchanged without it
    const base = registered({ modules: { history: true } }).defs.length;
    assert.strictEqual(registered({ modules: { history: true, bulk: true } }).defs.length, base + 2);
    assert.strictEqual(registered({ modules: { history: true, bulk: true, replace: true } }).defs.length, base + 3);
  } finally { resetModules(); }
});

test('ws_job: strict schema with action list|status|cancel|undo and no force (also with allowForce on)', () => {
  try {
    for (const allowForce of [false, true]) {
      const { schema, parse } = registered({ modules: { bulk: true, history: true }, allowForce });
      const js = schema('ws_job');
      assert.deepStrictEqual(js.properties.action.enum, ['list', 'status', 'cancel', 'undo']);
      assert.ok(!js.properties.force, 'no force');
      for (const k of ['job_id', 'items', 'cursor', 'limit', 'on_conflict', 'chunk_size', 'max_chunks', 'dry_run', 'preview']) assert.ok(js.properties[k], `ws_job has ${k}`);
      assert.ok(parse('ws_job', { action: 'list' }).success);
      assert.ok(parse('ws_job', { action: 'status', job_id: 'j1', items: 'all', cursor: '5' }).success);
      assert.ok(!parse('ws_job', { action: 'resume', job_id: 'j1' }).success, 'no resume action');
      assert.ok(!parse('ws_job', { action: 'list', nope: 1 }).success, 'strict');
      assert.ok(!parse('ws_job', { action: 'cancel', job_id: 'j1', force: true }).success, 'force refused');
    }
  } finally { resetModules(); }
});

test('ws_bulk / ws_replace: status_only, items, cursor and control "cancel" are refused naming ws_job (schema); max_chunks stays', () => {
  try {
    const { parse, schema } = registered({ modules: { bulk: true, replace: true } });
    for (const n of ['ws_bulk', 'ws_replace']) {
      const js = schema(n);
      for (const k of ['status_only', 'items', 'cursor']) assert.ok(!js.properties[k], `${n} no longer offers ${k}`);
      assert.ok(js.properties.max_chunks, `${n} keeps max_chunks (pacing)`);
      assert.deepStrictEqual(js.properties.control.enum, ['resume'], `${n}: control is only "resume"`);
      assert.ok(js.properties.job_id, `${n} keeps job_id`);
      for (const a of [{ job_id: 'j1', status_only: true }, { job_id: 'j1', items: 'all' }, { job_id: 'j1', cursor: '3' }, { job_id: 'j1', max_chunks: 2, status_only: true }]) {
        const r = parse(n, a);
        assert.ok(!r.success, `${n} ${JSON.stringify(a)} refused`);
        const issues = JSON.stringify(r.error.issues);
        assert.match(issues, /ws_job/, `${n}: the error names ws_job (${issues})`);
        assert.doesNotMatch(issues, /max_chunks[,:]/, `${n}: max_chunks is not listed as moved (${issues})`);
      }
      assert.ok(parse(n, { job_id: 'j1', max_chunks: 2 }).success, `${n}: {job_id, max_chunks} continues`);
      assert.ok(parse(n, { job_id: 'j1', max_chunks: 1, control: 'resume' }).success, `${n}: resume with max_chunks`);
      assert.ok(!parse(n, { job_id: 'j1', max_chunks: 0 }).success, `${n}: max_chunks is at least 1`);
      const c = parse(n, { job_id: 'j1', control: 'cancel' });
      assert.ok(!c.success);
      assert.match(JSON.stringify(c.error.issues), /ws_job/, `${n}: control cancel names ws_job`);
      assert.ok(parse(n, { job_id: 'j1', control: 'resume' }).success, `${n}: resume stays`);
      assert.ok(parse(n, { job_id: 'j1' }).success, `${n}: job_id alone continues`);
      assert.match(byNameDesc(n), /ws_job/, `${n} description points at ws_job`);
    }
    function byNameDesc(n) { return registered({ modules: { bulk: true, replace: true } }).byName[n].description; }
  } finally { resetModules(); }
});

test('ws_bulk / ws_replace: the handler refuses the moved arguments too (invalid, naming ws_job), before any database work', async () => {
  try {
    const { byName } = registered({ modules: { bulk: true, replace: true } });
    for (const n of ['ws_bulk', 'ws_replace']) {
      for (const a of [{ job_id: 'j1', status_only: true }, { job_id: 'j1', control: 'cancel' }, { job_id: 'j1', max_chunks: 1, items: 'all' }, { job_id: 'j1', cursor: '0' }]) {
        const out = await handlerOut(byName[n], a);
        assert.ok(out.isError, `${n} ${JSON.stringify(a)}`);
        assert.strictEqual(out.structuredContent.error.code, 'invalid');
        assert.match(out.structuredContent.error.message, /ws_job/);
        assert.doesNotMatch(out.structuredContent.error.message, /max_chunks[,:]/, 'max_chunks is not named as moved');
      }
    }
  } finally { resetModules(); }
});

test('ws_bulk: one description (no duplicate key), mentioning publish "if_clean"', () => {
  const fs = need('node:fs');
  const src = fs.readFileSync(require.resolve('../server/modules/_bulk/jobs.js'), 'utf8');
  const def = src.slice(src.indexOf('function toolDef('));
  assert.strictEqual((def.slice(0, def.indexOf('resolveInputSchema')).match(/\n\s+description:/g) || []).length, 1, 'ws_bulk has one description key');
  try {
    const { byName, parse } = registered({ modules: { bulk: true, replace: true } });
    assert.match(byName.ws_bulk.description, /if_clean/);
    assert.ok(parse('ws_bulk', { uid: PAGE, filters: { title: 'x' }, set: { title: 'y' }, publish: 'if_clean', dry_run: true }).success);
    assert.ok(!parse('ws_bulk', { uid: PAGE, filters: { title: 'x' }, set: { title: 'y' }, publish: 'always' }).success);
    assert.ok(parse('ws_replace', { uid: PAGE, find: 'a', replace: 'b', publish: 'if_clean', dry_run: true }).success);
  } finally { resetModules(); }
});

test('guidance: the instructions name ws_job only when bulk or replace is on, and mention if_match and if_clean', () => {
  const G = need('../server/guidance');
  assert.match(G.instructions([PAGE], 'guard', ['history', 'bulk']), /ws_job/);
  assert.match(G.instructions([PAGE], 'guard', ['replace']), /ws_job/);
  assert.ok(!/ws_job/.test(G.instructions([PAGE], 'guard', ['history'])), 'no ws_job without bulk/replace');
  const t = G.instructions([PAGE], 'guard', ['history']);
  assert.match(t, /if_match/);
  assert.match(t, /if_clean/);
});

// ---------------------------------------------------------------- 2. ws_job: list, status, cancel, undo (stub store)

/** The job tables in memory, with update, count and ordering (as the store uses them). */
function jobStrapi({ jobs = [], items = [], receipts = [] } = {}) {
  const S = need('../server/modules/_bulk/store');
  const tableOf = (uid) => (uid === S.JOB_UID ? jobs : uid === S.ITEM_UID ? items : receipts);
  const match = (row, where) => Object.entries(where || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$gt' in v) return row[k] > v.$gt;
      if ('$lt' in v) return row[k] < v.$lt;
      if ('$in' in v) return v.$in.includes(row[k]);
      if ('$startsWith' in v) return String(row[k]).startsWith(v.$startsWith);
    }
    return row[k] === v;
  });
  const sorted = (rows, orderBy) => {
    if (!orderBy) return rows;
    const [[k, dir]] = Object.entries(orderBy);
    return [...rows].sort((a, b) => (dir === 'desc' ? b[k] - a[k] : a[k] - b[k]));
  };
  const st = {
    config: { get: (k) => (k === 'plugin::writesafe' ? {} : k === 'server.app.keys' ? ['k'] : undefined) },
    log: { warn() {}, info() {}, error() {}, debug() {} },
    contentTypes: { [S.JOB_UID]: {}, [S.ITEM_UID]: {} },
    components: {},
    db: {
      config: { connection: { client: 'sqlite' } },
      transaction: async (cb) => cb({}),
      queryBuilder: (uid) => {
        const q = { where: {} };
        const chain = {
          select() { return chain; }, where(w) { q.where = w; return chain; }, orderBy() { return chain; }, limit() { return chain; }, forUpdate() { return chain; },
          first() { q.first = true; return chain; },
          execute: async () => { const rows = tableOf(uid).filter((r) => match(r, q.where)); return q.first ? (rows[0] ? { ...rows[0] } : null) : rows; },
        };
        return chain;
      },
      query: (uid) => ({
        findOne: async ({ where }) => { const r = tableOf(uid).find((x) => match(x, where)); return r ? { ...r } : null; },
        findMany: async ({ where, orderBy, limit }) => sorted(tableOf(uid).filter((r) => match(r, where)), orderBy).slice(0, limit || 1e9).map((r) => ({ ...r })),
        count: async ({ where }) => tableOf(uid).filter((r) => match(r, where)).length,
        update: async ({ where, data }) => { const r = tableOf(uid).find((x) => match(x, where)); if (r) Object.assign(r, data); return r; },
        create: async ({ data }) => { const r = { id: tableOf(uid).length + 1, ...data }; tableOf(uid).push(r); return r; },
        createMany: async ({ data }) => { tableOf(uid).push(...data); return { count: data.length }; },
      }),
    },
  };
  return st;
}
const bulkRow = (id, over = {}) => ({
  id, jobId: `j${id}`, owner: 'o', slot: null, tool: 'ws_bulk', contentType: PAGE, targetLocale: null, action: 'patch', mode: 'continue', state: 'done',
  spec: { set: { title: 'x' } }, total: 3, cursor: 3, chunks: 1, nOk: 2, nUnchanged: 0, nSkipped: 0, nFailed: 1, nConflict: 0, undoable: true,
  createdAt: `2026-01-0${id}T00:00:00.000Z`, updatedAt: `2026-01-0${id}T00:00:01.000Z`, ...over,
});
const undoRow = (id, over = {}) => ({
  id, jobId: `u${id}`, owner: 'o', slot: 'undo|scope', tool: 'ws_undo', action: 'undo', mode: 'skip', chunkSize: 25, state: 'running', total: 4, cursor: 1, chunks: 1,
  stopped: null, undoable: false, spec: { v: 1, receipt_id: 'j1', single: false, scope: 'scope', force: false, total: 4, cursor: null, totals: { restored: 1 }, items: 1 },
  createdAt: `2026-01-0${id}T00:00:00.000Z`, updatedAt: `2026-01-0${id}T00:00:01.000Z`, ...over,
});

test('ws_job list: the caller\'s jobs only (bulk, replace and undo), newest first, paged', async () => {
  const JT = need('../server/modules/_bulk/job-tool');
  const st = jobStrapi({
    jobs: [bulkRow(1), bulkRow(2, { tool: 'ws_replace', action: 'replace', state: 'running', cursor: 1 }), undoRow(3), bulkRow(4, { owner: 'x' }), bulkRow(5, { state: 'awaiting_approval' })],
  });
  const p1 = await JT.list(st, 'o', { limit: 2 });
  assert.deepStrictEqual(p1.jobs.map((j) => j.job_id), ['j5', 'u3'], 'own jobs, newest first');
  assert.ok(p1.next_cursor, 'more pages');
  const p2 = await JT.list(st, 'o', { limit: 2, cursor: p1.next_cursor });
  assert.deepStrictEqual(p2.jobs.map((j) => j.job_id), ['j2', 'j1']);
  assert.ok(!p2.next_cursor, 'last page');
  const j1 = p2.jobs[1];
  for (const k of ['job_id', 'tool', 'action', 'uid', 'status', 'total', 'processed', 'totals', 'created_at', 'updated_at']) assert.ok(k in j1, `list item has ${k}`);
  assert.ok(!('spec' in j1) && !('qfilters' in j1), 'no content in the list (no spec, no filter)');
  assert.strictEqual(j1.uid, PAGE);
  assert.deepStrictEqual(j1.totals, { ok: 2, unchanged: 0, skipped: 0, failed: 1, conflict: 0 });
  const u = p1.jobs[1];
  assert.strictEqual(u.tool, 'ws_undo');
  assert.strictEqual(u.undo_of, 'j1');
  assert.ok(!JSON.stringify([p1, p2]).includes('"j4"'), 'never another token\'s job');
  assert.strictEqual(await codeOf(() => JT.list(st, 'o', { cursor: 'abc' })), 'invalid');
});

test('ws_job status: a bulk job like status_only before (problems by default, paged), another token\'s job is not_found', async () => {
  const JT = need('../server/modules/_bulk/job-tool');
  const items = [
    { jobId: 'j1', ordinal: 0, docId: 'a', state: 'ok', chunk: 1, info: null },
    { jobId: 'j1', ordinal: 1, docId: 'b', state: 'failed', chunk: 1, info: { error: { code: 'invalid', message: 'm' } } },
    { jobId: 'j1', ordinal: 2, docId: 'c', state: 'ok', chunk: 1, info: null },
  ];
  const st = jobStrapi({ jobs: [bulkRow(1), bulkRow(4, { owner: 'x' })], items });
  const r = await JT.status(st, {}, {}, 'o', { job_id: 'j1' });
  assert.strictEqual(r.job_id, 'j1');
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.items_scope, 'problems');
  assert.deepStrictEqual(r.items.map((i) => i.documentId), ['b']);
  const all = await JT.status(st, {}, {}, 'o', { job_id: 'j1', items: 'all' });
  assert.deepStrictEqual(all.items.map((i) => i.documentId), ['a', 'b', 'c']);
  assert.strictEqual(await codeOf(() => JT.status(st, {}, {}, 'o', { job_id: 'j4' })), 'not_found');
  assert.strictEqual(await codeOf(() => JT.status(st, {}, {}, 'o', { job_id: 'nope' })), 'not_found');
  assert.strictEqual(await codeOf(() => JT.status(st, {}, {}, 'o', {})), 'invalid', 'job_id required');
});

test('ws_job cancel: a running or awaiting_approval bulk job is cancelled (slot freed); a done job is left as it is', async () => {
  const JT = need('../server/modules/_bulk/job-tool');
  const jobs = [bulkRow(1, { state: 'running', slot: 'o|p', cursor: 1 }), bulkRow(2, { state: 'awaiting_approval', slot: 'o|q', cursor: 0 }), bulkRow(3), bulkRow(4, { owner: 'x', state: 'running', slot: 'x|p' })];
  const st = jobStrapi({ jobs });
  const r = await JT.cancel(st, {}, {}, 'o', { job_id: 'j1' });
  assert.strictEqual(r.status, 'cancelled');
  assert.strictEqual(r.cancelled, true);
  assert.strictEqual(jobs[0].state, 'cancelled');
  assert.strictEqual(jobs[0].slot, null);
  assert.match(r.note, /kept/);
  const w = await JT.cancel(st, {}, {}, 'o', { job_id: 'j2' });
  assert.strictEqual(w.status, 'cancelled', 'a job waiting for approval is cancelled by its owner');
  const d = await JT.cancel(st, {}, {}, 'o', { job_id: 'j3' });
  assert.strictEqual(d.status, 'done');
  assert.strictEqual(d.cancelled, false);
  assert.strictEqual(await codeOf(() => JT.cancel(st, {}, {}, 'o', { job_id: 'j4' })), 'not_found');
  assert.strictEqual(jobs[3].state, 'running', 'another token\'s job is untouched');
});

test('undo job cancel: stops after the current chunk, keeps what was reverted, frees the slot; resuming it is job_cancelled', async () => {
  const JT = need('../server/modules/_bulk/job-tool');
  const UJ = need('../server/modules/history/undo-job');
  const E = need('../server/engine');
  const jobs = [undoRow(3)];
  const st = jobStrapi({ jobs });
  const r = await JT.cancel(st, {}, {}, 'o', { job_id: 'u3' });
  assert.strictEqual(r.status, 'cancelled');
  assert.strictEqual(r.cancelled, true);
  assert.strictEqual(jobs[0].state, 'cancelled');
  assert.strictEqual(jobs[0].slot, null, 'the slot is free: a new undo of the same receipt may start');
  assert.match(r.note, /kept/);
  assert.deepStrictEqual(r.totals.restored, 1, 'what was reverted before is reported');
  // the cancel itself, as undo-job exports it
  assert.strictEqual(typeof UJ.cancel, 'function');
  // ws_undo {undo_job_id} on the cancelled job
  const e = await errOf(() => UJ.handle(st, {}, E, { undo_job_id: 'u3' }, { requestInfo: { headers: { authorization: 'Bearer t' } } }).catch((x) => { throw x; }));
  // the owner differs here (token scope), so check the cancelled state on the owner path directly
  assert.ok(e, 'refused');
  const job = { job_id: 'u3', status: 'cancelled' };
  assert.strictEqual((await errOf(() => UJ.resumeCheck(job))).code, 'job_cancelled');
});

test('ws_job undo: starts (or continues) the undo job of the caller\'s job through the undo-job code; other tokens get not_found', async () => {
  const JT = need('../server/modules/_bulk/job-tool');
  const UJ = need('../server/modules/history/undo-job');
  const MOD = need('../server/modules');
  const orig = { handle: UJ.handle, sourceStatus: UJ.sourceStatus };
  const calls = [];
  UJ.handle = async (strapi, ctx, E, a) => { calls.push(a); return { ok: true, undo_job_id: 'u9', undo_of: a.receipt_id || null, status: 'running', next: { hint: 'Call ws_undo again with only {undo_job_id}', undo_job_id: 'u9' } }; };
  UJ.sourceStatus = async () => null;
  try {
    MOD.load(null, { modules: { bulk: true } }); // history on by default
    const st = jobStrapi({ jobs: [bulkRow(1), bulkRow(4, { owner: 'x' }), undoRow(3), bulkRow(5, { action: 'publish', undoable: false })] });
    const r = await JT.undo(st, {}, {}, 'o', { job_id: 'j1', on_conflict: 'stop', chunk_size: 5, max_chunks: 1 });
    assert.strictEqual(calls[0].receipt_id, 'j1');
    assert.strictEqual(calls[0].on_conflict, 'stop');
    assert.strictEqual(calls[0].chunk_size, 5);
    assert.strictEqual(calls[0].max_chunks, 1);
    assert.match(r.next.hint, /ws_job/, 'the continue hint names ws_job');
    assert.strictEqual(await codeOf(() => JT.undo(st, {}, {}, 'o', { job_id: 'j4' })), 'not_found');
    // an active undo job id: continued
    await JT.undo(st, {}, {}, 'o', { job_id: 'u3' });
    assert.strictEqual(calls[1].undo_job_id, 'u3');
    // a publish job cannot be undone
    assert.strictEqual(await codeOf(() => JT.undo(st, {}, {}, 'o', { job_id: 'j5' })), 'unsupported');
    // an active source job: job_running
    UJ.sourceStatus = async () => 'running';
    assert.strictEqual(await codeOf(() => JT.undo(st, {}, {}, 'o', { job_id: 'j1' })), 'job_running');
    UJ.sourceStatus = async () => null;
    // history off: unsupported
    MOD.load(null, { modules: { bulk: true, history: false } });
    assert.strictEqual(await codeOf(() => JT.undo(st, {}, {}, 'o', { job_id: 'j1' })), 'unsupported');
  } finally { Object.assign(UJ, orig); resetModules(); }
});

test('ws_job: each action takes only its own arguments', async () => {
  const JT = need('../server/modules/_bulk/job-tool');
  const st = jobStrapi({ jobs: [bulkRow(1)] });
  assert.strictEqual(await codeOf(() => JT.dispatch(st, {}, {}, 'o', { action: 'list', job_id: 'j1' })), 'invalid');
  assert.strictEqual(await codeOf(() => JT.dispatch(st, {}, {}, 'o', { action: 'cancel', job_id: 'j1', items: 'all' })), 'invalid');
  assert.strictEqual(await codeOf(() => JT.dispatch(st, {}, {}, 'o', { action: 'status', job_id: 'j1', on_conflict: 'skip' })), 'invalid');
  assert.strictEqual(await codeOf(() => JT.dispatch(st, {}, {}, 'o', { action: 'status', job_id: 'j1' })), 'ok');
});

// ---------------------------------------------------------------- 3. hints and approval tier

test('job hints name ws_job: pause text, stopped job, approval reply and the job_running refusal', () => {
  const J = need('../server/modules/_bulk/jobs');
  assert.match(J.PAUSE_TEXT.canary, /ws_job/);
  assert.ok(!/control: "cancel"/.test(J.PAUSE_TEXT.canary));
  const fs = need('node:fs');
  for (const f of ['../server/modules/_bulk/jobs.js', '../server/approval/gate.js']) {
    const src = fs.readFileSync(require.resolve(f), 'utf8');
    assert.ok(!/control: \\?"cancel\\?"/.test(src.replace(/\/\/.*$/gm, '')), `${f}: no hint sends control "cancel"`);
    assert.ok(!/status_only: true\}/.test(src.replace(/\/\/.*$/gm, '')), `${f}: no hint sends status_only`);
  }
});

test('approvals: a ws_bulk patch with publish "if_clean" counts as a publish for approvals.escalate.publish', () => {
  const GATE = need('../server/approval/gate');
  const T = need('../server/approval/tiers');
  const strapi = registryStrapi({}).strapi;
  const s = T.settings({ enabled: true, escalate: { publish: true } }, 5000);
  const plain = T.tierFor(3, GATE.opOf(strapi, { uid: PAGE, action: 'patch', spec: { set: { title: 'x' } } }), s);
  assert.strictEqual(plain.tier, 'automatic');
  const clean = T.tierFor(3, GATE.opOf(strapi, { uid: PAGE, action: 'patch', spec: { set: { title: 'x' }, publish: 'if_clean' } }), s);
  assert.strictEqual(clean.reason, 'publish');
  const off = T.settings({ enabled: true }, 5000);
  assert.strictEqual(T.tierFor(3, GATE.opOf(strapi, { uid: PAGE, action: 'patch', spec: { publish: 'if_clean' } }), off).tier, 'automatic');
});

test('ws_bulk: publish "if_clean" is part of the plan (spec hash) and its totals count published and skipped', () => {
  const J = need('../server/modules/_bulk/jobs');
  const a = { uid: PAGE, filters: { title: 'x' }, set: { title: 'y' } };
  const d = (spec) => ({ action: 'patch', spec });
  assert.notStrictEqual(J.specHash('ws_bulk', a, d({ set: { title: 'y' } })), J.specHash('ws_bulk', a, d({ set: { title: 'y' }, publish: 'if_clean' })));
  const plain = J.bulkSpec({ action: 'patch', set: { title: 'y' } });
  assert.deepStrictEqual(plain, { set: { title: 'y' }, unset: undefined, ops: undefined }, 'built as rc.2 built it (same plan hash)');
  assert.ok(!('publish' in plain), 'no publish key without the argument');
  assert.deepStrictEqual(J.bulkSpec({ action: 'patch', set: { title: 'y' }, publish: 'if_clean' }), { set: { title: 'y' }, unset: undefined, ops: undefined, publish: 'if_clean' });
  const job = { nOk: 3, nUnchanged: 0, nSkipped: 0, nFailed: 0, nConflict: 0, nPublished: 2, nPublishSkipped: 1, spec: { publish: 'if_clean' } };
  assert.deepStrictEqual(J.totalsOf(job), { ok: 3, unchanged: 0, skipped: 0, failed: 0, conflict: 0, published: 2, publish_skipped: 1 });
  assert.ok(!('published' in J.totalsOf({ ...job, spec: {} })), 'plain jobs keep their totals');
  const S = need('../server/modules/_bulk/store');
  const attrs = S.contentTypes['bulk-job'].schema.attributes;
  assert.strictEqual(attrs.nPublished.type, 'integer');
  assert.strictEqual(attrs.nPublishSkipped.type, 'integer');
  assert.strictEqual(S.rowToJob({ nPublished: '2', nPublishSkipped: null }).nPublished, 2);
  // an item that published, or skipped the publish, keeps that in its stored info and in the status list
  const out = J.itemOut({ state: 'ok' }, { docId: 'a', state: 'ok', chunk: 1, info: { publish_skipped: 'draft_had_other_changes' } });
  assert.strictEqual(out.publish_skipped, 'draft_had_other_changes');
  assert.deepStrictEqual(J.storedInfo({ status: 'ok', publish_skipped: 'draft_had_other_changes' }), { publish_skipped: 'draft_had_other_changes' });
  assert.deepStrictEqual(J.storedInfo({ status: 'ok', published: true }), { published: true });
});

// ---------------------------------------------------------------- 4 and 5. ws_patch: publish "if_clean" and if_match

/**
 * A stub Strapi for applyPatch on one draft & publish page: SQLite (no row lock statements), the Document Service
 * records update/publish and keeps the draft and the live version in memory.
 */
function patchStrapi({ draft, live = null, dp = true, cannotPublish = false, unreadable = [], attrs = {}, components = {}, readable = null, sanitize = null } = {}) {
  const calls = { update: [], publish: [], findPublished: 0 };
  const state = { draft: { ...draft }, live: live ? { ...live } : null };
  const visible = sanitize || ((o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !unreadable.includes(k))));
  // readable(path): the permission check of one field path (default: every path but those in `unreadable`)
  const canRead = (f) => (f === undefined ? true : (readable ? readable(f) : !unreadable.includes(f)));
  const pc = {
    cannot: { update: () => false, publish: () => cannotPublish, read: (e, f) => !canRead(f), create: () => false, delete: () => false },
    can: { read: (e, f) => canRead(f), update: () => true, publish: () => !cannotPublish },
    sanitizeOutput: async (d) => visible(d),
    sanitizeUpdateInput: () => async (d) => d,
  };
  let tick = 0;
  const strapi = {
    contentTypes: {
      [PAGE]: {
        uid: PAGE, kind: 'collectionType', options: { draftAndPublish: dp }, info: { singularName: 'page' },
        attributes: { title: { type: 'string' }, note: { type: 'text' }, secret: { type: 'string' }, views: { type: 'integer' }, ...attrs },
      },
    },
    components,
    config: { get: () => undefined },
    log: { warn() {}, info() {}, error() {}, debug() {} },
    plugin: (n) => (n === 'content-manager' ? { service: () => ({ create: () => pc }) } : undefined),
    db: {
      config: { connection: { client: 'sqlite' } },
      transaction: async (cb) => cb({}),
      queryBuilder: () => {
        const ch = { select: () => ch, where: () => ch, orderBy: () => ch, forUpdate: () => ch, execute: async () => [{ id: 1, documentId: state.draft.documentId, updatedAt: state.draft.updatedAt }] };
        return ch;
      },
      query: () => ({ findOne: async () => null, findMany: async () => [], count: async () => 0 }),
    },
    documents: () => ({
      findOne: async (p) => {
        if (p.status === 'published') { calls.findPublished += 1; return state.live ? { ...state.live } : null; }
        return { ...state.draft };
      },
      update: async (p) => {
        calls.update.push(p);
        tick += 1;
        const { updatedBy, ...data } = p.data || {};
        state.draft = { ...state.draft, ...data, updatedAt: new Date(Date.parse(state.draft.updatedAt) + tick * 1000).toISOString() };
        return { ...state.draft };
      },
      publish: async (p) => { calls.publish.push(p); state.live = { ...state.draft, id: 99, publishedAt: '2026-02-01T00:00:00.000Z' }; return { documentId: p.documentId }; },
    }),
  };
  return { strapi, calls, state, pc };
}
const ctx = { userAbility: {}, user: { id: 1 } };
const DRAFT = { id: 1, documentId: 'd1', title: 'Old', note: 'n', secret: 's', views: 3, publishedAt: null, updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' };
const LIVE = { ...DRAFT, id: 2, publishedAt: '2026-01-01T00:00:00.000Z' };
const quiet = () => need('../server/modules').load(null, { modules: { history: false } });

test('if_clean: a draft equal to the live version is patched and published in the same write', async () => {
  const E = need('../server/engine');
  const M = need('../server/model');
  quiet();
  try {
    const { strapi, calls, state } = patchStrapi({ draft: DRAFT, live: LIVE });
    const v = M.versionOf(strapi, PAGE, DRAFT);
    const r = await E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: 'New' }, expected_version: v, publish: 'if_clean' });
    assert.strictEqual(calls.update.length, 1);
    assert.strictEqual(calls.publish.length, 1, 'published');
    assert.strictEqual(r.published, true);
    assert.strictEqual(r.published_version, r.version, 'the version written is the version published');
    assert.ok(!('publish_skipped' in r));
    assert.strictEqual(state.live.title, 'New');
  } finally { resetModules(); }
});

test('if_clean: a draft with other unpublished changes is patched but not published (publish_skipped)', async () => {
  const E = need('../server/engine');
  const M = need('../server/model');
  quiet();
  try {
    const { strapi, calls } = patchStrapi({ draft: { ...DRAFT, note: 'unreviewed' }, live: LIVE });
    const v = M.versionOf(strapi, PAGE, { ...DRAFT, note: 'unreviewed' });
    const r = await E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: 'New' }, expected_version: v, publish: 'if_clean' });
    assert.strictEqual(calls.update.length, 1, 'the draft is written');
    assert.strictEqual(calls.publish.length, 0, 'never published');
    assert.strictEqual(r.published, false);
    assert.strictEqual(r.publish_skipped, 'draft_had_other_changes');
    assert.ok(!JSON.stringify(r).includes('unreviewed'), 'no content in the reply');
    // never published (no live version): skipped too
    const n = patchStrapi({ draft: DRAFT, live: null });
    const r2 = await E.applyPatch(n.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: 'New' }, expected_version: M.versionOf(n.strapi, PAGE, DRAFT), publish: 'if_clean' });
    assert.strictEqual(n.calls.publish.length, 0);
    assert.strictEqual(r2.publish_skipped, 'no_live_version');
  } finally { resetModules(); }
});

test('if_clean: a patch that leaves the version as it was publishes nothing (nothing_changed)', async () => {
  const E = need('../server/engine');
  const M = need('../server/model');
  quiet();
  try {
    const { strapi, calls } = patchStrapi({ draft: DRAFT, live: LIVE });
    const r = await E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: DRAFT.title }, expected_version: M.versionOf(strapi, PAGE, DRAFT), publish: 'if_clean' });
    assert.strictEqual(r.version, r.previous_version, 'same content, same version');
    assert.strictEqual(calls.publish.length, 0, 'live already equals the draft: no publish (no lifecycle hooks, no new publishedAt)');
    assert.strictEqual(r.published, false);
    assert.strictEqual(r.publish_skipped, 'nothing_changed');
    const d = await E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: DRAFT.title }, expected_version: M.versionOf(strapi, PAGE, DRAFT), publish: 'if_clean', dry_run: true });
    assert.strictEqual(d.would_publish, false);
    assert.strictEqual(d.publish_skipped, 'nothing_changed');
  } finally { resetModules(); }
});

test('if_clean: refused before any write without publish permission, on a type without draft & publish, or with another value', async () => {
  const E = need('../server/engine');
  const M = need('../server/model');
  quiet();
  try {
    const a = (s) => ({ uid: PAGE, documentId: 'd1', set: { title: 'New' }, expected_version: M.versionOf(s, PAGE, DRAFT), publish: 'if_clean' });
    const np = patchStrapi({ draft: DRAFT, live: LIVE, cannotPublish: true });
    const e = await errOf(() => E.applyPatch(np.strapi, ctx, a(np.strapi)));
    assert.strictEqual(e.code, 'forbidden');
    assert.match(e.message, /Nothing was written/);
    assert.strictEqual(np.calls.update.length, 0, 'nothing written');
    const nodp = patchStrapi({ draft: DRAFT, dp: false });
    assert.strictEqual(await codeOf(() => E.applyPatch(nodp.strapi, ctx, a(nodp.strapi))), 'invalid');
    assert.strictEqual(nodp.calls.update.length, 0);
    const other = patchStrapi({ draft: DRAFT, live: LIVE });
    assert.strictEqual(await codeOf(() => E.applyPatch(other.strapi, ctx, { ...a(other.strapi), publish: 'always' })), 'invalid');
    assert.strictEqual(other.calls.update.length, 0);
  } finally { resetModules(); }
});

test('if_clean: a dry run never calls publish and says whether it would', async () => {
  const E = need('../server/engine');
  const M = need('../server/model');
  quiet();
  try {
    const { strapi, calls } = patchStrapi({ draft: DRAFT, live: LIVE });
    const r = await E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: 'New' }, expected_version: M.versionOf(strapi, PAGE, DRAFT), publish: 'if_clean', dry_run: true });
    assert.strictEqual(calls.publish.length, 0);
    assert.strictEqual(r.would_publish, true);
    assert.ok(!r.published);
    const dirty = patchStrapi({ draft: { ...DRAFT, views: 9 }, live: LIVE });
    const r2 = await E.applyPatch(dirty.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: 'New' }, expected_version: M.versionOf(dirty.strapi, PAGE, { ...DRAFT, views: 9 }), publish: 'if_clean', dry_run: true });
    assert.strictEqual(r2.would_publish, false);
    assert.strictEqual(r2.publish_skipped, 'draft_had_other_changes');
  } finally { resetModules(); }
});

test('if_clean: ws_patch offers publish, ws_batch items refuse it', async () => {
  const E = need('../server/engine');
  try {
    const { schema, parse } = registered({ modules: {} });
    assert.deepStrictEqual(schema('ws_patch').properties.publish.enum, ['if_clean']);
    assert.ok(!parse('ws_batch', { items: [{ uid: PAGE, documentId: 'd1', set: { title: 'x' }, expected_version: 'v', publish: 'if_clean' }] }).success, 'batch items have no publish');
  } finally { resetModules(); }
  quiet();
  try {
    const { strapi, calls } = patchStrapi({ draft: DRAFT, live: LIVE });
    const M = need('../server/model');
    const e = await errOf(() => E.applyBatch(strapi, ctx, { items: [{ uid: PAGE, documentId: 'd1', set: { title: 'x' }, expected_version: M.versionOf(strapi, PAGE, DRAFT), publish: 'if_clean' }] }));
    assert.ok(e && (e.code === 'invalid' || (e.failed && e.failed.error.code === 'invalid')) || calls.publish.length === 0);
    const ab = await (async () => { try { await E.applyBatch(strapi, ctx, { items: [{ uid: PAGE, documentId: 'd1', set: { title: 'x' }, expected_version: M.versionOf(strapi, PAGE, DRAFT), publish: 'if_clean' }] }); return null; } catch (x) { return x; } })();
    assert.ok(ab instanceof E.BatchAbort, 'the batch is aborted');
    assert.strictEqual(ab.failed.error.code, 'invalid');
    assert.match(ab.failed.error.message, /publish/);
    assert.strictEqual(calls.publish.length, 0);
    assert.strictEqual(calls.update.length, 0);
  } finally { resetModules(); }
});

test('if_match: a scalar set without expected_version is accepted when every written field has an entry and matches', async () => {
  const E = need('../server/engine');
  quiet();
  try {
    const { strapi, calls, state } = patchStrapi({ draft: DRAFT, live: LIVE });
    const r = await E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: 'New' }, if_match: { title: 'Old' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.update.length, 1);
    assert.strictEqual(state.draft.title, 'New');
    // canonical comparison: numbers, extra entries for fields not written
    const s2 = patchStrapi({ draft: DRAFT });
    await E.applyPatch(s2.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { views: 4 }, unset: ['note'], if_match: { views: 3, note: 'n', title: 'Old' } });
    assert.strictEqual(s2.calls.update.length, 1);
  } finally { resetModules(); }
});

test('if_match: a changed field is a version_conflict naming it, with the current value of those fields only', async () => {
  const E = need('../server/engine');
  quiet();
  try {
    const { strapi, calls } = patchStrapi({ draft: { ...DRAFT, title: 'Changed by a colleague' } });
    const e = await errOf(() => E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: 'New', views: 4 }, if_match: { title: 'Old', views: 3 } }));
    assert.strictEqual(e.code, 'version_conflict');
    assert.deepStrictEqual(e.fields_changed, ['title']);
    assert.deepStrictEqual(Object.keys(e.current).filter((k) => !['documentId', 'locale'].includes(k)), ['title'], 'current shows only the changed fields');
    assert.strictEqual(e.current.title, 'Changed by a colleague');
    assert.ok(!/Changed by a colleague/.test(e.message) && !/Changed by a colleague/.test((e.retry && e.retry.hint) || ''), 'content only in data fields');
    assert.match(e.retry.hint, /if_match/);
    assert.strictEqual(calls.update.length, 0);
  } finally { resetModules(); }
});

test('if_match: refusals (coverage, force, unknown or dotted fields, hidden fields, not an object); expected_version is still checked', async () => {
  const E = need('../server/engine');
  const M = need('../server/model');
  quiet();
  try {
    const s = patchStrapi({ draft: DRAFT, unreadable: ['secret'] });
    const p = (a) => errOf(() => E.applyPatch(s.strapi, ctx, { uid: PAGE, documentId: 'd1', ...a }));
    const cov = await p({ set: { title: 'New', note: 'x' }, if_match: { title: 'Old' } });
    assert.strictEqual(cov.code, 'precondition_required');
    assert.match(cov.message, /note/);
    assert.match(cov.message, /if_match/);
    assert.strictEqual((await p({ set: { title: 'New' }, if_match: { title: 'Old' }, force: true })).code, 'invalid');
    assert.strictEqual((await p({ set: { title: 'New' }, if_match: { title: 'Old', nope: 1 } })).code, 'invalid');
    assert.match((await p({ set: { title: 'New' }, if_match: { 'title.x': 'Old' } })).message, /top-level/);
    assert.strictEqual((await p({ set: { title: 'New' }, if_match: { title: 'Old', secret: 's' } })).code, 'forbidden', 'no oracle for a hidden value');
    assert.strictEqual((await p({ set: { title: 'New' }, if_match: ['title'] })).code, 'invalid');
    assert.strictEqual((await p({ set: { title: 'New' }, if_match: { title: 'Old' }, expected_version: M.versionOf(s.strapi, PAGE, { ...DRAFT, title: 'x' }) })).code, 'version_conflict');
    assert.strictEqual(s.calls.update.length, 0);
  } finally { resetModules(); }
});

test('if_match: a component is compared as a whole, readable when every sub-field is (permissions name leaf paths)', async () => {
  const E = need('../server/engine');
  quiet();
  try {
    const SEO = { 'shared.seo': { uid: 'shared.seo', attributes: { metaTitle: { type: 'string' }, metaDescription: { type: 'text' } } } };
    const draft = { ...DRAFT, seo: { id: 7, metaTitle: 'T', metaDescription: 'D' } };
    // as Strapi's CASL rules: a component's permission lists its leaf paths (seo.metaTitle, ...), never "seo" itself
    const opts = { draft, attrs: { seo: { type: 'component', repeatable: false, component: 'shared.seo' } }, components: SEO, readable: (f) => f !== 'seo' };
    const s = patchStrapi(opts);
    const r = await E.applyPatch(s.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { seo: { metaTitle: 'T2', metaDescription: 'D' } }, if_match: { seo: { id: 7, metaTitle: 'T', metaDescription: 'D' } } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(s.calls.update.length, 1, 'the value read (with its row id) matches: written');
    const c = patchStrapi(opts);
    const e = await errOf(() => E.applyPatch(c.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { seo: { metaTitle: 'T2' } }, if_match: { seo: { metaTitle: 'other', metaDescription: 'D' } } }));
    assert.strictEqual(e.code, 'version_conflict');
    assert.deepStrictEqual(e.fields_changed, ['seo']);
    assert.strictEqual(c.calls.update.length, 0);
    // a sub-field the token cannot read: the component is refused whatever the value (a change there would go unseen)
    const hide = (o) => ({ ...o, seo: o.seo ? { id: o.seo.id, metaTitle: o.seo.metaTitle } : o.seo });
    for (const guess of ['D', 'x']) {
      const h = patchStrapi({ ...opts, readable: (f) => f !== 'seo' && f !== 'seo.metaDescription', sanitize: hide });
      const x = await errOf(() => E.applyPatch(h.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { seo: { metaTitle: 'T2' } }, if_match: { seo: { metaTitle: 'T', metaDescription: guess } } }));
      assert.strictEqual(x.code, 'forbidden');
      assert.strictEqual(h.calls.update.length, 0);
    }
  } finally { resetModules(); }
});

test('if_match: in the ws_patch and ws_batch item schemas, and counted in versionsIn (implicit retry record)', () => {
  const E = need('../server/engine');
  try {
    const { schema } = registered({ modules: {} });
    assert.ok(schema('ws_patch').properties.if_match, 'ws_patch if_match');
    assert.match(JSON.stringify(schema('ws_batch').properties.items), /if_match/, 'ws_batch items if_match');
    assert.match(schema('ws_patch').properties.if_match.description, /expected_version/);
  } finally { resetModules(); }
  const a = E.versionsIn('ws_patch', { if_match: { title: 'Old' } });
  assert.strictEqual(a.length, 1);
  assert.notDeepStrictEqual(a, E.versionsIn('ws_patch', { if_match: { title: 'Other' } }));
  assert.strictEqual(E.versionsIn('ws_batch', { items: [{ if_match: { title: 'Old' } }, { expected_version: 'v' }] }).length, 2);
  assert.strictEqual(E.versionsIn('ws_patch', {}).length, 0);
});

test('if_match: a ws_batch patch item with if_match only does not vouch for a later publish item of the same document', async () => {
  const E = need('../server/engine');
  quiet();
  try {
    const { strapi, calls } = patchStrapi({ draft: DRAFT, live: LIVE });
    let ab = null;
    try {
      await E.applyBatch(strapi, ctx, { items: [{ uid: PAGE, documentId: 'd1', set: { title: 'New' }, if_match: { title: 'Old' } }, { action: 'publish', uid: PAGE, documentId: 'd1' }] });
    } catch (x) { ab = x; }
    assert.ok(ab instanceof E.BatchAbort);
    assert.strictEqual(ab.index, 1);
    assert.strictEqual(ab.failed.error.code, 'precondition_required');
    assert.strictEqual(calls.publish.length, 0);
    let ab2 = null;
    try { await E.applyBatch(strapi, ctx, { items: [{ action: 'publish', uid: PAGE, documentId: 'd1', if_match: { title: 'x' } }] }); } catch (x) { ab2 = x; }
    assert.strictEqual(ab2.failed.error.code, 'invalid', 'a publish item takes no if_match');
  } finally { resetModules(); }
});

// ---------------------------------------------------------------- second-agent review of the phase 4 PR

test('if_clean: a draft Strapi\'s publish validation would refuse is written and stays a draft (publish_invalid), dry run too', async () => {
  const E = need('../server/engine');
  const M = need('../server/model');
  const { errors } = require('@strapi/utils');
  quiet();
  try {
    for (const dry of [false, true]) {
      const { strapi, calls } = patchStrapi({ draft: DRAFT, live: LIVE });
      strapi.entityValidator = {
        validateEntityCreation: async () => { throw new errors.ValidationError('title must be at least 5 characters', { errors: [{ path: ['title'], message: 'too short' }] }); },
      };
      const r = await E.applyPatch(strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: 'New' }, expected_version: M.versionOf(strapi, PAGE, DRAFT), publish: 'if_clean', ...(dry ? { dry_run: true } : {}) });
      assert.strictEqual(calls.publish.length, 0, 'never published');
      assert.strictEqual(r.publish_skipped, 'publish_invalid');
      assert.deepStrictEqual(r.publish_invalid_paths, ['title']);
      if (dry) assert.strictEqual(r.would_publish, false);
      else { assert.strictEqual(r.published, false); assert.strictEqual(calls.update.length, 1, 'the draft is still written'); }
    }
    // a validator that accepts: published as before
    const ok = patchStrapi({ draft: DRAFT, live: LIVE });
    let validated = 0;
    ok.strapi.entityValidator = { validateEntityCreation: async () => { validated += 1; } };
    const r = await E.applyPatch(ok.strapi, ctx, { uid: PAGE, documentId: 'd1', set: { title: 'New' }, expected_version: M.versionOf(ok.strapi, PAGE, DRAFT), publish: 'if_clean' });
    assert.strictEqual(validated, 1);
    assert.strictEqual(r.published, true);
    assert.strictEqual(ok.calls.publish.length, 1);
  } finally { resetModules(); }
});

test('approvals: an approver of a patch or replace job with publish "if_clean" needs the publish permission too', () => {
  const A = need('../server/approval/approver');
  const pc = (canPublish) => ({ cannot: { update: () => false, publish: () => !canPublish } });
  const job = { uid: PAGE, action: 'patch', spec: { set: { title: 'x' }, publish: 'if_clean' } };
  assert.strictEqual(A.mayAct(pc(false), job), false, 'update-only admin cannot approve a job that publishes');
  assert.strictEqual(A.mayAct(pc(true), job), true);
  assert.strictEqual(A.mayAct(pc(false), { ...job, spec: { set: { title: 'x' } } }), true, 'a plain patch needs update only');
  const rep = { uid: PAGE, action: 'replace', tool: 'ws_replace', spec: { find: 'a', replace: 'b', publish: 'if_clean' } };
  assert.strictEqual(A.mayActPaths(pc(false), rep, ['title']), false);
  assert.strictEqual(A.mayActPaths(pc(true), rep, ['title']), true);
});

// A job store in memory and a chunk that only counts: handle() -> control() -> resumeView() -> runJob(), so the
// test sees how many chunks one call runs. The fake job is done after `total` chunks. The start path (plan_token, a
// start sent again) is covered end to end by tests/test_phase4_rest.py and tests/test_bulk_create.py.
async function countChunks(args, { total = 5, state = 'running', tool = 'ws_bulk' } = {}) {
  const J = need('../server/modules/_bulk/jobs');
  const S = need('../server/modules/_bulk/store');
  const U = need('../server/modules/_bulk/util');
  const E = need('../server/engine');
  const job = { id: 1, jobId: 'j1', owner: 'o', tool, contentType: PAGE, action: 'patch', mode: 'continue', state, total, cursor: 0, chunks: 0,
    nOk: 0, nUnchanged: 0, nSkipped: 0, nFailed: 0, nConflict: 0, undoable: false, reconcile: { still_matching: 0, late_matches: 0, late_ids: [] } };
  const orig = { ensure: S.ensure, findJob: S.findJob, lockJob: S.lockJob, saveJob: S.saveJob, callerId: U.callerId, runWrite: E.runWrite };
  let chunks = 0;
  let hooks = null;
  const st = { config: { get: (k) => (k === 'plugin::writesafe' ? { bulk: { paceMs: 0, timeBudgetMs: 60000 } } : undefined) }, log: { warn() {}, info() {}, error() {}, debug() {} } };
  try {
    S.ensure = async () => ({ ok: true });
    S.findJob = async () => ({ ...job });
    S.lockJob = async () => job;
    S.saveJob = async () => {};
    U.callerId = () => 'o';
    E.runWrite = async (st_, ctx, tool_, a, fn) => {
      if (fn.toString().includes('chunkTx')) {
        chunks += 1;
        job.cursor += 1;
        job.chunks += 1;
        if (job.cursor >= job.total) job.state = 'done';
        return { job: { ...job }, items: [] };
      }
      return fn();
    };
    hooks = J.setHooks({ gate: null, chunkGuard: null });
    const r = await J.handle(st, {}, {}, tool, args, U.settings(st).bulk, async () => { throw new Error('no start here'); });
    return { r, chunks };
  } finally {
    Object.assign(S, { ensure: orig.ensure, findJob: orig.findJob, lockJob: orig.lockJob, saveJob: orig.saveJob });
    U.callerId = orig.callerId;
    E.runWrite = orig.runWrite;
    if (hooks) J.setHooks(hooks);
  }
}

test('ws_bulk / ws_replace {job_id, max_chunks}: the call runs at most max_chunks chunks, the job stays resumable', async () => {
  for (const tool of ['ws_bulk', 'ws_replace']) {
    const a = await countChunks({ job_id: 'j1', max_chunks: 2 }, { tool });
    assert.strictEqual(a.chunks, 2, `${tool}: two chunks`);
    assert.strictEqual(a.r.status, 'running');
    assert.strictEqual(a.r.processed, 2);
    assert.strictEqual(a.r.next.job_id, 'j1');
    const b = await countChunks({ job_id: 'j1', max_chunks: 9 }, { tool });
    assert.strictEqual(b.chunks, 5, `${tool}: max_chunks above what is left ends at done`);
    assert.strictEqual(b.r.status, 'done');
    const c = await countChunks({ job_id: 'j1' }, { tool });
    assert.strictEqual(c.chunks, 5, `${tool}: without max_chunks the call runs to done (within the time budget)`);
    const d = await countChunks({ job_id: 'j1', max_chunks: 1, control: 'resume' }, { tool, state: 'paused' });
    assert.strictEqual(d.chunks, 1, `${tool}: resume of a paused job with max_chunks 1 runs one chunk`);
    assert.strictEqual(d.r.status, 'running');
  }
});

test('ws_bulk / ws_replace: max_chunks passes the handler (not refused as moved)', async () => {
  try {
    const { byName } = registered({ modules: { bulk: true, replace: true } });
    for (const n of ['ws_bulk', 'ws_replace']) {
      const out = await handlerOut(byName[n], { job_id: 'j1', max_chunks: 1 });
      // the registry Strapi has no database: the call gets past the argument checks and fails later, not as `invalid`
      if (out.isError) assert.notStrictEqual(out.structuredContent.error.code, 'invalid', JSON.stringify(out.structuredContent.error));
    }
  } finally { resetModules(); }
});
