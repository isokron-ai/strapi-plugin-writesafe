"""Functional tests for 1.0 hardening Phase 2, stream A: versions and keys, against a running Strapi with every module on
(ci/run_suite.sh), after the token scripts and scripts/setup_l10n.mjs (locales fr and de).
  item 15   the semantic version "v2.<mac>": row ids and updatedAt are not content; type, order, nesting, relations
            and media are; bound to uid, documentId and locale; rc.2 tokens refused (version_format); ws_localize
            uses structural paths and returns a source_version that stays valid (Phase 0 N13).
  item 16b  content-bound row keys "<component>:<id>:<mac>" and stale_row_key (Phase 0 test 6 scenario C in place;
            the import scenarios A and B are tests/test_row_key_import.py).
  item 16c  set and unset need expected_version (or force); row ops never do.
  item 16d  implicit idempotency: a version-checked write applies once; a retry of the same request is answered with
            the first receipt; another request with the same old version still conflicts.
Run: python3 tests/test_versions_keys.py   (exit 1 on any failure; writes tests/results/test_versions_keys-<db>.json)
ONLY=t15,t16d python3 tests/test_versions_keys.py runs the tests whose names contain one of those strings.
SPIKE_PG=1 / SPIKE_MYSQL=1 (with SPIKE_PG_CONTAINER / SPIKE_MYSQL_CONTAINER) point the SQL helpers at Postgres / MySQL."""
import json, os, re, sqlite3, subprocess, sys, threading, time, traceback
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "spike"))
import spike, common
from spike import A, B, RA, RB

PAGE = "api::page.page"
GUIDE = "api::guide.guide"
GAL = "api::gallery.gallery"
NONCE = str(int(time.time()))
results = []
CURRENT = [None]
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]
V2 = re.compile(r"^v2\.[A-Za-z0-9_-]{43}$")
KEY = re.compile(r"^[a-z0-9-]+\.[a-z0-9-]+:\d+:[A-Za-z0-9_-]{22}$")


def check(name, cond, detail=None):
    results.append({"group": CURRENT[0], "test": name, "pass": bool(cond), "detail": detail if not cond else None})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str, ensure_ascii=False)[:900]))


def T(fn):
    if ONLY and not any(o in fn.__name__ for o in ONLY):
        return fn
    CURRENT[0] = fn.__name__
    try:
        fn()
    except Exception:
        check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-1200:])
    return fn


def ws(tool, args, who=A):
    err, r, n, full = spike.tool(who, tool, args)
    if err and isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    return err, r


def err_of(r):
    return (r or {}).get("error") or {} if isinstance(r, dict) else {}


def code(r):
    return err_of(r).get("code")


def wget(uid, doc, loc=None, who=A):
    a = {"uid": uid, "documentId": doc}
    if loc:
        a["locale"] = loc
    e, r = ws("ws_get", a, who)
    if e:
        raise RuntimeError(r)
    return r


def rest(method, path, data=None, who=RA):
    s, b, _ = spike.rest(who, method, path, {"data": data} if data is not None else None)
    if s not in (200, 201):
        raise RuntimeError((method, path, s, b))
    return b["data"]


def sql(q):
    """One statement against the instance's database (read-write), as tests/test_l10n_history.py does it."""
    if os.environ.get("SPIKE_MYSQL"):
        pw = json.load(open(os.environ.get("SPIKE_MYSQL_SECRET") or os.path.join(spike.ROOT, ".secrets", "mysql.json")))["password"]
        out = subprocess.run(["docker", "exec", "-i", "-e", "MYSQL_PWD", os.environ["SPIKE_MYSQL_CONTAINER"], "mysql", "-u" + os.environ.get("SPIKE_MYSQL_USER", "root"), "-N", "-B",
                              os.environ.get("SPIKE_DB_NAME", "strapi"), "-e", "SET SESSION sql_mode='ANSI_QUOTES'; " + q],
                             env=dict(os.environ, MYSQL_PWD=pw), capture_output=True, text=True, check=True).stdout
        return [l.split("\t") for l in out.splitlines() if l]
    if os.environ.get("SPIKE_PG"):
        out = subprocess.run(["docker", "exec", os.environ["SPIKE_PG_CONTAINER"], "psql", "-U", os.environ.get("SPIKE_PG_USER", "postgres"), "-d", os.environ.get("SPIKE_DB_NAME", "strapi"), "-At", "-F", "\t", "-c", q],
                             capture_output=True, text=True, check=True).stdout
        return [l.split("\t") for l in out.splitlines() if l]
    c = sqlite3.connect(common.DB, timeout=30)
    try:
        cur = c.execute(q)
        rows = cur.fetchall()
        c.commit()
        return [[str(x) for x in r] for r in rows]
    finally:
        c.close()


def reset_sequence(table):
    """The usual "fix the sequences" step after a manual restore: the next id is max(id) + 1, so a removed newest row's
    id is handed out again (Phase 0 test 6, scenario C)."""
    if os.environ.get("SPIKE_MYSQL"):
        sql("ALTER TABLE %s AUTO_INCREMENT = 1" % table)  # InnoDB moves it up to max(id) + 1
    elif os.environ.get("SPIKE_PG"):
        seq = sql("select pg_get_serial_sequence('%s','id')" % table)[0][0]
        sql("select setval('%s', (select max(id) from %s))" % (seq, table))
    else:
        sql("update sqlite_sequence set seq = (select max(id) from %s) where name = '%s'" % (table, table))


