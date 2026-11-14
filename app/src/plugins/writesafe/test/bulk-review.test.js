'use strict';

// Unit tests for the second-agent review of PR #16 (stream E bulk core): M1-M3, L1-L5.
// Modules are required inside each test, so a missing export fails that test only. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };
const need = (p) => require(p);
const codeOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return (e.payload && e.payload.code) || e.message; } };

// A fake Strapi for the job store: jobs and items in memory, transactions just run their callback.
function fakeStrapi({ jobs = [], items = [], cfg = {} } = {}) {
  const S = need('../server/modules/_bulk/store');
  const log = [];
  const tableOf = (uid) => (uid === S.JOB_UID ? jobs : items);
  const match = (row, where) => Object.entries(where || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$gt' in v) return row[k] > v.$gt;
      if ('$gte' in v) return row[k] >= v.$gte;
      if ('$lt' in v) return row[k] < v.$lt;
      if ('$in' in v) return v.$in.includes(row[k]);
    }
    return row[k] === v;
  });
  let inTx = 0;
  const st = {
    config: { get: (k) => (k === 'plugin::writesafe' ? cfg : k === 'server.app.keys' ? ['k'] : undefined) },
    log: { warn() {}, info() {}, error() {} },
    contentTypes: { [S.JOB_UID]: {}, [S.ITEM_UID]: {} },
    db: {
      config: { connection: { client: 'sqlite' } },
      transaction: async (cb) => { inTx += 1; log.push('tx+'); try { return await cb({}); } finally { inTx -= 1; log.push('tx-'); } },
      queryBuilder: (uid) => {
        const q = { where: {} };
        const chain = {
          select() { return chain; }, where(w) { q.where = w; return chain; }, orderBy() { return chain; }, limit() { return chain; }, forUpdate() { return chain; },
          first() { q.first = true; return chain; },
          execute: async () => { const rows = tableOf(uid).filter((r) => match(r, q.where)); return q.first ? rows[0] || null : rows; },
        };
        return chain;
      },
      query: (uid) => ({
        findOne: async ({ where }) => tableOf(uid).find((r) => match(r, where)) || null,
        findMany: async ({ where, limit }) => tableOf(uid).filter((r) => match(r, where)).slice(0, limit || 1e9),
        deleteMany: async ({ where }) => {
          const t = tableOf(uid);
          const gone = t.filter((r) => match(r, where));
          for (const g of gone) t.splice(t.indexOf(g), 1);
          log.push(`delete ${uid === S.JOB_UID ? 'job' : 'items'} in tx=${inTx > 0}`);
          return { count: gone.length };
        },
        update: async () => ({}),
      }),
    },
  };
  return { st, log };
}

const baseJob = (over = {}) => ({
  id: 1, jobId: 'j1', owner: 'o', tool: 'ws_bulk', contentType: 'api::page.page', action: 'patch', mode: 'continue', state: 'done',
  total: 600, cursor: 600, chunks: 24, nOk: 300, nUnchanged: 0, nSkipped: 0, nFailed: 250, nConflict: 50, undoable: true, ...over,
});

// ---------------------------------------------------------------- M1: the regex budget is not eaten by setup

test('M1: a scan of 20,000 documents with a trivial pattern stays inside a 1 s regex budget (one V8 context per replacer)', () => {
  const R = need('../server/modules/replace');
  const run = R.makeReplacer({ find: 'acme', replace: 'apex' }, { regexTimeoutMs: 250, totalRegexMs: 1000, maxPatternLength: 100, maxReplaceLength: 100, maxOutputLength: 1000 });
  for (let i = 0; i < 20000; i += 1) run([`hello acme ${i}`]);
  assert.ok(run.left() > 500, `setup time is not counted as regex time (left ${run.left()} ms)`);
});

test('M1: a catastrophic pattern is still stopped per document and in total', () => {
  const R = need('../server/modules/replace');
  const run = R.makeReplacer({ find: '(a+)+$', replace: '', regex: true }, { regexTimeoutMs: 100, totalRegexMs: 250, maxPatternLength: 100, maxReplaceLength: 100, maxOutputLength: 1000 });
  const t0 = Date.now();
  const codes = [];
  for (let i = 0; i < 5; i += 1) { try { run(['a'.repeat(40) + '!']); codes.push('ok'); } catch (e) { codes.push(e.payload.code); } }
  assert.deepStrictEqual(codes, Array(5).fill('regex_timeout'));
  assert.ok(Date.now() - t0 < 2000, 'the total budget ends the work');
});

