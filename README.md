# writesafe for Strapi 5

[![MWS writecheck](https://github.com/isokron-ai/strapi-plugin-writesafe/actions/workflows/writecheck.yml/badge.svg?branch=main)](https://github.com/isokron-ai/strapi-plugin-writesafe/actions/workflows/writecheck.yml)

Checked against [MWS](https://isokron.ai/mws), the MCP Write-Safety Requirements, on every code change and nightly.

> **Status: 1.0.0**, on npm as [`strapi-plugin-writesafe-mcp`](https://www.npmjs.com/package/strapi-plugin-writesafe-mcp)
> and listed on the [Strapi Marketplace](https://community.strapi.io/marketplace/write-safe-mcp). Tested on every Strapi 5
> minor from 5.47 to 5.62 with SQLite, Postgres 16 and MySQL 8.4 (48 of 48 cells). Free and MIT-licensed.

writesafe adds safe-write tools to the MCP server built into Strapi 5. It runs inside Strapi's own `/mcp` endpoint
through the plugin API (`strapi.ai.mcp.registerTool`), next to Strapi's built-in tools, with the same admin tokens and
the same permissions. Strapi's built-in update tools replace whole lists (dynamic zones, repeatable components, rich-text
blocks), as its REST API does, so an agent working from an old read can remove a row a colleague just added. writesafe's
`ws_*` tools check the document's version before writing and refuse a stale write with the current state, edit single
rows by key instead of resending whole lists, and offer all-or-nothing batches, idempotency keys and dry runs. Optional
modules add create and delete, bulk jobs, find and replace, copy, translation, a history of agent writes with undo, and
media import.

The plugin's own documentation is in [`app/src/plugins/writesafe/README.md`](app/src/plugins/writesafe/README.md), with
the changes in its [`CHANGELOG.md`](app/src/plugins/writesafe/CHANGELOG.md) and the module references in
[`docs/`](docs/). To install it and connect an agent: [`docs/install.md`](docs/install.md) and
[`docs/clients.md`](docs/clients.md).

## What is in this repository

| Path | What |
|---|---|
| `app/src/plugins/writesafe/` | The plugin (the future npm package) and its unit tests |
| `app/` | The Strapi 5 test app the plugin is tested in (no secrets; CI generates throwaway ones per run) |
| `app/src/plugins/probe/` | A test-only plugin for boundary tests; off unless `WRITESAFE_TEST_PROBE=true` |
| `tests/`, `spike/`, `scripts/` | The functional suites, the MCP/REST client helpers they use, and their token and fixture setup |
| `ci/` | The test matrix: per-version app preparation, the suite runner, the package check, the matrix report |
| `.github/workflows/` | CI on every push and pull request, the full version grid (nightly, tags, on demand), a nightly canary against new Strapi releases, the MWS writecheck (`writecheck.yml`: every code change, nightly), and the manual npm publish workflow (Trusted Publishing) |

## Running the tests

Needs Node 22 and Python 3.

Unit tests (no Strapi needed):

```bash
cd app && npm ci && cd src/plugins/writesafe && node --test test/*.test.js
```

The functional suites against one Strapi version on SQLite. `prepare_app.sh` builds a throwaway copy of the test app
with the packed plugin; `run_suite.sh` generates throwaway credentials, starts Strapi on 127.0.0.1:1337 and runs every
suite with every module on:

```bash
ci/prepare_app.sh 5.62.0 ../work/app-5.62.0
APP_DIR=../work/app-5.62.0 DB=sqlite ci/run_suite.sh
```

Postgres and MySQL, and the whole matrix on a machine with Docker: see the headers of `ci/run_suite.sh` and
`ci/local_matrix.sh`.

CI runs the unit tests and package checks, then the functional suites on SQLite, Postgres 16 and MySQL 8.4: on every
push and pull request against three Strapi versions (the oldest and newest in
[`ci/strapi-versions.json`](ci/strapi-versions.json), and 5.51.2; `.github/workflows/ci.yml`), and nightly, on release
tags and on demand against every Strapi 5 minor listed there (5.47 onward, the versions with
`strapi.ai.mcp.registerTool`; `.github/workflows/full-grid.yml`).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in
[SECURITY.md](SECURITY.md), not in a public issue.

## Licence

MIT. See [LICENSE](LICENSE). Built and maintained by
[IsoKron](https://isokron.ai/?utm_source=github&utm_medium=readme&utm_campaign=writesafe).