def draft_updated_at(table, doc, loc=None):
    q = "select updated_at from %s where document_id = '%s' and published_at is null" % (table, doc)
    if loc:
        q += " and locale = '%s'" % loc
    return sql(q)[0][0]


def new_page(tag, **kw):
    return common.create_page_mcp("vk-%s-%s" % (tag, NONCE), **kw)


def items_of(doc):
    return common.rest_get(RA, doc)["items"]


# ================================================================ item 15: the semantic version
@T
def t15_token_format():
    doc = new_page("fmt")
    g = wget(PAGE, doc)
    check("15: ws_get returns a v2 version token (\"v2.\" + 43 base64url characters, a full-length HMAC)", bool(V2.match(g["version"])), g["version"])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "set": {"note": "fmt"}})
    check("15: receipts carry v2 tokens", not e and V2.match(r.get("version", "")) and r.get("previous_version") == g["version"], r)


@T
def t15_legacy_token_refused():
    doc = new_page("legacy")
    g = wget(PAGE, doc)
    old = "%s~0123456789ab" % g["updatedAt"]
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": old, "set": {"note": "legacy"}})
    er = err_of(r)
    check("15: an rc.2 / Phase 1 token is refused with version_format (requires_reread, retryable false), nothing written",
          e and er.get("code") == "version_format" and er.get("requires_reread") is True and er.get("retryable") is False
          and "ws_get" in er.get("message", "") and common.rest_get(RA, doc)["note"] == "n0", r)
    e, r = ws("ws_publish", {"uid": PAGE, "documentId": doc, "expected_version": old})
    check("15: ws_publish refuses an rc.2 token the same way", e and code(r) == "version_format", r)


@T
def t15_recreated_rows_keep_the_version():
    doc = new_page("recreate")
    g = wget(PAGE, doc)
    ids0 = [x[1] for x in common.cmp_rows(doc, "items")]
    # a whole-list REST write of the same content without ids: Strapi deletes the rows and inserts new ones
    s, b, _ = common.rest_put(RA, doc, {"items": common.strip_ids(common.rest_get(RA, doc)["items"])})
    ids1 = [x[1] for x in common.cmp_rows(doc, "items")]
    g2 = wget(PAGE, doc)
    check("15 setup: the REST write recreated the item rows with new ids", s == 200 and set(ids0).isdisjoint(ids1), [s, ids0, ids1])
    check("15: rows recreated with the same content keep the version (row ids and updatedAt are not content)", g2["version"] == g["version"], [g["version"], g2["version"]])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "set": {"note": "after-recreate"}})
    check("15: a write with the version read before the recreation succeeds", not e and r.get("ok"), r)


@T
def t15_real_changes_still_conflict():
    def attempt(label, change):
        doc = new_page("real-" + label)
        g = wget(PAGE, doc)
        change(doc, g)
        e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "set": {"note": "agent"}})
        check("15: %s changes the version: the old version conflicts, nothing written" % label,
              e and code(r) == "version_conflict" and common.rest_get(RA, doc)["note"] == "n0", r)
    k = lambda g, f, i: g["rows"][f][i]
    attempt("row order (a move)", lambda doc, g: ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "move", "field": "items", "key": k(g, "items", 2), "position": "start"}]}, B))
    attempt("a zone row's type (text replaced by hero with the same text)", lambda doc, g: ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [
        {"op": "remove", "field": "sections", "key": k(g, "sections", 0)},
        {"op": "add", "field": "sections", "component": "blocks.hero", "data": {"heading": "text 0"}, "position": "start"}]}, B))
    attempt("nesting (a nested component added to a row)", lambda doc, g: ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [
        {"op": "update", "field": "items", "key": k(g, "items", 0), "data": {"meta": {"note": "nested"}}}]}, B))
    attempt("a nested value", lambda doc, g: (ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k(g, "items", 0), "data": {"meta": {"note": "x"}}}]}, B),
                                              ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": wget(PAGE, doc)["rows"]["items"][0], "data": {"meta": {"note": "y"}}}]}, B)))
    attempt("a relation", lambda doc, g: ws("ws_patch", {"uid": PAGE, "documentId": doc, "force": True, "set": {"reviewer": rest("POST", "/api/authors", {"name": "rv-" + NONCE})["documentId"]}}, B))


def guide_en(tag):
    s, b, _ = spike.rest(RA, "POST", "/api/guides?status=draft&locale=en", {"data": {
        "title": "Guide " + tag, "note": "note " + tag, "code": "C-" + tag,
        "items": [{"label": "rake", "qty": 1}, {"label": "spade", "qty": 2}],
        "sections": [{"__component": "blocks.hero", "heading": "Welcome"}, {"__component": "blocks.text", "body": "Body text"}],
        "facts": [{"label": "fact one", "qty": 1}, {"label": "fact two", "qty": 2}]}})
    if s not in (200, 201):
        raise RuntimeError((s, b))
    return b["data"]["documentId"]


def localize(doc, loc, src_version, translate=lambda u: "XX " + u["source"], **kw):
    e, p = ws("ws_localize", {"uid": GUIDE, "documentId": doc, "locale": loc})
    if e:
        return e, p, None
    a = {"uid": GUIDE, "documentId": doc, "locale": loc, "translations": {u["path"]: translate(u) for u in p["units"]},
         "expected_source_version": src_version, **kw}
    if p.get("target_version"):
        a["expected_version"] = p["target_version"]
    e, r = ws("ws_localize", a)
    return e, r, p


