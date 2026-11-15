'use strict';

// The admin Settings page (admin/SettingsPage.mjs) and its registration (admin/index.mjs), rendered with react-dom/server
// on stand-in design-system components (test/fixtures/admin-stubs.mjs): what is editable, what stays locked, what the
// page sends.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const mod = require('node:module');

// the admin's Strapi-only imports resolve to the stand-ins (registerHooks: Node 22.15+; register before that)
const STUB = pathToFileURL(path.join(__dirname, 'fixtures', 'admin-stubs.mjs')).href;
const STUBBED = ['@strapi/strapi/admin', '@strapi/design-system', 'react-router-dom'];
if (typeof mod.registerHooks === 'function') {
  mod.registerHooks({ resolve: (specifier, context, next) => (STUBBED.includes(specifier) ? { url: STUB, shortCircuit: true } : next(specifier, context)) });
} else {
  mod.register(pathToFileURL(path.join(__dirname, 'fixtures', 'admin-loader.mjs')));
}
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'admin', 'SettingsPage.mjs')).href);

const rowsFor = (over = {}) => {
  const base = {
    'approvals.escalate.publish': { value: false, source: 'default' },
    'approvals.escalate.relations': { value: true, source: 'config' },
    'approvals.requesterMayApprove': { value: true, source: 'default' },
    'approvals.automaticMax': { value: 5000, source: 'derived' },
    'approvals.twoApproverAbove': { value: 20000, source: 'default' },
    'approvals.maxDocuments': { value: 300, source: 'runtime', file: 20000 },
    'approvals.approverQuietHours': { value: 24, source: 'default' },
    ...over,
  };
  return Object.entries(base).map(([key, r]) => ({ key, ...r }));
};
const view = (rows, values = { 'approvals.maxDocuments': 300 }) => ({
  sections: [{ id: 'approvals', title: 'Bulk job approvals', rows }], overrides: { values, by: 'Dana Admin (1)', at: '2026-11-14T10:00:00.000Z', log: [] },
  media_file_allow: ['a.example', 'b.example'], refresh_seconds: 10,
});

async function render(canUpdate, d = view(rowsFor())) {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const P = await load();
  const { draft, rows } = P.draftOf(d);
  return renderToStaticMarkup(React.createElement(P.Tighten, { data: d, rows, draft, setDraft: () => {}, canUpdate, busy: false, onSave() {}, onReset() {} }));
}
const field = (html, key) => {
  const i = html.indexOf(`data-name="${key}"`);
  assert.ok(i >= 0, `field ${key}`);
  return html.slice(i, html.indexOf('data-c="Field.Root"', i + 1) > 0 ? html.indexOf('data-c="Field.Root"', i + 1) : undefined);
};

test('settings page: every runtime setting is shown with the config file value; read-only without settings.update', async () => {
  const ro = await render(false);
  for (const [k] of (await load()).EDITABLE) assert.match(field(ro, k), /data-disabled="true"/, k);
  assert.match(ro, /Read only: changing these needs the &quot;Tighten settings at runtime&quot; permission/);
  assert.doesNotMatch(ro, /data-c="Button"/, 'no Save or reset without the permission');
  assert.match(ro, /data-c="Checkbox" data-disabled="true" data-checked="true">a\.example/);
});

test('settings page: with settings.update, only tightening is offered; settings already strict in the file stay locked', async () => {
  const rw = await render(true);
  assert.match(field(rw, 'approvals.escalate.publish'), /data-disabled="false"/);
  assert.match(field(rw, 'approvals.escalate.relations'), /data-disabled="true"/, 'already on in the config file');
  assert.match(field(rw, 'approvals.escalate.relations'), /Already on in the config file/);
  assert.match(field(rw, 'approvals.requesterMayApprove'), /Can only be turned off here/);
  assert.match(field(rw, 'approvals.maxDocuments'), /data-value="300"/);
  assert.match(field(rw, 'approvals.maxDocuments'), /Config file: 20,000\. Can only be lowered here/);
  assert.match(field(rw, 'approvals.approverQuietHours'), /Can only be raised here/);
  assert.match(rw, /Last changed by Dana Admin \(1\)/);
  assert.match(rw, /Back to the config file/);
});

test('settings page: what Save sends: the values that differ from the config file, and switched-off hosts', async () => {
  const P = await load();
  const d = view(rowsFor(), { 'approvals.maxDocuments': 300, 'media.disabled': ['b.example'] });
  const { draft, rows } = P.draftOf(d);
  assert.deepStrictEqual(P.valuesOf(draft, rows), { 'approvals.maxDocuments': 300, 'media.disabled': ['b.example'] });
  assert.deepStrictEqual(P.valuesOf({ ...draft, 'approvals.maxDocuments': 20000, 'approvals.escalate.publish': true, 'media.disabled': [] }, rows), { 'approvals.escalate.publish': true });
  assert.deepStrictEqual([P.fmt(true), P.fmt(false), P.fmt(25000), P.fmt([]), P.fmt(['a', 'b']), P.fmt(null)], ['on', 'off', '25,000', '(empty)', 'a, b', '–']);
  // a switched-off host since removed from the config file has no checkbox: it is not sent again (Save would get 400)
  const stale = P.draftOf(view(rowsFor(), { 'media.disabled': ['b.example', 'gone.example'] }));
  assert.deepStrictEqual(stale.draft['media.disabled'], ['b.example']);
  assert.deepStrictEqual(P.draftOf(view(rowsFor(), { 'media.disabled': 'b.example' })).draft['media.disabled'], [], 'garbage is ignored');
});

test('settings page: the effective-config table shows the source and the config file value of a tightened setting', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const P = await load();
  const html = renderToStaticMarkup(React.createElement(P.Rows, { rows: [
    { key: 'approvals.maxDocuments', value: 300, source: 'runtime', file: 20000, hard: 100000 },
    { key: 'modules.bulk', value: true, source: 'config', default_on: false },
  ] }));
  assert.match(html, /tightened here/);
  assert.match(html, /config file: 20,000/);
  assert.match(html, /hard limit 100,000/);
  assert.match(html, /off by default/);
  const adj = renderToStaticMarkup(React.createElement(P.Rows, { rows: [{ key: 'approvals.twoApproverAbove', value: 20000, source: 'derived', adjusted: { from: 25000, source: 'default' } }] }));
  assert.match(adj, /derived/);
  assert.match(adj, /default: 25,000, adjusted to fit the other limits/);
  // adjusted and tightened here: one line, no contradiction
  const both = renderToStaticMarkup(React.createElement(P.Rows, { rows: [{ key: 'approvals.twoApproverAbove', value: 10000, source: 'runtime', file: 20000, adjusted: { from: 25000, source: 'config' } }] }));
  assert.match(both, /config file: 25,000 \(runs as 20,000 to fit the other limits\)/);
  assert.doesNotMatch(both, /config file: 20,000/);
});

test('admin entry: the settings link is in Settings, behind settings.read, and lazy-loads the protected page', async () => {
  const links = [];
  const app = { addMenuLink() {}, registerPlugin() {}, addSettingsLink: (section, link) => links.push([section, link]) };
  const entry = (await import(pathToFileURL(path.join(__dirname, '..', 'admin', 'index.mjs')).href)).default;
  entry.register(app);
  assert.strictEqual(links.length, 1);
  const [section, link] = links[0];
  assert.strictEqual(section, 'global');
  assert.strictEqual(link.to, 'writesafe');
  assert.deepStrictEqual(link.permissions, [{ action: 'plugin::writesafe.settings.read', subject: null }]);
  const mod = await link.Component();
  assert.strictEqual(typeof mod.default, 'function');
});
