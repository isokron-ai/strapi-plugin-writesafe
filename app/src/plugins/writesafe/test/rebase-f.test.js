'use strict';

// Stream G on stream F: undo jobs (tool ws_undo, slot undo|<scope>) share E's job tables but are not approval-tier
// bulk jobs. They are never gated, never run by the runner, not stopped by the kill switches, and the jobs page only
// lists them: their pause, resume and cancel stay with the agent (ws_undo). Retention prunes them as E and F do.
const test = require('node:test');
const assert = require('node:assert');

const undoRow = (over = {}) => ({ id: 7, jobId: 'u1', owner: 'o', slot: 'undo|o:r1:skip', tool: 'ws_undo', contentType: null, targetLocale: null,
  action: 'undo', spec: { totals: {} }, qfilters: null, mode: 'skip', chunkSize: 25, state: 'running', total: 30, cursor: 5, chunks: 1,
  nOk: 0, nUnchanged: 0, nSkipped: 0, nFailed: 0, nConflict: 0, undoable: false, idHash: null, approval: null, runner: false, ...over });

const strapiWith = (row) => ({
  db: { query: () => ({ findOne: async () => row, findMany: async () => [], update: async () => row }), transaction: async (fn) => fn() },
  config: { get: () => ({}) }, store: { get: async () => null },
});

test('the admin job API refuses pause, resume and cancel of an undo job (not_supported); the agent controls it', async () => {
  const C = require('../server/approval/control');
  for (const [op, st] of [['pause', 'running'], ['resume', 'stopped'], ['cancel', 'running']]) {
    const strapi = strapiWith(undoRow({ state: st }));
    await assert.rejects(() => C[op](strapi, 'u1', 'Dana (1)'), (e) => e.code === 'not_supported' && /ws_undo/.test(e.message), op);
  }
});

test('retention prunes an idle undo job as E and F do: no approval horizon, no linked records', () => {
  const AR = require('../server/approval/retention');
  const AD = require('../server/runner/adapter');
  for (const st of ['running', 'paused', 'stopped', 'done', 'cancelled']) {
    assert.strictEqual(AR.jobAction(AD.toG(undoRow({ state: st })), null, null, Date.now()), 'prune', st);
  }
  assert.strictEqual(AR.longKept(AD.toG(undoRow({ state: 'paused' }))), false);
});

test('an undo job is recognised from its row (tool ws_undo), not from its size', () => {
  const AD = require('../server/runner/adapter');
  assert.strictEqual(AD.isUndo(undoRow()), true);
  assert.strictEqual(AD.isUndo(AD.toG(undoRow())), true);
  assert.strictEqual(AD.isUndo({ ...undoRow(), tool: 'ws_bulk', slot: 'o|api::page.page' }), false);
  assert.strictEqual(AD.summary(AD.toG(undoRow())).kind, 'undo');
});
