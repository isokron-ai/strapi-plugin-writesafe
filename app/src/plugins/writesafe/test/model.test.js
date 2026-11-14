'use strict';
// Unit tests for the pure helpers. Run: node --test app/src/plugins/writesafe/test
const test = require('node:test');
const assert = require('node:assert');
const M = require('../server/model');

const strapi = {
  contentTypes: {
    'api::page.page': { attributes: {
      title: { type: 'string' }, body: { type: 'blocks' },
      seo: { type: 'component', component: 'shared.seo', repeatable: false },
      items: { type: 'component', component: 'shared.item', repeatable: true },
      sections: { type: 'dynamiczone', components: ['blocks.text', 'blocks.hero'] },
      author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
    } },
  },
  components: {
    'shared.seo': { attributes: { metaTitle: { type: 'string' } } },
    'shared.item': { attributes: { label: { type: 'string' }, qty: { type: 'integer' } } },
    'blocks.text': { attributes: { body: { type: 'text' } } },
    'blocks.hero': { attributes: { heading: { type: 'string' }, link: { type: 'relation', target: 'api::page.page' } } },
  },
};

test('canonical JSON is key-order independent', () => {
  assert.strictEqual(M.canonical({ b: 1, a: [{ y: 2, x: 1 }] }), M.canonical({ a: [{ x: 1, y: 2 }], b: 1 }));
});

test('content hash ignores timestamps and authors but not content', () => {
  const d = { title: 't', updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 1, items: [{ id: 1, label: 'a' }] };
  assert.strictEqual(M.contentHash(d), M.contentHash({ ...d, updatedAt: '2027-01-01T00:00:00.000Z', updatedBy: 2 }));
  assert.notStrictEqual(M.contentHash(d), M.contentHash({ ...d, title: 'u' }));
  assert.notStrictEqual(M.contentHash(d), M.contentHash({ ...d, items: [{ id: 2, label: 'a' }] }), 'a recreated row changes the version');
});

test('version token (1.0 hardening item 15): "v2.<mac>", no timestamp, only the full token matches', () => {
  const d = { documentId: 'd1', title: 't', updatedAt: '2026-01-01T00:00:00.000Z' };
  const v = M.versionOf(strapi, 'api::page.page', d);
  assert.match(v, /^v2\.[A-Za-z0-9_-]{43}$/);
  assert.ok(M.versionMatches(strapi, 'api::page.page', v, d));
  assert.ok(M.versionMatches(strapi, 'api::page.page', v, { ...d, updatedAt: '2027-01-01T00:00:00.000Z' }), 'updatedAt is not a matching condition');
  assert.ok(!M.versionMatches(strapi, 'api::page.page', '2026-01-01T00:00:00.000Z', d), 'bare updatedAt refused');
  assert.ok(M.isVersionToken(v) && !M.isVersionToken('2026-01-01T00:00:00.000Z'));
  assert.ok(!M.versionMatches(strapi, 'api::page.page', v, { ...d, title: 'u' }), 'different content');
  assert.ok(!M.versionMatches(strapi, 'api::page.page', v.slice(0, -1) + (v.endsWith('A') ? 'B' : 'A'), d));
  assert.ok(!M.versionMatches(strapi, 'api::page.page', '', d));
  assert.ok(!M.versionMatches(strapi, 'api::page.page', undefined, d));
});

