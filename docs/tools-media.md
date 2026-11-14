# Media module: `ws_media_import` and `ws_media_find`

The media module gets files into the Strapi Media Library from URLs, then lets the agent find them again. The agent
never handles file bytes, so 200 images cost about 450 bytes of reply each, not a base64 payload. The module lives in
`server/modules/media/` (writesafe 1.1, branch `v1-media`).

- Strapi's own MCP server cannot upload files: its media tools manage existing assets only.
- Community MCP servers upload base64 through the tool call, which overflows the context window.
- The demand case is 200 images attached to nested components.

## Turn it on

```js
// config/plugins.js
module.exports = () => ({
  writesafe: {
    enabled: true,
    resolve: './src/plugins/writesafe',
    config: {
      modules: { media: true },
      media: {
        allow: ['images.example.com', 'https://cdn.example.net/products/'], // default []: nothing can be imported
        maxBytes: 10 * 1024 * 1024,   // default 10 MB, enforced while downloading
        maxPixels: 40000000,          // default 40 MP (width x height x frames), read from the image header
        allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'], // the default
        timeoutMs: 20000,             // one deadline for DNS, every redirect and the whole body
        maxRedirects: 3,              // 0 to 10
        maxItems: 50,                 // files per call
        concurrency: 4,               // downloads at once, per call and per process
      },
    },
  },
});
```

When the module is off (the default), the plugin registers neither tool. The import index table
(`writesafe_media_imports`) is still declared, but it stays empty.

The media options are checked when the module loads. A bad entry stops Strapi and prints the reason.

### The allowlist

| Entry | Matches |
|---|---|
| `images.example.com` | `https://images.example.com/<any path>`, default port only |
| `*.cdn.example.com` | any subdomain over https, but not `cdn.example.com` itself |
| `https://cdn.example.net/products/` | that scheme, host and port, with paths under `/products/` |
| `http://assets.internal.example:8080/` | plain http is allowed only when the entry says `http://` |

- **Path prefixes.** A prefix matches on the normalised path, so `..`, `%2e%2e` and duplicate slashes are resolved first.
- **Escapes below a prefix are refused.** Under a path prefix, `%2f`, `%5c`, `%2e`, `%25` (double encoding) and `;` in
  the path are refused.
  Some servers and proxies would otherwise serve `/products/..%2fprivate/x` from outside the prefix.
- **Every hop is checked.** Each redirect target must match an entry too.

## `ws_media_import`

```json
{"items": [
   {"url": "https://images.example.com/screens/home.png", "alt": "Home screen", "caption": "v2", "name": "home"},
   {"url": "https://images.example.com/screens/cart.png", "idempotency_key": "screens-2026-11-cart"}
 ],
 "folder_path": "Screens/2026"}
```

**Arguments:**

- **`items`:** 1 to `maxItems` items. Each item has:
  - `url`;
  - optional `name`, the stored name. Its extension always comes from the detected type;
  - optional `alt` and `caption`;
  - optional `idempotency_key`.
- **Folder:** `folder` (a numeric id) or `folder_path` (names separated by `/`). Missing folders are created unless
  `create_folders: false` is passed.
