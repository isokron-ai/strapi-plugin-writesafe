#!/usr/bin/env node
// Boots the app (no HTTP listener), runs every writesafe compat probe and prints the version table.
// Exit 1 if a probe failed, 2 if Strapi's version is not in the table (with STRICT=1 only). Use in CI after a Strapi
// bump: a failing row names the adapter in app/src/plugins/writesafe/server/compat/ to fix.
//   node scripts/compat_check.mjs [--json]        (env as for scripts/start.sh; DATABASE_* for Postgres/MySQL)
//   APP_DIR=<prepared app> node scripts/compat_check.mjs   (CI: ci/run_suite.sh runs it on the app under test, with the
//                                                          plugin installed from its package; a failed probe fails CI)
// The deep probes (server/compat/internals.js deepProbes, 1.0 hardening phase 4) write inside transactions that are
// always rolled back; run this on a test database, never on production (they refuse NODE_ENV=production).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.resolve(process.env.APP_DIR || path.join(root, 'app'));
const require = createRequire(path.join(appDir, 'package.json'));
process.env.HOST = '127.0.0.1';
process.chdir(appDir);
const { createStrapi } = require('@strapi/strapi');
const app = createStrapi({ appDir, distDir: appDir });
app.log.level = 'error';
await app.load();
// The plugin as Strapi loaded it: installed from its package (CI) or from the source folder (this repo's app).
let plugin;
try { plugin = path.join(path.dirname(require.resolve('strapi-plugin-writesafe-mcp/package.json')), 'server'); } catch { plugin = path.join(appDir, 'src/plugins/writesafe/server'); }
const C = require(path.join(plugin, 'compat/index.js'));
const MCP = require(path.join(plugin, 'compat/mcp.js'));
const cfg = require(path.join(plugin, 'config.js')).get(app);
MCP.confirmIntercept(app, C.intercepted || [], cfg.builtinUpdates);
// The MCP server must be running when it is enabled: guard/hide keep it stopped when they cannot be enforced.
if (app.ai?.mcp?.isEnabled?.() && !app.ai.mcp.isRunning?.()) {
  const st = C.status['mcp.intercept_builtin_tools'];
  C.note('mcp.intercept_builtin_tools', false, `MCP server not running after bootstrap${st && st.detail ? ` (${st.detail})` : ''}`);
}
// End to end (phase 2 item 13, fourth review N22): an initialize reply built the way Strapi builds it must carry the
// instructions; replacing the SDK export alone is not proof.
if (cfg.serverInstructions) {
  const r = await MCP.probeInstructions();
  C.note('mcp.server_instructions', r.ok, r.detail);
}
// The Authorization header reaches tool handlers through Strapi's handler-context builder (runtime-only otherwise).
try {
  const core = path.dirname(require.resolve('@strapi/core'));
  const { createMcpCapabilityHandlerContext } = require(path.join(core, 'services/mcp/utils/createMcpCapabilityHandlerContext.js'));
  const req = new Request('http://127.0.0.1/mcp', { headers: { authorization: 'Bearer compat-check' } });
  const extra = createMcpCapabilityHandlerContext({ mcpReq: { signal: undefined, id: 1 }, http: { req } });
  MCP.authHeader(app, extra);
} catch (e) {
  // Strapi 5.47-5.4x has no handler-context builder: tool handlers get the MCP SDK's own `extra`, whose requestInfo
  // carries the headers. That cannot be built in process here; the functional suites check it end to end (keys and
  // jobs are refused without the header), so it is reported as not probed rather than failed.
  if (e && e.code === 'MODULE_NOT_FOUND') C.note('mcp.request_auth_header', null, 'no handler-context builder in this Strapi (the SDK extra is passed through); not probed in process');
  else C.note('mcp.request_auth_header', false, `handler context not buildable: ${e.message}`);
}
// Behaviour of the internals the rc.2 table did not list (N26): writes inside rolled-back transactions.
await require(path.join(plugin, 'compat/internals.js')).deepProbes(app);
const r = C.report(app);
await app.destroy();
if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 1));
else {
  console.log(`Strapi ${r.strapi} (${r.tested_version ? 'tested' : 'NOT in the version table'})`);
  for (const f of r.features) console.log(`${f.ok === true ? 'ok  ' : f.ok === false ? 'FAIL' : '--  '} ${f.feature.padEnd(30)} ${f.adapter.padEnd(28)} ${f.detail}`);
}
const failed = r.features.filter((f) => f.ok === false);
process.exit(failed.length ? 1 : (!r.tested_version && process.env.STRICT === '1' ? 2 : 0));
