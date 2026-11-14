"""End-to-end probe of what an MCP client receives (writesafe hardening phase 2, item 13; fourth review N21, N22).

For the builtinUpdates mode the running Strapi was started with (WRITESAFE_BUILTIN_UPDATES, default guard), checks the
real `initialize` reply (server instructions) and the real `tools/list` (which built-in content-manager tools are
listed, and what they say), and that guard refuses through the real tool call. ci/run_suite.sh restarts Strapi once per
mode (keep, guide, guard, hide) and runs this file each time; any failed check fails the suite, so a Strapi minor that
moves the intercept or stops sending the instructions fails CI instead of passing silently.
Run: WRITESAFE_BUILTIN_UPDATES=guard python3 tests/test_mcp_probe.py (same env as tests/test_plugin.py)."""
import json, os, sys, traceback
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "spike"))
import spike, common
from spike import A

MODE = os.environ.get("WRITESAFE_BUILTIN_UPDATES", "guard")
MODULES = [m for m in os.environ.get("WRITESAFE_MODULES", "").split(",") if m]
results = []


def check(name, cond, detail=None):
    name = "[%s] %s" % (MODE, name)
    results.append({"mode": MODE, "test": name, "pass": bool(cond), "detail": None if cond else detail})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:700]))


def main():
    s, b, _ = spike.rpc(A, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "probe", "version": "0"}})
    ins = ((b or {}).get("result") or {}).get("instructions") or ""
    check("initialize carries the server instructions", "ws_patch" in ins and "expected_version" in ins, b)
    mode_line = {
        "keep": "replace every list field you send",
        "guide": "replace every list field you send",
        "guard": "here only accept scalar fields",
        "hide": "are not offered for these types",
    }[MODE]
    check("instructions describe this mode's built-in tools", mode_line in ins, ins)
    for m, tool in (("create", "ws_create"), ("delete", "ws_delete"), ("localize", "ws_localize"), ("media", "ws_media_import"), ("bulk", "ws_bulk")):
        if m in MODULES:
            check("instructions name %s (module %s on)" % (tool, m), tool in ins, ins)

    s, b, _ = spike.rpc(A, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    d = lambda n: (tools.get(n) or {}).get("description") or ""
    listed = lambda n: n in tools
    delete_on, create_on = "delete" in MODULES, "create" in MODULES
    if MODE == "keep":
        check("keep: update/publish/delete listed unchanged", listed("update_page") and listed("publish_page") and listed("delete_page")
              and "ws_patch" not in d("update_page") and "ws_delete" not in d("delete_page"), sorted(tools))
    if MODE == "guide":
        check("guide: update_page points to ws_patch", "ws_patch" in d("update_page"), d("update_page"))
        check("guide: publish_page points to ws_publish", "ws_publish" in d("publish_page"), d("publish_page"))
        if delete_on:
            check("guide: delete_page points to ws_delete (N21)", "ws_delete" in d("delete_page"), d("delete_page"))
        if create_on:
            check("guide: create_page points to ws_create (N21)", "ws_create" in d("create_page"), d("create_page"))
    if MODE == "guard":
        check("guard: update_page listed with the guard note", "Write-safe guard" in d("update_page"), d("update_page"))
        check("guard: publish_page not listed", not listed("publish_page"), sorted(tools))
        if delete_on:
            check("guard: delete_page not listed when ws_delete is on (N21)", not listed("delete_page"), sorted(tools))
        if create_on:
            check("guard: create_page listed and points to ws_create (N21)", listed("create_page") and "ws_create" in d("create_page"), d("create_page"))
        doc = common.create_page_mcp("probe-guard")
        err, r, _, _ = spike.tool(A, "update_page", {"documentId": doc, "data": {"title": "probe-guard", "sections": [{"__component": "blocks.text", "body": "replaced"}]}})
        check("guard: update_page with a dynamic zone is refused through the real call", err and "use_ws_patch" in str(r), r)
    if MODE == "hide":
        check("hide: update_page, publish_page and discard_page_draft not listed", not listed("update_page") and not listed("publish_page") and not listed("discard_page_draft"), sorted(tools))
        if delete_on:
            check("hide: delete_page not listed when ws_delete is on (N21)", not listed("delete_page"), sorted(tools))
        if create_on:
            check("hide: create_page not listed when ws_create is on (N21)", not listed("create_page"), sorted(tools))
    check("ws_get and ws_patch listed", listed("ws_get") and listed("ws_patch"), sorted(tools))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        check("probe crashed", False, traceback.format_exc()[-1500:])
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    json.dump(results, open(os.path.join(HERE, "results", "test_mcp_probe-%s-%s.json" % (os.environ.get("DB_LABEL", "sqlite"), MODE)), "w"), indent=1, default=str)
    fails = [r for r in results if not r["pass"]]
    print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
    sys.exit(1 if fails else 0)