test('M1: validate refuses a regex budget that cannot give one document its own limit', () => {
  const U = need('../server/modules/_bulk/util');
  assert.throws(() => U.validate({ replace: { totalRegexMs: 100, regexTimeoutMs: 250 } }), /totalRegexMs/);
  assert.doesNotThrow(() => U.validate({ replace: { totalRegexMs: 5000, maxScanDocuments: 100000 } }));
  assert.throws(() => U.validate({ replace: { totalRegexMs: 300, maxScanDocuments: 100000 } }), /too small to scan/);
});

// ---------------------------------------------------------------- M2: the plan binds the job that runs

test('M2: the spec hash covers the resolved spec (e.g. ws_replace fields from permissions), mode and allow_all', () => {
  const J = need('../server/modules/_bulk/jobs');
  const a = { uid: 'api::page.page', find: 'x', replace: 'y' };
  const h = (fields, extra = {}) => J.specHash('ws_replace', { ...a, ...extra }, { action: 'replace', spec: { find: 'x', replace: 'y', regex: false, fields } });
  assert.notStrictEqual(h(['title']), h(['title', 'summary']), 'the same arguments with other resolved fields are another plan');
  assert.strictEqual(h(['title']), h(['title'], { preview: 3, chunk_size: 2, dry_run: true }));
  assert.notStrictEqual(h(['title']), h(['title'], { mode: 'continue' }));
  assert.notStrictEqual(h(['title']), h(['title'], { allow_all: true }));
});

test('M2: a start whose undoable differs from the plan is refused (plan_mismatch)', () => {
  const J = need('../server/modules/_bulk/jobs');
  const now = Date.now();
  const parsed = { exp: Math.floor(now / 1000) + 600, undoable: true };
  assert.strictEqual(J.startCheck(parsed, { undoable: true, now }), null);
  assert.strictEqual(J.startCheck(parsed, { undoable: false, now }).payload.code, 'plan_mismatch');
  assert.strictEqual(J.startCheck({ ...parsed, exp: Math.floor(now / 1000) - 1 }, { undoable: true, now }).payload.code, 'plan_expired');
});

// ---------------------------------------------------------------- M3: bounded replies

test('M3: a job reply lists at most 200 items, and failures/conflicts are bounded with a "more" count', async () => {
  const J = need('../server/modules/_bulk/jobs');
  const big = 'e'.repeat(2000);
  const items = [];
  for (let i = 0; i < 600; i += 1) {
    items.push({ jobId: 'j1', ordinal: i, docId: `d${i}`, state: i < 300 ? 'ok' : i < 550 ? 'failed' : 'conflict', chunk: 1, info: i < 300 ? null : { error: { code: 'write_failed', message: 'm', driver_error: big } } });
  }
  const { st } = fakeStrapi({ items });
  const callItems = items.map((r) => ({ documentId: r.docId, status: r.state, ...(r.info ? { error: r.info.error } : {}) }));
  const v = await J.view(st, baseJob(), callItems);
  assert.ok(v.items.length <= 200, `items ${v.items.length}`);
  assert.strictEqual(v.items_truncated, true);
  assert.match(v.items_note, /status_only/);
  assert.ok(v.failures.length <= 20 && v.failures_more === 250 - v.failures.length, JSON.stringify({ n: v.failures.length, more: v.failures_more }));
  assert.ok(v.conflicts.length <= 20 && v.conflicts_more === 50 - v.conflicts.length);
  assert.ok(JSON.stringify(v).length < 120000, `reply size ${JSON.stringify(v).length}`);
  assert.ok(v.failures.every((f) => f.error.driver_error.length <= 500), 'driver text is trimmed in lists');
});

test('M3: an item error keeps at most 500 characters of the driver text', () => {
  const J = need('../server/modules/_bulk/jobs');
  assert.strictEqual(J.compactError({ code: 'write_failed', message: 'm', driver_error: 'x'.repeat(2000) }).driver_error.length, 500);
});

// ---------------------------------------------------------------- L1: the stopping document is counted

