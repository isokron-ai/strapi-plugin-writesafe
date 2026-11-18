# Security policy

## Status

The supported release is the latest 1.x on npm (`strapi-plugin-writesafe-mcp`). No response times are promised; we
look at every report.

The plugin is tested on the Strapi 5 versions in the CI matrix (`ci/strapi-versions.json`) on SQLite, Postgres and
MySQL.

## Reporting a vulnerability

Do **not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a
vulnerability**. Only the maintainers see the report.

Please include:

- the plugin version or commit, the Strapi version and the database;
- the tool call (with any token values removed) and what you expected;
- whether the problem needs a valid admin token, and which permissions that token holds.

We credit reporters in the advisory unless you ask us not to.

If the problem is in Strapi itself rather than this plugin, report it to Strapi as well
(https://github.com/strapi/strapi/security).
