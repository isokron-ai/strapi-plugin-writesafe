"""1.0 hardening item 16b: row keys across `strapi export` / `strapi import` (Phase 0 test 6, scenarios A and B).
Phase 0 measured that an old "<component>:<id>" key edited a DIFFERENT row after an import into a fresh database (6 of
12 keys) and the reply said ok. Since item 16b a key is "<component>:<id>:<mac>", bound to the row's content and to
the database epoch (table writesafe_row_epoch, which data transfer does not carry).
  A  same database: an OLDER export is imported back (`--force --only content`) while Strapi runs. Every old key must
     edit the same row or be refused; never another row.
  B  fresh database: the export is imported into a new, empty database (a migration, a restore to a new host, a copy
     to staging), served by a second Strapi. Every old key must be refused (stale_row_key or row_not_found): 0
     wrong-row edits, and 0 same-row edits either (the new database has its own epoch).
Run through ci/run_suite.sh with SUITES=test_row_key_import (Strapi on $PORT with the fixtures), or by hand with the env
of tests/test_plugin.py plus APP_DIR, DB (sqlite|postgres|mysql), DB_CONTAINER (postgres/mysql), PORT2 (default
$PORT + 5) and WORK. ROUNDS (default 2). Writes tests/results/test_row_key_import-<db>.json."""
import json, os, re, secrets, shutil, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "spike"))
import spike, common
from spike import A, B, RA

PAGE = "api::page.page"
APP = os.environ["APP_DIR"]
DBK = os.environ.get("DB", "sqlite")
PORT = int(os.environ.get("PORT", "1337"))
PORT2 = int(os.environ.get("PORT2", str(PORT + 5)))
WORK = os.environ.get("WORK") or os.path.join(APP, ".ci")
ROUNDS = int(os.environ.get("ROUNDS", "2"))
EXP = os.path.join(WORK, "exports")
os.makedirs(EXP, exist_ok=True)
MAIN = {"base": spike.BASE, "tok": spike.TOK}
results = []
records = {"A": [], "B": []}


def check(name, cond, detail=None):
    results.append({"test": name, "pass": bool(cond), "detail": None if cond else detail})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:900]))


def ws(tool, args, who=A):
    e, r, _, _ = spike.tool(who, tool, args)
    if e and isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    return e, r


def code(r):
    return ((r or {}).get("error") or {}).get("code") if isinstance(r, dict) else None


def use(base, tok=None):
    spike.BASE = base
    spike.TOK = tok or MAIN["tok"]


def env_for(db_name=None, port=None):
    env = dict(os.environ, HOST="127.0.0.1", NODE_ENV="test", STRAPI_TELEMETRY_DISABLED="true", DO_NOT_TRACK="1", SERVE_ADMIN_PANEL="false")
    if port:
        env["PORT"] = str(port)
    if db_name:
        if DBK == "sqlite":
            env["DATABASE_FILENAME"] = ".tmp/%s.db" % db_name
        else:
            env["DATABASE_NAME"] = db_name
    return env


def cli(env, *args):
    p = subprocess.run(["node", "node_modules/@strapi/strapi/bin/strapi.js", *args], cwd=APP, env=env, capture_output=True, text=True, timeout=900)
    if p.returncode != 0:
        raise RuntimeError(p.stdout[-1500:] + p.stderr[-1500:])
    return p.stdout


def db_admin(sql_text):
    """CREATE / DROP DATABASE on the server of this run (postgres, mysql)."""
    c = os.environ["DB_CONTAINER"]
    if DBK == "postgres":
        subprocess.run(["docker", "exec", c, "psql", "-U", os.environ.get("DB_USER", "postgres"), "-q", "-c", sql_text], check=True, capture_output=True, text=True)
    else:
        subprocess.run(["docker", "exec", "-i", "-e", "MYSQL_PWD", c, "mysql", "-u" + os.environ.get("DB_USER", "root"), "-e", sql_text],
                       env=dict(os.environ, MYSQL_PWD=os.environ["DB_PASSWORD"]), check=True, capture_output=True, text=True)


def drop_db(name):
    if DBK == "sqlite":
        for suf in ("", "-wal", "-shm", "-journal"):
            p = os.path.join(APP, ".tmp", name + ".db" + suf)
            if os.path.exists(p):
                os.remove(p)
    elif DBK == "postgres":
        db_admin("DROP DATABASE IF EXISTS %s WITH (FORCE)" % name)
    else:
        db_admin("DROP DATABASE IF EXISTS %s" % name)


def create_db(name):
    drop_db(name)
    if DBK != "sqlite":
        db_admin("CREATE DATABASE %s" % name)


