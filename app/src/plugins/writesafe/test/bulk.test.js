'use strict';

// Unit tests for the bulk-stream modules' pure helpers (no Strapi needed).
const test = require('node:test');
const assert = require('node:assert');
const R = require('../server/modules/replace');
const U = require('../server/modules/_bulk/util');

const cfg = { regexTimeoutMs: 200, totalRegexMs: 400, maxPatternLength: 100, maxReplaceLength: 100, maxOutputLength: 1000 };

test('literal replace: $ in the replacement is literal, counts matches', () => {
  const r = R.makeReplacer({ find: 'a.b', replace: '$1', regex: false }, cfg);
  assert.deepStrictEqual(r(['a.b a.b', 'axb']), [['$1 $1', 2], ['axb', 0]]);
});

test('regex replace expands groups, named groups and $&', () => {
  const r = R.makeReplacer({ find: '(\\w+)@(?<d>\\w+)', replace: '$2/$1/$<d>/$&', regex: true }, cfg);
  assert.deepStrictEqual(r(['joe@ex']), [['ex/joe/ex/joe@ex', 1]]);
});

test('case-insensitive literal', () => {
  const r = R.makeReplacer({ find: 'acme', replace: 'Apex', case_sensitive: false }, cfg);
  assert.deepStrictEqual(r(['ACME acme']), [['Apex Apex', 2]]);
});

test('refusals: empty match, bad regex, bad flags, long pattern, long replacement', () => {
  const code = (spec) => { try { R.makeReplacer(spec, cfg); return 'ok'; } catch (e) { return e.payload.code; } };
  assert.strictEqual(code({ find: 'x*', replace: '', regex: true }), 'invalid');
  assert.strictEqual(code({ find: '([', replace: '', regex: true }), 'invalid');
  assert.strictEqual(code({ find: 'x', replace: '', regex: true, flags: 'y' }), 'invalid');
  assert.strictEqual(code({ find: 'x'.repeat(101), replace: '' }), 'invalid');
  assert.strictEqual(code({ find: 'x', replace: 'y'.repeat(101) }), 'invalid');
});

test('catastrophic backtracking is stopped, per document and in total', () => {
  const r = R.makeReplacer({ find: '(a+)+$', replace: '', regex: true }, cfg);
  const codes = [];
  for (let i = 0; i < 4; i += 1) { try { r(['a'.repeat(40) + '!']); codes.push('ok'); } catch (e) { codes.push(e.payload.code); } }
  assert.deepStrictEqual(codes, ['regex_timeout', 'regex_timeout', 'regex_timeout', 'regex_timeout']);
});

test('output size cap', () => {
  const r = R.makeReplacer({ find: 'a', replace: 'b'.repeat(100) }, cfg);
  assert.throws(() => r(['a'.repeat(20)]), (e) => e.payload.code === 'invalid');
});

test('droppedPaths finds nested fields removed by a sanitizer', () => {
  const input = { title: 't', items: [{ label: 'x', meta: { note: 'n', flag: true } }], tags: ['a', 'b'] };
  const sanitized = { title: 't', items: [{ label: 'x', meta: { flag: true } }], tags: ['a', 'b'] };
  assert.deepStrictEqual(U.droppedPaths(input, sanitized), ['items[0].meta.note']);
  assert.deepStrictEqual(U.droppedPaths({ a: 1, b: 2 }, { a: 1 }), ['b']);
});

test('freshRows strips ids and keys at every component depth', () => {
  const strapi = { components: {
    'shared.item': { attributes: { label: { type: 'string' }, meta: { type: 'component', component: 'shared.meta' } } },
    'shared.meta': { attributes: { note: { type: 'string' } } },
  } };
  const out = U.freshRows(strapi, 'shared.item', [{ id: 4, _key: 'shared.item:4', label: 'x', meta: { id: 9, note: 'n' } }]);
  assert.deepStrictEqual(out, [{ label: 'x', meta: { note: 'n' } }]);
});
