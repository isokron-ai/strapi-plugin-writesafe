/* In-process check (phase 1 re-review, B): the populates that feed permission checks load only what conditions need.
 * For Strapi's admin::has-same-role-as-creator condition the creator's admin row must come back WITHOUT its password
 * hash, reset or registration token or email; a condition on a related field (createdBy.firstname) must load that
 * field and nothing private beside it. Boots the app in-process (no HTTP server) on a COPY of the SQLite database.
 * Run (after a SQLite suite run, so app/.tmp/data.db exists):  node tests/test_condition_populate.js
 * APP_DIR=<prepared app> runs it against a prepared app (plugin from node_modules). Exit 1 on any failure. */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.resolve(process.env.APP_DIR || path.join(__dirname, '..', 'app'));
const COPY = '.tmp/cond-populate-test.db';
fs.copyFileSync(path.join(APP, '.tmp', 'data.db'), path.join(APP, COPY));
Object.assign(process.env, {
  DATABASE_CLIENT: 'sqlite', DATABASE_FILENAME: COPY, HOST: '127.0.0.1', PORT: '1998',
  STRAPI_TELEMETRY_DISABLED: 'true', WRITESAFE_TEST_PROBE: 'false', GRAPHQL_ENABLED: 'false',
});
process.chdir(APP);

const results = [];
const check = (name, cond, detail) => {
  results.push({ test: name, pass: Boolean(cond), detail: cond ? null : detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `  ${JSON.stringify(detail).slice(0, 600)}`}`);
};
const SECRET = ['password', 'resetPasswordToken', 'registrationToken', 'email'];

(async () => {
  const { createStrapi } = require(path.join(APP, 'node_modules', '@strapi', 'strapi'));
  const app = await createStrapi({ appDir: APP, distDir: APP }).load();
  const P = [path.join(APP, 'src', 'plugins', 'writesafe', 'server'), path.join(APP, 'node_modules', 'strapi-plugin-writesafe-mcp', 'server')].find((p) => fs.existsSync(p));
  const M = require(path.join(P, 'model'));
  const E = require(path.join(P, 'engine'));
  const PAGE = 'api::page.page';
  try {
    const user = await app.db.query('admin::user').findOne({ populate: ['roles'] });
    const created = await app.documents(PAGE).create({ data: { title: 'cond populate', createdBy: user.id, updatedBy: user.id } });
    const conds = app.admin.services.permission.conditionProvider;
    const sameRole = await conds.get('admin::has-same-role-as-creator').handler(user);
    const ability = (cond) => ({ rulesFor: (action, subject) => (subject === PAGE ? [{ action, conditions: cond }] : []) });
    const leaks = (row) => (row ? SECRET.filter((k) => row[k] !== undefined) : ['(no row)']);
    for (const [label, cond, want] of [
      ['has-same-role-as-creator', sameRole, (c) => Array.isArray(c.roles) && c.roles.length > 0 && c.roles.every((r) => r.id)],
      ['a condition on createdBy.firstname', { 'createdBy.firstname': { $eq: user.firstname } }, (c) => c.firstname === user.firstname],
    ]) {
      await E.withCaller({ userAbility: ability(cond) }, async () => {
        const doc = await app.documents(PAGE).findOne({ documentId: created.documentId, status: 'draft', populate: M.populateFor(app, PAGE) });
        check(`${label}: Document Service read loads the creator without ${SECRET.join(', ')}`, doc && doc.createdBy && doc.createdBy.id === user.id && !leaks(doc.createdBy).length, doc && doc.createdBy);
        check(`${label}: ... and with what the condition needs`, doc && doc.createdBy && want(doc.createdBy), doc && doc.createdBy);
        const row = await app.db.query(PAGE).findOne({ where: { documentId: created.documentId }, populate: M.permQueryPopulate(app, PAGE) });
        check(`${label}: Query Engine read loads the creator without ${SECRET.join(', ')}`, row && row.createdBy && row.createdBy.id === user.id && !leaks(row.createdBy).length, row && row.createdBy);
        check(`${label}: ... and with what the condition needs`, row && row.createdBy && want(row.createdBy), row && row.createdBy);
      });
    }
  } catch (e) {
    check('condition populate test crashed', false, String(e.stack || e));
  }
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  const fails = results.filter((r) => !r.pass).length;
  console.log(`${results.length - fails} passed, ${fails} failed`);
  await app.destroy().catch(() => {});
  for (const f of [COPY, `${COPY}-wal`, `${COPY}-shm`]) fs.rmSync(path.join(APP, f), { force: true });
  process.exit(fails ? 1 : 0);
})();