@T
def t15_n13_localize_source_version():
    """Phase 0 N13: after ws_localize created fr, the receipt's source_version was no longer en's version, so a second
    ws_localize with it got version_conflict although nobody edited en."""
    doc = guide_en("n13-" + NONCE)
    en0 = wget(GUIDE, doc, "en")
    facts0 = [r["_key"] for r in en0["data"]["facts"]]
    e, r, p = localize(doc, "fr", en0["version"], lambda u: "FR " + u["source"])
    check("15 N13 setup: ws_localize creates fr", not e and r.get("created") is True, r)
    paths = [u["path"] for u in (p or {}).get("units", [])]
    rowpaths = [x for x in paths if "[" in x]
    check("15: plan paths are structural (\"sections[0:blocks.hero].heading\"), never row ids",
          rowpaths and all(re.search(r"\[\d+:[A-Za-z0-9._-]+\]", x) for x in rowpaths) and not any(re.search(r":\d+\]", x) for x in rowpaths)
          and "sections[0:blocks.hero].heading" in paths and "items[1:shared.item].label" in paths, paths)
    en1 = wget(GUIDE, doc, "en")
    facts1 = [x["_key"] for x in en1["data"]["facts"]]
    print("  en facts keys before/after the fr create:", facts0, facts1)
    check("15 N13: the receipt's source_version is en's current version (re-read in the transaction)", r.get("source_version") == en1["version"], [r.get("source_version"), en1["version"]])
    check("15 N13: creating fr did not change en's version (only row ids moved)", en1["version"] == en0["version"], [en0["version"], en1["version"]])
    e2, r2, _ = localize(doc, "de", r.get("source_version"), lambda u: "DE " + u["source"])
    check("15 N13: a second ws_localize with the receipt's source_version succeeds (creates de)", not e2 and r2.get("ok") and r2.get("created") is True, r2)
    e3, r3, _ = localize(doc, "fr", en0["version"], lambda u: "FR2 " + u["source"])
    check("15 N13: the version read before both creates still works (fr update)", not e3 and r3.get("ok"), r3)
    # a real change to en's content (a non-localized fact) makes the old source version conflict
    e, rr = ws("ws_patch", {"uid": GUIDE, "documentId": doc, "locale": "en", "ops": [{"op": "update", "field": "facts", "key": wget(GUIDE, doc, "en")["rows"]["facts"][0], "data": {"label": "fact ONE"}}]}, B)
    e4, r4, _ = localize(doc, "fr", en0["version"], lambda u: "FR3 " + u["source"])
    check("15: after a real change to en, the old source version conflicts", not e and e4 and code(r4) == "version_conflict", [rr, r4])


@T
def t15_locale_bound():
    doc = guide_en("loc-" + NONCE)
    en = wget(GUIDE, doc, "en")
    e, r, _ = localize(doc, "fr", en["version"], lambda u: u["source"])  # fr gets en's content unchanged
    fr = wget(GUIDE, doc, "fr")
    same = {k: v for k, v in fr["data"].items() if not isinstance(v, list)} == {k: v for k, v in en["data"].items() if not isinstance(v, list)}
    check("15 setup: fr has the same (scalar) content as en", not e and same, [en["data"], fr["data"]])
    check("15: the same content in two locales has two versions", fr["version"] != en["version"], [en["version"], fr["version"]])
    e, r = ws("ws_patch", {"uid": GUIDE, "documentId": doc, "locale": "fr", "expected_version": en["version"], "set": {"note": "fr via en token"}})
    check("15: a token read from en is refused for fr (version_conflict), nothing written", e and code(r) == "version_conflict" and wget(GUIDE, doc, "fr")["data"]["note"] != "fr via en token", r)


# ================================================================ item 16b: content-bound row keys
@T
def t16b_key_format():
    doc = new_page("kfmt")
    g = wget(PAGE, doc)
    keys = g["rows"]["items"] + g["rows"]["sections"]
    check("16b: component row keys are \"<component>:<id>:<mac>\" (22-character MAC)", all(KEY.match(x) for x in keys), keys)
    check("16b: the keys in data match rows", [x["_key"] for x in g["data"]["items"]] == g["rows"]["items"], g)
    check("16b: blocks keys keep their form", all(re.match(r"^#\d+:[0-9a-f]{8}$", x) for x in g["rows"]["body"]), g["rows"]["body"])


@T
def t16b_two_agents():
    doc = new_page("agents")
    g = wget(PAGE, doc)          # both agents read the same state
    k = g["rows"]["items"]
    e1, r1 = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[0], "data": {"qty": 101}}]}, A)
    e2, r2 = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[1], "data": {"qty": 202}}]}, B)
    it = items_of(doc)
    check("16b: two agents editing separate rows from one read both succeed", not e1 and not e2 and [x["qty"] for x in it][:2] == [101, 202], [r1, r2, it])
    e3, r3 = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[0], "data": {"label": "agent B's label"}}]}, B)
    er = err_of(r3)
    check("16b: the second agent on the SAME row gets stale_row_key (requires_reread), nothing written",
          e3 and er.get("code") == "stale_row_key" and er.get("requires_reread") is True and er.get("key") == k[0]
          and "agent B's label" not in json.dumps(items_of(doc)), r3)
    check("16b: stale_row_key does not hand out the row's new key", wget(PAGE, doc)["rows"]["items"][0] not in json.dumps(r3), er)
    now = wget(PAGE, doc)["rows"]["items"]   # row 0 edited by A, row 1 by B since
    rows1 = (r1 or {}).get("rows", {}).get("items", {})
    check("16b: the reply returns the new key of the row it changed (rekeyed old -> new), and no other key",
          rows1.get("rekeyed") == {k[0]: now[0]} and "keys_after" not in rows1, [r1, now])
    e4, r4 = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": rows1.get("rekeyed", {}).get(k[0], "x"), "data": {"qty": 103}}]}, A)
    check("16b: agent A's next op with the returned key needs no re-read", not e4 and items_of(doc)[0]["qty"] == 103, r4)


