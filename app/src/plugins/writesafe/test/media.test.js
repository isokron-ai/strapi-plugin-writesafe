'use strict';
// Unit tests for the media module's pure helpers (network guard, allowlist, names). Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const N = require('../server/modules/media/net');
const { _internal: I, validateConfig } = require('../server/modules/media');

test('blocked addresses', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', 'ff02::1', '198.18.0.1',
    '::ffff:0:7f00:1', '2001:2::1', '2001:10::1', '2001:20::1', '2001::1', '2001:db8::1', '3fff::1', '5f00::1', '::7f00:1', '4000::1']) {
    assert.ok(N.blockedReason(a), `${a} must be blocked`);
  }
  for (const a of ['93.184.215.14', '8.8.8.8', '2606:4700::6810:84e5', '2001:4860:4860::8888', '172.32.0.1', '100.128.0.1', '64:ff9b::808:808', '::ffff:8.8.8.8']) {
    assert.strictEqual(N.blockedReason(a), null, `${a} is public`);
  }
});

test('allowlist entries and matching', () => {
  const rules = ['images.example.com', '*.cdn.example.net', 'https://assets.example.org/products/', 'http://127.0.0.1:2047/files/'].map(N.parseAllowEntry);
  const ok = (u) => N.matchAllow(new URL(u), rules);
  assert.ok(ok('https://images.example.com/a/b.png'));
  assert.ok(!ok('http://images.example.com/a.png'), 'bare host means https only');
  assert.ok(!ok('https://images.example.com:8443/a.png'), 'other port');
  assert.ok(!ok('https://evil-images.example.com/a.png'));
  assert.ok(!ok('https://images.example.com.evil.net/a.png'));
  assert.ok(ok('https://x.cdn.example.net/a.png'));
  assert.ok(!ok('https://cdn.example.net/a.png'), 'wildcard does not cover the bare domain');
  assert.ok(ok('https://assets.example.org/products/1.png'));
  assert.ok(!ok('https://assets.example.org/products-old/1.png'), 'prefix ends at a path segment');
  assert.ok(!ok('https://assets.example.org/products/../admin/x.png'), 'dot segments are resolved first');
  assert.ok(!ok('https://assets.example.org/products/%2e%2e/admin/x.png'), 'encoded dot segments are resolved first');
  assert.ok(!ok('https://assets.example.org/products/..%2fadmin/x.png'), 'encoded slash under a path prefix');
  assert.ok(!ok('https://assets.example.org/products/..%5Cadmin/x.png'), 'encoded backslash under a path prefix');
  assert.ok(!ok('https://assets.example.org/products/..;/admin/x.png'), 'path parameter under a path prefix');
  assert.ok(!ok('https://assets.example.org/products/..%252fadmin/x.png'), 'double-encoded slash under a path prefix');
  assert.ok(ok('https://images.example.com/a%2fb.png'), 'no path prefix: encoded characters are harmless');
  assert.ok(ok('http://127.0.0.1:2047/files/x.png'));
  assert.ok(!ok('http://127.0.0.1:2048/files/x.png'));
  assert.throws(() => N.parseAllowEntry('ftp://x.example.com/'));
  assert.throws(() => N.parseAllowEntry('https://u:p@x.example.com/'));
  assert.throws(() => N.parseAllowEntry('x.example.com/path'));
});

test('checkUrl refuses schemes, credentials and unlisted hosts', () => {
  const rules = [N.parseAllowEntry('https://images.example.com/')];
  assert.throws(() => N.checkUrl('file:///etc/passwd', rules), (e) => e.code === 'invalid_url');
  assert.throws(() => N.checkUrl('https://u:p@images.example.com/a.png', rules), (e) => e.code === 'invalid_url');
  assert.throws(() => N.checkUrl('https://other.example.com/a.png', rules), (e) => e.code === 'host_not_allowed');
  assert.throws(() => N.checkUrl('gopher://images.example.com/', rules), (e) => e.code === 'invalid_url');
  assert.strictEqual(N.checkUrl('https://images.example.com/a.png?sig=1', rules).allowedBy, 'https://images.example.com/');
  assert.strictEqual(N.redact(new URL('https://images.example.com/a.png?sig=SECRET#x')), 'https://images.example.com/a.png');
});

