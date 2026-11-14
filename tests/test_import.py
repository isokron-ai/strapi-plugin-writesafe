"""1.0 version-token and key boundary across a data import (`strapi export` / `strapi import --only content`).
SQLite only (the import CLI runs against app/.tmp/data.db next to the running server); the DB file is backed up
first and the backup path is printed. Run with the env of tests/test_plugin.py. Writes tests/results/test_import.json.

Scenario: page P is exported; then the agent's colleague changes P (a scalar and a new repeatable row); the agent reads
P (version V1, keys K1); then the old export is imported, which puts P back as it was. The agent's write with V1 must
be refused, and its keys must either name the same rows or be refused, never another row."""
import json, os, shutil, subprocess, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "spike"))
import spike, common
from common import vv, vb  # 1.0 hardening item 16c: set/unset need expected_version
from spike import A, B, RA

UID = "api::page.page"
results = []
WORK = os.environ.get("IMPORT_WORK", os.path.join(tempfile.gettempdir(), "writesafe-import-exports"))


def check(name, cond, detail=None):
    results.append({"test": name, "pass": bool(cond), "detail": None if cond else detail})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:600]))


def ws(tool, args, who=A):
    e, r, _, _ = spike.tool(who, tool, args)
    if e and isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    return e, r


def strapi_cli(*args):
    env = dict(os.environ, HOST="127.0.0.1")
    p = subprocess.run(["npx", "strapi", *args], cwd=os.path.join(ROOT, "app"), env=env, capture_output=True, text=True, timeout=900)
    if p.returncode != 0:
        raise RuntimeError(p.stdout[-1500:] + p.stderr[-1500:])
    return p.stdout


os.makedirs(WORK, exist_ok=True)
db = os.path.join(ROOT, "app", ".tmp", "data.db")
backup = os.path.join(WORK, "data.db.before-import-%d" % int(time.time()))
shutil.copy(db, backup)
print("backup of the SQLite DB:", backup)

doc = common.create_page_mcp("ti-import")
g0 = ws("ws_get", {"uid": UID, "documentId": doc})[1]
exp = os.path.join(WORK, "ti-%d" % int(time.time()))
strapi_cli("export", "--no-encrypt", "--no-compress", "--only", "content", "-f", exp)

# the colleague changes P after the export
e, r = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"note": "after-export"}, "ops": [{"op": "add", "field": "items", "data": {"label": "after-export", "qty": 9}}]}), B)
new_key = r["rows"]["items"]["added"][0]
g1 = ws("ws_get", {"uid": UID, "documentId": doc})[1]
idem = "ti-idem-%d" % int(time.time())
e, r_idem = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"summary": "idem-1"}, "idempotency_key": idem}))
g1 = ws("ws_get", {"uid": UID, "documentId": doc})[1]

strapi_cli("import", "-f", exp + ".tar", "--force", "--only", "content")
time.sleep(1)

after = common.rest_get(RA, doc)
check("setup: the import put the page back as exported", after["note"] == "n0" and len(after["items"]) == 3, [after["note"], len(after["items"])])
e, r = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g1["version"], "set": {"summary": "agent"}})
check("write with the version read before the import is refused (version_conflict)", e and r.get("error", {}).get("code") == "version_conflict", r)
g2 = ws("ws_get", {"uid": UID, "documentId": doc})[1]
check("the version after the import differs from the one before it", g2["version"] != g1["version"], [g1["version"], g2["version"]])
print("  version at export:", g0["version"], " after import:", g2["version"], " same:", g0["version"] == g2["version"])
ids_kept = g0["rows"]["items"] == g2["rows"]["items"]
print("  component ids kept by the import:", ids_kept, g0["rows"]["items"], g2["rows"]["items"])
# keys read before the import: each must still name the same row (same label) or be refused
bad = []
labels0 = {k: x["label"] for k, x in zip(g0["rows"]["items"], g0["data"]["items"])}
for k, label in labels0.items():
    e, r = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 500}}]})
    now = common.rest_get(RA, doc)["items"]
    hit = [x["label"] for x in now if x["qty"] == 500]
    if not e and hit != [label]:
        bad.append(["wrong row", k, label, hit])
    if e and r.get("error", {}).get("code") != "row_not_found":
        bad.append(["unexpected error", k, r])
    if not e:  # reset
        ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 1}}]})
check("keys read before the import either edit the same row or are refused (never another row)", not bad, bad)
e, r = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": new_key, "data": {"label": "GHOST"}}]})
check("the key of a row added after the export is row_not_found after the import", e and r.get("error", {}).get("code") == "row_not_found" and "GHOST" not in json.dumps(common.rest_get(RA, doc)), r)
# receipts: the receipts table is content too, so the import rolls it back
e, r2 = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"summary": "idem-1"}, "idempotency_key": idem}))
check("documented boundary: an idempotency receipt stored after the export is gone after the import (the retry writes again)", not e and not r2.get("replayed"), r2)

os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
json.dump({"ids_kept": ids_kept, "version_same_as_export": g0["version"] == g2["version"], "checks": results},
          open(os.path.join(HERE, "results", "test_import" + ("_" + os.environ["DB_LABEL"] if os.environ.get("DB_LABEL") else "") + ".json"), "w"), indent=1, default=str)
fails = [x for x in results if not x["pass"]]
print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
sys.exit(1 if fails else 0)