@T
def t16b_identical_rows():
    s, b, _ = spike.rest(RA, "POST", "/api/pages?status=draft", {"data": {"title": "vk-ident-" + NONCE, "note": "n0",
                                                                           "items": [{"label": "same", "qty": 1}, {"label": "same", "qty": 1}, {"label": "same", "qty": 1}]}})
    doc = b["data"]["documentId"]
    g = wget(PAGE, doc)
    k = g["rows"]["items"]
    check("16b: three identical rows have three different keys", len(set(k)) == 3, k)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[1], "data": {"qty": 7}}]})
    check("16b: an op on the second of identical rows edits exactly that row", not e and [x["qty"] for x in items_of(doc)] == [1, 7, 1], [r, items_of(doc)])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "remove", "field": "items", "key": k[0]}]}, B)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[0], "data": {"qty": 9}}]})
    check("16b: the key of a removed row is row_not_found (and edits nothing)", e and code(r) == "row_not_found" and 9 not in [x["qty"] for x in items_of(doc)], r)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[2], "data": {"qty": 3}}]})
    check("16b: the untouched identical row keeps its key", not e and [x["qty"] for x in items_of(doc)] == [7, 3], [r, items_of(doc)])


@T
def t16b_nested_repeatables():
    gal = rest("POST", "/api/galleries?status=draft", {"title": "vk-nested-" + NONCE, "groups": [
        {"name": "g1", "entries": [{"note": "a1"}, {"note": "a2"}]}, {"name": "g2", "entries": [{"note": "b1"}]}]})["documentId"]
    g = wget(GAL, gal)
    k = g["rows"]["groups"]
    check("16b setup: a gallery with nested repeatable rows", len(k) == 2 and all(KEY.match(x) for x in k)
          and [x.get("note") for x in g["data"]["groups"][0]["entries"]] == ["a1", "a2"], g["data"])
    # colleague changes a NESTED row of g1 (the whole nested list is written; nested rows are recreated). Replacing a
    # nested list needs expected_version since 1.0 hardening item 20 (stream F, nested lists).
    e, r = ws("ws_patch", {"uid": GAL, "documentId": gal, "expected_version": g["version"], "ops": [{"op": "update", "field": "groups", "key": k[0], "data": {"entries": [{"note": "a1"}, {"note": "A2 colleague"}]}}]}, B)
    check("16b setup: the colleague's nested edit applied", not e, r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": gal, "ops": [{"op": "update", "field": "groups", "key": k[0], "data": {"name": "agent"}}]})
    check("16b: a key whose row changed in a NESTED repeatable is stale (stale_row_key), nothing written",
          e and code(r) == "stale_row_key" and wget(GAL, gal)["data"]["groups"][0]["name"] == "g1", r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": gal, "ops": [{"op": "update", "field": "groups", "key": k[1], "data": {"name": "agent g2"}}]})
    check("16b: the other row's key (its nested rows untouched) still works", not e and wget(GAL, gal)["data"]["groups"][1]["name"] == "agent g2", r)


@T
def t16b_copy_source_key_checked():
    doc = new_page("copy")
    g = wget(PAGE, doc)
    k = g["rows"]["sections"]
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "sections", "key": k[0], "data": {"body": "colleague"}}]}, B)
    other = new_page("copy-target")
    n0 = len(wget(PAGE, other)["data"]["sections"])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": other, "ops": [{"op": "copy", "field": "sections", "key": k[0], "from": {"documentId": doc}}]})
    check("16b: copy with a stale SOURCE key is refused (stale_row_key), nothing copied", e and code(r) == "stale_row_key" and len(wget(PAGE, other)["data"]["sections"]) == n0, r)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": other, "ops": [{"op": "copy", "field": "sections", "key": wget(PAGE, doc)["rows"]["sections"][0], "from": {"documentId": doc}}]})
    check("16b: copy with the source's current key works", not e and "colleague" in json.dumps(wget(PAGE, other)["data"]["sections"]), r)


@T
def t16b_rc2_key_refused():
    doc = new_page("rc2key")
    g = wget(PAGE, doc)
    old = ":".join(g["rows"]["items"][0].split(":")[:2])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": old, "data": {"qty": 55}}]})
    check("16b: an rc.2 key without a MAC (\"<component>:<id>\") is refused with stale_row_key", e and code(r) == "stale_row_key" and 55 not in [x["qty"] for x in items_of(doc)], r)


@T
def t16b_sequence_reset():
    """Phase 0 test 6, scenario C: the newest row is removed, the sequence is reset to max(id), a colleague adds a row
    (it gets the removed row's id). The agent's key for the removed row must not edit the colleague's row."""
    doc = new_page("seq", n_items=3)   # its rows are the newest in the table
    g = wget(PAGE, doc)
    old = g["rows"]["items"][2]
    old_id = int(old.split(":")[1])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "remove", "field": "items", "key": old}]}, B)
    reset_sequence("components_shared_items")
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "add", "field": "items", "data": {"label": "colleague-new", "qty": 1}}]}, B)
    new_key = (r or {}).get("rows", {}).get("items", {}).get("added", ["x:0"])[0]
    reused = int(new_key.split(":")[1]) == old_id
    check("16b setup: the sequence reset hands the removed row's id to the colleague's new row", not e and reused, [old, new_key, r])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": old, "data": {"qty": 4242}}]})
    wrong = [x["label"] for x in items_of(doc) if x["qty"] == 4242]
    check("16b: the stale key of the removed row is refused (stale_row_key); 0 wrong-row edits", e and code(r) == "stale_row_key" and not wrong, [r, wrong])