test('test override only with NODE_ENV=test', () => {
  assert.strictEqual(N.testOverride({}), null);
  for (const env of ['production', 'development', undefined, 'TEST', 'test ']) {
    const o = N.testOverride({ NODE_ENV: env, WRITESAFE_MEDIA_TEST_LOOPBACK_PORTS: '2047' });
    assert.ok(o.ignored, `ignored with NODE_ENV=${env}`);
  }
  const o = N.testOverride({ NODE_ENV: 'test', WRITESAFE_MEDIA_TEST_LOOPBACK_PORTS: '2047, x', WRITESAFE_MEDIA_TEST_DNS: '10.0.0.1:53' });
  assert.deepStrictEqual([...o.ports], ['2047']);
  assert.strictEqual(o.dnsServer, null, 'test DNS must be on loopback');
});

test('pinAddress exempts only exact loopback on the listed ports', async () => {
  const o = N.testOverride({ NODE_ENV: 'test', WRITESAFE_MEDIA_TEST_LOOPBACK_PORTS: '2047' });
  assert.ok((await N.pinAddress(new URL('http://127.0.0.1:2047/'), o)).testExempt);
  await assert.rejects(N.pinAddress(new URL('http://127.0.0.1:2048/'), o), (e) => e.code === 'ssrf_blocked');
  await assert.rejects(N.pinAddress(new URL('http://127.0.0.2:2047/'), o), (e) => e.code === 'ssrf_blocked');
  await assert.rejects(N.pinAddress(new URL('http://169.254.169.254:2047/'), o), (e) => e.code === 'ssrf_blocked');
  await assert.rejects(N.pinAddress(new URL('http://10.0.0.1:2047/'), o), (e) => e.code === 'ssrf_blocked');
  await assert.rejects(N.pinAddress(new URL('http://127.0.0.1:2047/'), null), (e) => e.code === 'ssrf_blocked');
});

test('config: the SSRF guard has no switch; bad entries are refused at startup', () => {
  assert.throws(() => validateConfig({ media: { allowPrivateNetworks: true } }), /cannot be relaxed/);
  assert.throws(() => validateConfig({ media: { allow: ['ftp://x/'] } }));
  assert.throws(() => validateConfig({ media: { maxBytes: -1 } }));
  validateConfig({ modules: { media: true }, media: { allow: ['images.example.com'], maxBytes: 1000 } });
});

test('stored names', () => {
  assert.strictEqual(I.safeName(undefined, '/a/b/photo.txt', 'png', 'ab'.repeat(32)), 'photo.png');
  assert.strictEqual(I.safeName('../../etc/passwd', '/x', 'png', 'ab'.repeat(32)), '_.._etc_passwd.png');
  assert.strictEqual(I.safeName(undefined, '/a/%2e%2e%2f%2e%2e%2fx.php', 'jpg', 'ab'.repeat(32)), '_.._x.jpg');
  assert.strictEqual(I.safeName(undefined, '/', 'png', 'abcdef0123456789'.repeat(4)), 'import-abcdef012345.png');
  assert.strictEqual(I.safeName('con', '/', 'png', 'ab'.repeat(32)), '_con.png');
  assert.ok(I.matchesType('image/png', ['image/*']) && !I.matchesType('image/svg+xml', ['image/png']));
  for (const t of ['application/xml', 'text/xml', 'image/svg+xml', 'application/xhtml+xml', 'application/rss+xml', 'text/html', 'application/x-shockwave-flash']) assert.ok(I.isNever(t), t);
  assert.ok(!I.isNever('application/pdf') && !I.isNever('image/png'));
});

test('override needs NODE_ENV=test AND Strapi bound to loopback', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: 'test', WRITESAFE_MEDIA_TEST_LOOPBACK_PORTS: '2047' });
    const fake = (host, env = 'test') => ({ config: { get: (k) => (k === 'server.host' ? host : k === 'environment' ? env : undefined) } });
    assert.ok(!I.decideOverride(fake('127.0.0.1')).ignored);
    assert.ok(I.decideOverride(fake('0.0.0.0')).ignored, 'public bind: ignored');
    assert.ok(I.decideOverride(fake(undefined)).ignored, 'no host (all interfaces): ignored');
    assert.ok(I.decideOverride(fake('127.0.0.1', 'production')).ignored, 'Strapi environment production: ignored');
    process.env.NODE_ENV = 'production';
    assert.ok(I.decideOverride(fake('127.0.0.1')).ignored, 'production: ignored');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