- **`idempotency_key` for the whole call:** it is applied to each item together with the item's index and URL.
- **`dry_run`:** checks every URL (scheme, allowlist, the first hop's address) without downloading anything. With a
  `folder_path` that does not exist yet, it reports `folder_would_be_created` and creates nothing.

**Reply:**

```json
{"ok": false, "partial": true, "counts": {"created": 1, "existing": 1, "failed": 1}, "folder": 12,
 "items": [
  {"i": 0, "status": "created", "id": 41, "ref": "q8w0x3…", "name": "home.png", "mime": "image/png", "bytes": 48211,
   "url": "/uploads/home_3f9c1a.png", "folder": 12, "sha256": "9b1c7e0d55aa21f3"},
  {"i": 1, "status": "existing", "id": 17, "ref": "m2kd9…", "name": "cart.png", "mime": "image/png", "bytes": 30122,
   "url": "/uploads/cart_77ab02.png", "folder": 3, "sha256": "e01f9d3c84b2a6c0"},
  {"i": 2, "status": "failed", "source": "https://images.example.com/x.svg",
   "error": {"code": "mime_not_allowed", "message": "…", "detected_type": "…"}}
 ],
 "use": "Put an item's `ref` in a media field …"}
```

**Statuses:**

- **`created`:** the file was imported.
- **`existing`:** the same content was already in the library and is reused as is. The `note` field says so if your
  alt text or caption differ; it never edits someone else's file.
- **`failed`:** the item was not imported. Retry only the failed items.
- **`valid`:** returned by a dry run.

**Reply flags:**

- `ok` is true only when nothing failed.
- `partial` is true when some items failed and some did not.
- The reply is `isError` only when every item failed.

### `ref`: using imported media in the same agent loop

`ref` is the file's documentId. It is the form `ws_get` shows media fields in, the same form 0.2 uses for relations,
and the form Strapi 5.62 accepts for media through REST and through the built-in `update_<type>` tool. Both were checked
by `tests/test_media.py` `t_use_in_content` on all three databases. The import reply points to ws_patch only (the
built-in update tool may not be listed, and it has no version check). Item errors carry `retryable` and
`requires_reread` like every ws_* error.

`id` (numeric) is also returned, because Strapi's own `media_*` tools take numeric ids.

**Coordination with `v1-core`.** Media inside component rows is still refused (`unsupported`) on `v1-core` as of
13 Nov. `t_use_in_content` therefore records that case as SKIP, not as a pass. When core accepts media refs in
component rows, they should accept this documentId form. The one place to change if core picks another form is
`refOf()` in `server/modules/media/index.js`.

### Error codes

| Code | Meaning |
|---|---|
| `host_not_allowed` | The URL, or a redirect target, is not on the allowlist. A redirect target is not echoed back. |
| `ssrf_blocked` | The host resolves to a non-public address. The address appears in the server log only. |
| `invalid_url` | The scheme is not http or https, the URL carries `user:pass@`, or it does not parse. |
| `dns_failed` | The host does not resolve. |
| `too_many_redirects` | The chain is longer than `maxRedirects`. |
| `fetch_failed` | Not HTTP 200, or the connection dropped. |
| `timeout` | The download took longer than `timeoutMs`. |
| `too_large` | The file is over `maxBytes` (from the declared length, or cut off while streaming), or the image is over `maxPixels`. |
| `mime_not_allowed` | The type detected from the bytes is not allowed, or could not be detected. `declared_type` is the remote server's Content-Type reduced to a bare MIME type (null when it is not one); it is never quoted in the message (1.0 hardening). |
| `invalid_file` | The bytes claim an image but Strapi's image check rejects them. |
| `folder_not_found` | The given `folder` or `folder_path` does not exist. |
| `idempotency_key_reused` | The same key was used before with a different request. |
| `in_progress` | Another call with the same key is still running. |
| `forbidden` | The token lacks the needed Media Library permission. |

## `ws_media_find`

Run it before importing, so the agent reuses a file instead of uploading it again.

**Filters:** `name`, `alt` (contains, case-insensitive), `mime` (`image` or `image/png`), `folder` (id; `null` is the
root), `folder_path`, `ids`, `sha256` (a prefix of at least 8 hex characters, from an import receipt) and
`source_url` (exact, or a prefix ending in `*`; a query or fragment is stripped first, since imports store the URL
without them). It also takes `limit` (1 to 100, default 20) and `page`.

**Rows:** `{id, ref, name, mime, bytes, url, folder, alt}`. Files imported by this module also carry `sha256` and
`source`.

**Limits:**

- Rows are about 300 bytes each.
- `sha256` and `source_url` only know files imported through `ws_media_import`. Files uploaded in the admin have no
  index entry.

## Security model

**Permissions.**

- `ws_media_import` is gated on `plugin::upload.assets.create`, and the handler checks it again.
- `ws_media_find` is gated on `plugin::upload.read`, and Strapi's permission conditions are applied to the query.
- Dedup only reuses a file the token may read. Otherwise it uploads a new copy, so a token never learns about a file it
  cannot see.

**SSRF guard.** Each hop (the first request and every redirect) goes through these steps:

1. Only `http:` and `https:` are allowed, with no credentials in the URL.
2. The URL must match the allowlist.
3. The host is resolved once, and the hop is refused if **any** answer is not public:
   - IPv4: 0/8, 10/8, 100.64/10 (CGNAT, including Alibaba's metadata address), 127/8, 169.254/16 (link-local and
     cloud metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24,
     203.0.113/24, 224/4 and 240/4.
   - IPv6: anything outside global unicast 2000::/3, plus 2001::/23, 2001:db8::/32, 2002::/16 and 3fff::/20 inside it.
     IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`) addresses are judged by their embedded IPv4 address,
     so hosts behind DNS64 still work.
   - IP literals in decimal, hex or short form (`2130706433`, `0x7f.1`) are normalised by the URL parser first.
4. The connection goes only to the addresses that were checked, through a pinned `lookup`. A changed DNS answer
   (DNS rebinding) is never used.
5. The request uses a fresh agent with no keep-alive and no proxy from the environment.
6. Redirects are followed by hand, up to `maxRedirects`, and each one starts again at step 1.

**Size, time and type.**

- **Size.** `maxBytes` is checked against Content-Length and again while streaming. A body longer than its declared
  length is cut at that length.
- **Time.** One deadline covers DNS, every hop and the body.
- **Type from bytes.** The type is detected from the bytes (`file-type`). The declared Content-Type and the URL's
  extension are ignored, and the stored extension comes from the detected type.
- **Never stored, whatever the config allows:**
  - HTML and XHTML;
  - SVG, and any `+xml`, `application/xml` or `text/xml` type. An SVG or XHTML file with an `<?xml?>` prolog is
    detected as `application/xml`, and a browser would run its script on the Strapi origin;
  - JavaScript, shell scripts, Windows executables and Flash.
- **Strapi's own rules apply too.** The app's `plugin::upload.security.allowedTypes` and `deniedTypes` apply on top.
- **Image size.** Image dimensions are read from the header before Strapi decodes the image. Anything over
  `maxPixels` is refused, which stops decompression bombs such as a 50 KB PNG of 16000 x 16000 pixels.
  - The check covers the formats sharp opens (JPEG, PNG, WebP, GIF, TIFF, AVIF/HEIF). Strapi does not decode other
    formats either.
  - sharp is resolved the way Strapi's upload plugin resolves it. If it is missing, the check cannot run, so imports
    in the formats sharp decodes are refused (`pixel_check_unavailable`) and Strapi logs an error at the first one
    (fails closed since the phase 2 hardening; rc.2 skipped the check with a warning).
- **Polyglots.** Files such as a GIF header followed by HTML are stored as images. They are harmless as long as
  uploads are served with `X-Content-Type-Options: nosniff`. Strapi's default security middleware does this, and the
  tests check it.

**Names and storage.**

- Stored names lose path separators, control characters and reserved characters, and Windows device names are
  escaped.
- Strapi's upload service stores the file under a generated hash name, so a name can never choose a path.
- Every upload provider works (local, S3, Cloudinary, …). URLs from private providers are signed.

**Dedup and idempotency.**

- **Dedup.** Dedup uses the sha256 of the downloaded bytes. Imports of the same bytes are serialised across every
  Strapi process on the database (phase 2 hardening): each takes a claim row `claim:media-sha:<sha256>` in the receipts
  table, whose `key` has a unique index, before it looks for an existing file and uploads. A second node waits for the
  first, then finds its file (`existing`). The claim is refreshed while the import runs; a node that waits more than 10
  minutes answers `in_progress` (retryable); a claim not refreshed for 10 minutes (a process that died) is taken over,
  and receipts retention deletes old claims. Without the unique index dedup falls back to one process (logged).
  `tests/test_phase2_c.py` imports one file from two Strapi processes at once on Postgres and MySQL.
- **Index failure.** If recording the uploaded file in the import index fails, the file is removed from the Media
  Library again and the item fails with `index_failed` (retryable). If the removal fails too, the error carries
  `file_id` and the log names the stray file.
- **Idempotency keys.**
  - Keys are scoped to the token (as in ws_patch) and stored hashed in the receipts table.
  - A key is released when the import fails, so a refused item can be retried with the same key.
  - Keys are refused when there is no token principal.
  - A claim older than 10 minutes counts as abandoned (the process died mid-import). A claim waiting for a download or
    upload slot is refreshed, so it never counts as abandoned. Claims are updated and released by their row id, never
    by key, so one caller cannot remove another's claim.

**Query strings are not kept.** The URL's query string (it may carry a signature) is never stored or echoed: `source`
and `source_url` are scheme, host and path only.

## The test-only override (and why production cannot turn it on by accident)

The functional tests need to fetch from a local HTTP server and to resolve test names to private addresses. The guard
blocks both, by design. The override that allows this:

1. **Comes only from environment variables, never from config.** These `writesafe.media` keys make Strapi refuse to
   start: `allowPrivate`, `allowPrivateNetworks`, `allowLoopback`, `testLoopbackPorts`, `testDns`, `ssrf` and
   `disableSsrfGuard`.
2. **Needs all three of these conditions:**
   - `NODE_ENV=test` exactly. `production`, `development` (the default under `strapi start`), unset, or `TEST` all
     disable it;
   - Strapi bound to a loopback host (`server.host` is 127.0.0.1, ::1 or localhost), and Strapi's environment not
     `production`. A staging server that listens publicly never gets it;
   - the variables themselves:
     - `WRITESAFE_MEDIA_TEST_LOOPBACK_PORTS=2047` treats exactly 127.0.0.1 and ::1 on those ports as public;
     - `WRITESAFE_MEDIA_TEST_DNS=127.0.0.1:2049` resolves only names ending in `.ws-test` through that DNS server. The
       server must itself be on loopback.
3. **Exempts loopback on the listed ports only.** Private ranges, link-local and metadata addresses stay blocked
   in every mode. `127.0.0.2` is not exempt either.
4. **Is loud.** At startup Strapi logs `TEST OVERRIDE ACTIVE … Never run production like this`. A reply that used it
   carries `test_override: true`. When the variables are set but ignored, Strapi logs that they are `IGNORED` and that
   the guard is fully on.

**What the test runs check:**

- `MODE=prod` starts Strapi with `NODE_ENV=production` and the test variables still set. It checks that the loopback
  test server is refused and that the test DNS is not used.
- Unit tests check the `NODE_ENV` cases and the loopback-bind condition.

## Tests

| Suite | What it covers |
|---|---|
| `app/src/plugins/writesafe/test/media.test.js` | blocked ranges (IPv4, IPv6, mapped, NAT64), allowlist matching and escapes, URL checks, override gating, config refusals, names, never-types |
| `tests/test_media.py` (`MODE=on`) | 134 checks per database (133 pass, 1 skip pending v1-core): catalog, import, allowlist, SSRF (direct, DNS, rebinding pin, redirects), size, pixels, MIME, timeout, dedup, idempotency, batches, dry run, permissions, folders, find, use in content, 200-file scale |
| `tests/test_media.py` (`MODE=off`, `MODE=prod`) | the module off registers no tools; production ignores the override |

`scripts/run_media_matrix.sh sqlite|postgres|mysql` runs all of them plus the core suite (`tests/test_plugin.py`)
with the module on. It uses `scripts/start_media.sh`: Strapi on 127.0.0.1:2037; Postgres 16 in
`isokron-strapi-1-0-media-pg` (127.0.0.1:5933); MySQL 8.4 in `isokron-strapi-1-0-media-mysql` (127.0.0.1:3807).

The test servers are:

- 127.0.0.1:2047, the file server, the only exempt port;
- 127.0.0.1:2048 and [::1]:2048, the "internal" canary. Every hit is recorded, and the tests require zero;
- UDP 127.0.0.1:2049, the DNS stub for `*.ws-test`.

## Limits

- No proxy support: a deployment whose egress must go through an HTTP proxy cannot use the module yet.
- Dedup across Strapi nodes needs the receipts table's unique key index (created at startup; without it keys and jobs
  are refused and the log says so). The index covers files imported by this module only.
- `existing` reuses a file as it is, and never updates its alt text or caption (use `media_update_asset`).
- A truncated image that Strapi's own image check accepts is stored (that is Strapi's validation, not ours).
- A test of reuse under a read condition (for example "own files only") is not automated. All test tokens belong to
  one admin user, so the condition cannot tell their files apart.

## From the package README

The package README's section on this module, moved here unchanged.

### `media`: ws_media_import and ws_media_find

`ws_media_import` imports 1 to 50 files per call from URLs; the bytes never pass through the agent. Only hosts on
`media.allow` (default empty: nothing) are fetched; private, loopback, link-local and metadata addresses are always
refused, the connection is pinned to the checked address and every redirect is re-checked. Size cap while streaming,
pixel cap from the image header (it needs `sharp`; without it imports of formats sharp decodes are refused, `pixel_check_unavailable`),
MIME type from the bytes (HTML, XML, SVG and scripts never stored), dedup by sha256 (`status: "existing"`; safe across
replicas: imports of the same bytes queue on a claim row in the receipts table, whose key is unique), folders by id or
path, per-item status and idempotency keys. If recording the file in the import index fails after the upload, the file
is removed again (`index_failed`, retryable). Each item returns `ref`, the
file's documentId, to put in a media field with ws_patch. `ws_media_find` searches by name, alt text, MIME type,
folder, ids, content hash or source URL (a query or fragment in it is ignored, as imports store the URL without them).
A refusal keeps the remote server's Content-Type only as a bare MIME type in `declared_type`, never in the message.