@T
def t16b_epoch_missing_at_runtime():
    """The epoch row is gone (an admin reset, or the database was swapped under a running Strapi): the next check (at
    most every 10 s) creates a new epoch, and every key read before it is refused."""
    doc = new_page("epoch")
    old = wget(PAGE, doc)["rows"]["items"][0]
    before = sql("select value from writesafe_row_epoch where name = 'rowkeys'")
    sql("delete from writesafe_row_epoch")
    time.sleep(10.5)
    g = wget(PAGE, doc)
    after = sql("select value from writesafe_row_epoch where name = 'rowkeys'")
    check("16b: a missing epoch is recreated as a NEW epoch", before and after and before[0][0] != after[0][0], [len(before), len(after)])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": old, "data": {"qty": 77}}]})
    check("16b: keys read under the old epoch are refused (stale_row_key), nothing written", e and code(r) == "stale_row_key" and 77 not in [x["qty"] for x in items_of(doc)], r)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": g["rows"]["items"][0], "data": {"qty": 78}}]})
    check("16b: keys read after it work", not e and items_of(doc)[0]["qty"] == 78, r)


# ================================================================ item 16c: set and unset need a version
@T
def t16c_set_and_unset_need_a_version():
    doc = new_page("16c")
    def refused(label, args):
        e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, **args})
        er = err_of(r)
        ok = e and er.get("code") == "precondition_required" and er.get("requires_reread") is True and "current_version" not in er and "expected_version" in er.get("message", "")
        check("16c: %s without expected_version is refused (precondition_required), nothing written" % label, ok, r)
    before = common.rest_get(RA, doc)
    refused("a scalar set", {"set": {"note": "no version"}})
    refused("a single component set", {"set": {"seo": {"metaTitle": "no version"}}})
    refused("a scalar unset", {"unset": ["note"]})
    refused("a list unset", {"unset": ["items"]})
    refused("a set with ops in the same call", {"set": {"note": "x"}, "ops": [{"op": "add", "field": "items", "data": {"label": "z", "qty": 1}}]})
    after = common.rest_get(RA, doc)
    check("16c: nothing was written by the refused calls", after["note"] == before["note"] and len(after["items"]) == len(before["items"]) and after["seo"] == before["seo"], [before, after])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "add", "field": "items", "data": {"label": "op", "qty": 1}}]})
    check("16c: row ops still need no version", not e and r.get("ok"), r)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": wget(PAGE, doc)["version"], "set": {"note": "versioned"}, "unset": ["summary"]})
    check("16c: set and unset with expected_version apply", not e and common.rest_get(RA, doc)["note"] == "versioned", r)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "force": True, "set": {"note": "forced"}})
    check("16c: force: true still overwrites without a version", not e and common.rest_get(RA, doc)["note"] == "forced", r)
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": doc, "set": {"note": "batch"}}]})
    check("16c: a ws_batch patch item with set and no version is refused (the batch rolls back)", e and (r or {}).get("items", [{}])[0].get("error", {}).get("code") == "precondition_required", r)


