'use strict';

// Stream G on stream E's job tables: the state mapping (no Strapi needed).
const test = require('node:test');
const assert = require('node:assert');

const row = (over = {}) => ({ id: 1, jobId: 'j1', owner: 'o', slot: 'o|api::page.page', tool: 'ws_bulk', contentType: 'api::page.page', targetLocale: null,
  action: 'patch', spec: {}, qfilters: {}, mode: 'stop_on_error', chunkSize: 25, state: 'running', total: 10, cursor: 0, chunks: 0,
  nOk: 0, nUnchanged: 0, nSkipped: 0, nFailed: 0, nConflict: 0, undoable: false, idHash: 'h', ...over });

test('a job waiting for approval holds its slot (one active job per token and type)', () => {
  const S = require('../server/modules/_bulk/store');
  assert.ok(S.ACTIVE.includes('awaiting_approval'));
  const AD = require('../server/runner/adapter');
  for (const t of ['done', 'cancelled', 'rejected', 'expired']) assert.ok(AD.TERMINAL.includes(t), t);
});

test('toG maps E\'s row to the approval view; planHash binds the job id (plan MAC) and idHash', () => {
  const AD = require('../server/runner/adapter');
  const g = AD.toG(row({ state: 'paused', paused: { reason: 'admin_job', detail: 'Dana (1)' }, approval: { request_id: 'ar1' }, runner: true, cursor: 4 }));
  assert.deepStrictEqual([g.job_id, g.status, g.uid, g.next, g.total, g.pause_reason, g.runner, g.approval.request_id], ['j1', 'paused', 'api::page.page', 4, 10, 'admin_job', true, 'ar1']);
  assert.notStrictEqual(AD.planHash(row()), AD.planHash(row({ jobId: 'j2' })));
  assert.notStrictEqual(AD.planHash(row()), AD.planHash(row({ idHash: 'h2' })));
  assert.strictEqual(AD.manifestRoot(row()), 'h');
});

test('the agent\'s control "resume" is refused for an admin pause, a permission change and runner errors; a canary pause is the agent\'s', async () => {
  const G = require('../server/approval/gate');
  const strapi = { db: { query: () => ({ findMany: async () => [] }) }, config: { get: () => ({}) } };
  for (const reason of ['admin_job', 'permission_changed', 'runner_errors']) {
    const r = await G.gate.onResume(strapi, {}, {}, row({ state: 'paused', paused: { reason, code: 'job_paused' } }), { control: 'resume' });
    assert.strictEqual(r.reply.error.code, 'job_paused', reason);
  }
  assert.strictEqual(await G.gate.onResume(strapi, {}, {}, row({ state: 'paused', paused: { reason: 'canary', code: 'paused_canary' } }), { control: 'resume' }), null);
});

test('either kill switch stops jobs: E\'s bulk.paused or the admin\'s', async () => {
  const C = require('../server/approval/control');
  assert.strictEqual(await C.killSwitch({ config: { get: () => ({ bulk: { paused: true } }) }, store: { get: async () => null } }), true);
  assert.strictEqual(await C.killSwitch({ config: { get: () => ({}) }, store: { get: async () => ({ on: true }) } }), true);
  assert.strictEqual(await C.killSwitch({ config: { get: () => ({}) }, store: { get: async () => null } }), false);
});

test('a cancelled job\'s reply stays ok (E\'s contract: the cancel succeeded); waiting, rejected and expired are not ok', async () => {
  const J = require('../server/modules/_bulk/jobs');
  const strapi = { db: { query: () => ({ findMany: async () => [], count: async () => 0 }) }, config: { get: () => ({}) } };
  assert.strictEqual((await J.view(strapi, row({ state: 'cancelled', cursor: 2 }), [])).ok, true);
  for (const st of ['awaiting_approval', 'rejected', 'expired']) assert.strictEqual((await J.view(strapi, row({ state: st }), [])).ok, false, st);
});
