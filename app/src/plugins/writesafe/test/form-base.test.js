'use strict';

// The stale form guard's admin half (admin/form-base.mjs): the fetch wrapper, and a pin of the Strapi internals it
// relies on (unsupported: the Content Manager's request URLs and the admin's use of the global fetch). The pin reads
// the installed @strapi/content-manager and @strapi/admin (the test app's, as in CI) and fails when a Strapi release
// changes them, so the wrapper is checked again before that minor is supported.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import(path.join(__dirname, '..', 'admin', 'form-base.mjs'));

test('entryOf: the Content Manager entry URLs the wrapper keys on', async () => {
  const F = await load();
  assert.deepStrictEqual(F.entryOf('/content-manager/collection-types/api::page.page/abc?locale=en&status=draft', 'GET'), { key: 'api::page.page|abc|en', action: null, method: 'GET', status: 'draft' });
  assert.strictEqual(F.entryOf('/content-manager/collection-types/api::page.page/abc/actions/publish?locale=fr', 'POST').key, 'api::page.page|abc|fr');
  assert.strictEqual(F.entryOf('/content-manager/single-types/api::homepage.homepage', 'PUT').key, 'api::homepage.homepage||');
  assert.strictEqual(F.entryOf('/content-manager/collection-types/api::page.page/actions/bulkPublish', 'POST'), null);
  assert.strictEqual(F.entryOf('/admin/users/me', 'GET'), null);
});

test('the wrapper: the version of a load goes back as the base of that tab\'s Save, publish and discard only', async () => {
  const calls = [];
  const headersOf = (h) => Object.fromEntries(new Headers(h || {}).entries());
  global.window = {
    location: { href: 'http://127.0.0.1:1337/admin/content-manager' },
    fetch: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET', headers: headersOf(init && init.headers) });
      const v = String(url).includes('/abc') ? '7' : null;
      return new Response('{}', { status: 200, headers: v ? { 'x-writesafe-version': v } : {} });
    },
  };
  try {
    const F = await import(`${path.join(__dirname, '..', 'admin', 'form-base.mjs')}?t=${Date.now()}`);
    assert.strictEqual(F.install(), true);
    assert.strictEqual(F.install(), false, 'installs once');
    await window.fetch('/content-manager/collection-types/api::page.page/abc?status=draft');
    await window.fetch('/content-manager/collection-types/api::page.page/abc', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
    await window.fetch('/content-manager/collection-types/api::page.page/abc/actions/publish', { method: 'POST', body: '{}' });
    await window.fetch('/content-manager/collection-types/api::page.page/other', { method: 'PUT', body: '{}' });
    await window.fetch('/content-manager/collection-types/api::page.page/actions/bulkPublish', { method: 'POST', body: '{}' });
    assert.strictEqual(calls[1].headers['x-writesafe-base'], '7');
    assert.strictEqual(calls[1].headers['content-type'], 'application/json', 'the caller\'s headers are kept');
    assert.strictEqual(calls[2].headers['x-writesafe-base'], '7');
    assert.strictEqual(calls[3].headers['x-writesafe-base'], undefined, 'another entry: no base');
    assert.strictEqual(calls[4].headers['x-writesafe-base'], undefined, 'bulk actions carry no form');
  } finally {
    delete global.window;
  }
});

test('S4: a late answer of an earlier load never moves the base; a Save\'s answer does', async () => {
  const calls = [];
  const gates = [];
  global.window = {
    location: { href: 'http://127.0.0.1:1337/admin/content-manager' },
    fetch: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET', base: new Headers((init && init.headers) || {}).get('x-writesafe-base') });
      const n = calls.length;
      const v = { 1: '3', 2: '5', 3: '6' }[n] || '9';
      if (n === 1) await new Promise((r) => gates.push(r)); // the first load answers last
      return new Response('{"data":{"title":"t"}}', { status: 200, headers: { 'x-writesafe-version': v } });
    },
  };
  try {
    const F = await import(`${path.join(__dirname, '..', 'admin', 'form-base.mjs')}?s4=${Date.now()}`);
    F.install();
    const u = '/content-manager/collection-types/api::page.page/abc?status=draft';
    const first = window.fetch(u);
    await window.fetch(u); // started later, answers first: version 5
    gates.forEach((r) => r());
    await first; // the earlier request's late answer (version 3) must not move the base back
    await window.fetch('/content-manager/collection-types/api::page.page/abc', { method: 'PUT', body: '{}' });
    assert.strictEqual(calls[2].base, '5');
    await window.fetch('/content-manager/collection-types/api::page.page/abc', { method: 'PUT', body: '{}' });
    assert.strictEqual(calls[3].base, '6', 'the Save\'s answer sets the base');
  } finally {
    delete global.window;
  }
});