@T
def t16c_descriptions():
    s, b, raw = spike.rpc(A, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    props = tools["ws_patch"]["inputSchema"]["properties"]
    check("16c: ws_patch's expected_version and set/unset descriptions say set and unset need expected_version",
          "set and unset" in props["expected_version"]["description"] and "expected_version" in props["set"]["description"] and "expected_version" in props["unset"]["description"],
          [props["expected_version"]["description"], props["set"]["description"], props["unset"]["description"]])
    check("16c: row ops say they need no version", "No expected_version" in props["ops"]["description"], props["ops"]["description"])


# ================================================================ item 16d: implicit idempotency
@T
def t16d_retry_returns_first_receipt():
    doc = new_page("16d")
    g = wget(PAGE, doc)
    req = {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "set": {"note": "once"}, "ops": [{"op": "add", "field": "items", "data": {"label": "once", "qty": 1}}]}
    e1, r1 = ws("ws_patch", req)
    t1 = draft_updated_at("pages", doc)
    time.sleep(1.1)
    e2, r2 = ws("ws_patch", req)
    t2 = draft_updated_at("pages", doc)
    labels = [x["label"] for x in items_of(doc)]
    check("16d: the same versioned request sent again returns the first receipt (replayed), instead of a conflict",
          not e1 and not e2 and r2.get("replayed") is True and r2.get("version") == r1.get("version") and r2.get("rows") == r1.get("rows"), [r1, r2])
    check("16d: and writes nothing twice (one row added, updatedAt unchanged)", labels.count("once") == 1 and t1 == t2, [labels, t1, t2])
    e3, r3 = ws("ws_patch", {**req, "set": {"note": "other change"}})
    check("16d: a DIFFERENT request with the same old version still conflicts", e3 and code(r3) == "version_conflict" and common.rest_get(RA, doc)["note"] == "once", r3)
    e4, r4 = ws("ws_patch", req, B)
    check("16d: the same request from another token is not answered with this token's receipt (version_conflict)", e4 and code(r4) == "version_conflict", r4)


@T
def t16d_batch_and_delete():
    d1, d2 = new_page("16d-b1"), new_page("16d-b2")
    batch = {"items": [{"uid": PAGE, "documentId": d1, "expected_version": wget(PAGE, d1)["version"], "set": {"note": "b1"}},
                       {"uid": PAGE, "documentId": d2, "expected_version": wget(PAGE, d2)["version"], "set": {"note": "b2"}}]}
    e1, r1 = ws("ws_batch", batch)
    e2, r2 = ws("ws_batch", batch)
    check("16d: a versioned ws_batch sent again returns the first receipt", not e1 and not e2 and r2.get("replayed") is True and r2.get("items") == r1.get("items"), [r1, r2])
    d3 = new_page("16d-del")
    req = {"uid": PAGE, "documentId": d3, "expected_version": wget(PAGE, d3)["version"]}
    e1, r1 = ws("ws_delete", req)
    e2, r2 = ws("ws_delete", req)
    check("16d: ws_delete sent again is answered with the first reply (replayed), stripped of the recreate payload",
          not e1 and not e2 and r2.get("replayed") is True and r2.get("deleted") is True and "recreate" not in r2, [r1, r2])


@T
def t16d_concurrent_identical():
    doc = new_page("16d-conc")
    g = wget(PAGE, doc)
    req = {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "ops": [{"op": "add", "field": "items", "data": {"label": "conc", "qty": 1}}], "set": {"note": "conc"}}
    out = [None, None]

    def run(i):
        out[i] = ws("ws_patch", req)
    th = [threading.Thread(target=run, args=(i,)) for i in range(2)]
    for t in th:
        t.start()
    for t in th:
        t.join()
    labels = [x["label"] for x in items_of(doc)]
    ok = [x for x in out if x and not x[0]]
    check("16d: two identical versioned requests at once: both answered ok, one replayed, the row added once",
          len(ok) == 2 and sum(1 for x in ok if x[1].get("replayed")) == 1 and labels.count("conc") == 1, [out, labels])


# ================================================================ second-agent review of PR #17
def published_ids(doc):
    return [r[0] for r in sql("select id from pages where document_id = '%s' and published_at is not null" % doc)]


@T
def tr1_reply_keys_never_cover_unread_rows():
    """Review finding 1: a reply must not hand out a fresh key for a row the agent never saw (a colleague changed B;
    the agent's write to A must not return B's new key, or the agent can overwrite B without reading it)."""
    doc = new_page("tr1")
    g = wget(PAGE, doc)          # the agent reads [A, B, C]
    k = g["rows"]["items"]
    e, rc = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[1], "data": {"label": "colleague B"}}]}, B)
    kb_new = wget(PAGE, doc, who=B)["rows"]["items"][1]
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[0], "data": {"qty": 11}}]})
    check("review 1: the agent's own write succeeds", not e and r.get("ok"), r)
    check("review 1: the reply carries no key of the row the colleague changed (no keys_after for unread rows)", kb_new not in json.dumps(r), r)
    rows = (r or {}).get("rows", {}).get("items", {})
    check("review 1: the reply's new keys cover only the row this write changed", set((rows.get("rekeyed") or {}).keys()) == {k[0]} and "keys_after" not in rows, rows)
    e, r2 = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[1], "data": {"label": "agent B"}}]})
    check("review 1: the agent's old key for B is still stale_row_key", e and code(r2) == "stale_row_key" and items_of(doc)[1]["label"] == "colleague B", r2)
    # row_not_found lists identities only (no MAC), so it is no source of fresh keys either
    e, r3 = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": "shared.item:999999999:AAAAAAAAAAAAAAAAAAAAAA", "data": {"qty": 1}}]})
    ck = err_of(r3).get("current_keys") or []
    check("review 1: row_not_found's current_keys are row identities without a MAC", e and code(r3) == "row_not_found" and ck and all(re.match(r"^[a-z0-9-]+\.[a-z0-9-]+:\d+$", x) for x in ck), r3)


@T
def tr2_publish_retry_applies_once():
    """Review finding 2a: publishing does not move the draft version, so a retry used to publish again (and again
    after an editor unpublished)."""
    doc = new_page("tr2-pub")
    v = wget(PAGE, doc)["version"]
    req = {"uid": PAGE, "documentId": doc, "expected_version": v}
    e1, r1 = ws("ws_publish", req)
    ids1 = published_ids(doc)
    e2, r2 = ws("ws_publish", req)
    check("review 2a: a publish retry is answered with the first receipt (replayed), the live row is not rebuilt",
          not e1 and not e2 and r2.get("replayed") is True and published_ids(doc) == ids1 and ids1, [r1, r2, ids1, published_ids(doc)])
    e, u = spike.tool(A, "unpublish_page", {"documentId": doc})[:2]
    check("review 2a setup: an editor unpublished", not e and published_ids(doc) == [], u)
    e3, r3 = ws("ws_publish", req)
    # MWS self-test D1 (MWS-RES-1): the live version is no longer what the first publish produced, so the retry is not
    # answered with that success any more; it is refused (replay_superseded) and still publishes nothing
    check("review 2a: the retry after the unpublish does not publish again (replay_superseded, not a success)",
          e3 and code(r3) == "replay_superseded" and err_of(r3).get("current_version") is None and published_ids(doc) == [], [r3, published_ids(doc)])


