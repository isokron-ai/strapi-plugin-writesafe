'use strict';
// #41, second symptom: on @strapi/utils 5.47.0 to 5.52.1 (zod 3.25's zod/v4 build, its own global registry) the MCP
// SDK converted the input schemas with another zod copy and every argument description was lost in tools/list.
// compat/schema-meta.js copies the metadata into the SDK's registry. Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { z } = require('@strapi/utils');
const META = require('../server/compat/schema-meta');
const T = require('../server/tools');

global.strapi = global.strapi || { log: { warn() {}, info() {}, error() {}, debug() {} } };

test('copyMeta: every described node reaches another registry (object, optional, preprocess, union, array, catchall)', () => {
  const other = z.registry(); // stands in for the SDK's zod registry
  const s = z.object({
    a: z.string().optional().describe('A'),
    b: T.L.bool(z.boolean()).optional().describe('B'),
    c: T.L.arr(z.array(z.object({ k: z.string().describe('K') }).strict())).optional().describe('C'),
    d: z.union([z.enum(['x']), z.object({ i: z.number().describe('I') })]).describe('D'),
    e: z.object({}).catchall(z.string().describe('E')),
  }).strict();
  META.copyMeta(s, [other]);
  const js = z.toJSONSchema(s, { metadata: other, unrepresentable: 'any', io: 'input' });
  assert.strictEqual(js.properties.a.description, 'A');
  assert.strictEqual(js.properties.b.description, 'B');
  assert.strictEqual(js.properties.c.description, 'C');
  assert.strictEqual(js.properties.c.items.properties.k.description, 'K');
  assert.strictEqual(js.properties.d.description, 'D');
  assert.strictEqual(js.properties.d.anyOf[1].properties.i.description, 'I');
  assert.strictEqual(js.properties.e.additionalProperties.description, 'E');
  // idempotent, and never throws on odd input
  assert.doesNotThrow(() => { META.copyMeta(s, [other]); META.copyMeta(null, [other]); META.copyMeta({ _zod: null }, [other]); });
});

test('copyMeta: nothing to do where the registries are one (zod 4 everywhere)', () => {
  assert.ok(!META.registries().includes(z.globalRegistry), 'our own registry is never a target');
  if (z.globalRegistry === globalThis.__zod_globalRegistry) assert.strictEqual(META.registries().length, 0, 'one shared registry: no targets');
  const s = z.object({ a: z.string().describe('A') });
  assert.strictEqual(META.copyMeta(s), s, 'returns the same schema');
});