test('B3: changedFields lists what the editor changed against the loaded form (untouched relations left out)', async () => {
  const F = await load();
  const before = { title: 'a', note: 'n', items: [{ id: 1, qty: 4 }], reviewer: { count: 0 } };
  const sent = { title: 'b', note: 'n', items: [{ id: 1, qty: 5 }], reviewer: { connect: [], disconnect: [] }, updatedAt: 'x' };
  assert.deepStrictEqual(F.changedFields(sent, before).map((f) => f.field), ['title', 'items']);
  assert.deepStrictEqual(F.changedFields({ title: 'b' }, null).map((f) => f.field), ['title'], 'without the loaded form, every field');
});

function strapiFile(pkg, rel) {
  let dir;
  try { dir = path.dirname(require.resolve(`${pkg}/package.json`, { paths: [path.join(__dirname, '..', '..', '..', '..')] })); } catch { return null; }
  const f = path.join(dir, rel);
  return fs.existsSync(f) ? { text: fs.readFileSync(f, 'utf8'), version: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version } : null;
}

test('pin (Strapi internals): the Content Manager calls these URLs, through the admin\'s global fetch', (t) => {
  const docs = strapiFile('@strapi/content-manager', 'dist/admin/services/documents.js');
  const client = strapiFile('@strapi/admin', 'dist/admin/admin/src/utils/getFetchClient.js');
  if (!docs || !client) { t.skip('@strapi/content-manager or @strapi/admin not installed here'); return; }
  // findOne and update (collection and single types)
  assert.match(docs.text, /url: `\/content-manager\/\$\{collectionType\}\/\$\{model\}\$\{collectionType !== collections\.SINGLE_TYPES && documentId \? `\/\$\{documentId\}` : ''\}`/, `content-manager ${docs.version}: findOne URL`);
  assert.match(docs.text, /url: `\/content-manager\/\$\{collectionType\}\/\$\{model\}\$\{documentId && collectionType !== collections\.SINGLE_TYPES \? `\/\$\{documentId\}` : ''\}`/, `content-manager ${docs.version}: update URL`);
  for (const a of ['publish', 'discard', 'unpublish']) assert.ok(docs.text.includes(`/\${documentId}/actions/${a}\``), `content-manager ${docs.version}: ${a} URL`);
  assert.match(client.text, /await fetch\(createRequestUrl\(url\)/, `admin ${client.version}: requests go through the global fetch`);
});

test('pin (Strapi internals): the "Your unsaved edits" panel reads a JSON string body and error.details of a 409', (t) => {
  const client = strapiFile('@strapi/admin', 'dist/admin/admin/src/utils/getFetchClient.js');
  const errs = strapiFile('@strapi/core', 'dist/services/errors.js');
  if (!client || !errs) { t.skip('@strapi/admin or @strapi/core not installed here'); return; }
  // the panel compares the form it sent (init.body, a JSON string) with the form as loaded
  assert.match(client.text, /body:\s*isFormDataRequest\(data\)\s*\?\s*data\s*:\s*JSON\.stringify\(data\)/, `admin ${client.version}: put/post bodies are JSON strings`);
  // it opens only on { error: { details: { code: 'stale_form' } } }: strapi::errors answers an HttpError's details
  assert.match(errs.text, /formatHttpError\s*=\s*\(error\)\s*=>\s*\{[\s\S]{0,400}error:\s*\{[\s\S]{0,200}details:\s*error\.details/, `core ${errs.version}: an HttpError's details reach the body`);
});

test('R2-S2: a merged Save\'s answer never moves the base (the form still holds the sent values); the next load does', async () => {
  const calls = [];
  global.window = {
    location: { href: 'http://127.0.0.1:1337/admin/content-manager' },
    fetch: async (url, init) => {
      const method = (init && init.method) || 'GET';
      calls.push({ url, method, base: new Headers((init && init.headers) || {}).get('x-writesafe-base') });
      const n = calls.length;
      // 1: load at 3; 2: Save merged at 4; 3: Save not merged at 5; 4: load at 6
      const h = { 1: { 'x-writesafe-version': '3' }, 2: { 'x-writesafe-version': '4', 'x-writesafe-merged': encodeURIComponent('[{"label":"items row qty","from":"4","to":"12"}]') },
        3: { 'x-writesafe-version': '5' }, 4: { 'x-writesafe-version': '6' } }[n] || {};
      return new Response('{"data":{"title":"t"}}', { status: 200, headers: h });
    },
    document: undefined,
  };
  try {
    const F = await import(`${path.join(__dirname, '..', 'admin', 'form-base.mjs')}?r2s2=${Date.now()}`);
    F.install();
    const u = '/content-manager/collection-types/api::page.page/abc';
    await window.fetch(`${u}?status=draft`);
    await window.fetch(u, { method: 'PUT', body: '{}' }); // merged
    await window.fetch(u, { method: 'PUT', body: '{}' }); // a second Save before the refetch landed
    assert.strictEqual(calls[2].base, '3', 'the merged Save left the base at the load\'s version: the second Save is merged again');
    await window.fetch(`${u}?status=draft`); // the refetch
    await window.fetch(u, { method: 'PUT', body: '{}' });
    assert.strictEqual(calls[4].base, '6', 'the load after it moves the base');
  } finally {
    delete global.window;
  }
});