@T
def tr2_batch_with_unversioned_item_applies_once():
    d1, d2 = new_page("tr2-b1"), new_page("tr2-b2")
    # the versioned item writes the value the field already holds, so the (semantic) version does not move and the
    # retry passes its check: only a lookup of the stored reply keeps the add item from running twice
    batch = {"items": [{"uid": PAGE, "documentId": d1, "expected_version": wget(PAGE, d1)["version"], "set": {"note": "n0"}},
                       {"uid": PAGE, "documentId": d2, "ops": [{"op": "add", "field": "items", "data": {"label": "tr2-add", "qty": 1}}]}]}
    e1, r1 = ws("ws_batch", batch)
    e2, r2 = ws("ws_batch", batch)
    labels = [x["label"] for x in items_of(d2)]
    check("review 2b: a batch retry with an unversioned add item replays; the row is added once", not e1 and not e2 and r2.get("replayed") is True and labels.count("tr2-add") == 1, [r1, r2, labels])


@T
def tr2_retry_after_colleague_undo_is_not_reapplied():
    """Review finding 2c: the colleague undid the agent's write (the document is back at the agent's version); the
    agent's late retry must not write it again over the colleague's undo."""
    doc = new_page("tr2-undo")
    req = {"uid": PAGE, "documentId": doc, "expected_version": wget(PAGE, doc)["version"], "set": {"note": "agent"}}
    e, r = ws("ws_patch", req)
    e, u = ws("ws_undo", {"receipt_id": r.get("receipt_id")}, B)
    check("review 2c setup: the colleague's undo put the note back", not e and common.rest_get(RA, doc)["note"] == "n0", u)
    e2, r2 = ws("ws_patch", req)
    # MWS self-test D1 (MWS-RES-1): the write is no longer in effect, so the retry is refused (replay_superseded), not
    # answered with the first success; it still writes nothing over the undo
    check("review 2c: the retry is refused (replay_superseded, requires_reread), the undo stands",
          e2 and code(r2) == "replay_superseded" and err_of(r2).get("requires_reread") is True and common.rest_get(RA, doc)["note"] == "n0",
          [r2, common.rest_get(RA, doc)["note"]])


@T
def tr2_localize_create_retry_replays():
    doc = guide_en("tr2-loc-" + NONCE)
    en = wget(GUIDE, doc, "en")
    e, p = ws("ws_localize", {"uid": GUIDE, "documentId": doc, "locale": "fr"})
    a = {"uid": GUIDE, "documentId": doc, "locale": "fr", "translations": {u["path"]: "FR " + u["source"] for u in p["units"]}, "expected_source_version": en["version"]}
    e1, r1 = ws("ws_localize", a)
    e2, r2 = ws("ws_localize", a)
    check("review 2d: a retry of a localize that created fr is answered with the first receipt (not precondition_required)",
          not e1 and not e2 and r2.get("replayed") is True and r2.get("created") is True, [r1, r2])


@T
def tr6_replay_records_hold_no_documents():
    doc = new_page("tr6")
    req = {"uid": PAGE, "documentId": doc, "expected_version": wget(PAGE, doc)["version"], "set": {"note": "SECRET-TR6"}, "return": "full"}
    e1, r1 = ws("ws_patch", req)
    e2, r2 = ws("ws_patch", req)
    check("review 6: the stored reply of a versioned write keeps no document (return: full is not replayed)", not e1 and "document" in r1 and not e2 and r2.get("replayed") is True and "document" not in r2, [list(r1), list(r2 or {})])


# ================================================================ second review round of PR #17
def backdate_claim(receipt_id, minutes):
    """Age the implicit claim of a write (its row carries the write's receipt_id with the history module on)."""
    if os.environ.get("SPIKE_MYSQL"):
        sql("update writesafe_receipts set created_at = created_at - interval %d minute where receipt_id = '%s'" % (minutes, receipt_id))
    elif os.environ.get("SPIKE_PG"):
        sql("update writesafe_receipts set created_at = created_at - interval '%d minutes' where receipt_id = '%s'" % (minutes, receipt_id))
    else:
        sql("update writesafe_receipts set created_at = created_at - %d where receipt_id = '%s'" % (minutes * 60000, receipt_id))


@T
def tn1_replay_says_how_to_apply_again():
    doc = new_page("tn1")
    req = {"uid": PAGE, "documentId": doc, "expected_version": wget(PAGE, doc)["version"], "set": {"note": "agent"}}
    e1, r1 = ws("ws_patch", req)
    e, u = ws("ws_undo", {"receipt_id": r1.get("receipt_id")}, B)   # a human undoes it: back at the agent's version
    e2, r2 = ws("ws_patch", req)
    cur = wget(PAGE, doc)["version"]
    # MWS self-test D1: the undo took the write out of effect, so this is replay_superseded, not a replayed success
    check("N1: the refused replay carries current_version, the receipt and the way to apply it again on purpose (idempotency_key)",
          e2 and code(r2) == "replay_superseded" and err_of(r2).get("current_version") == cur and err_of(r2).get("receipt_id") == r1.get("receipt_id")
          and "idempotency_key" in (err_of(r2).get("message") or ""), r2)
    e3, r3 = ws("ws_patch", {**req, "idempotency_key": "tn1-again-" + NONCE})
    check("N1: with an idempotency_key the same change applies again", not e3 and not r3.get("replayed") and common.rest_get(RA, doc)["note"] == "agent", r3)


