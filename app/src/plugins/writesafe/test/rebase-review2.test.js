'use strict';

// Second review of the stale form guard (X4), R2-S1, adopted: rows are named by field and position, never by a value,
// so a private (or unreadable) field's value never reaches the journal, a 409 label or the merge note.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const R = require(path.join(__dirname, '..', 'server', 'rebase'));

// A component whose first string field is private (or a password): the row label is built from it.
const MODEL = {
  'api::page.page': { attributes: {
    title: { type: 'string' },
    items: { type: 'component', repeatable: true, component: 'c.item' },
  } },
  'c.item': { attributes: {
    supplierCode: { type: 'string', private: true },
    label: { type: 'string' },
    qty: { type: 'integer' },
  } },
};
const attrsOf = (u) => (MODEL[u] || {}).attributes;
const UID = 'api::page.page';
const hash = (s) => `h(${s.length})`; // stand-in for the keyed hash
const PRIVATE_CODE = 'ACME-INTERNAL-7731';

const before = { title: 'Lunch', items: [{ id: 1, supplierCode: PRIVATE_CODE, label: 'Coffee', qty: 4 }] };
const after = { title: 'Lunch', items: [{ id: 1, supplierCode: PRIVATE_CODE, label: 'Coffee', qty: 12 }] };

test('S5: a private field value never goes into a journal entry (label included)', () => {
  const entries = R.journalOf(attrsOf, UID, before, after, ['items'], hash);
  assert.equal(entries.length, 1);
  assert.ok(!JSON.stringify(entries).includes(PRIVATE_CODE), `journal entry carries the private value: ${JSON.stringify(entries)}`);
});

test('S5: a 409 conflict on a non-secret row field does not carry a private field value in its label', () => {
  const entries = R.journalOf(attrsOf, UID, before, after, ['items'], hash);
  const mine = { title: 'Lunch', items: [{ id: 1, supplierCode: PRIVATE_CODE, label: 'Coffee', qty: 7 }] };
  const r = R.rebase(attrsOf, UID, { mine, current: after, entries, hash });
  assert.equal(r.conflicts.length, 1);
  // stale-form.js view() shows x.label whenever the LEAF (items.qty) is readable: the label is not checked
  assert.ok(!String(r.conflicts[0].label).includes(PRIVATE_CODE), `conflict label: ${r.conflicts[0].label}`);
});

test('S5: a merge note (kept) does not carry a private field value in its label', () => {
  const entries = R.journalOf(attrsOf, UID, before, after, ['items'], hash);
  const mine = { title: 'Lunch (editor)', items: [{ id: 1, supplierCode: PRIVATE_CODE, label: 'Coffee', qty: 4 }] };
  const r = R.rebase(attrsOf, UID, { mine, current: after, entries, hash });
  assert.equal(r.conflicts.length, 0);
  assert.ok(r.kept.length >= 1);
  assert.ok(!JSON.stringify(r.kept.map((k) => k.label)).includes(PRIVATE_CODE), `kept labels: ${JSON.stringify(r.kept.map((k) => k.label))}`);
});

test('holds: the private field itself is journaled as a hash', () => {
  const b = { items: [{ id: 1, supplierCode: 'A', label: 'Coffee', qty: 4 }] };
  const a = { items: [{ id: 1, supplierCode: 'B', label: 'Coffee', qty: 4 }] };
  const e = R.journalOf(attrsOf, UID, b, a, ['items'], hash);
  assert.equal(e.length, 1);
  assert.equal(e[0].hashed, true);
  assert.deepEqual(e[0].before, { h: 'h(3)' });
});
