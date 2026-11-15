# Connecting an agent

The ws_* tools are registered on Strapi's own MCP server, so a client connects to Strapi, not to a separate writesafe
server. Every client below sees Strapi's built-in tools and the ws_* tools in one `tools/list`.

| | |
|---|---|
| URL | `<your Strapi URL>/mcp`, e.g. `http://localhost:1337/mcp` in development |
| Transport | Streamable HTTP, stateless (no session id). Only `POST` is accepted; `GET`, `PUT`, `PATCH` and `DELETE` answer 405 |
| Auth | `Authorization: Bearer <admin token>` on every request. A missing or invalid token, or a Content API token, gets 401 |
| Server side | `mcp: { enabled: true }` in `config/server.js`, and the plugin enabled ([install.md](install.md)) |

Create the admin token under **Settings > Administration panel > Admin Tokens** ([install.md](install.md#a-token-for-the-agent)).
The tools a client sees depend on that token's permissions.

Keep the token out of files you share or commit. The examples read it from an environment variable,
`STRAPI_MCP_TOKEN`, where the client supports one. Replace `http://localhost:1337` with your Strapi's URL.

## Clients that connect over HTTP

Most MCP clients take the same three things: the transport (`http` or `streamable-http`), the URL, and a header. A
typical config file entry:

```json
{
  "mcpServers": {
    "strapi": {
      "type": "http",
      "url": "http://localhost:1337/mcp",
      "headers": { "Authorization": "Bearer ${STRAPI_MCP_TOKEN}" }
    }
  }
}
```

- The key names differ per client (`type` or `transport`, `url` or `serverUrl`, and how environment variables are
  written); check your client's MCP docs. In some clients an entry with a `url` and no `type` is read as a local (stdio)
  server, so set the type explicitly.
- Use a variable of its own for the token (such as `STRAPI_MCP_TOKEN`), not one another tool already reads, and check
  whether your client expands variables in headers; if it does not, the token has to go in its config file as text.
- Check the connection in the client: `strapi` should be connected, with the ws_* tools listed.

## Clients that only start local (stdio) servers

A client whose config can only start local processes reaches Strapi through the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "strapi": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote@0.16.6", "http://localhost:1337/mcp",
        "--transport", "http-only", "--allow-http",
        "--header", "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer <admin token>" }
    }
  }
}
```

- `mcp-remote@0.16.6` is the version this setup was tested with. `--allow-http` is needed only for plain `http://` to a
  host other than `localhost`; it is harmless here, and should be dropped for an `https://` URL.
- The header is passed as `Authorization:${AUTH_HEADER}` with no space in `args`: some clients do not escape spaces in
  arguments, so the space lives in the env value instead.
- Many such clients do not read your shell environment, so the token sits in plain text in their config file.
- Connectors that a client's provider runs in its own cloud connect from there, not from your machine, so Strapi must
  be on a public HTTPS URL (port 443); `localhost` does not work there.

## Another example

The same entry in the `streamable-http` form some clients use:

```json
{
  "mcpServers": {
    "strapi": {
      "type": "streamable-http",
      "url": "http://localhost:1337/mcp",
      "headers": { "Authorization": "Bearer <admin token>" }
    }
  }
}
```

The key names differ per client (`type` or `transport`, `url` or `serverUrl`, and how environment variables are
written); check your client's MCP docs. Clients that run in Docker cannot reach `localhost` on the host: use
`host.docker.internal` (on Linux, start the container with `--add-host=host.docker.internal:host-gateway`).

Without a client, with `curl`: the server is stateless, so a single `POST` answers a request without an
`initialize` first. Replies come as server-sent events (`data: {...}` lines).

```bash
curl -s http://localhost:1337/mcp \
  -H "Authorization: Bearer $STRAPI_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | sed -n 's/^data: //p' | jq -r '.result.tools[].name' | grep '^ws_'
```

An empty result means the token has no permission on a covered content type, the plugin is off, or the request failed:
run the `curl` without the pipe to see the HTTP status and error.

## Server instructions

With `serverInstructions: true` (the default) the `initialize` reply carries short instructions that tell the agent
to read with `ws_get` and write with `ws_patch` and `ws_publish`. Clients that pass server instructions to the model
need nothing else. With other clients, a one-line system prompt does the same: "To edit Strapi
content, read with ws_get and write with ws_patch / ws_publish, sending the version you read."