class Second:
    """A second Strapi of the same app on PORT2, on another database."""

    def __init__(self, db_name):
        self.db_name, self.proc = db_name, None
        self.base = "http://127.0.0.1:%d" % PORT2
        self.log = os.path.join(WORK, "strapi-import-%s.log" % db_name)

    def start(self):
        lf = open(self.log, "a")
        self.proc = subprocess.Popen(["node", "--max-old-space-size=4096", "node_modules/@strapi/strapi/bin/strapi.js", "start"], cwd=APP,
                                     env=env_for(self.db_name, PORT2), stdout=lf, stderr=subprocess.STDOUT)
        for _ in range(180):
            try:
                with urllib.request.urlopen(self.base + "/_health", timeout=2) as r:
                    if r.status == 204:
                        return
            except Exception:
                pass
            if self.proc.poll() is not None:
                raise RuntimeError("second strapi exited; see " + self.log)
            time.sleep(1)
        raise RuntimeError("second strapi not healthy; see " + self.log)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(30)
            except Exception:
                self.proc.kill()
        self.proc = None

    def tokens(self):
        """First admin and the spike tokens on this instance (throwaway, written under WORK/secrets, never printed)."""
        sec = os.path.join(WORK, "secrets")
        os.makedirs(sec, exist_ok=True)
        adm = os.path.join(sec, "admin-%s.json" % self.db_name)
        tok = os.path.join(sec, "tokens-%s.json" % self.db_name)
        a = {"email": "ci-import@example.test", "password": "Ci9" + secrets.token_urlsafe(18)}
        fd = os.open(adm, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(a, f)
        req = urllib.request.Request(self.base + "/admin/register-admin", method="POST", headers={"content-type": "application/json"},
                                     data=json.dumps({"firstname": "CI", "lastname": "Import", **a}).encode())
        try:
            urllib.request.urlopen(req, timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code != 400:  # the imported admin users may already include one: then log in with ours fails, see below
                raise
        subprocess.run(["node", os.path.join(ROOT, "scripts", "setup_tokens.mjs")], env=dict(os.environ, SPIKE_BASE=self.base, SPIKE_ADMIN=adm, SPIKE_TOKENS=tok),
                       check=True, capture_output=True, text=True)
        return json.load(open(tok))


def labels(doc):
    g = ws("ws_get", {"uid": PAGE, "documentId": doc})[1]
    return [(x["_key"], x["label"]) for x in g["data"]["items"]]


def probe(doc, old):
    """For each (key, label) read earlier: a row op without a version. Which row did it edit?"""
    out = []
    for k, label in old:
        e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 4242}}]})
        now = ws("ws_get", {"uid": PAGE, "documentId": doc})[1]["data"]["items"]
        hit = [x["label"] for x in now if x["qty"] == 4242]
        res = code(r) if e else ("same_row" if hit == [label] else "WRONG_ROW")
        out.append({"key": k, "meant": label, "result": res, "edited": hit})
        if not e:
            for x in now:
                if x["qty"] == 4242:
                    ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": x["_key"], "data": {"qty": 1}}]})
    return out


def shuffle(doc):
    """remove the first row, add one at the end, move the old last row to the start: ids no longer in list order."""
    k = ws("ws_get", {"uid": PAGE, "documentId": doc})[1]["rows"]["items"]
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [
        {"op": "remove", "field": "items", "key": k[0]},
        {"op": "add", "field": "items", "data": {"label": "added", "qty": 1}, "position": "end"},
        {"op": "move", "field": "items", "key": k[-1], "position": "start"}]}, B)
    if e:
        raise RuntimeError(r)