test('row keys', () => {
  const a = strapi.contentTypes['api::page.page'].attributes;
  assert.deepStrictEqual(M.rowKeys('repeatable', a.items, [{ id: 5 }, { id: 9 }]), ['shared.item:5', 'shared.item:9']);
  assert.deepStrictEqual(M.rowKeys('dynamiczone', a.sections, [{ id: 1, __component: 'blocks.text' }, { id: 1, __component: 'blocks.hero' }]), ['blocks.text:1', 'blocks.hero:1']);
  const k = M.rowKeys('blocks', a.body, [{ type: 'paragraph', children: [] }]);
  assert.match(k[0], /^#0:[0-9a-f]{8}$/);
});

test('populate covers components, zones and relation ids', () => {
  const p = M.populateFor(strapi, 'api::page.page');
  assert.ok(p.seo && p.items && p.sections.on['blocks.text'] && p.sections.on['blocks.hero'].populate.link);
  assert.deepStrictEqual(p.author, { fields: ['documentId'] });
  assert.ok(!('title' in p));
});

test('presentDoc replaces ids with _key and lists row keys', () => {
  const { data, rows } = M.presentDoc(strapi, 'api::page.page', {
    id: 3, documentId: 'd', title: 't', seo: { id: 2, metaTitle: 'm' }, items: [{ id: 7, label: 'x', qty: 1 }],
    sections: [{ id: 4, __component: 'blocks.text', body: 'b' }], body: [], author: { documentId: 'a1' },
  });
  // keys are content-bound since 1.0 hardening item 16b: "<component>:<id>:<mac>"
  assert.match(data.seo._key, /^shared\.seo:2:[A-Za-z0-9_-]{22}$/);
  assert.deepStrictEqual({ ...data.seo, _key: undefined }, { _key: undefined, metaTitle: 'm' });
  assert.match(data.items[0]._key, /^shared\.item:7:[A-Za-z0-9_-]{22}$/);
  assert.deepStrictEqual({ ...data.items[0], _key: undefined }, { _key: undefined, label: 'x', qty: 1 });
  assert.strictEqual(data.author, 'a1');
  assert.strictEqual(rows.sections.length, 1);
  assert.match(rows.sections[0], /^blocks\.text:4:[A-Za-z0-9_-]{22}$/);
  assert.strictEqual(data.sections[0]._key, rows.sections[0]);
  assert.ok(!('id' in data) && !('documentId' in data));
});

test('unsupportedNested flags morph relations inside components; media (1.0) and targeted relations (0.2) are supported', () => {
  const s2 = { contentTypes: {}, components: { 'x.c': { attributes: { pic: { type: 'media' }, any: { type: 'relation', relation: 'morphToOne' }, link: { type: 'relation', relation: 'manyToOne', target: 'api::page.page' } } } } };
  assert.deepStrictEqual(M.unsupportedNested(s2, 'x.c'), ['x.c.any']);
  assert.deepStrictEqual(M.unsupportedNested(strapi, 'blocks.hero'), []);
  assert.deepStrictEqual(M.unsupportedNested(strapi, 'shared.item'), []);
});

test('normalize reduces relations to documentIds at any depth, so the version ignores target row ids', () => {
  const d1 = { title: 't', updatedAt: '2026-01-01T00:00:00.000Z', author: { id: 4, documentId: 'a1' },
    sections: [{ id: 1, __component: 'blocks.hero', link: { id: 9, documentId: 'p1' } }] };
  const d2 = { ...d1, author: { id: 5, documentId: 'a1' }, sections: [{ id: 1, __component: 'blocks.hero', link: { id: 10, documentId: 'p1' } }] };
  const n1 = M.normalize(strapi, 'api::page.page', d1);
  assert.strictEqual(n1.author, 'a1');
  assert.strictEqual(n1.sections[0].link, 'p1');
  assert.strictEqual(M.versionOf(strapi, 'api::page.page', n1), M.versionOf(strapi, 'api::page.page', M.normalize(strapi, 'api::page.page', d2)));
  const d3 = { ...d1, sections: [{ id: 1, __component: 'blocks.hero', link: { id: 9, documentId: 'p2' } }] };
  assert.notStrictEqual(M.versionOf(strapi, 'api::page.page', n1), M.versionOf(strapi, 'api::page.page', M.normalize(strapi, 'api::page.page', d3)), 'a relation change inside a zone row changes the version');
});

test('version hash is keyed: the same content gives another hash under another key (no offline guessing)', () => {
  const d = { title: 't', note: 'approved', updatedAt: '2026-01-01T00:00:00.000Z' };
  M.setVersionKey('k1');
  const h1 = M.contentHash(d);
  assert.strictEqual(h1, M.contentHash({ ...d }), 'stable under one key');
  M.setVersionKey('k2');
  assert.notStrictEqual(M.contentHash(d), h1);
  const plain = require('crypto').createHash('sha256').update(M.canonical({ title: 't', note: 'approved' })).digest('hex').slice(0, 12);
  assert.notStrictEqual(M.contentHash(d), plain, 'not the unkeyed sha256');
  // the v2 version token is keyed the same way
  M.setVersionKey('k1');
  const v1 = M.versionOf(strapi, 'api::page.page', d);
  M.setVersionKey('k2');
  assert.notStrictEqual(M.versionOf(strapi, 'api::page.page', d), v1);
});

test('presentDoc leaves out fields the token cannot read (absent after sanitizing) instead of showing []', () => {
  const { data, rows } = M.presentDoc(strapi, 'api::page.page', { title: 't', seo: null, sections: [] });
  assert.ok(!('items' in data) && !('items' in rows) && !('body' in data));
  assert.deepStrictEqual(rows.sections, []);
});