test('L1: stop_on_error: the failing document is a failed item (counted, listed), and back to pending on resume', () => {
  const J = need('../server/modules/_bulk/jobs');
  const job = baseJob({ state: 'stopped', nFailed: 0, stopped: { documentId: 'd2', error: { code: 'invalid' } } });
  const r = J.stopRecord(job, { id: 9, docId: 'd2' }, { code: 'invalid', message: 'm' });
  assert.deepStrictEqual(r, { id: 9, state: 'failed', info: { error: { code: 'invalid', message: 'm' } } });
  assert.strictEqual(job.nFailed, 1);
  const back = J.unstopRecord(job);
  assert.strictEqual(job.nFailed, 0);
  assert.strictEqual(back.docId, 'd2');
});

// ---------------------------------------------------------------- L2: retention

test('L2: a job is never pruned while its plan token can still start it again; job and items go in one transaction', async () => {
  const S = need('../server/modules/_bulk/store');
  const now = Date.UTC(2026, 10, 14, 12);
  assert.strictEqual(S.jobCutoff(72, 900, now).getTime(), now - 72 * 3600000);
  assert.ok(S.jobCutoff(0.0001, 900, now).getTime() <= now - 900000, 'the plan TTL wins over a tiny jobHours');
  const old = new Date(now - 100 * 3600000);
  const { st, log } = fakeStrapi({ jobs: [{ id: 1, jobId: 'j1', updatedAt: old }], items: [{ jobId: 'j1', ordinal: 0 }, { jobId: 'j1', ordinal: 1 }] });
  const r = await S.prune(st, new Date(now - 72 * 3600000));
  assert.deepStrictEqual(r, { jobs: 1, items: 2 });
  assert.ok(log.filter((l) => l.startsWith('delete')).every((l) => l.endsWith('tx=true')), JSON.stringify(log));
});

// ---------------------------------------------------------------- L3, L5: the job a call names

test('L3: {job_id} of another tool is not_found; a job whose action is not loaded is refused', () => {
  const J = need('../server/modules/_bulk/jobs');
  const job = baseJob();
  assert.doesNotThrow(() => J.checkJob(job, 'o', 'ws_bulk'));
  for (const [j, owner, tool, code] of [[job, 'o', 'ws_replace', 'not_found'], [job, 'x', 'ws_bulk', 'not_found'], [null, 'o', 'ws_bulk', 'not_found'], [baseJob({ action: 'nope' }), 'o', 'ws_bulk', 'unsupported']]) {
    assert.throws(() => J.checkJob(j, owner, tool), (e) => e.payload.code === code, `${tool} ${owner} -> ${code}`);
  }
});

test('L4: the status cursor accepts only an integer', () => {
  const J = need('../server/modules/_bulk/jobs');
  assert.strictEqual(J.parseCursor(undefined), -1);
  assert.strictEqual(J.parseCursor('199'), 199);
  assert.strictEqual(J.parseCursor('-1'), -1);
  for (const bad of ['', ' ', '0x10', '1e3', '1.5', 'abc', '-2']) assert.throws(() => J.parseCursor(bad), (e) => e.payload.code === 'invalid', JSON.stringify(bad));
});

test('L5: cancel or resume of a job pruned meanwhile is not_found, not a TypeError', async () => {
  const J = need('../server/modules/_bulk/jobs');
  const { st } = fakeStrapi({ jobs: [] });
  const job = baseJob({ state: 'running' });
  assert.strictEqual(await codeOf(() => J.control(st, {}, {}, job, 'o', { control: 'cancel' }, 1000)), 'not_found');
  assert.strictEqual(await codeOf(() => J.control(st, {}, {}, baseJob({ state: 'paused' }), 'o', { control: 'resume' }, 1000)), 'not_found');
});

// ---------------------------------------------------------------- L6: the rebase guard

test('L6: deps.lockDocuments uses compat/db.lockDocuments when it exists (stream B)', async () => {
  const DB = need('../server/compat/db');
  const D = need('../server/modules/_bulk/deps');
  const had = DB.lockDocuments;
  const calls = [];
  DB.lockDocuments = async (st, targets) => { calls.push(targets); };
  try {
    await D.lockDocuments({}, 'api::page.page', ['a', 'b'], 'en');
  } finally {
    if (had) DB.lockDocuments = had; else delete DB.lockDocuments;
  }
  assert.deepStrictEqual(calls, [[{ uid: 'api::page.page', documentId: 'a' }, { uid: 'api::page.page', documentId: 'b' }]]);
});
