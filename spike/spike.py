"""Tiny client for Strapi 5's built-in MCP server (/mcp) and the Content API (REST), used by the spike tests.

Tokens are read from .secrets/tokens.json (outside git). Every call is appended to an in-memory log with the
Authorization header redacted, so each test can dump exact requests and responses to results/.
"""
import json
import os
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = os.environ.get("SPIKE_BASE", "http://127.0.0.1:1337")
MCP_PATH = os.environ.get("SPIKE_MCP_PATH", "/mcp")
MCP_BASE = os.environ.get("SPIKE_MCP_BASE")  # e.g. a wire-proxy in front of /mcp
TOK = json.load(open(os.environ.get("SPIKE_TOKENS", os.path.join(ROOT, ".secrets", "tokens.json"))))
A, B = "agent-a", "agent-b"          # MCP admin tokens
RA, RB = "rest-a", "rest-b"          # Content API full-access tokens

LOG: list = []
_id = 0


def _token(who):
    return TOK["admin"][who] if who in TOK["admin"] else TOK["rest"][who]


def http(who, method, path, body=None, headers=None, log=True, base=None):
    h = {"Accept": "application/json", "Authorization": "Bearer " + _token(who)}
    if body is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request((base or BASE) + path, data=data, headers=h, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            status, raw, ctype = r.status, r.read(), r.headers.get("content-type", "")
    except urllib.error.HTTPError as e:
        status, raw, ctype = e.code, e.read(), e.headers.get("content-type", "")
    t1 = time.time()
    text = raw.decode(errors="replace")
    parsed = None
    if "text/event-stream" in ctype:
        for line in text.splitlines():
            if line.startswith("data:"):
                try:
                    parsed = json.loads(line[5:].strip())
                except Exception:
                    pass
    else:
        try:
            parsed = json.loads(text) if text else None
        except Exception:
            parsed = text[:2000]
    if log:
        LOG.append({
            "t_start": round(t0, 4), "t_end": round(t1, 4), "who": who, "method": method, "path": path,
            "request_headers": {k: ("<redacted>" if k == "Authorization" else v) for k, v in h.items()},
            "request_body": body, "status": status, "content_type": ctype, "response": parsed,
            "response_bytes": len(raw),
        })
    return status, parsed, raw


def rpc(who, method, params=None, base=None):
    global _id
    _id += 1
    return http(who, "POST", MCP_PATH, {"jsonrpc": "2.0", "id": _id, "method": method, "params": params or {}},
                {"Accept": "application/json, text/event-stream"}, base=base or MCP_BASE)


def tool(who, name, arguments):
    """Returns (isError, structuredContent-or-text, raw_bytes_len, full_result)."""
    status, body, raw = rpc(who, "tools/call", {"name": name, "arguments": arguments})
    res = body.get("result") if isinstance(body, dict) else None
    if res is None:
        return True, body, len(raw), body
    if res.get("isError"):
        return True, (res.get("content") or [{}])[0].get("text"), len(raw), res
    return False, res.get("structuredContent"), len(raw), res


def rest(who, method, path, body=None):
    return http(who, method, path, body)


def dump(path, extra=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump({"summary": extra, "log": LOG}, f, indent=1, default=str)
    LOG.clear()


def results(name):
    return os.path.join(ROOT, "spike", "results", name)