@T
def tsd1_aba_fresh_request_is_not_a_false_success():
    """MWS self-test D1 (MWS-RES-1): A sets review, B sets draft (the document is back at A's first version), A reads
    again and sends the same request. It must not be answered ok with nothing applied."""
    doc = new_page("sd1")
    common.rest_put(RB, doc, {"note": "draft"})
    v0 = wget(PAGE, doc)["version"]
    req = {"uid": PAGE, "documentId": doc, "expected_version": v0, "set": {"note": "review"}}
    e1, r1 = ws("ws_patch", req)
    check("D1 setup: A sets review", not e1 and common.rest_get(RA, doc)["note"] == "review", r1)
    e2, r2 = ws("ws_patch", req)
    check("D1: a plain retry right after the write still replays (one write)", not e2 and r2.get("replayed") is True and r2.get("version") == r1.get("version"), r2)
    e, b = ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": r1["version"], "set": {"note": "draft"}}, B)
    check("D1 setup: B sets draft", not e and common.rest_get(RA, doc)["note"] == "draft", b)
    v0b = wget(PAGE, doc)["version"]
    check("D1 setup: the re-read gives the first version again (content-hash versions)", v0b == v0, [v0, v0b])
    e3, r3 = ws("ws_patch", req)
    note = common.rest_get(RA, doc)["note"]
    check("D1: the identical fresh request is refused (replay_superseded, isError), not answered ok; nothing written",
          e3 and code(r3) == "replay_superseded" and not r3.get("ok") and err_of(r3).get("produced_version") == r1.get("version")
          and err_of(r3).get("current_version") == v0 and note == "draft", [r3, note])
    e4, r4 = ws("ws_patch", {**req, "idempotency_key": "sd1-" + NONCE})
    check("D1: resent with an idempotency_key, the change applies", not e4 and not r4.get("replayed") and common.rest_get(RA, doc)["note"] == "review", r4)
    e5, r5 = ws("ws_patch", {**req, "idempotency_key": "sd1-" + NONCE})
    check("D1: and that keyed request replays on a retry (the explicit-key path is unchanged)", not e5 and r5.get("replayed") is True, r5)


@T
def tsd1_batch_and_delete_after_aba():
    """MWS self-test D1 for ws_batch (a chain of two patch items on one document) and ws_delete."""
    d1 = new_page("sd1-b")
    v0 = wget(PAGE, d1)["version"]
    batch = {"items": [{"uid": PAGE, "documentId": d1, "expected_version": v0, "set": {"note": "b-one"}},
                       {"uid": PAGE, "documentId": d1, "set": {"note": "b-two"}}]}
    e1, r1 = ws("ws_batch", batch)
    e2, r2 = ws("ws_batch", batch)
    check("D1 batch: a plain retry of a chained batch (two items, one document) replays", not e1 and not e2 and r2.get("replayed") is True, [r1, r2])
    e, u = ws("ws_undo", {"receipt_id": r1.get("receipt_id")}, B)
    check("D1 batch setup: a colleague undid the batch (back at the first version)", not e and wget(PAGE, d1)["version"] == v0, u)
    e3, r3 = ws("ws_batch", batch)
    check("D1 batch: the same batch again is refused (replay_superseded), nothing written",
          e3 and code(r3) == "replay_superseded" and len(err_of(r3).get("superseded_items") or []) == 2 and wget(PAGE, d1)["version"] == v0, r3)
    d3 = new_page("sd1-del")
    req = {"uid": PAGE, "documentId": d3, "expected_version": wget(PAGE, d3)["version"]}
    e1, r1 = ws("ws_delete", req)
    e, u = ws("ws_undo", {"receipt_id": r1.get("receipt_id")}, B)
    eg, g = ws("ws_get", {"uid": PAGE, "documentId": d3})
    check("D1 delete setup: the colleague's undo restored the document (same documentId)", not e and not eg, [u, g])
    # informational: the delete rule needs only the document to exist again, not the same version
    check("D1 delete setup (info): the restored document reads with the version the delete named", not eg and g.get("version") == req["expected_version"], g)
    e2, r2 = ws("ws_delete", req)
    eg2, g2 = ws("ws_get", {"uid": PAGE, "documentId": d3})
    check("D1 delete: the same delete again is refused (replay_superseded), not answered deleted: true; the document stays",
          e2 and code(r2) == "replay_superseded" and not eg2, [r2, g2])


@T
def tn1_implicit_claims_expire_after_minutes():
    doc = new_page("tn1-ttl")
    req = {"uid": PAGE, "documentId": doc, "expected_version": wget(PAGE, doc)["version"], "set": {"note": "agent"}}
    e1, r1 = ws("ws_patch", req)
    e, u = ws("ws_undo", {"receipt_id": r1.get("receipt_id")}, B)
    backdate_claim(r1.get("receipt_id"), 11)          # older than retention.implicitClaimMinutes (10)
    e2, r2 = ws("ws_patch", req)
    check("N1: an implicit claim older than implicitClaimMinutes no longer replays: a deliberate re-run writes",
          not e and not e2 and not r2.get("replayed") and common.rest_get(RA, doc)["note"] == "agent", [u, r2])


@T
def tn2_retry_addressed_differently_replays():
    doc = guide_en("tn2-" + NONCE)
    req = {"uid": GUIDE, "documentId": doc, "expected_version": wget(GUIDE, doc, "en")["version"], "set": {"note": "tn2"}}
    e1, r1 = ws("ws_patch", req)                        # default locale left out
    e2, r2 = ws("ws_patch", {**req, "locale": "en"})    # the retry names it
    check("N2: a retry that names the default locale is the same request (replayed, not idempotency_key_reused)",
          not e1 and not e2 and r2.get("replayed") is True, [r1, r2])


os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
tag = os.environ.get("RESULT_TAG") or os.environ.get("DB_LABEL") or "sqlite"
json.dump({"checks": results}, open(os.path.join(HERE, "results", "test_versions_keys-%s.json" % tag), "w"), indent=1, default=str)
fails = [x for x in results if not x["pass"]]
print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
sys.exit(1 if fails else 0)
