# Install

writesafe adds `ws_*` tools to the MCP server built into Strapi 5. It has no server of its own: agents connect to
Strapi's `/mcp` endpoint with an admin token, as they do for Strapi's own tools.

> Not on npm yet: the package name below is the one it will be published under. Until then, copy
> `app/src/plugins/writesafe` from this repository into `src/plugins/writesafe` of your app and add
> `resolve: './src/plugins/writesafe'` next to `enabled: true`. If you turn on the `media` module, also run
> `npm install file-type@^21.3.4` in your app (the package installs it as its one dependency).

## Five lines

```bash
npm install strapi-plugin-writesafe-mcp
# config/plugins.js:  module.exports = () => ({ writesafe: { enabled: true } });
# config/server.js:   add  mcp: { enabled: true },  to the object it returns (Strapi's MCP server)
npm run build        # rebuilds the admin panel (the plugin adds a jobs page and a settings page)
npm run start        # or: npm run develop
```

The plugin's config key is `writesafe` (the `strapi.name` in its package.json), not the npm package name. In a
TypeScript project the files are `config/plugins.ts` and `config/server.ts` (`export default () => ({ ... })`).
Strapi's MCP server is off unless `server.mcp.enabled` is `true`.

Check: with an admin token that has Read, Update and Publish on at least one `api::` content type, `tools/list` on
`/mcp` now shows `ws_schema`, `ws_get`, `ws_patch`, `ws_publish`, `ws_batch`, `ws_find`, `ws_history` and `ws_undo`
(the last three are default modules, below). A token with fewer permissions sees fewer tools ([the table
below](#a-token-for-the-agent)). How to connect a client: [clients.md](clients.md).

## Requirements

- **Strapi 5.47.0 or later, below 6** (the package's peer range). 5.47 is the first release with the MCP server and
  `strapi.ai.mcp.registerTool`.
- **Tested in CI** on the latest patch of every Strapi 5 minor from 5.47 to 5.62 (5.47.1, 5.48.1, 5.49.0, 5.50.2,
  5.51.2, 5.52.3, 5.53.0, 5.54.0, 5.55.1, 5.56.0, 5.57.0, 5.58.0, 5.59.0, 5.60.0, 5.61.1, 5.62.0), each on SQLite,
  PostgreSQL 16 and MySQL 8.4. A newer minor is allowed by the peer range but is untested until it is added to
  `ci/strapi-versions.json`. Prefer a minor other than 5.51.x (its MCP endpoint's memory use keeps growing while it
  runs). MariaDB is not tested.
- **Node.js 22 or later.**
- **`APP_KEYS`** set, as in every generated Strapi project. Version tokens are keyed from it; without it they change on
  every restart (the plugin logs a warning). Rotating or reordering `APP_KEYS` makes every version token and row key stale.
- Content types: `api::` collection and single types. Plugin and admin types are not covered. Types with a polymorphic
  relation inside a component, or components nested deeper than 8 levels, are left out (`ws_schema` names them).

## Modules: on by default, and optional

| | Tools | How to change |
|---|---|---|
| **Core** (always on) | `ws_schema`, `ws_get`, `ws_patch`, `ws_publish`, `ws_batch` | cannot be turned off |
| **`history`** (on by default) | `ws_history`, `ws_undo`; every ws_* write stores a receipt with a before-image | `modules: { history: false }` |
| **`find`** (on by default) | `ws_find` | `modules: { find: false }` |
| `create` (optional) | `ws_create` | `modules: { create: true }` |
| `delete` (optional) | `ws_delete` | `modules: { delete: true }` |
| `bulk` (optional) | `ws_bulk`, `ws_job` (list, status, cancel or undo your bulk jobs) | `modules: { bulk: true }` |
| `replace` (optional) | `ws_replace` (and `ws_job` when `bulk` is off) | `modules: { replace: true }` |
| `copy` (optional) | the `copy` row op in `ws_patch` and `ws_batch` | `modules: { copy: true }` |
| `localize` (optional) | `ws_localize` | `modules: { localize: true }` |
| `media` (optional) | `ws_media_import`, `ws_media_find` | `modules: { media: true }`, plus `media: { allow: ['your-host.example'] }`; the allowlist is empty by default, so nothing can be imported until it lists a host |

Turning everything on:

```js
// config/plugins.js
module.exports = () => ({
  writesafe: {
    enabled: true,
    config: {
      modules: { create: true, delete: true, bulk: true, replace: true, copy: true, localize: true, media: true },
      media: { allow: ['images.example.com'] },
    },
  },
});
```

`modules` takes booleans only; a module name the plugin does not know is logged as a warning at startup. Every other
option has a default. One changes Strapi's own tools: `builtinUpdates` is `'guard'` by default, so the built-in
`update_<type>` and `write_<type>` refuse whole-list and component writes on existing content (pointing the agent to
`ws_patch`) and `publish_<type>` is not listed. `'keep'` leaves them unchanged. All options:
[the plugin README, Config](../app/src/plugins/writesafe/README.md#config).

## A token for the agent

Strapi's MCP endpoint accepts **admin tokens** only; a Content API token (Settings > API Tokens) gets 401.

1. In the admin panel: **Settings > Administration panel > Admin Tokens > Create new Admin Token**.
2. **Name** it after the agent (one token per agent or client: receipts and `ws_history` record which token wrote).
   Pick a **Token duration** (7, 30 or 90 days, or Unlimited).
3. Tick the permissions the agent needs. The token can only get permissions your own account has. Each ws_* tool is
   listed when the token has its permission on at least one covered content type:

   | Permission | Tools |
   |---|---|
   | **Read** (Collection Types / Single Types tabs) | `ws_schema`, `ws_get`, `ws_find`, `ws_history` |
   | **Update** | `ws_patch`, `ws_localize`, `ws_replace`, `ws_undo` |
   | **Publish** | `ws_publish` |
   | **Update** or **Publish** | `ws_batch`, `ws_bulk`, `ws_job` |
   | **Create** | `ws_create` |
   | **Delete** | `ws_delete` |
   | Plugins tab, Upload: **Create (upload)** / **Access the Media Library** | `ws_media_import` / `ws_media_find` |

   Field and locale restrictions and conditions on these permissions apply to the ws_* tools as they do in the admin
   panel. For an agent, tick nothing under Settings or Users & Roles, and not Write-safe's **Approve writesafe jobs**
   (Plugins tab). For agent tokens, set the plugin option
   `adminTokens: 'mcp-only'`. It applies to every admin token: they then work only on `/mcp`, and bulk-job approvals
   need it ([Approvals and the job runner](tools-approvals.md)).
4. **Save** and copy the token. Without `admin.secrets.encryptionKey` Strapi shows it only once; with one, the token's
   owner can view it again. Regenerating gives a new token, and the old one stops working.

Then put the token in your MCP client's `Authorization: Bearer <token>` header: [clients.md](clients.md).

## Uninstall

Remove `writesafe` from `config/plugins.js` and uninstall the package. Content is written through Strapi's Document
Service and stays as it is. With Strapi's default database settings, the next start drops the plugin's own tables
(receipts and history, bulk jobs, approvals, the media import index), so export them first if you need them. The
`writesafe_row_epoch` table and a few `plugin_writesafe_*` rows in `strapi_core_store_settings` stay until you delete
them.
