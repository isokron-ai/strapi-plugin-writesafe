'use strict';
// MWS self-test D4 (MWS-IN-6): strict argument types by default. A string sent where a boolean, integer, object or
// array is declared is refused with a message naming the type and the value; lenientArgs: true decodes it instead.
// The advertised JSON Schema is the declared type either way. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { z } = require('@strapi/utils');
const CFG = require('../server/config');
const T = require('../server/tools');
const F = require('../server/force');
// The classic zod 3 API: zod 4 ships it as zod/v3, zod 3.25 as its root and zod/v3. @strapi/utils itself exports zod/v4 on
// every Strapi in the peer range, but the refusal must not depend on that (it used ctx.issues, which zod 3 lacks).
const z3 = (() => { try { return require('zod/v3').z; } catch { return null; } })();
const TAIL = 'Nothing was changed; send the call again with that type.';

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {} } };

const schema = () => z.object({
  dry_run: T.L.bool(z.boolean()).optional(),
  limit: T.L.int(z.number().int().min(1)).optional(),
  set: T.L.obj(z.object({}).catchall(z.any())).optional(),
  ops: T.L.arr(z.array(z.object({ op: z.string(), position: T.position().optional() }))).optional(),
}).strict();
const issues = (s, v) => { const r = s.safeParse(v); return r.success ? null : r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })); };

test('the default config is strict (lenientArgs: false)', () => {
  assert.strictEqual(CFG.defaults.lenientArgs, false);
});

