# Contributing

Thanks for helping. This repository holds `strapi-plugin-writesafe-mcp`, write-safe tools for Strapi 5's built-in MCP
server, and the test harness that checks it against every supported Strapi minor and database.

## Reporting a bug

Open an issue with:

- the plugin version, the Strapi version (`npx strapi version`), the database and the Node version;
- the tool call (`ws_get`, `ws_patch`, `ws_publish` or `ws_batch`) with its arguments. **Remove tokens.**
- the reply you got and the reply you expected;
- whether the problem also happens with Strapi's built-in `get_<type>` / `update_<type>` tools.

Security problems go through private reporting instead. See [SECURITY.md](SECURITY.md).

## Layout

| Path | What |
|---|---|
| `app/src/plugins/writesafe/` | The plugin: the npm package (`strapi-server.js`, `server/`), its unit tests (`test/`) |
| `app/` | The test app: content types with dynamic zones, repeatable components, blocks, i18n, a single type and relations |
| `tests/test_plugin.py` | The functional suite: about 150 checks against a running Strapi |
| `spike/` | MCP and REST client helpers the suite uses |
| `scripts/` | Token and fixture setup for the suite, and the pre-push secret scan |
| `ci/` | The CI matrix: per-version app preparation, suite runner, package check, matrix report |
| `.github/workflows/` | CI (every push and PR), nightly canary against new Strapi releases, manual npm publish |

## Running the tests

Unit tests (no Strapi needed):

```bash
cd app/src/plugins/writesafe && node --test test/*.test.js
```

The functional suite against one Strapi version on SQLite (Node 22, Python 3):

```bash
ci/prepare_app.sh 5.62.0 ../work/app-5.62.0          # test app with the packed plugin
APP_DIR=../work/app-5.62.0 DB=sqlite ci/run_suite.sh  # generates throwaway credentials, starts Strapi on 127.0.0.1:1337
```

The full matrix (SQLite, Postgres 16, MySQL 8.4) on a machine with Docker: see the header of `ci/local_matrix.sh`.

## Making a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the behaviour. The plugin's contract is
   its error codes and receipt shapes (see the plugin README). Changing them breaks agents that rely on them.
2. Add or change a check in `tests/test_plugin.py` for every behaviour change, and a unit test for pure helpers.
3. Run the unit tests, the functional suite on at least SQLite, and `node ci/check_pack.mjs`.
4. Run `python3 scripts/scan_secrets.py` before you push.
5. Open a pull request. CI must pass on the whole matrix before review. CI skips pull requests that change only
   markdown or results files, except the plugin README, which ships in the package.

Keep the plugin dependency-free (peer dependencies on Strapi only) and plain CommonJS, so the published files are the
reviewed source.

## Supporting a new Strapi minor

The nightly canary opens an issue when a new `@strapi/strapi@latest` breaks the suite. To add a minor to the matrix,
append its latest patch to `ci/strapi-versions.json`. When the new minor is newer than `resolve_before`, move
`resolve_before` to a date after its release.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence of this project.