for rnd in range(ROUNDS):
    tag = "%d-%d" % (rnd, int(time.time()))
    # ---------------------------------------------------------------- A: same database, older export imported back
    use(MAIN["base"])
    doc = common.create_page_mcp("rki-a-" + tag, n_items=4)
    at_export = labels(doc)
    exp = os.path.join(EXP, "a-" + tag)
    cli(env_for(), "export", "--no-encrypt", "--no-compress", "--only", "content", "-f", exp)
    shuffle(doc)
    read_last = labels(doc)
    cli(env_for(), "import", "-f", exp + ".tar", "--force", "--only", "content")
    time.sleep(1)
    rec = {"round": rnd, "at_export": at_export, "read_after_export": read_last, "after_import": labels(doc),
           "probe_at_export": probe(doc, at_export), "probe_read_after_export": probe(doc, read_last)}
    records["A"].append(rec)
    print("A", rnd, [x["result"] for x in rec["probe_at_export"]], [x["result"] for x in rec["probe_read_after_export"]])

    # ---------------------------------------------------------------- B: fresh database (Phase 0 test 6 B)
    # A small site in its own database (so its row ids are low, as on a real site's first months), exported and imported
    # into a new, empty database: ids restart at 1 there, in list order, so old ids name other rows.
    src, dst = "rki_src_%d" % rnd, "rki_dst_%d" % rnd
    create_db(src)
    first = Second(src)
    try:
        first.start()
        use(first.base, first.tokens())
        for i in range(2):
            common.create_page_mcp("rki-b-filler-%d-%s" % (i, tag), n_items=2)
        doc = common.create_page_mcp("rki-b-" + tag, n_items=4)
        shuffle(doc)
        g_src = ws("ws_get", {"uid": PAGE, "documentId": doc})[1]
        before = labels(doc)
    finally:
        first.stop()
        use(MAIN["base"])
    exp = os.path.join(EXP, "b-" + tag)
    cli(env_for(src), "export", "--no-encrypt", "--no-compress", "--only", "content", "-f", exp)
    create_db(dst)
    second = Second(dst)
    try:
        cli(env_for(dst, PORT2), "import", "-f", exp + ".tar", "--force", "--only", "content")
        second.start()
        use(second.base, second.tokens())
        after = labels(doc)
        ids_after = {":".join(k.split(":")[:2]): label for k, label in after}
        # an old key whose id now names a row: the case Phase 0 measured as a wrong-row edit (6 of 12)
        reused = [k for k, label in before if ":".join(k.split(":")[:2]) in ids_after]
        e, rv = ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g_src["version"], "set": {"summary": "after-migration"}})
        rec = {"round": rnd, "keys_before": before, "keys_after_import": after, "old_ids_reused": len(reused),
               "old_ids_reused_same_label": sum(1 for k, label in before if ids_after.get(":".join(k.split(":")[:2])) == label),
               "probe": probe(doc, before), "versioned_write_with_source_version": "ok" if not e else code(rv)}
        records["B"].append(rec)
        print("B", rnd, before, after, [x["result"] for x in rec["probe"]], "reused ids:", rec["old_ids_reused"], rec["versioned_write_with_source_version"])
    finally:
        second.stop()
        use(MAIN["base"])
        drop_db(src)
        drop_db(dst)

pa = [x for rec in records["A"] for k in ("probe_at_export", "probe_read_after_export") for x in rec[k]]
pb = [x for rec in records["B"] for x in rec["probe"]]
agg = {
    "A_same_db_import": {"keys": len(pa), "wrong_row": sum(x["result"] == "WRONG_ROW" for x in pa), "results": sorted({x["result"] for x in pa})},
    "B_fresh_db_import": {"keys": len(pb), "wrong_row": sum(x["result"] == "WRONG_ROW" for x in pb), "same_row": sum(x["result"] == "same_row" for x in pb),
                          "old_ids_reused": sum(r["old_ids_reused"] for r in records["B"]), "old_ids_reused_same_label": sum(r["old_ids_reused_same_label"] for r in records["B"]),
                          "results": sorted({x["result"] for x in pb}), "versioned_write": sorted({r["versioned_write_with_source_version"] for r in records["B"]})},
}
check("16b A: same-database import: 0 wrong-row edits; every old key edits its own row or is refused (stale_row_key / row_not_found)",
      pa and agg["A_same_db_import"]["wrong_row"] == 0 and set(agg["A_same_db_import"]["results"]) <= {"same_row", "stale_row_key", "row_not_found"}, agg["A_same_db_import"])
check("16b B setup: after the import into a fresh database, old row ids name rows again (the Phase 0 wrong-row case)",
      agg["B_fresh_db_import"]["old_ids_reused"] > 0, agg["B_fresh_db_import"])
check("16b B: fresh-database import: every old key is refused (stale_row_key / row_not_found), 0 wrong-row edits, 0 same-row edits",
      pb and agg["B_fresh_db_import"]["wrong_row"] == 0 and agg["B_fresh_db_import"]["same_row"] == 0
      and set(agg["B_fresh_db_import"]["results"]) <= {"stale_row_key", "row_not_found"}, agg["B_fresh_db_import"])
print(json.dumps(agg, indent=1))
os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
json.dump({"db": DBK, "aggregate": agg, "records": records, "checks": results},
          open(os.path.join(HERE, "results", "test_row_key_import-%s.json" % (os.environ.get("RESULT_TAG") or DBK)), "w"), indent=1, default=str)
fails = [x for x in results if not x["pass"]]
print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
sys.exit(1 if fails else 0)