test('strict: a string for each declared type is refused, naming the type and the value, saying nothing changed', () => {
  T._setLenient(false);
  const s = schema();
  const cases = [
    [{ dry_run: 'true' }, 'dry_run', /must be a JSON boolean \(true or false, without quotes\); a string was sent \("true"\)/],
    [{ limit: '5' }, 'limit', /must be a JSON integer \(without quotes\); a string was sent \("5"\)/],
    [{ set: '{"note":"x"}' }, 'set', /must be a JSON object, not a string that contains JSON; a string was sent/],
    [{ ops: '[]' }, 'ops', /must be a JSON array, not a string that contains JSON; a string was sent \("\[\]"\)/],
    [{ ops: [{ op: 'add', position: { index: '0' } }] }, 'ops.0.position.index', /must be a JSON integer \(without quotes\); a string was sent \("0"\)/],
  ];
  for (const [v, path, re] of cases) {
    const got = issues(s, v);
    assert.ok(got && got.some((i) => i.path === path && re.test(i.message) && /Nothing was changed/.test(i.message)), `${JSON.stringify(v)}: ${JSON.stringify(got)}`);
  }
  // a long value is cut in the message, and says so
  const long = issues(s, { set: `{"note":"${'x'.repeat(100)}"}` });
  assert.ok(long[0].message.length < 220 && /"…\)/.test(long[0].message), long[0].message);
  // a position sent as a JSON string is named, not hidden behind the union's "Invalid input"
  const pos = issues(s, { ops: [{ op: 'add', position: '{"index":0}' }] });
  assert.deepStrictEqual(pos, [{ path: 'ops.0.position',
    message: `must be "start", "end" or a JSON object such as {"index": 0}, not a string that contains JSON; a string was sent ("{\\"index\\":0}"). ${TAIL}` }]);
});

test('strict: the JSON types pass unchanged, and "start"/"end" positions stay strings', () => {
  T._setLenient(false);
  const r = schema().safeParse({ dry_run: true, limit: 5, set: { note: 'true' }, ops: [{ op: 'add', position: 'end' }, { op: 'add', position: { index: 0 } }] });
  assert.ok(r.success, JSON.stringify(r.error && r.error.issues));
  assert.deepStrictEqual(r.data.set, { note: 'true' }, 'a field value "true" is data');
});

test('lenientArgs: true decodes the same strings (the opt-in)', () => {
  T._setLenient(true);
  try {
    const r = schema().safeParse({ dry_run: 'true', limit: '5', set: '{"note":"x"}', ops: '[{"op":"add","position":{"index":0}}]' });
    assert.ok(r.success, JSON.stringify(r.error && r.error.issues));
    assert.deepStrictEqual(r.data, { dry_run: true, limit: 5, set: { note: 'x' }, ops: [{ op: 'add', position: { index: 0 } }] });
    assert.ok(issues(schema(), { dry_run: 'yes' }), 'an ambiguous string is still refused');
  } finally { T._setLenient(false); }
});

test('the mode is read when a value is parsed, so a schema built before register() follows the config', () => {
  T._setLenient(false);
  const s = schema();
  T._setLenient(true);
  try {
    assert.ok(s.safeParse({ dry_run: 'true' }).success, 'built strict, parsed lenient');
  } finally { T._setLenient(false); }
  assert.ok(!s.safeParse({ dry_run: 'true' }).success, 'and strict again');
});

test('the advertised JSON Schema declares only the JSON type in both modes (no string forms)', { skip: typeof z.toJSONSchema !== 'function' && 'zod 3: no z.toJSONSchema' }, () => {
  for (const on of [false, true]) {
    T._setLenient(on);
    const js = z.toJSONSchema(schema(), { io: 'input' });
    assert.strictEqual(js.properties.dry_run.type, 'boolean');
    assert.strictEqual(js.properties.limit.type, 'integer');
    assert.strictEqual(js.properties.set.type, 'object');
    assert.strictEqual(js.properties.ops.type, 'array');
    assert.ok(!JSON.stringify(js).includes('"type":"string","enum":["true"'), 'no string form of a boolean');
  }
  T._setLenient(false);
});

test('force (L.bool through F.arg, offered with allowForce) is strict too; lenient decodes it', () => {
  F.configure({ allowForce: true });
  try {
    T._setLenient(false);
    const s = z.object({ ...F.arg(z, T.L, 'Skip the check.') }).strict();
    assert.deepStrictEqual(issues(s, { force: 'true' }), [{ path: 'force',
      message: `must be a JSON boolean (true or false, without quotes); a string was sent ("true"). ${TAIL}` }]);
    assert.deepStrictEqual(s.parse({ force: true }), { force: true });
    T._setLenient(true);
    assert.deepStrictEqual(s.parse({ force: 'true' }), { force: true });
  } finally { T._setLenient(false); F.configure({ allowForce: false }); }
});

// The wrapped schema renders as the plain one: the strict/lenient step adds nothing to tools/list. Known gap: zod 4.x
// drops a preprocess-wrapped argument from `required` in io: 'input', so `required` is compared separately below.
const withoutRequired = (j) => JSON.parse(JSON.stringify(j, (k, v) => (k === 'required' ? undefined : v)));
const wrappedAndPlain = () => {
  const P = z.union([z.enum(['start', 'end']), z.object({ index: z.number().int().min(0).describe('0-based index.') }).strict()]);
  const wrapped = z.object({
    uid: z.string(),
    dry_run: T.L.bool(z.boolean()).optional(),
    limit: T.L.int(z.number().int().min(1)).optional(),
    set: T.L.obj(z.object({}).catchall(z.any())).optional(),
    items: T.L.arr(z.array(T.L.obj(z.object({ note: z.string() }).strict()))),
    position: T.L.pos(z.union([z.enum(['start', 'end']), z.object({ index: T.L.int(z.number().int().min(0)).describe('0-based index.') }).strict()])).optional(),
    ...F.arg(z, T.L, 'Skip the check.'),
  }).strict();
  const plain = z.object({
    uid: z.string(),
    dry_run: z.boolean().optional(),
    limit: z.number().int().min(1).optional(),
    set: z.object({}).catchall(z.any()).optional(),
    items: z.array(z.object({ note: z.string() }).strict()),
    position: P.optional(),
    ...F.arg(z, { bool: (x) => x }, 'Skip the check.'),
  }).strict();
  return { wrapped, plain };
};

test('the strict schema renders exactly as the plain (unwrapped) schema, apart from `required`, in both modes', { skip: typeof z.toJSONSchema !== 'function' && 'zod 3: no z.toJSONSchema' }, () => {
  F.configure({ allowForce: true });
  try {
    for (const on of [false, true]) {
      T._setLenient(on);
      const { wrapped, plain } = wrappedAndPlain();
      const w = z.toJSONSchema(wrapped, { io: 'input' });
      const p = z.toJSONSchema(plain, { io: 'input' });
      assert.deepStrictEqual(withoutRequired(w), withoutRequired(p), `lenient=${on}`);
      // the known gap (a follow-up, not D4): zod 4.x drops the wrapped required `items` (and `index`) from `required`;
      // zod 3.25's v4 build (Strapi 5.47 to 5.52) keeps them. Wrapping never adds a required argument.
      assert.deepStrictEqual(p.required, ['uid', 'items']);
      assert.ok(w.required.every((k) => p.required.includes(k)) && w.required.includes('uid'), JSON.stringify(w.required));
    }
  } finally { T._setLenient(false); F.configure({ allowForce: false }); }
});

test('zod 3 (classic API): the strict refusal is the same single issue, not a TypeError', { skip: !z3 && 'zod/v3 not installed' }, () => {
  T._setLenient(false);
  const s3 = z3.object({
    dry_run: z3.preprocess(T.refuseString('boolean'), z3.boolean()).optional(),
    limit: z3.preprocess(T.refuseString('integer'), z3.number().int()).optional(),
    set: z3.preprocess(T.refuseString('object'), z3.object({}).catchall(z3.any())).optional(),
    ops: z3.preprocess(T.refuseString('array'), z3.array(z3.object({
      position: z3.preprocess(T.refusePosition, z3.union([z3.enum(['start', 'end']), z3.object({ index: z3.number().int() }).strict()])).optional(),
    }))).optional(),
  }).strict();
  const s4 = schema();
  const cases = [{ dry_run: 'true' }, { limit: '5' }, { set: '{"note":"x"}' }, { ops: '[]' },
    { ops: [{ position: '{"index":0}' }] }, { ops: [{ position: { index: '0' } }] }];
  for (const v of cases) {
    let got;
    assert.doesNotThrow(() => { got = issues(s3, v); }, JSON.stringify(v));
    assert.strictEqual(got.length, 1, `${JSON.stringify(v)}: ${JSON.stringify(got)}`);
    // zod 4 adds `op` (required in schema()) for the ops cases; compare the refusal itself
    const want = issues(s4, v.ops && typeof v.ops !== 'string' ? { ops: [{ op: 'add', ...v.ops[0] }] } : v);
    assert.deepStrictEqual(got, want, JSON.stringify(v));
  }
  const ok = { dry_run: true, limit: 5, set: { note: 'true' }, ops: [{ position: 'end' }, { position: { index: 0 } }] };
  assert.deepStrictEqual(s3.parse(ok), ok);
});
