"""Functional tests for the write-safe plugin, against a running Strapi (scripts/start.sh) with the spike tokens.
Run: python3 tests/test_plugin.py   (exit 1 on any failure; writes tests/results/test_plugin.json)
ONLY=t_hidden,t_i18n python3 tests/test_plugin.py runs the tests whose names contain one of those strings."""
import base64, hashlib, json, os, sys, threading, time, traceback
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "spike"))
import spike, common
from spike import A, B, RA, RB
from common import vv, vb, ident

UID = "api::page.page"
results = []


CURRENT = [None]


def check(name, cond, detail=None):
    results.append({"group": CURRENT[0], "test": name, "pass": bool(cond), "detail": detail if not cond else None})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:600]))


def ws(tool, args, who=A):
    err, r, n, full = spike.tool(who, tool, args)
    if err and isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    return err, r, n


def get(doc, who=A):
    return ws("ws_get", {"uid": UID, "documentId": doc}, who)[1]



ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]


def T(fn):
    if ONLY and not any(o in fn.__name__ for o in ONLY):
        return fn
    CURRENT[0] = fn.__name__
    try:
        fn()
    except Exception as e:
        check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-800:])
    return fn


@T
def t_catalog():
    s, b, raw = spike.rpc(A, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    for n in ("ws_get", "ws_patch", "ws_publish", "ws_batch"):
        check("catalog lists " + n, n in tools)
    check("ws_patch top-level args are strict", tools["ws_patch"]["inputSchema"].get("additionalProperties") is False,
          tools["ws_patch"]["inputSchema"].get("additionalProperties"))
    check("receipt store is not exposed as tools", not any("receipt" in n for n in tools))


@T
def t_get_and_scalar_patch():
    doc = common.create_page_mcp("tp-scalar")
    items0 = common.cmp_rows(doc, "items")
    g = get(doc)
    check("ws_get returns version and row keys", g["version"].startswith("v2.") and len(g["rows"]["items"]) == 3, g)
    err, r, n = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"note": "x"}})
    check("scalar patch ok", not err and r["ok"] and r["changed"] == ["note"], r)
    check("receipt is compact (structured receipt < 300 bytes)", len(json.dumps(r, separators=(",", ":"))) < 300, len(json.dumps(r, separators=(",", ":"))))
    check("receipt version changes", r["version"] != g["version"] and r["previous_version"] == g["version"], r)
    check("value written", common.rest_get(RA, doc)["note"] == "x")
    check("components untouched by scalar patch", common.cmp_rows(doc, "items") == items0, [items0, common.cmp_rows(doc, "items")])


@T
def t_conflict_structure():
    doc = common.create_page_mcp("tp-conflict")
    g = get(doc)
    common.rest_put(RB, doc, {"note": "colleague"})
    err, r, n = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"note": "agent"}})
    e = (r or {}).get("error", {})
    check("stale write refused as version_conflict", err and e.get("code") == "version_conflict", r)
    check("conflict carries current_version", e.get("current_version", "").startswith("v2."), e)
    check("conflict carries the current value of the touched field", e.get("current", {}).get("note") == "colleague", e)
    check("conflict carries a retry hint with the new expected_version", e.get("retry", {}).get("expected_version") == e.get("current_version"), e)
    check("nothing written on conflict", common.rest_get(RA, doc)["note"] == "colleague")
    err, r2, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": e["current_version"], "set": {"note": "agent"}})
    check("retry with current_version succeeds", not err and r2["ok"], r2)
    err, r3, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": common.rest_get(RA, doc)["updatedAt"], "set": {"summary": "y"}})
    check("hardening item 3: a bare updatedAt is refused as expected_version (invalid, says to use ws_get's version)",
          err and (r3 or {}).get("error", {}).get("code") == "invalid" and "ws_get" in (r3 or {}).get("error", {}).get("message", "") and common.rest_get(RA, doc).get("summary") != "y", r3)


@T
def t_row_ops_keep_ids_and_colleague_rows():
    doc = common.create_page_mcp("tp-ops")
    g = get(doc)
    items_before = common.cmp_rows(doc, "items")
    common.rest_put(RB, doc, {"sections": common.rest_get(RB, doc)["sections"] + [{"__component": "blocks.text", "body": "COLLEAGUE"}]})
    k_items, k_secs, k_body = g["rows"]["items"], g["rows"]["sections"], g["rows"]["body"]
    err, r, n = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [
        {"op": "update", "field": "items", "key": k_items[1], "data": {"qty": 42}},
        {"op": "update", "field": "sections", "key": k_secs[0], "data": {"body": "AGENT"}},
        {"op": "add", "field": "sections", "component": "blocks.hero", "data": {"heading": "NEW"}, "position": {"after": k_secs[0]}},
        {"op": "remove", "field": "sections", "key": k_secs[2]},
        {"op": "move", "field": "items", "key": k_items[2], "position": "start"},
        {"op": "add", "field": "body", "data": common.para("NEWPARA"), "position": "end"},
        {"op": "update", "field": "body", "key": k_body[0], "data": common.para("EDITED")},
    ]})
    check("row ops ok", not err and r["ok"], r)
    v = common.rest_get(RA, doc)
    secs = json.dumps(v["sections"])
    check("colleague's added block survived (no expected_version, row ops)", "COLLEAGUE" in secs, v["sections"])
    check("agent block edit applied", "AGENT" in secs and "NEW" in secs and "cta 2" not in secs, v["sections"])
    check("items qty updated and moved", v["items"][0]["label"] == "item 2" and v["items"][2]["qty"] == 42, v["items"])
    items_after = common.cmp_rows(doc, "items")
    check("repeatable component ids kept by row ops", sorted(x[1] for x in items_before) == sorted(x[1] for x in items_after), [items_before, items_after])
    check("blocks edits applied", json.dumps(v["body"]).count("EDITED") == 1 and "NEWPARA" in json.dumps(v["body"]), v["body"])
    check("receipt lists added row keys", r["rows"]["sections"]["added"][0].startswith("blocks.hero:"), r.get("rows"))


@T
def t_row_not_found():
    doc = common.create_page_mcp("tp-rnf")
    g = get(doc)
    key = g["rows"]["items"][0]
    # A whole-list write through REST recreates every item row (new ids); built-in update_page refuses lists under guard
    v = common.rest_get(RA, doc)
    common.rest_put(RA, doc, {"items": common.strip_ids(v["items"])})
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": key, "data": {"qty": 1}}]})
    e = (r or {}).get("error", {})
    check("op on a key that no longer exists -> row_not_found with current keys", err and e.get("code") == "row_not_found" and len(e.get("current_keys", [])) == 3, r)


@T
def t_precondition_and_set_list():
    doc = common.create_page_mcp("tp-set")
    g = get(doc)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "set": {"sections": []}})
    check("whole-list set without expected_version -> precondition_required", err and r["error"]["code"] == "precondition_required", r)
    rows = [dict(x) for x in g["data"]["items"]]
    rows[0]["qty"] = 9
    rows = rows[:2] + [{"label": "fresh", "qty": 1}]
    before = [x[1] for x in common.cmp_rows(doc, "items")]
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"items": rows}})
    after = [x[1] for x in common.cmp_rows(doc, "items")]
    check("set list with _key keeps those rows' ids", not err and after[:2] == before[:2] and after[2] not in before, [r, before, after])
    check("receipt reports kept/removed/added", r["rows"]["items"]["kept"] == 2 and len(r["rows"]["items"]["removed"]) == 1, r)


@T
def t_single_component_merge():
    doc = common.create_page_mcp("tp-seo")
    g = get(doc)
    before = common.cmp_rows(doc, "seo")
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"seo": {"metaDescription": "d"}}})
    v = common.rest_get(RA, doc)
    check("single component merges and keeps its row id", not err and v["seo"]["metaTitle"] == "meta" and v["seo"]["metaDescription"] == "d" and common.cmp_rows(doc, "seo") == before, [r, v["seo"]])


@T
def t_validation():
    doc = common.create_page_mcp("tp-val")
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "set": {"nmae": "typo"}})
    check("unknown field refused (not silently ignored)", err and r["error"]["code"] == "invalid" and "nmae" in r["error"]["message"], r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "items", "data": {"label": "x", "colour": "red"}}]})
    check("unknown component field refused", err and r["error"]["code"] == "invalid", r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expectedUpdatedAt": "x", "set": {"note": "a"}})
    check("misspelt top-level precondition argument rejected (strict schema)", err, r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "set": {"items": [{"label": "x", "qty": "NaN"}]}, "force": True})
    check("Strapi validation error surfaces as invalid", err and r["error"]["code"] in ("invalid",), r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": "nope", "set": {"note": "a"}})
    check("missing document -> not_found", err and r["error"]["code"] == "not_found", r)


@T
def t_dry_run():
    doc = common.create_page_mcp("tp-dry")
    g = get(doc)
    before = common.rest_get(RA, doc)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "dry_run": True,
                                "set": {"note": "dry"}, "ops": [{"op": "add", "field": "items", "data": {"label": "dry", "qty": 1}}]})
    after = common.rest_get(RA, doc)
    check("dry run returns a receipt marked dry_run, written false", not err and r["dry_run"] and r["written"] is False, r)
    check("dry run wrote nothing", before["updatedAt"] == after["updatedAt"] and after["note"] == before["note"] and len(after["items"]) == 3, after)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "dry_run": True, "set": {"items": [{"label": "x", "qty": "NaN"}]}, "force": True})
    check("dry run reports Strapi validation errors", err and r["error"]["code"] == "invalid", r)


@T
def t_idempotency():
    doc = common.create_page_mcp("tp-idem")
    key = "idem-" + doc
    a = {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "items", "data": {"label": "once", "qty": 1}}], "idempotency_key": key}
    e1, r1, _ = ws("ws_patch", a)
    e2, r2, _ = ws("ws_patch", a)
    items = common.rest_get(RA, doc)["items"]
    check("retry with same key replays the receipt", not e1 and not e2 and r2.get("replayed") is True and r2["version"] == r1["version"], [r1, r2])
    check("retry did not add the row twice", sum(i["label"] == "once" for i in items) == 1, items)
    b = dict(a); b["ops"] = [{"op": "add", "field": "items", "data": {"label": "other", "qty": 1}}]
    e3, r3, _ = ws("ws_patch", b)
    check("same key with a different request -> idempotency_key_reused", e3 and r3["error"]["code"] == "idempotency_key_reused", r3)
    other = common.create_page_mcp("tp-idem-other")
    c = dict(a); c["documentId"] = other
    e4, r4, _ = ws("ws_patch", c)
    check("same key on another document is a new request, not a collision", not e4 and not r4.get("replayed"), r4)
    # concurrent duplicates
    doc2 = common.create_page_mcp("tp-idem2")
    a2 = dict(a); a2["documentId"] = doc2; a2["idempotency_key"] = "idem-c-" + doc2
    out = []
    bar = threading.Barrier(4)
    def run():
        bar.wait(); out.append(ws("ws_patch", a2))
    ts = [threading.Thread(target=run) for _ in range(4)]; [t.start() for t in ts]; [t.join() for t in ts]
    items2 = common.rest_get(RA, doc2)["items"]
    check("4 concurrent duplicates write once", sum(i["label"] == "once" for i in items2) == 1 and all(not o[0] for o in out), [o[1] for o in out])


@T
def t_batch():
    d1, d2 = common.create_page_mcp("tp-b1"), common.create_page_mcp("tp-b2")
    g1, g2 = get(d1), get(d2)
    err, r, n = ws("ws_batch", vb({"items": [
        {"ref": "one", "uid": UID, "documentId": d1, "expected_version": g1["version"], "set": {"note": "b1"}},
        {"ref": "two", "uid": UID, "documentId": d2, "ops": [{"op": "add", "field": "sections", "component": "blocks.cta", "data": {"label": "go", "url": "https://example.test"}}]},
    ], "idempotency_key": "batch-ok-" + d1}))
    check("batch commits all items", not err and r["committed"] and [i["status"] for i in r["items"]] == ["ok", "ok"], r)
    g1b = get(d1)
    common.rest_put(RB, d2, {"note": "colleague"})
    err, r, n = ws("ws_batch", vb({"items": [
        {"ref": "one", "uid": UID, "documentId": d1, "expected_version": g1b["version"], "set": {"note": "SHOULD-ROLL-BACK"}},
        {"ref": "two", "uid": UID, "documentId": d2, "expected_version": g2["version"], "set": {"note": "stale"}},
        {"ref": "three", "uid": UID, "documentId": d1, "set": {"summary": "never"}},
    ]}))
    st = [i["status"] for i in (r or {}).get("items", [])]
    check("batch with a stale item is refused as a whole", err and r["committed"] is False and st == ["rolled_back", "failed", "not_attempted"], r)
    check("failed item carries version_conflict", r["items"][1]["error"]["code"] == "version_conflict", r["items"][1])
    check("first item rolled back in the DB", common.rest_get(RA, d1)["note"] == "b1")
    err, r, _ = ws("ws_batch", vb({"dry_run": True, "items": [
        {"uid": UID, "documentId": d1, "set": {"note": "dry1"}}, {"uid": UID, "documentId": d2, "set": {"note": "dry2"}}]}))
    check("batch dry run validates all and writes nothing", not err and r["dry_run"] and all(i["status"] == "valid" for i in r["items"]) and common.rest_get(RA, d1)["note"] == "b1", r)


@T
def t_publish():
    doc = common.create_page_mcp("tp-pub")
    g = get(doc)
    common.rest_put(RB, doc, {"summary": "unreviewed"})
    err, r, _ = ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g["version"]})
    s, b, _ = spike.rest(RA, "GET", "/api/pages/%s?status=published" % doc)
    check("publish of a changed draft refused", err and r["error"]["code"] == "version_conflict" and s == 404, [r, s])
    g2 = get(doc)
    err, r, _ = ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g2["version"]})
    s, b, _ = spike.rest(RA, "GET", "/api/pages/%s?status=published" % doc)
    check("publish of the reviewed draft ok", not err and s == 200 and b["data"]["summary"] == "unreviewed", r)


@T
def t_rbac():
    if "agent-ro" not in spike.TOK["admin"]:
        check("rbac tokens present (run scripts/setup_restricted_tokens.mjs)", False); return
    s, b, raw = spike.rpc("agent-ro", "tools/list")
    names = [t["name"] for t in b["result"]["tools"]]
    check("read-only token sees ws_get but no write tools", "ws_get" in names and not any(n in names for n in ("ws_patch", "ws_batch", "ws_publish")), names)
    err, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": "x", "set": {"note": "a"}}), "agent-ro")
    check("read-only token cannot call ws_patch", err, r)
    doc = common.create_page_mcp("tp-rbac")
    err, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"note": "forbidden", "summary": "allowed"}}), "agent-nonote")
    check("field-level restriction refuses the write as a whole (forbidden), no silent drop", err and r["error"]["code"] == "forbidden" and "note" in r["error"]["message"], r)
    check("nothing written when a field is forbidden", common.rest_get(RA, doc)["summary"] == "s")
    err, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"summary": "allowed"}}), "agent-nonote")
    check("allowed field writes", not err and common.rest_get(RA, doc)["summary"] == "allowed", r)


# ---------------------------------------------------------------- 0.2: replies hide fields the token cannot read
# agent-noread (scripts/setup_hardening.mjs) can update every page field but cannot READ `note`,
# `seo.metaDescription` or `items`.
NR = "agent-noread"


def _canon(v):
    """Python copy of model.js canonical() (ASCII content only)."""
    if isinstance(v, list):
        return "[" + ",".join(_canon(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k) + ":" + _canon(v[k]) for k in sorted(v)) + "}"
    return json.dumps(v, ensure_ascii=False)


def _raw_from_view(data):
    """Rebuild the raw draft (component ids instead of _key) from a ws_get view, as a token holder could."""
    def row(r):
        if not isinstance(r, dict) or "_key" not in r:
            return r
        o = {k: v for k, v in r.items() if k != "_key"}
        o["id"] = int(r["_key"].split(":")[1])   # "<component>:<id>:<mac>" since 1.0 hardening item 16b
        return o
    out = {}
    for k, v in data.items():
        out[k] = [row(x) for x in v] if isinstance(v, list) else row(v)
    return out


def _hash12(doc):
    return hashlib.sha256(_canon(doc).encode()).hexdigest()[:12]


@T
def t_hidden_fields():
    if NR not in spike.TOK["admin"]:
        check("agent-noread token present (run scripts/setup_hardening.mjs)", False); return
    doc = common.create_page_mcp("tp-hidden")
    common.rest_put(RB, doc, {"note": "SECRET-NOTE-1", "seo": {**{k: v for k, v in common.rest_get(RB, doc)["seo"].items()}, "metaDescription": "SECRET-META-1"}})
    g = ws("ws_get", {"uid": UID, "documentId": doc}, NR)[1]
    d = g["data"]
    check("ws_get hides an unreadable scalar (note)", "note" not in d and "SECRET" not in json.dumps(g), d)
    check("ws_get hides an unreadable component field (seo.metaDescription) and keeps the readable one",
          "metaDescription" not in (d.get("seo") or {}) and d.get("seo", {}).get("metaTitle") == "meta", d.get("seo"))
    check("ws_get omits an unreadable list field instead of showing it empty", "items" not in d and "items" not in g["rows"],
          {"items": d.get("items"), "rows": g["rows"].get("items")})
    # stale write on the hidden field itself
    common.rest_put(RB, doc, {"note": "SECRET-NOTE-2"})
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"note": "agent"}}, NR)
    e = (r or {}).get("error", {})
    check("noread: stale write is still refused (version_conflict)", err and e.get("code") == "version_conflict", r)
    check("conflict reply on a hidden field does not carry its value", "note" not in e.get("current", {}) and "SECRET" not in json.dumps(r), e.get("current"))
    check("nothing written on that conflict", common.rest_get(RA, doc)["note"] == "SECRET-NOTE-2")
    # stale write touching a component with a hidden sub-field, and a hidden list
    g = ws("ws_get", {"uid": UID, "documentId": doc}, NR)[1]
    common.rest_put(RB, doc, {"summary": "colleague"})
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"],
                                "set": {"seo": {"metaTitle": "agent"}, "summary": "agent"},
                                "ops": [{"op": "add", "field": "items", "data": {"label": "agent", "qty": 1}}]}, NR)
    e = (r or {}).get("error", {})
    check("conflict on seo+items: current shows readable values only",
          err and e.get("code") == "version_conflict" and e["current"].get("summary") == "colleague"
          and "metaDescription" not in (e["current"].get("seo") or {}) and "items" not in e["current"] and "items" not in e.get("current_rows", {})
          and "SECRET" not in json.dumps(r), e)
    # return: full
    err, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"summary": "agent-full"}, "return": "full"}), NR)
    check("return full hides unreadable fields", not err and "note" not in r["document"] and "items" not in r["document"]
          and "SECRET" not in json.dumps(r), r)
    # batch item conflict and publish conflict
    g = ws("ws_get", {"uid": UID, "documentId": doc}, NR)[1]
    common.rest_put(RB, doc, {"note": "SECRET-NOTE-3"})
    err, r, _ = ws("ws_batch", vb({"items": [{"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"note": "b"}}]}), NR)
    check("batch conflict item hides unreadable fields", err and r["items"][0]["error"]["code"] == "version_conflict" and "SECRET" not in json.dumps(r), r)
    err, r, _ = ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g["version"]}, NR)
    check("publish conflict hides unreadable fields", err and r["error"]["code"] == "version_conflict" and "SECRET" not in json.dumps(r)
          and "note" not in r["error"]["current"], r)
    # the full-read token still sees them (control)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"note": "a"}})
    check("control: a full-read token's conflict reply carries the hidden field", err and r["error"]["current"].get("note") == "SECRET-NOTE-3", r)


@T
def t_hidden_version_oracle():
    """The version token must not let a token test guesses for a field it cannot read (offline hash oracle)."""
    if NR not in spike.TOK["admin"]:
        return
    doc = common.create_page_mcp("tp-oracle", n_items=0)
    common.rest_put(RB, doc, {"note": "approved"})
    full = get(doc)
    g = ws("ws_get", {"uid": UID, "documentId": doc}, NR)[1]
    target = g["version"].split(".", 1)[1]   # v2 token: "v2.<mac>" (1.0 hardening item 15)
    raw = _raw_from_view(g["data"])
    raw["seo"]["metaDescription"] = None
    raw["items"] = []
    plain = lambda d: base64.urlsafe_b64encode(hashlib.sha256(_canon(d).encode()).digest()).decode().rstrip("=")
    hits = [c for c in ["approved", "rejected", "pending", "n0", None] if target in (_hash12({**raw, "note": c}), plain({**raw, "note": c}))]
    check("version hash cannot be recomputed from readable data plus a guess of a hidden field", not hits,
          {"matching_guesses": hits})
    check("version is the same for every token (one document version)", full["version"] == g["version"], [full["version"], g["version"]])


# ---------------------------------------------------------------- 0.2: i18n (api::guide.guide is localized; en default, fr added)
GUID = "api::guide.guide"


def guide_data(title, tag):
    return {"title": title, "note": "note-" + tag, "code": "C1",
            "items": [{"label": "%s item %d" % (tag, i), "qty": i + 1} for i in range(2)],
            "sections": [{"__component": "blocks.text", "body": "%s text" % tag}, {"__component": "blocks.hero", "heading": "%s hero" % tag}]}


def create_guide(title, locales=("en", "fr")):
    s, b, _ = spike.rest(RA, "POST", "/api/guides?status=draft&locale=" + locales[0], {"data": guide_data(title, locales[0])})
    if s not in (200, 201):
        raise RuntimeError((s, b))
    doc = b["data"]["documentId"]
    for loc in locales[1:]:
        s, b, _ = spike.rest(RA, "PUT", "/api/guides/%s?status=draft&locale=%s" % (doc, loc), {"data": guide_data(title + " " + loc, loc)})
        if s != 200:
            raise RuntimeError((s, b))
    return doc


def guide_rest(doc, loc, status="draft"):
    s, b, _ = spike.rest(RA, "GET", "/api/guides/%s?populate=*&status=%s&locale=%s" % (doc, status, loc))
    return b["data"] if s == 200 else None


def gget(doc, loc=None, who=A, uid=GUID):
    a = {"uid": uid, "documentId": doc}
    if loc:
        a["locale"] = loc
    return ws("ws_get", a, who)[1]


@T
def t_i18n_versions_per_locale():
    doc = create_guide("tg-ver")
    en, fr = gget(doc, "en"), gget(doc, "fr")
    check("ws_get per locale: locale echoed and versions differ", en["locale"] == "en" and fr["locale"] == "fr" and en["version"] != fr["version"]
          and fr["data"]["note"] == "note-fr", [en.get("locale"), fr.get("locale"), fr["data"].get("note")])
    d = gget(doc)
    check("no locale = the default locale (en)", d["locale"] == "en" and d["version"] == en["version"], d.get("locale"))
    # colleague edits fr only
    spike.rest(RB, "PUT", "/api/guides/%s?status=draft&locale=fr" % doc, {"data": {"note": "colleague-fr"}})
    err, r, _ = ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "en", "expected_version": en["version"], "set": {"note": "agent-en"}})
    check("a change in fr does not make an en write stale", not err and r["locale"] == "en", r)
    err, r, _ = ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "fr", "expected_version": fr["version"], "set": {"note": "agent-fr"}})
    e = (r or {}).get("error", {})
    fr_now = gget(doc, "fr")
    check("stale fr write refused with version_conflict", err and e.get("code") == "version_conflict", r)
    check("conflict names locale fr and carries fr's current version and value",
          e.get("locale") == "fr" and e.get("current_version") == fr_now["version"] and e.get("current", {}).get("note") == "colleague-fr", e)
    check("nothing written to fr; en has the agent's value", guide_rest(doc, "fr")["note"] == "colleague-fr" and guide_rest(doc, "en")["note"] == "agent-en")
    en2 = gget(doc, "en")
    err, r, _ = ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "fr", "expected_version": en2["version"], "set": {"note": "x"}})
    check("an en version is not accepted for fr", err and r["error"]["code"] == "version_conflict", r)
    err, r, _ = ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "fr", "expected_version": e["current_version"], "set": {"note": "agent-fr"}})
    check("retry with fr's current_version lands", not err and guide_rest(doc, "fr")["note"] == "agent-fr", r)


@T
def t_i18n_shared_field():
    """`code` is not localized: Strapi copies it to every locale, so a write to it in one locale changes the others."""
    doc = create_guide("tg-shared")
    fr = gget(doc, "fr")
    spike.rest(RB, "PUT", "/api/guides/%s?status=draft&locale=en" % doc, {"data": {"code": "C2"}})
    fr2 = gget(doc, "fr")
    check("non-localized field copied to fr by Strapi", fr2["data"]["code"] == "C2", fr2["data"].get("code"))
    err, r, _ = ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "fr", "expected_version": fr["version"], "set": {"code": "C-agent"}})
    check("fr write from before the shared-field change is refused", err and r["error"]["code"] == "version_conflict" and r["error"]["current"]["code"] == "C2", r)


@T
def t_i18n_row_ops():
    doc = create_guide("tg-ops")
    en0, fr = gget(doc, "en"), gget(doc, "fr")
    cur = guide_rest(doc, "fr")
    spike.rest(RB, "PUT", "/api/guides/%s?status=draft&locale=fr" % doc,
               {"data": {"sections": cur["sections"] + [{"__component": "blocks.cta", "label": "COLLEAGUE-FR", "url": "https://example.test"}]}})
    ks = fr["rows"]["sections"]
    err, r, _ = ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "fr", "ops": [
        {"op": "update", "field": "sections", "key": ks[0], "data": {"body": "AGENT-FR"}},
        {"op": "add", "field": "sections", "component": "blocks.hero", "data": {"heading": "NEW-FR"}, "position": "start"},
        {"op": "remove", "field": "sections", "key": ks[1]},
        {"op": "update", "field": "items", "key": fr["rows"]["items"][0], "data": {"qty": 99}},
    ]})
    v = guide_rest(doc, "fr")
    secs = json.dumps(v["sections"])
    check("row ops on fr's dynamic zone ok", not err and r["locale"] == "fr", r)
    check("fr: colleague's row kept, agent's edits in", "COLLEAGUE-FR" in secs and "AGENT-FR" in secs and "NEW-FR" in secs and "fr hero" not in secs, v["sections"])
    check("fr: row ids kept for untouched and updated rows", all(k in ident(gget(doc, "fr")["rows"]["sections"]) for k in ident([ks[0]])) and v["items"][0]["qty"] == 99, v["items"])
    en1 = gget(doc, "en")
    check("en untouched by fr row ops (same version, same rows)", en1["version"] == en0["version"] and en1["rows"] == en0["rows"], [en0["rows"], en1["rows"]])
    err, r, _ = ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "en", "ops": [{"op": "update", "field": "sections", "key": ks[0], "data": {"body": "x"}}]})
    check("a fr row key is not found in en (row_not_found with en's keys)", err and r["error"]["code"] == "row_not_found" and r["error"]["current_keys"] == ident(en1["rows"]["sections"]), r)   # identities, no MAC (review finding 1)


@T
def t_i18n_edges():
    doc = create_guide("tg-edge", locales=("en",))
    err, r, _ = ws("ws_patch", vv({"uid": GUID, "documentId": doc, "locale": "fr", "set": {"note": "x"}}))
    check("write to a locale the document does not have -> not_found, and no locale is created",
          err and r["error"]["code"] == "not_found" and r["error"].get("locale") == "fr" and guide_rest(doc, "fr") is None, r)
    err, r, _ = ws("ws_patch", vv({"uid": GUID, "documentId": doc, "locale": "xx", "set": {"note": "x"}}))
    check("unknown locale code -> invalid, listing the locales", err and r["error"]["code"] == "invalid" and "fr" in r["error"]["message"], r)
    pdoc = common.create_page_mcp("tp-locale")
    err, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": pdoc, "locale": "fr", "set": {"note": "x"}}))
    check("locale on a non-localized type -> invalid (not silently ignored)", err and r["error"]["code"] == "invalid", r)
    err, r, _ = ws("ws_get", {"uid": GUID, "documentId": doc, "locale": "fr"})
    check("ws_get of a missing locale -> not_found", err and r["error"]["code"] == "not_found", r)


@T
def t_i18n_publish_and_batch():
    doc = create_guide("tg-pub")
    fr, en = gget(doc, "fr"), gget(doc, "en")
    err, r, _ = ws("ws_publish", {"uid": GUID, "documentId": doc, "locale": "fr", "expected_version": fr["version"]})
    check("publish fr only", not err and r["locale"] == "fr" and guide_rest(doc, "fr", "published") is not None and guide_rest(doc, "en", "published") is None, r)
    spike.rest(RB, "PUT", "/api/guides/%s?status=draft&locale=en" % doc, {"data": {"note": "unreviewed-en"}})
    err, r, _ = ws("ws_batch", vb({"items": [
        {"uid": GUID, "documentId": doc, "locale": "fr", "set": {"note": "batch-fr"}},
        {"action": "publish", "uid": GUID, "documentId": doc, "locale": "en", "expected_version": en["version"]}]}))
    check("batch: stale en publish rolls back the fr patch", err and [i["status"] for i in r["items"]] == ["rolled_back", "failed"]
          and r["items"][1]["error"].get("locale") == "en" and guide_rest(doc, "fr")["note"] == "note-fr", r)
    key = "same-key-" + doc
    e1, r1, _ = ws("ws_patch", vv({"uid": GUID, "documentId": doc, "locale": "en", "set": {"summary": "x"} if False else {"note": "k"}, "idempotency_key": key}))
    e2, r2, _ = ws("ws_patch", vv({"uid": GUID, "documentId": doc, "locale": "fr", "set": {"note": "k"}, "idempotency_key": key}))
    check("idempotency key scoped per locale: same key on en and fr both write", not e1 and not e2 and not r2.get("replayed")
          and guide_rest(doc, "fr")["note"] == "k", [r1, r2])


# ---------------------------------------------------------------- 0.2: single types (api::homepage.homepage)
HUID = "api::homepage.homepage"


def home_rest(status="draft"):
    s, b, _ = spike.rest(RA, "GET", "/api/homepage?populate=*&status=" + status)
    return b["data"] if s == 200 else None


def home_reset():
    spike.rest(RA, "DELETE", "/api/homepage")
    s, b, _ = spike.rest(RA, "PUT", "/api/homepage?status=draft", {"data": {
        "title": "Home", "note": "n0", "items": [{"label": "h%d" % i, "qty": i} for i in range(3)],
        "sections": [{"__component": "blocks.text", "body": "home text"}, {"__component": "blocks.hero", "heading": "home hero"}]}})
    if s != 200:
        raise RuntimeError((s, b))
    return b["data"]["documentId"]


@T
def t_single_type():
    s, b, _ = spike.rpc(A, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    check("catalog: ws_* accept the single type uid", all(HUID in json.dumps(tools[n]["inputSchema"]) for n in ("ws_get", "ws_patch", "ws_publish", "ws_batch")))
    spike.rest(RA, "DELETE", "/api/homepage")
    err, r, _ = ws("ws_get", {"uid": HUID})
    check("single type with no content -> not_found with a hint", err and r["error"]["code"] == "not_found" and "write_homepage" in r["error"]["message"], r)
    err, r, _ = ws("ws_patch", vv({"uid": HUID, "set": {"note": "x"}}))
    check("ws_patch does not create a single type", err and r["error"]["code"] == "not_found" and home_rest() is None, r)
    doc = home_reset()
    g = ws("ws_get", {"uid": HUID})[1]
    check("ws_get without documentId reads the single type", g["documentId"] == doc and g["version"].startswith("v2.") and len(g["rows"]["sections"]) == 2, g)
    check("ws_get with its documentId gives the same version", gget(doc, uid=HUID)["version"] == g["version"])
    err, r, _ = ws("ws_get", {"uid": HUID, "documentId": "not-the-one"})
    check("ws_get with another documentId -> not_found", err and r["error"]["code"] == "not_found", r)
    err, r, _ = ws("ws_patch", {"uid": HUID, "expected_version": g["version"], "set": {"note": "agent"}})
    check("ws_patch on a single type with expected_version", not err and r["documentId"] == doc and home_rest()["note"] == "agent", r)
    # stale write and conflict
    spike.rest(RB, "PUT", "/api/homepage?status=draft", {"data": {"note": "colleague"}})
    err, r, _ = ws("ws_patch", {"uid": HUID, "expected_version": g["version"], "set": {"note": "stale"}})
    check("stale single-type write refused with the current value", err and r["error"]["code"] == "version_conflict" and r["error"]["current"]["note"] == "colleague"
          and home_rest()["note"] == "colleague", r)
    # row ops keep a colleague's row
    g = ws("ws_get", {"uid": HUID})[1]
    cur = home_rest()
    spike.rest(RB, "PUT", "/api/homepage?status=draft", {"data": {"sections": cur["sections"] + [{"__component": "blocks.cta", "label": "COLLEAGUE", "url": "https://example.test"}]}})
    err, r, _ = ws("ws_patch", {"uid": HUID, "ops": [{"op": "update", "field": "sections", "key": g["rows"]["sections"][1], "data": {"heading": "AGENT"}},
                                                     {"op": "remove", "field": "items", "key": g["rows"]["items"][0]}]})
    secs = json.dumps(home_rest()["sections"])
    check("single type row ops keep the colleague's row", not err and "COLLEAGUE" in secs and "AGENT" in secs and len(home_rest()["items"]) == 2, r)
    err, r, _ = ws("ws_patch", {"uid": HUID, "set": {"sections": []}})
    check("single type whole-list set without expected_version -> precondition_required", err and r["error"]["code"] == "precondition_required", r)
    err, r, _ = ws("ws_patch", vv({"uid": UID, "set": {"note": "x"}}))
    check("collection type without documentId -> invalid", err and r["error"]["code"] == "invalid" and "documentId" in r["error"]["message"], r)


@T
def t_single_type_batch_and_publish():
    doc = home_reset()
    pdoc = common.create_page_mcp("tp-single-batch")
    g, gp = ws("ws_get", {"uid": HUID})[1], get(pdoc)
    err, r, _ = ws("ws_batch", vb({"items": [
        {"ref": "home", "uid": HUID, "expected_version": g["version"], "set": {"note": "batch-home"}},
        {"ref": "page", "uid": UID, "documentId": pdoc, "expected_version": gp["version"], "set": {"note": "batch-page"}}]}))
    check("batch across a single type and a collection type commits", not err and r["committed"] and home_rest()["note"] == "batch-home", r)
    g2 = ws("ws_get", {"uid": HUID})[1]
    err, r, _ = ws("ws_batch", vb({"items": [
        {"ref": "page", "uid": UID, "documentId": pdoc, "set": {"note": "never"}},
        {"ref": "home", "uid": HUID, "expected_version": g["version"], "set": {"note": "stale"}}]}))
    check("batch with a stale single-type item rolls back all", err and [i["status"] for i in r["items"]] == ["rolled_back", "failed"]
          and common.rest_get(RA, pdoc)["note"] == "batch-page", r)
    spike.rest(RB, "PUT", "/api/homepage?status=draft", {"data": {"title": "Home (unreviewed)"}})
    err, r, _ = ws("ws_publish", {"uid": HUID, "expected_version": g2["version"]})
    check("single type: publish of a changed draft refused", err and r["error"]["code"] == "version_conflict" and home_rest("published") is None, r)
    g3 = ws("ws_get", {"uid": HUID})[1]
    err, r, _ = ws("ws_publish", {"uid": HUID, "expected_version": g3["version"]})
    pub = home_rest("published")
    check("single type: publish of the reviewed draft", not err and r["documentId"] == doc and pub and pub["title"] == "Home (unreviewed)", r)


# ---------------------------------------------------------------- 0.2: relations inside components
# page.credits: repeatable shared.credit {role, author (manyToOne author), reviewers (manyToMany author)};
# page.sections can hold blocks.quote {text, author (manyToOne author)}.
DEEP = ("populate[credits][populate]=*&populate[sections][on][blocks.quote][populate]=*&populate[sections][on][blocks.text]=true"
        "&populate[sections][on][blocks.hero]=true&populate[sections][on][blocks.cta]=true")


def author(name):
    s, b, _ = spike.rest(RA, "POST", "/api/authors", {"data": {"name": name}})
    if s not in (200, 201):
        raise RuntimeError((s, b))
    return b["data"]["documentId"]


def rel_view(doc):
    """REST read of credits and quote relations: [(role, author documentId, sorted reviewer documentIds)], [(text, author)]."""
    s, b, _ = spike.rest(RA, "GET", "/api/pages/%s?status=draft&%s" % (doc, DEEP))
    d = b["data"]
    cr = [(c["role"], (c.get("author") or {}).get("documentId"), sorted(x["documentId"] for x in c.get("reviewers") or [])) for c in d["credits"]]
    qs = [(q["text"], (q.get("author") or {}).get("documentId")) for q in d["sections"] if q["__component"] == "blocks.quote"]
    return cr, qs, d


def create_rel_page(title, a1, a2, a3):
    data = common.page_data(title)
    data["credits"] = [{"role": "writer", "author": a1, "reviewers": [a2, a3]}, {"role": "editor", "author": a2, "reviewers": []}]
    data["sections"] = data["sections"] + [{"__component": "blocks.quote", "text": "q1", "author": a1}]
    s, b, _ = spike.rest(RA, "POST", "/api/pages?status=draft", {"data": data})
    if s not in (200, 201):
        raise RuntimeError((s, b))
    return b["data"]["documentId"]


@T
def t_relations_in_components():
    a1, a2, a3 = author("Ann"), author("Ben"), author("Cat")
    doc = create_rel_page("tp-rel", a1, a2, a3)
    cr0, qs0, _ = rel_view(doc)
    check("fixture: relations stored in components", cr0 == [("writer", a1, sorted([a2, a3])), ("editor", a2, [])] and qs0 == [("q1", a1)], [cr0, qs0])
    g = get(doc)
    c = g["data"]["credits"]
    check("ws_get shows component relations as documentIds", c[0]["author"] == a1 and sorted(c[0]["reviewers"]) == sorted([a2, a3])
          and [x for x in g["data"]["sections"] if x["__component"] == "blocks.quote"][0]["author"] == a1, c)
    ids0 = [k for k in g["rows"]["credits"]]
    # row op on ANOTHER row of the same zone and on a credits scalar: every relation kept, ids kept
    hero = [k for k in g["rows"]["sections"] if k.startswith("blocks.hero:")][0]
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [
        {"op": "update", "field": "sections", "key": hero, "data": {"heading": "AGENT"}},
        {"op": "update", "field": "credits", "key": ids0[0], "data": {"role": "lead writer"}}]})
    cr, qs, _ = rel_view(doc)
    check("row ops next to relation rows are accepted", not err, r)
    check("row ops keep every relation (credits author/reviewers, quote author)",
          cr == [("lead writer", a1, sorted([a2, a3])), ("editor", a2, [])] and qs == [("q1", a1)], [cr, qs])
    check("row ops keep the credits row ids", ident(get(doc)["rows"]["credits"]) == ident(ids0), [ids0, get(doc)["rows"]["credits"]])
    # 1.0 hardening item 16b: row 0 changed (role), so its key changed; row 1's did not
    ids1 = get(doc)["rows"]["credits"]
    check("16b: the edited row has a new key, the untouched row keeps its key", ids1[0] != ids0[0] and ids1[1] == ids0[1] and r["rows"]["credits"]["rekeyed"] == {ids0[0]: ids1[0]}, [ids0, ids1, r])
    # change relations by row op: author (to-one) and reviewers (to-many), add a row with relations. Replacing a to-many
    # relation inside a row needs expected_version since 1.0 hardening item 20 (nested lists; ref ops need none).
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "credits", "key": ids1[0], "data": {"reviewers": [a2]}}]})
    e_ = (r or {}).get("error", {}) if isinstance(r, dict) else {}
    check("an update op replacing a nested to-many relation without expected_version: precondition_required", err and e_.get("code") == "precondition_required"
          and "credits.reviewers" in e_.get("fields", []), r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": get(doc)["version"], "ops": [
        {"op": "update", "field": "credits", "key": ids1[1], "data": {"author": a3, "reviewers": [a1]}},
        {"op": "add", "field": "credits", "data": {"role": "photos", "author": a2, "reviewers": [a1, a3]}},
        {"op": "update", "field": "credits", "key": ids1[0], "data": {"reviewers": [a2]}}]})
    cr, qs, _ = rel_view(doc)
    check("row ops set to-one and to-many relations, and add a row with relations", not err and cr == [
        ("lead writer", a1, [a2]), ("editor", a3, [a1]), ("photos", a2, sorted([a1, a3]))], [r, cr])
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "credits", "key": r["rows"]["credits"]["rekeyed"][ids1[1]], "data": {"author": None}}]})
    cr, _, _ = rel_view(doc)
    check("null clears a to-one relation in a row", not err and cr[1] == ("editor", None, [a1]), [r, cr])


@T
def t_relations_stale_and_invalid():
    a1, a2, a3 = author("Dee"), author("Eve"), author("Fay")
    doc = create_rel_page("tp-rel-stale", a1, a2, a3)
    g = get(doc)
    k0 = g["rows"]["credits"][0]
    # colleague changes row 0's author through REST (component ids sent, so the row is kept)
    _, _, d = rel_view(doc)
    credits = [{"id": c["id"], "role": c["role"], "author": (c["author"] or {}).get("documentId"), "reviewers": [x["documentId"] for x in c["reviewers"]]} for c in d["credits"]]
    credits[0]["author"] = a3
    s, b, _ = common.rest_put(RB, doc, {"credits": credits})
    cr, _, _ = rel_view(doc)
    check("fixture: colleague changed row 0's author", s == 200 and cr[0][1] == a3, [s, cr])
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"],
                                "ops": [{"op": "update", "field": "credits", "key": k0, "data": {"author": a2}}]})
    e = (r or {}).get("error", {})
    check("stale write to a relation in a component refused (version_conflict)", err and e.get("code") == "version_conflict", r)
    check("conflict carries the colleague's relation value", (e.get("current", {}).get("credits") or [{}])[0].get("author") == a3, e.get("current"))
    check("nothing written on that conflict", rel_view(doc)[0][0][1] == a3)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"],
                                "set": {"credits": [{**x, "author": a2} for x in g["data"]["credits"]]}})
    check("stale whole-list set of a relation-holding list refused", err and r["error"]["code"] == "version_conflict" and rel_view(doc)[0][0][1] == a3, r)
    # no expected_version, the key read before the colleague's change: refused since 1.0 hardening item 16b (the key is
    # bound to the row's content, so it no longer matches row 0)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "credits", "key": k0, "data": {"role": "agent-role"}}]})
    check("16b: a row op with the key read before a colleague changed that row: stale_row_key, nothing written",
          err and r["error"]["code"] == "stale_row_key" and r["error"]["requires_reread"] is True and rel_view(doc)[0][0][0] != "agent-role", r)
    # after a re-read: a row op on another field of that row merges into the current row and keeps the relation
    k0 = get(doc)["rows"]["credits"][0]
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "credits", "key": k0, "data": {"role": "agent-role"}}]})
    cr, _, _ = rel_view(doc)
    check("row op without a version keeps the colleague's relation on that row", not err and cr[0] == ("agent-role", a3, sorted([a2, a3])), [r, cr])
    k0 = get(doc)["rows"]["credits"][0]
    # invalid relation values are refused, never dropped
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "credits", "key": k0, "data": {"author": "doesnotexist000000000000"}}]})
    check("relation to a missing document -> invalid, nothing written", err and r["error"]["code"] == "invalid" and rel_view(doc)[0][0][1] == a3, r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "credits", "key": k0, "data": {"author": {"connect": [a1]}}}]})
    check("relation given as an object -> invalid (documentId strings only)", err and r["error"]["code"] == "invalid", r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "credits", "key": k0, "data": {"reviewers": a1}}]})
    check("to-many relation given as a string -> invalid (list expected)", err and r["error"]["code"] == "invalid", r)
    g2 = get(doc)
    rows = [dict(x) for x in g2["data"]["credits"]]
    rows[1]["role"] = "set-role"
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g2["version"], "set": {"credits": rows}})
    cr2, _, _ = rel_view(doc)
    check("whole-list set with _key rows keeps their relations and ids", not err and cr2 == [cr[0], ("set-role", cr[1][1], cr[1][2])]
          and ident(get(doc)["rows"]["credits"]) == ident(g2["rows"]["credits"]), [r, cr, cr2])



@T
def t_relations_field_permission():
    """agent-noauthor may update pages but not credits.author: a change to it is refused, never dropped."""
    if "agent-noauthor" not in spike.TOK["admin"]:
        check("agent-noauthor token present (run scripts/setup_hardening.mjs)", False); return
    NA = "agent-noauthor"
    a1, a2, a3 = author("Gil"), author("Hal"), author("Ivy")
    doc = create_rel_page("tp-rel-perm", a1, a2, a3)
    g = get(doc)
    k = g["rows"]["credits"]
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "credits", "key": k[1], "data": {"author": a3}}]}, NA)
    check("restricted relation inside a component: change refused (forbidden), not silently dropped",
          err and r["error"]["code"] == "forbidden" and "credits.author" in r["error"]["message"] and rel_view(doc)[0][1][1] == a2, r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "credits", "data": {"role": "new", "author": a3}}]}, NA)
    check("restricted relation in an added row: refused", err and r["error"]["code"] == "forbidden" and len(rel_view(doc)[0]) == 2, r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "credits", "key": k[0], "data": {"role": "r2", "author": a1}}]}, NA)
    check("re-sending the unchanged restricted value is allowed and keeps it", not err and rel_view(doc)[0][0][:2] == ("r2", a1), r)
    rows = [dict(x) for x in get(doc)["data"]["credits"]]
    rows[0]["role"] = "set-role"
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": get(doc)["version"], "set": {"credits": rows}}, NA)
    cr = rel_view(doc)[0]
    check("whole-list set echoing unchanged relations is allowed; relations kept", not err and cr[0][:2] == ("set-role", a1) and cr[1][1] == a2, [r, cr])
    rows = [dict(x) for x in get(doc)["data"]["credits"]]   # row 0 changed above, so its key did (1.0 hardening item 16b)
    rows[1]["author"] = a1
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": get(doc)["version"], "set": {"credits": rows}}, NA)
    check("whole-list set changing a restricted relation: refused", err and r["error"]["code"] == "forbidden" and rel_view(doc)[0][1][1] == a2, r)


# ---------------------------------------------------------------- 0.2: draft & publish, publish only what was reviewed
def published(doc):
    s, b, _ = spike.rest(RA, "GET", "/api/pages/%s?populate=*&status=published" % doc)
    return b["data"] if s == 200 else None


@T
def t_publish_reviewed_only():
    doc = common.create_page_mcp("tp-pub2")
    g1 = get(doc)
    err, r, _ = ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g1["version"]})
    check("first publish of the reviewed draft", not err and r["published_version"] == g1["version"] and published(doc)["note"] == "n0", r)
    # the agent edits and reviews v2, then a colleague changes the draft before the agent publishes
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g1["version"], "set": {"note": "agent-v2"}})
    g2 = get(doc)
    cur = common.rest_get(RB, doc)
    common.rest_put(RB, doc, {"summary": "UNREVIEWED", "sections": cur["sections"] + [{"__component": "blocks.text", "body": "UNREVIEWED-BLOCK"}]})
    err, r, _ = ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g2["version"]})
    p = published(doc)
    check("publish after a colleague's draft change is refused", err and r["error"]["code"] == "version_conflict", r)
    check("refusal carries what changed (current summary)", r["error"]["current"].get("summary") == "UNREVIEWED", r["error"].get("current", {}).get("summary"))
    check("the live version is untouched: still v1, without the agent's or the colleague's change",
          p["note"] == "n0" and p["summary"] == "s" and "UNREVIEWED" not in json.dumps(p), p)
    g3 = get(doc)
    err, r, _ = ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g3["version"]})
    p = published(doc)
    check("after a new review the draft publishes; the live version equals what was reviewed",
          not err and r["published_version"] == g3["version"] and p["note"] == g3["data"]["note"] and p["summary"] == g3["data"]["summary"]
          and [x.get("body") or x.get("heading") or x.get("label") for x in p["sections"]] == [x.get("body") or x.get("heading") or x.get("label") for x in g3["data"]["sections"]], [r, p])
    err, r, _ = ws("ws_publish", {"uid": UID, "documentId": doc})
    check("ws_publish without expected_version is rejected by the schema", err, r)


def _publish_race(rounds, colleague):
    """Agent publishes its reviewed version while the colleague writes the draft at the same moment."""
    out = {"published_reviewed": 0, "refused": 0, "published_unreviewed": 0, "other": []}
    for i in range(rounds):
        doc = common.create_page_mcp("tp-race-%d" % i)
        g = get(doc)
        res = {}
        bar = threading.Barrier(2)
        def agent():
            bar.wait(); res["a"] = ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g["version"]})
        def coll():
            bar.wait(); res["b"] = colleague(doc)
        ts = [threading.Thread(target=agent), threading.Thread(target=coll)]
        [t.start() for t in ts]; [t.join() for t in ts]
        err, r, _ = res["a"]
        p = published(doc)
        draft = common.rest_get(RA, doc)
        if not err and p and p["note"] == "n0" and draft["note"] == "RACE":
            out["published_reviewed"] += 1
        elif err and r["error"]["code"] == "version_conflict" and p is None and draft["note"] == "RACE":
            out["refused"] += 1
        elif not err and p and p["note"] == "RACE":
            out["published_unreviewed"] += 1
        else:
            out["other"].append([r, p and p["note"], draft["note"], res["b"][:2]])
    return out


@T
def t_publish_race():
    n = int(os.environ.get("RACE_ROUNDS", "10"))
    o = _publish_race(n, lambda doc: common.rest_put(RB, doc, {"note": "RACE"}))
    check("race with a REST writer: never publishes the unreviewed change (%d rounds)" % n,
          o["published_unreviewed"] == 0 and not o["other"] and o["published_reviewed"] + o["refused"] == n, o)
    print("   race REST:", {k: v for k, v in o.items() if k != "other"})
    o = _publish_race(n, lambda doc: ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"note": "RACE"}}), B))
    check("race with a plugin writer: never publishes the unreviewed change (%d rounds)" % n,
          o["published_unreviewed"] == 0 and not o["other"] and o["published_reviewed"] + o["refused"] == n, o)
    print("   race ws_patch:", {k: v for k, v in o.items() if k != "other"})


# ---------------------------------------------------------------- 0.2: idempotency keys under concurrency
def _concurrent(calls):
    """Run the given zero-arg callables at the same moment; returns their results in order."""
    out = [None] * len(calls)
    bar = threading.Barrier(len(calls))
    def run(i):
        bar.wait(); out[i] = calls[i]()
    ts = [threading.Thread(target=run, args=(i,)) for i in range(len(calls))]
    [t.start() for t in ts]; [t.join() for t in ts]
    return out


def _labels(doc, label):
    return sum(i["label"] == label for i in common.rest_get(RA, doc)["items"])


@T
def t_idem_concurrent_duplicates():
    rounds = int(os.environ.get("IDEM_ROUNDS", "5"))
    bad = []
    for i in range(rounds):
        doc = common.create_page_mcp("tp-idc-%d" % i)
        a = {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "items", "data": {"label": "once", "qty": 1}}], "idempotency_key": "dup-%s" % doc}
        res = _concurrent([lambda: ws("ws_patch", a)] * 4)
        fresh = [r for e, r, _ in res if not e and not r.get("replayed")]
        if _labels(doc, "once") != 1 or any(e for e, _, _ in res) or len(fresh) != 1 or len({r["version"] for _, r, _ in res}) != 1:
            bad.append([doc, _labels(doc, "once"), [r for _, r, _ in res]])
    check("ws_patch: %d rounds x 4 concurrent duplicates -> one write, one fresh receipt, 3 replays of it" % rounds, not bad, bad)
    d1, d2 = common.create_page_mcp("tp-idc-b1"), common.create_page_mcp("tp-idc-b2")
    b = {"items": [{"uid": UID, "documentId": d, "ops": [{"op": "add", "field": "items", "data": {"label": "batch-once", "qty": 1}}]} for d in (d1, d2)],
         "idempotency_key": "dup-batch-" + d1}
    res = _concurrent([lambda: ws("ws_batch", b)] * 4)
    check("ws_batch: 4 concurrent duplicates -> each document written once",
          _labels(d1, "batch-once") == 1 and _labels(d2, "batch-once") == 1 and not any(e for e, _, _ in res)
          and sum(not r.get("replayed") for _, r, _ in res) == 1, [r for _, r, _ in res])
    doc = common.create_page_mcp("tp-idc-pub")
    g = get(doc)
    pa = {"uid": UID, "documentId": doc, "expected_version": g["version"], "idempotency_key": "dup-pub-" + doc}
    res = _concurrent([lambda: ws("ws_publish", pa)] * 4)
    check("ws_publish: 4 concurrent duplicates -> one publish, 3 replays", not any(e for e, _, _ in res)
          and sum(not r.get("replayed") for _, r, _ in res) == 1 and published(doc) is not None, [r for _, r, _ in res])


@T
def t_idem_concurrent_conflicting():
    doc = common.create_page_mcp("tp-idc-diff")
    key = "same-key-diff-req-" + doc
    calls = [(lambda n=n: ws("ws_patch", {"uid": UID, "documentId": doc, "idempotency_key": key,
                                          "ops": [{"op": "add", "field": "items", "data": {"label": "diff-%d" % n, "qty": 1}}]})) for n in range(4)]
    res = _concurrent(calls)
    items = common.rest_get(RA, doc)["items"]
    landed = [x["label"] for x in items if x["label"].startswith("diff-")]
    codes = sorted((r["error"]["code"] if e else "ok") for e, r, _ in res)
    check("same key, 4 different requests at once -> exactly one lands; the others are refused, not written",
          len(landed) == 1 and codes.count("ok") == 1 and all(c in ("idempotency_key_reused", "in_progress") for c in codes if c != "ok"), [landed, codes])
    docs = [common.create_page_mcp("tp-idc-multi-%d" % n) for n in range(4)]
    res = _concurrent([(lambda d=d: ws("ws_patch", {"uid": UID, "documentId": d, "idempotency_key": "shared-readable-key",
                                                     "ops": [{"op": "add", "field": "items", "data": {"label": "multi", "qty": 1}}]})) for d in docs])
    check("same key on 4 documents at once -> 4 independent writes", all(_labels(d, "multi") == 1 for d in docs)
          and not any(e or r.get("replayed") for e, r, _ in res), [r for _, r, _ in res])


@T
def t_idem_scope_per_token():
    """agent-a and agent-b are two tokens of the same admin user (two agents). Their keys must not collide."""
    doc = common.create_page_mcp("tp-idc-tok")
    a = {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "items", "data": {"label": "per-token", "qty": 1}}], "idempotency_key": "add-volunteer-row"}
    res = _concurrent([lambda: ws("ws_patch", a, A), lambda: ws("ws_patch", a, B)])
    check("same key and request from two tokens of one user -> two writes, no replay across tokens",
          _labels(doc, "per-token") == 2 and not any(e or r.get("replayed") for e, r, _ in res), [_labels(doc, "per-token"), [r for _, r, _ in res]])
    e, r, _ = ws("ws_patch", a, A)
    check("...and each token still gets its own replay", not e and r.get("replayed") is True and _labels(doc, "per-token") == 2, r)


@T
def t_idem_long_key_and_refusals():
    doc = common.create_page_mcp("tp-idc-long")
    key = ("k" * 190) + doc[:10]
    a = {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "items", "data": {"label": "long", "qty": 1}}], "idempotency_key": key}
    e1, r1, _ = ws("ws_patch", a)
    e2, r2, _ = ws("ws_patch", a)
    check("200-character key: write then replay", not e1 and not e2 and r2.get("replayed") is True and _labels(doc, "long") == 1, [r1, r2])
    gdoc = create_guide("tg-long-key")
    ga = vv({"uid": GUID, "documentId": gdoc, "locale": "fr", "set": {"note": "long-key"}, "idempotency_key": key})
    e1, r1, _ = ws("ws_patch", ga)
    e2, r2, _ = ws("ws_patch", ga)
    check("200-character key on a localized type (longer uid + locale): write then replay", not e1 and not e2 and r2.get("replayed") is True, [r1, r2])
    g = get(doc)
    common.rest_put(RB, doc, {"note": "colleague"})
    st = {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"note": "agent"}, "idempotency_key": "stale-" + doc}
    res = _concurrent([lambda: ws("ws_patch", st)] * 4)
    check("4 concurrent stale duplicates -> all refused with version_conflict, nothing stored",
          all(e and r["error"]["code"] == "version_conflict" for e, r, _ in res), [r for _, r, _ in res])
    g2 = get(doc)
    st2 = dict(st); st2["expected_version"] = g2["version"]
    e, r, _ = ws("ws_patch", st2)
    check("the same key works for the corrected request (a refusal does not burn the key)", not e and not r.get("replayed")
          and common.rest_get(RA, doc)["note"] == "agent", r)



@T
def t_concurrent_writes_distinct_docs():
    """8 row-op writes on 8 different pages at once, 3 rounds. On MySQL these hit InnoDB next-key-lock deadlocks on
    pages_cmps; the plugin retries the whole write (nothing was written), so every write must land exactly once."""
    bad = []
    for rnd in range(3):
        docs = [common.create_page_mcp("tp-par-%d-%d" % (rnd, n)) for n in range(8)]
        res = _concurrent([(lambda d=d: ws("ws_patch", {"uid": UID, "documentId": d, "ops": [{"op": "add", "field": "items", "data": {"label": "par", "qty": 1}}]})) for d in docs])
        for d, (e, r, _) in zip(docs, res):
            if e or _labels(d, "par") != 1:
                bad.append([d, r, _labels(d, "par")])
    check("24 concurrent writes on distinct documents: every one lands exactly once", not bad, bad)


# ---------------------------------------------------------------------------------------------------------------
# 1.0: tool collision, version-token boundary, key safety, lock order, lenient arguments
# ---------------------------------------------------------------------------------------------------------------
import urllib.request, urllib.error

_JWT = [None]


def admin_http(method, path, body=None):
    """Admin API call with an admin JWT (what the admin panel's Content Manager sends)."""
    if _JWT[0] is None:
        adm = json.load(open(os.environ.get("SPIKE_ADMIN") or os.path.join(spike.ROOT, ".secrets", "admin.json")))
        req = urllib.request.Request(spike.BASE + "/admin/login", data=json.dumps({"email": adm["email"], "password": adm["password"]}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            _JWT[0] = json.loads(r.read())["data"]["token"]
    req = urllib.request.Request(spike.BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + _JWT[0]}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, (json.loads(e.read() or b"null") if True else None)


def probe(path, body):
    s, b, _ = spike.rest(RA, "POST", "/api/probe/" + path, body)
    if s == 404:
        raise RuntimeError("probe plugin not enabled: start Strapi with WRITESAFE_TEST_PROBE=true")
    return s, b


def gql(query, variables=None):
    s, b, _ = spike.rest(RA, "POST", "/graphql", {"query": query, "variables": variables or {}})
    return s, b


def _err(r):
    return (r or {}).get("error", {}) if isinstance(r, dict) else {}


@T
def t_v1_server_instructions_and_steering():
    s, b, _ = spike.rpc(A, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    ins = (b.get("result") or {}).get("instructions") or ""
    check("initialize carries server instructions naming ws_patch and expected_version", "ws_patch" in ins and "expected_version" in ins, ins[:300])
    s, b, _ = spike.rpc(A, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    check("ws_patch description says to use it instead of update_<type>", "instead of update_<type>" in tools["ws_patch"]["description"], tools["ws_patch"]["description"][:200])
    check("ws_publish description says to use it instead of publish_<type>", "instead of publish_<type>" in tools["ws_publish"]["description"])
    mode = os.environ.get("WRITESAFE_BUILTIN_UPDATES", "guard")
    if mode == "guard":
        check("guard (the default): update_page is listed and refuses list fields", "update_page" in tools and "ws_patch" in tools["update_page"]["description"], tools.get("update_page", {}).get("description"))
        check("guard (the default): publish_page is not listed", "publish_page" not in tools)
    if mode == "guide":
        check("guide: update_page is listed and its description points to ws_patch", "update_page" in tools and "ws_patch" in tools["update_page"]["description"], tools.get("update_page", {}).get("description"))
        check("guide: publish_page points to ws_publish", "ws_publish" in tools["publish_page"]["description"])
        check("guide: write_homepage points to ws_patch", "ws_patch" in tools["write_homepage"]["description"])
        other = [n for n in tools if n.startswith("update_plugin-")]  # 5.47 lists no plugin types' tools
        check("guide: tools of non-covered types are untouched", all("ws_patch" not in tools[n]["description"] for n in other), other)


@T
def t_v1_lenient_args():
    """Some MCP clients are reported to send booleans and JSON objects as strings."""
    doc = common.create_page_mcp("tp-lenient")
    g = get(doc)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": json.dumps({"note": "from-string"}), "dry_run": "true"})
    check("set as a JSON string and dry_run as \"true\" are accepted", not err and r.get("dry_run") is True and r.get("written") is False, r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": json.dumps([{"op": "add", "field": "items", "data": {"label": "s", "qty": 1}, "position": json.dumps({"index": "0"})}])})
    check("ops as a JSON string (with a string-encoded position) are accepted", not err and r["ok"], r)
    check("the string-encoded op landed at index 0", common.rest_get(RA, doc)["items"][0]["label"] == "s")
    err, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"note": "true"}}))
    check("a string field value \"true\" stays a string", not err and common.rest_get(RA, doc)["note"] == "true", r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "set": "not json", "dry_run": "yes"})
    check("an ambiguous string is still refused by the schema", err, r)
    err, r, _ = ws("ws_batch", vb({"items": json.dumps([{"uid": UID, "documentId": doc, "set": {"summary": "b"}}]), "dry_run": "false"}))
    check("ws_batch items as a JSON string accepted", not err and r["committed"] is True, r)
    err, r, _ = ws("ws_get", {"uid": UID, "documentId": doc, "fields": '["note"]'})
    check("ws_get fields as a JSON string accepted", not err and list(r["data"].keys()) == ["note"], r)


def _boundary(name, change, expect_value=None):
    """Read a version, change the draft through another path, then a write with the old version must be refused."""
    doc = common.create_page_mcp("tp-bnd-" + name)
    g = get(doc)
    bare = common.rest_get(RA, doc)["updatedAt"]
    out = change(doc)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"summary": "agent"}})
    check("boundary %s: stale expected_version refused (version_conflict)" % name, err and _err(r).get("code") == "version_conflict", [out, r])
    if expect_value:
        f, v = expect_value
        check("boundary %s: the other path's change is kept" % name, json.dumps(common.rest_get(RA, doc)[f]).find(v) >= 0, common.rest_get(RA, doc)[f])
    return doc, g, bare


@T
def t_v1_boundary_admin_content_manager_save():
    def change(doc):
        s, b = admin_http("GET", "/content-manager/collection-types/%s/%s" % (UID, doc))
        data = b["data"]
        data["note"] = "admin-save"
        body = {k: v for k, v in data.items() if k not in ("id", "documentId", "createdAt", "updatedAt", "publishedAt", "createdBy", "updatedBy", "localizations", "locale", "status")}
        s2, b2 = admin_http("PUT", "/content-manager/collection-types/%s/%s" % (UID, doc), body)
        if s2 != 200:
            raise RuntimeError((s2, b2))
        return s2
    _boundary("cm_admin_save", change, ("note", "admin-save"))


@T
def t_v1_boundary_rest():
    _boundary("rest", lambda doc: common.rest_put(RB, doc, {"note": "rest"})[0], ("note", "rest"))


@T
def t_v1_boundary_graphql():
    def change(doc):
        s, b = gql('mutation($id: ID!) { updatePage(documentId: $id, status: DRAFT, data: { note: "graphql" }) { documentId note } }', {"id": doc})
        if s != 200 or (b or {}).get("errors"):
            raise RuntimeError((s, b))
        return s
    _boundary("graphql", change, ("note", "graphql"))


@T
def t_v1_boundary_document_service_other_plugin():
    def change(doc):
        s, b = probe("document-update", {"uid": UID, "documentId": doc, "data": {"note": "plugin"}})
        if s != 200:
            raise RuntimeError((s, b))
        return s
    _boundary("document_service", change, ("note", "plugin"))


@T
def t_v1_boundary_builtin_mcp_tool():
    def change(doc):
        e, r, _, _ = spike.tool(B, "update_page", {"documentId": doc, "data": {"title": common.mcp_get(B, doc)["title"], "note": "builtin"}})
        if e:
            raise RuntimeError(r)
        return "ok"
    _boundary("builtin_update_page", change, ("note", "builtin"))


@T
def t_v1_boundary_raw_db():
    # raw SQL with updated_at bumped: both the full token and a bare updatedAt catch it
    doc, g, bare = _boundary("raw_db_bump", lambda doc: probe("raw-update", {"uid": UID, "documentId": doc, "set": {"note": "raw"}})[1], ("note", "raw"))
    # raw SQL that keeps updated_at: the hashed token still catches it ...
    doc, g, bare = _boundary("raw_db_keep_updated_at", lambda doc: probe("raw-update", {"uid": UID, "documentId": doc, "set": {"note": "raw-silent"}, "keepUpdatedAt": True})[1], ("note", "raw-silent"))
    check("raw_db_keep_updated_at: updatedAt really unchanged", common.rest_get(RA, doc)["updatedAt"] == bare)
    # ... and a bare updatedAt, which could not see it, is no longer accepted (hardening item 3)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": bare, "set": {"summary": "agent"}})
    check("a bare updatedAt is refused (it could not see a raw change that keeps updated_at)", err and _err(r).get("code") == "invalid", r)
    # a raw change to a component row only (the page row untouched)
    doc2 = common.create_page_mcp("tp-bnd-rawcmp")
    g2 = get(doc2)
    cid = int(g2["rows"]["items"][1].split(":")[1])
    probe("raw-component", {"component": "shared.item", "id": cid, "set": {"label": "raw-row"}})
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc2, "expected_version": g2["version"], "set": {"summary": "agent"}})
    check("boundary raw component row (page row untouched): stale version refused", err and _err(r).get("code") == "version_conflict", r)
    check("boundary raw component row: the conflict shows nothing about the untouched field set", "summary" in _err(r).get("current", {}), _err(r))


@T
def t_v1_boundary_outside_the_draft():
    """What the version does NOT cover, so the README can say so precisely."""
    a = author("Bnd Author")
    doc = create_rel_page("tp-bnd-outside", a, a, a)
    g = get(doc)
    s, b, _ = spike.rest(RA, "PUT", "/api/authors/%s" % a, {"data": {"name": "Renamed Author"}})
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"summary": "agent"}})
    check("documented boundary: renaming a related document does not change the version (only its documentId is covered)", s == 200 and not err, [s, r])
    g = get(doc)
    common.rest_put(RB, doc, {"note": "pub"})
    ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": get(doc, B)["version"]}, B)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": get(doc)["version"], "set": {"summary": "x"}})
    check("publishing does not change the draft's version (the draft is what ws_patch writes)", not err, r)


@T
def t_v1_keys_cross_document_field_locale():
    a, b = common.create_page_mcp("tp-key-a"), common.create_page_mcp("tp-key-b")
    ga, gb = get(a), get(b)
    before_b = common.rest_get(RA, b)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": b, "ops": [{"op": "update", "field": "items", "key": ga["rows"]["items"][0], "data": {"label": "HIJACK"}}]})
    check("component key of document A refused on document B (row_not_found)", err and _err(r).get("code") == "row_not_found", r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": b, "ops": [{"op": "update", "field": "body", "key": ga["rows"]["body"][0], "data": common.para("HIJACK")}]})
    check("blocks key of document A refused on document B, though the paragraphs are identical", err and _err(r).get("code") == "row_not_found" and ga["rows"]["body"][0] != gb["rows"]["body"][0], [r, ga["rows"]["body"][0], gb["rows"]["body"][0]])
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": a, "ops": [{"op": "update", "field": "sections", "key": ga["rows"]["items"][0], "data": {"body": "HIJACK"}}]})
    check("a key of field items refused on field sections", err and _err(r).get("code") == "row_not_found", r)
    check("nothing written to B by the refused ops", json.dumps(common.rest_get(RA, b)).count("HIJACK") == 0 and common.rest_get(RA, b)["updatedAt"] == before_b["updatedAt"])
    # locales: an en key on fr
    doc = create_guide("tk-guide")
    en, fr = gget(doc, "en"), gget(doc, "fr")
    k = [x for x in en["rows"].values() if x][0][0]
    field = [f for f, x in en["rows"].items() if x and x[0] == k][0]
    err, r, _ = ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "fr", "ops": [{"op": "remove", "field": field, "key": k}]})
    check("a row key of the en locale refused on fr", err and _err(r).get("code") == "row_not_found", [field, k, r])


@T
def t_v1_keys_forged_variants():
    doc = common.create_page_mcp("tp-key-forge")
    g = get(doc)
    k = g["rows"]["items"][0]
    cuid, cid, mac = k.split(":")
    # 1.0 hardening item 16b: keys are "<component>:<id>:<mac>"; a variant naming no row is row_not_found, one naming
    # the row with a wrong or missing MAC is stale_row_key. Never a hit.
    forged = {"%s:0%s:%s" % (cuid, cid, mac): "row_not_found", "%s: %s:%s" % (cuid, cid, mac): "row_not_found", cuid.upper() + ":" + cid + ":" + mac: "row_not_found",
              "%s:%d:%s" % (cuid, int(cid) + 100000, mac): "row_not_found", "shared.seo:%s:%s" % (cid, mac): "row_not_found", "": "row_not_found", "#0:00000000": "row_not_found",
              "%s:%s" % (cuid, cid): "stale_row_key", "%s:%s:%s " % (cuid, cid, mac): "stale_row_key", "%s:%s:%s;drop" % (cuid, cid, mac): "stale_row_key",
              "%s:%s:%s" % (cuid, cid, mac[:-1] + ("A" if mac[-1] != "A" else "B")): "stale_row_key", "%s:%s:%s.0" % (cuid, cid, mac): "stale_row_key"}
    bad = []
    for f, want in forged.items():
        err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": f, "data": {"label": "FORGED"}}]})
        if not (err and _err(r).get("code") == want):
            bad.append([f, want, r])
    check("forged key variants (leading zero, spaces, case, suffixes, another component, unknown id, wrong or missing MAC) are row_not_found or stale_row_key", not bad, bad)
    check("nothing written by forged keys", "FORGED" not in json.dumps(common.rest_get(RA, doc)))
    # the same key twice in one whole-list set
    rows = [dict(x) for x in g["data"]["items"]]
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"items": [rows[0], dict(rows[0], label="dup")]}})
    check("one _key twice in a set is refused (invalid)", err and _err(r).get("code") == "invalid", r)


@T
def t_v1_keys_zone_component_swap():
    """set with a dynamic-zone row's _key but another __component would carry the row id into another component table."""
    victim = common.create_page_mcp("tp-key-victim")
    doc = common.create_page_mcp("tp-key-swap")
    g = get(doc)
    text_key = [k for k in g["rows"]["sections"] if k.startswith("blocks.text:")][0]
    victim_before = common.rest_get(RA, victim)
    rows = [dict(x) for x in g["data"]["sections"]]
    for x in rows:
        if x["_key"] == text_key:
            x["__component"] = "blocks.hero"
            x.pop("body", None)
            x["heading"] = "SWAPPED"
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"sections": rows}})
    check("_key with a different __component refused (invalid)", err and _err(r).get("code") == "invalid", r)
    check("no other document's hero row was touched", json.dumps(common.rest_get(RA, victim)) == json.dumps(victim_before))


def _align_text_hero_ids():
    """Make the next blocks.text and blocks.hero ids equal by adding rows to a scratch page (test DB only)."""
    scratch = common.create_page_mcp("tp-key-scratch", n_sections=0)
    t = probe("raw-max-id", {"component": "blocks.text"})[1]["max"]
    h = probe("raw-max-id", {"component": "blocks.hero"})[1]["max"]
    if t != h:
        comp, n = ("blocks.text", h - t) if h > t else ("blocks.hero", t - h)
        data = {"body": "pad"} if comp == "blocks.text" else {"heading": "pad"}
        ws("ws_patch", {"uid": UID, "documentId": scratch, "ops": [{"op": "add", "field": "sections", "component": comp, "data": data}] * n})
    return probe("raw-max-id", {"component": "blocks.text"})[1]["max"] == probe("raw-max-id", {"component": "blocks.hero"})[1]["max"]


@T
def t_v1_keys_same_numeric_id_two_components():
    aligned = _align_text_hero_ids()
    doc = common.create_page_mcp("tp-key-sameid", n_sections=2)
    g = get(doc)
    ids = [k.split(":")[1] for k in g["rows"]["sections"]]
    check("setup: the zone holds blocks.text and blocks.hero rows with the same numeric id", aligned and ids[0] == ids[1], g["rows"]["sections"])
    tk, hk = g["rows"]["sections"]
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "sections", "key": hk, "data": {"heading": "HERO-ONLY"}}]})
    v = common.rest_get(RA, doc)["sections"]
    check("update by the hero key changes the hero row only", not err and v[1]["heading"] == "HERO-ONLY" and v[0]["body"] == "text 0", [r, v])
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "remove", "field": "sections", "key": tk}]})
    v = common.rest_get(RA, doc)["sections"]
    check("remove by the text key removes the text row only", not err and len(v) == 1 and v[0]["__component"] == "blocks.hero", v)


@T
def t_v1_keys_after_reorder_delete_readd():
    doc = common.create_page_mcp("tp-key-reorder", n_items=4)
    g = get(doc)
    k = g["rows"]["items"]
    # a colleague reverses the list (row ops keep ids)
    ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "move", "field": "items", "key": x, "position": "start"} for x in k]}, B)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": k[1], "data": {"qty": 77}}]})
    v = common.rest_get(RA, doc)["items"]
    check("after a reorder, a key still edits the row it named (item 1), not the row now at its old index", not err and [x for x in v if x["qty"] == 77][0]["label"] == "item 1", v)
    # the colleague deletes the highest-id row and adds a new one: the new row gets a new id, the old key stays dead
    last = sorted(k, key=lambda x: int(x.split(":")[1]))[-1]
    ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "remove", "field": "items", "key": last}]}, B)
    e2, r2, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "items", "data": {"label": "new", "qty": 1}}]}, B)
    check("a re-added row never reuses the deleted row's id", not e2 and r2["rows"]["items"]["added"][0] != last, [last, r2])
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": last, "data": {"label": "ZOMBIE"}}]})
    check("the deleted row's key is row_not_found, even after a new row was added", err and _err(r).get("code") == "row_not_found" and "ZOMBIE" not in json.dumps(common.rest_get(RA, doc)), r)
    # blocks: a key goes stale when its node moves
    g = get(doc)
    b0 = g["rows"]["body"][0]
    ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "body", "data": common.para("first"), "position": "start"}]}, B)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "body", "key": b0, "data": common.para("WRONG")}]})
    check("a blocks key is refused once its node moved (no edit of the node now at that index)", err and _err(r).get("code") == "row_not_found" and "WRONG" not in json.dumps(common.rest_get(RA, doc)["body"]), r)


@T
def t_v1_keys_after_clone():
    src = common.create_page_mcp("tp-key-clone")
    gs = get(src)
    s, b = admin_http("POST", "/content-manager/collection-types/%s/auto-clone/%s" % (UID, src), {})
    clone = (b or {}).get("data", {}).get("documentId")
    check("setup: content-manager clone made a copy", s in (200, 201) and clone, [s, b])
    gc = get(clone)
    shared = set(gs["rows"]["items"] + gs["rows"]["sections"]) & set(gc["rows"]["items"] + gc["rows"]["sections"])
    check("the clone's component rows have their own keys (new ids)", not shared, shared)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": clone, "ops": [{"op": "update", "field": "items", "key": gs["rows"]["items"][0], "data": {"label": "CLONEHIT"}}]})
    check("a source key is refused on the clone", err and _err(r).get("code") == "row_not_found", r)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": src, "ops": [{"op": "update", "field": "items", "key": gc["rows"]["items"][0], "data": {"label": "CLONEHIT"}}]})
    check("a clone key is refused on the source", err and _err(r).get("code") == "row_not_found", r)
    check("neither copy changed", "CLONEHIT" not in json.dumps(common.rest_get(RA, src)) + json.dumps(common.rest_get(RA, clone)))


def _deadlock_retries():
    log = os.environ.get("STRAPI_LOG")
    if not log or not os.path.exists(log):
        return None
    return sum(1 for l in open(log, errors="replace") if "[writesafe] ws_batch" in l and "retrying" in l)


@T
def t_v1_batch_lock_order_opposite_batches():
    """Two batches touching the same documents in opposite item order, at the same time, many rounds: both commit
    (they queue on the first lock instead of deadlocking) and no deadlock retry is logged."""
    rounds = int(os.environ.get("LOCK_ROUNDS", "10"))
    before = _deadlock_retries()
    bad = []
    for rnd in range(rounds):
        docs = [common.create_page_mcp("tp-lock-%d-%d" % (rnd, i)) for i in range(4)]
        fwd = [{"uid": UID, "documentId": d, "ops": [{"op": "add", "field": "items", "data": {"label": "fwd", "qty": 1}}]} for d in docs]
        rev = [{"uid": UID, "documentId": d, "ops": [{"op": "add", "field": "items", "data": {"label": "rev", "qty": 1}}]} for d in reversed(docs)]
        res = _concurrent([lambda: ws("ws_batch", {"items": fwd}), lambda: ws("ws_batch", {"items": rev}, B)])
        for e, r, _ in res:
            if e or not r.get("committed"):
                bad.append(r)
        for d in docs:
            if _labels(d, "fwd") != 1 or _labels(d, "rev") != 1:
                bad.append([d, _labels(d, "fwd"), _labels(d, "rev")])
    after = _deadlock_retries()
    check("%d rounds of opposite-order batches: both commit, every row once" % rounds, not bad, bad[:3])
    check("no deadlock retry was needed (rows locked in sorted order)", before is None or after - before == 0, [before, after])


@T
def t_v1_nested_component_ids():
    """Review finding (1.0): Strapi updates a component row by any id it is given. A nested id from another document
    must never reach it."""
    a = common.create_page_mcp("tp-nest-a")
    b = common.create_page_mcp("tp-nest-b")
    ga = get(a)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": a, "ops": [{"op": "update", "field": "items", "key": ga["rows"]["items"][0], "data": {"meta": {"note": "A-meta-" + a, "flag": True}}}]})
    check("setup: nested single component written on A", not e, r)
    with common.db() as c:
        row = c.execute("select id from components_shared_metas where note=?", ("A-meta-" + a,)).fetchone()
    meta_id = row[0] if row else None
    gb = get(b)
    attacks = [
        ("op update with a nested id", {"ops": [{"op": "update", "field": "items", "key": gb["rows"]["items"][0], "data": {"meta": {"id": meta_id, "note": "HIJACK"}}}]}),
        ("op add with a nested id", {"ops": [{"op": "add", "field": "items", "data": {"label": "x", "meta": {"id": meta_id, "note": "HIJACK"}}}]}),
        ("set list with a nested id", {"expected_version": gb["version"], "set": {"items": [dict(gb["data"]["items"][0], meta={"id": meta_id, "note": "HIJACK"})]}}),
        ("nested _key", {"ops": [{"op": "update", "field": "items", "key": gb["rows"]["items"][0], "data": {"meta": {"_key": "shared.meta:%s" % meta_id, "note": "HIJACK"}}}]}),
    ]
    for name, extra in attacks:
        e, r, _ = ws("ws_patch", dict({"uid": UID, "documentId": b}, **extra))
        check("nested ids refused: %s -> invalid" % name, e and _err(r).get("code") == "invalid", r)
    with common.db() as c:
        still = c.execute("select note from components_shared_metas where id=?", (meta_id,)).fetchone()
    check("A's nested row untouched", still and still[0] == "A-meta-" + a, still)
    ga2 = get(a)
    check("ws_get shows nested rows without ids", "id" not in (ga2["data"]["items"][0].get("meta") or {}), ga2["data"]["items"][0])
    # a nested single component merges into the current one (its row kept)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": a, "ops": [{"op": "update", "field": "items", "key": ga2["rows"]["items"][0], "data": {"meta": {"note": "A-meta-2-" + a}}}]})
    with common.db() as c:
        row2 = c.execute("select id, flag from components_shared_metas where note=?", ("A-meta-2-" + a,)).fetchone()
    check("nested single component merged: same row id, untouched sibling field kept", not e and row2 and row2[0] == meta_id and row2[1] in (1, True, "1", "t"), [r, row2, meta_id])
    # an echo of a ws_get row (no nested ids) through set keeps working
    g = get(a)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": a, "expected_version": g["version"], "set": {"items": g["data"]["items"]}})
    with common.db() as c:
        row3 = c.execute("select id from components_shared_metas where note=?", ("A-meta-2-" + a,)).fetchone()
    check("echoing ws_get's rows back with set keeps the nested row", not e and row3 and row3[0] == meta_id, [r, row3])


@T
def t_v1_null_nested_component():
    """Integration fix (found by the bulk stream): a row carrying an empty nested component (meta: null, as ws_get
    returns it) was refused as forbidden: items.meta even for a full-access token, because Strapi grants leaf paths only."""
    a = common.create_page_mcp("tp-nullmeta")
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": a, "ops": [{"op": "add", "field": "items", "data": {"label": "nm", "qty": 1, "meta": None}}]})
    check("add with meta: null -> ok", not e and r.get("ok"), r)
    g = get(a)
    check("ws_get shows the empty nested component as null", any(i.get("label") == "nm" and i.get("meta") is None for i in g["data"]["items"]), g["data"]["items"])
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": a, "expected_version": g["version"], "set": {"items": g["data"]["items"]}})
    check("set echoing ws_get rows with meta: null -> ok", not e and r.get("ok"), r)
    key = [k for k, i in zip(get(a)["rows"]["items"], get(a)["data"]["items"]) if i.get("label") == "nm"][0]
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": a, "ops": [{"op": "update", "field": "items", "key": key, "data": {"meta": {"note": "nm-note"}}}]})
    key = (r.get("rows", {}).get("items", {}).get("rekeyed") or {}).get(key, key)   # 1.0 hardening item 16b: the reply's new key
    e2, r2, _ = ws("ws_patch", {"uid": UID, "documentId": a, "ops": [{"op": "update", "field": "items", "key": key, "data": {"meta": None}}]})
    row = [i for i in get(a)["data"]["items"] if i.get("label") == "nm"][0]
    check("clearing a nested component that had values -> ok, now null", not e and not e2 and r2.get("ok") and row.get("meta") is None, [r, r2, row])


_PARTIAL = []


def partial_token():
    """An admin token (made here, in memory only) that may update api::page.page except seo.metaDescription and
    items.qty: for the clearing checks of the 1.0.0-rc.2 review."""
    if not _PARTIAL:
        st, me = admin_http("GET", "/admin/users/me/permissions")
        perms = [{k: p[k] for k in ("action", "subject", "properties", "conditions")} for p in (me or {}).get("data", []) if p.get("subject") == UID
                 and p["action"] in ("plugin::content-manager.explorer.read", "plugin::content-manager.explorer.update", "plugin::content-manager.explorer.create")]
        for p in perms:
            if p["action"].endswith(".update"):
                p["properties"] = dict(p["properties"], fields=[f for f in p["properties"].get("fields", []) if f not in ("seo.metaDescription", "items.qty")])
        st, t = admin_http("POST", "/admin/admin-tokens", {"name": "partial-%d" % int(time.time() * 1000), "description": "test_plugin clearing checks", "adminPermissions": perms, "lifespan": None})
        spike.TOK["admin"]["agent-partial"] = t["data"]["accessKey"]
        _PARTIAL.append("agent-partial")
    return _PARTIAL[0]


@T
def t_v1_clearing_needs_every_leaf():
    """Review (rc.2): clearing a component or dropping list rows changes every leaf the old value had, so a token that
    may not update one of those leaves is refused (before: seo: null or a remove op passed if any child was allowed)."""
    who = partial_token()
    doc = common.create_page_mcp("tp-clear")
    common.rest_put(RA, doc, {"seo": {"metaTitle": "t", "metaDescription": "keep me"}})
    g = get(doc)
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"seo": {"metaTitle": "t2"}}}), who)
    check("control: the partial token may change seo.metaTitle", not e, r)
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"seo": None}}), who)
    check("set seo: null refused (it would clear seo.metaDescription)", e and _err(r).get("code") == "forbidden", r)
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "unset": ["seo"]}), who)
    check("unset seo refused", e and _err(r).get("code") == "forbidden", r)
    g = get(doc)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "remove", "field": "items", "key": g["rows"]["items"][0]}]}, who)
    check("remove op on an items row refused (it would clear items.qty)", e and _err(r).get("code") == "forbidden", r)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"items": g["data"]["items"][1:]}}, who)
    check("set items without one row refused", e and _err(r).get("code") == "forbidden", r)
    v = common.rest_get(RA, doc)
    check("nothing was cleared", (v.get("seo") or {}).get("metaDescription") == "keep me" and len(v["items"]) == len(g["data"]["items"]), v.get("seo"))
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"seo": None}}))
    check("a full-access token may clear seo", not e, r)


@T
def t_v1_nonlocalized_list_concurrent_locales():
    """Review finding (1.0): a non-localized list is copied to every locale; row ops in en and fr at the same time must
    both survive (the write locks every locale's draft row)."""
    rounds = int(os.environ.get("NONLOC_ROUNDS", "6"))
    bad = []
    for rnd in range(rounds):
        doc = create_guide("tp-nonloc-%d" % rnd)
        res = _concurrent([
            lambda: ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "en", "ops": [{"op": "add", "field": "facts", "data": {"label": "from-en", "qty": 1}}]}),
            lambda: ws("ws_patch", {"uid": GUID, "documentId": doc, "locale": "fr", "ops": [{"op": "add", "field": "facts", "data": {"label": "from-fr", "qty": 1}}]}, B),
        ])
        for loc in ("en", "fr"):
            labels = sorted(x["label"] for x in (guide_rest(doc, loc) or {}).get("facts") or [])
            if labels != ["from-en", "from-fr"]:
                bad.append([rnd, loc, labels, [x[1] for x in res]])
    check("%d rounds of simultaneous row ops on a non-localized list in en and fr: both rows in both locales" % rounds, not bad, bad[:3])


import struct, zlib, uuid


def _png(seed):
    raw = b"".join(b"\x00" + bytes([seed % 256, (seed * 7) % 256, (seed * 13) % 256]) * 2 for _ in range(2))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def upload(name, data, ctype):
    bnd = "----" + uuid.uuid4().hex
    body = ('--%s\r\nContent-Disposition: form-data; name="files"; filename="%s"\r\nContent-Type: %s\r\n\r\n' % (bnd, name, ctype)).encode() + data + ("\r\n--%s--\r\n" % bnd).encode()
    req = urllib.request.Request(spike.BASE + "/api/upload", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + spike._token(RA), "Content-Type": "multipart/form-data; boundary=" + bnd})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())[0]


@T
def t_v1_media_in_components():
    """Stretch (a): attach EXISTING media to nested component rows (the '200 images on screen components' request)."""
    imgs = [upload("shot-%d.png" % i, _png(i), "image/png") for i in range(3)]
    txt = upload("notes.txt", b"plain text", "text/plain")
    doc = common.create_page_mcp("tp-media")
    # many rows, each with one image, in one call (by documentId and by numeric id)
    ops = [{"op": "add", "field": "screens", "data": {"caption": "s%d" % i, "shot": imgs[i % 3]["documentId"] if i % 2 else imgs[i % 3]["id"]}} for i in range(20)]
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": ops})
    check("20 screen rows with one image each, in one ws_patch", not e and len(r["rows"]["screens"]["added"]) == 20, r)
    g = get(doc)
    shots = [x["shot"] for x in g["data"]["screens"]]
    check("ws_get shows the images as file documentIds", shots[0] == imgs[0]["documentId"] and shots[1] == imgs[1]["documentId"], shots[:3])
    v1 = g["version"]
    # row 4 holds imgs[1] (row 5 already holds imgs[2]: since the semantic version, writing the same image there changes nothing)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": v1, "ops": [{"op": "update", "field": "screens", "key": g["rows"]["screens"][4], "data": {"shot": imgs[2]["documentId"]}}]})
    g2 = get(doc)
    check("changing one row's image changes that row only (others keep theirs)", not e and g2["data"]["screens"][4]["shot"] == imgs[2]["documentId"]
          and [x["shot"] for i, x in enumerate(g2["data"]["screens"]) if i != 4] == [x for i, x in enumerate(shots) if i != 4], r)
    check("the image is part of the version", g2["version"] != v1)
    # gallery in the dynamic zone: single + multiple media
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "sections", "component": "blocks.gallery",
                                                                       "data": {"title": "G", "image": imgs[0]["documentId"], "images": [imgs[1]["documentId"], txt["documentId"]]}}]})
    sec = [x for x in get(doc)["data"]["sections"] if x["_key"].startswith("blocks.gallery:")]
    check("a dynamic-zone row with a single and a multiple media field", not e and sec and sec[0]["image"] == imgs[0]["documentId"] and sec[0]["images"] == [imgs[1]["documentId"], txt["documentId"]], [r, sec])
    # refusals
    cases = [
        ("a text file in an images-only field", {"op": "add", "field": "screens", "data": {"shot": txt["documentId"]}}, "invalid"),
        ("a file that does not exist", {"op": "add", "field": "screens", "data": {"shot": "nosuchfile0000000000000"}}, "invalid"),
        ("a list in a single media field", {"op": "add", "field": "screens", "data": {"shot": [imgs[0]["documentId"]]}}, "invalid"),
        ("an object (upload-style) value", {"op": "add", "field": "screens", "data": {"shot": {"url": "http://x/y.png"}}}, "invalid"),
    ]
    for name, op, code in cases:
        e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [op]})
        check("media refused: %s -> %s" % (name, code), e and _err(r).get("code") == code, r)
    check("nothing written by the refused media ops", len(common.rest_get(RA, doc)["screens"]) == 20)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "screens", "key": g["rows"]["screens"][0], "data": {"shot": None}}]})
    check("null clears a single media field in a row", not e and get(doc)["data"]["screens"][0]["shot"] is None, r)


@T
def t_v1_media_permission():
    img = upload("perm.png", _png(99), "image/png")
    doc = common.create_page_mcp("tp-media-perm")
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "screens", "data": {"caption": "x", "shot": img["documentId"]}}]}, "agent-nonote")
    check("a token that cannot read the media library cannot attach files (forbidden)", e and _err(r).get("code") == "forbidden", r)


@T
def t_v1_top_level_relation_and_media():
    """So that builtinUpdates=hide loses nothing: ws_patch sets top-level relation and media fields."""
    img = upload("cover.png", _png(42), "image/png")
    au = author("Top Reviewer")
    doc = common.create_page_mcp("tp-top-refs")
    g = get(doc)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"cover": img["documentId"], "reviewer": au}})
    v = common.rest_get(RA, doc)
    check("set top-level media and relation", not e and v["cover"]["documentId"] == img["documentId"] and (v.get("reviewer") or {}).get("documentId") == au, [r, v.get("cover"), v.get("reviewer")])
    g2 = get(doc)
    check("ws_get shows them as documentIds, and the version covers them", g2["data"]["cover"] == img["documentId"] and g2["data"]["reviewer"] == au and g2["version"] != g["version"], g2["data"].get("cover"))
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"reviewer": "no-such-author-000000000"}}))
    check("unknown relation target refused", e and _err(r).get("code") == "invalid", r)
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "unset": ["cover", "reviewer"]}))
    v = common.rest_get(RA, doc)
    check("unset clears them", not e and not v.get("cover") and not v.get("reviewer"), [r, v.get("cover"), v.get("reviewer")])


@T
def t_v1_ws_schema():
    """Stretch (b): a compact schema tool so agents stop guessing structure."""
    e, r, _ = ws("ws_schema", {})
    check("ws_schema lists the covered types", not e and {t["uid"] for t in r["types"]} >= {UID, GUID, "api::homepage.homepage", "api::author.author"}, r)
    e, r, n = ws("ws_schema", {"uid": UID})
    f = r["fields"]
    check("page fields with kinds and how to edit them", not e and f["sections"]["type"] == "dynamiczone" and "ops" in f["sections"]["edit"] and f["items"]["component"] == "shared.item" and f["title"].get("required") is True, f)
    check("every dynamic-zone block and nested component shape is described", {"blocks.text", "blocks.hero", "blocks.cta", "blocks.quote", "blocks.gallery", "shared.item", "shared.meta", "shared.seo", "shared.screen", "shared.credit"} <= set(r["components"]), sorted(r["components"]))
    check("media and relation fields say what value to send", r["components"]["blocks.gallery"]["fields"]["images"]["multiple"] is True and f["reviewer"]["target"] == "api::author.author" and "documentId" in f["cover"]["value"], [r["components"]["blocks.gallery"], f["reviewer"], f["cover"]])
    check("ws_schema reply is compact (< 8 KB for the page type)", len(json.dumps(r, separators=(",", ":"))) < 8000, len(json.dumps(r, separators=(",", ":"))))
    e, r, _ = ws("ws_schema", {"uid": GUID})
    check("localized type marks non-localized fields", not e and r["localized"] is True and r["fields"]["facts"].get("localized") is False and r["fields"]["code"].get("localized") is False and "localized" not in r["fields"]["title"], r["fields"])
    e, r, _ = ws("ws_schema", {"uid": UID}, "agent-noread")
    check("fields the token cannot read are left out", not e and "note" not in r["fields"] and "items" not in r["fields"] and "title" in r["fields"], sorted(r.get("fields", {})))
    e, r, _ = ws("ws_schema", {"uid": UID}, "agent-nonote")
    check("a field the token can read but not update is marked write: false", not e and r["fields"]["note"].get("write") is False and "write" not in r["fields"]["title"], r.get("fields", {}).get("note"))


@T
def t_v1_dry_run_diff():
    """Stretch (c): dry_run returns a before/after diff of the touched fields and rows."""
    doc = common.create_page_mcp("tp-drydiff")
    g = get(doc)
    k = g["rows"]["items"]
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "dry_run": True, "set": {"note": "after"}, "ops": [
        {"op": "update", "field": "items", "key": k[0], "data": {"qty": 99}},
        {"op": "remove", "field": "items", "key": k[1]},
        {"op": "add", "field": "items", "data": {"label": "new", "qty": 1}},
        {"op": "move", "field": "items", "key": k[2], "position": "start"},
        {"op": "add", "field": "body", "data": common.para("added para")}]}))
    d = (r or {}).get("diff", {})
    check("dry run diff: scalar before/after", not e and d.get("note") == {"before": "n0", "after": "after"}, d.get("note"))
    it = d.get("items", {})
    check("dry run diff: row changed (with field before/after), removed and added, by key", ident([c["key"] for c in it.get("changed", [])]) == ident([k[0]])
          and [c.get("key_before") for c in it.get("changed", [])] == [k[0]] and it["changed"][0]["fields"]["qty"] == {"before": 1, "after": 99}
          and [x["key"] for x in it.get("removed", [])] == [k[1]] and it["added"][0]["row"]["label"] == "new", it)
    check("dry run diff: reorder flagged", it.get("reordered") is True, it)
    check("dry run diff: blocks node added", "added para" in json.dumps(d.get("body", {}).get("added")), d.get("body"))
    check("dry run diff: untouched fields left out", "title" not in d and "sections" not in d, list(d))
    check("dry run still wrote nothing", common.rest_get(RA, doc)["note"] == "n0")
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"note": "real"}}))
    check("a real write carries no diff (receipts stay small)", not e and "diff" not in r, r)


@T
def t_v1_draft_vs_live():
    """Stretch (d): compare the draft with the published version (ws_get compare, ws_publish dry_run)."""
    doc = common.create_page_mcp("tp-live")
    e, r, _ = ws("ws_get", {"uid": UID, "documentId": doc, "compare": "published"})
    check("never published: published.exists false, every field shows as added", not e and r["published"]["exists"] is False and r["published"]["diff"]["title"]["after"] == "tp-live", r.get("published"))
    g = get(doc)
    ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g["version"]})
    e, r, _ = ws("ws_get", {"uid": UID, "documentId": doc, "compare": "published"})
    check("just published: no differences (rows matched by content, not ids)", not e and r["published"]["exists"] is True and r["published"]["diff"] == {}, r["published"])
    g = get(doc)
    ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"summary": "draft only"}, "ops": [{"op": "update", "field": "items", "key": g["rows"]["items"][0], "data": {"label": "edited"}}]}))
    g = get(doc)
    e, r, _ = ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g["version"], "dry_run": True})
    d = (r or {}).get("diff", {})
    check("ws_publish dry_run: diff shows what goes live (summary before/after, the edited row)", not e and d.get("summary") == {"before": "s", "after": "draft only"}
          and any(x["row"]["label"] == "edited" for x in d.get("items", {}).get("added", [])) and any(x["row"]["label"] == "item 0" for x in d.get("items", {}).get("removed", [])), d)
    check("ws_publish dry_run published nothing", published(doc)["summary"] == "s")
    e, r, _ = ws("ws_get", {"uid": UID, "documentId": doc, "compare": "published", "fields": ["summary"]}, "agent-nonote")
    check("compare respects fields and the token's view", not e and list(r["published"]["diff"]) == ["summary"], r.get("published"))


_CREATOR_TOKEN = [None]


def creator_only_token():
    """An admin token like Strapi's Author role for media: page read/update, upload.read only for files it created
    (admin::is-creator), and NO read on api::author.author. Created through the admin API (throwaway, never printed)."""
    if _CREATOR_TOKEN[0]:
        return _CREATOR_TOKEN[0]
    s, b = admin_http("GET", "/admin/users/me/permissions")
    mine = b["data"]
    perms = [{k: p[k] for k in ("action", "subject", "properties", "conditions")} for p in mine
             if p["subject"] == UID and p["action"] in ("plugin::content-manager.explorer.read", "plugin::content-manager.explorer.update")]
    perms.append({"action": "plugin::upload.read", "subject": None, "properties": {}, "conditions": ["admin::is-creator"]})
    s, t = admin_http("POST", "/admin/admin-tokens", {"name": "spike-creator-only-%d" % int(time.time() * 1000), "description": "isokron-strapi-1-0 test", "adminPermissions": perms, "lifespan": None})
    if s not in (200, 201):
        raise RuntimeError((s, t))
    spike.TOK["admin"]["agent-creatoronly"] = t["data"]["accessKey"]
    _CREATOR_TOKEN[0] = "agent-creatoronly"
    return _CREATOR_TOKEN[0]


@T
def t_v1_refs_must_be_readable():
    """Review finding: new media and relation references must be readable by the token (conditions included)."""
    who = creator_only_token()
    img = upload("someone-elses.png", _png(7), "image/png")      # uploaded through the API token: not created by this token's user
    au = author("Unreadable Author")
    doc = common.create_page_mcp("tp-refs-read")
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "screens", "data": {"caption": "x", "shot": img["documentId"]}}]}, who)
    check("upload.read with admin::is-creator: another user's file cannot be attached", e and _err(r).get("code") == "invalid" and "cannot read" in _err(r).get("message", ""), r)
    e, r2, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "screens", "data": {"caption": "x", "shot": 99999999}}]}, who)
    check("... and the answer for a missing file is the same (no oracle)", e and _err(r2).get("message", "").split(":", 1)[1].replace("99999999", "X") == _err(r).get("message", "").split(":", 1)[1].replace(img["documentId"], "X"), [r, r2])
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": doc, "set": {"reviewer": au}}), who)
    check("a relation to a document of a type the token cannot read is refused", e and _err(r).get("code") == "invalid", r)
    # rows that already reference such a file can still be edited and re-sent by the same token
    ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "screens", "data": {"caption": "keep", "shot": img["documentId"]}}]})
    g = get(doc)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "update", "field": "screens", "key": g["rows"]["screens"][0], "data": {"caption": "edited"}}]}, who)
    check("editing a row whose image the token cannot read still works (only new references are checked)", not e, r)
    g = get(doc, who)
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"screens": g["data"]["screens"]}}, who)
    check("... also when the whole list is echoed back with set", not e, r)


# ================================================================ 1.0 hardening, phase 1
GAL = "api::gallery.gallery"


def _flags(e, retryable, reread):
    return e.get("retryable") is retryable and e.get("requires_reread") is reread


@T
def t_h1_reply_contract():
    """Item 1 (fourth review N1, N2, Design C): typed errors; retry advice per action; no version without its state."""
    doc = common.create_page_mcp("tp-h1-reply")
    g = get(doc)
    common.rest_put(RB, doc, {"note": "colleague"})
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"note": "agent"}})
    e = _err(r)
    check("patch conflict: retry.expected_version is the current version (re-apply your own change), with `current`",
          e.get("code") == "version_conflict" and e.get("retry", {}).get("expected_version") == e.get("current_version") and e.get("current", {}).get("note") == "colleague", e)
    check("patch conflict: retryable false, requires_reread true", _flags(e, False, True), e)
    err, r, _ = ws("ws_publish", {"uid": UID, "documentId": doc, "expected_version": g["version"]})
    e = _err(r)
    check("publish conflict: no retry.expected_version; the hint says to get approval for the new state",
          e.get("code") == "version_conflict" and "expected_version" not in e.get("retry", {}) and "approve" in e.get("retry", {}).get("hint", ""), e)
    check("publish conflict: typed (retryable false, requires_reread true)", _flags(e, False, True), e)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "set": {"sections": []}})
    e = _err(r)
    check("precondition_required carries no current_version and says to call ws_get",
          e.get("code") == "precondition_required" and "current_version" not in e and "ws_get" in e.get("message", ""), e)
    check("precondition_required: retryable false, requires_reread true", _flags(e, False, True), e)
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": "nope-" + doc, "set": {"note": "a"}})
    check("not_found: retryable false, requires_reread false", _err(r).get("code") == "not_found" and _flags(_err(r), False, False), r)
    err, r, _ = ws("ws_batch", vb({"items": [{"uid": UID, "documentId": doc, "expected_version": g["version"], "set": {"note": "x"}}]}))
    fe = (r or {}).get("items", [{}])[0].get("error", {})
    check("a failed batch item's error is typed too", fe.get("code") == "version_conflict" and _flags(fe, False, True), r)
    e2, r2, _, _ = spike.tool(A, "update_page", {"documentId": doc, "data": {"title": "t", "items": []}})
    try:
        r2 = json.loads(r2) if isinstance(r2, str) else r2
    except Exception:
        pass
    ge = _err(r2) if isinstance(r2, dict) else {}
    check("guard refusal of a built-in update is typed", e2 and ge.get("code") == "use_ws_patch" and _flags(ge, False, False), r2)


@T
def t_h1_batch_publish():
    """Item 2 (N5 and the same-batch exception): the version is enforced on batch publish items."""
    d = common.create_page_mcp("tp-h1-bpub")
    g = get(d)
    err, r, _ = ws("ws_batch", {"items": [{"action": "publish", "uid": UID, "documentId": d}]})
    s, _, _ = spike.rest(RA, "GET", "/api/pages/%s?status=published" % d)
    check("publish item without expected_version -> precondition_required, nothing published",
          err and r["items"][0]["error"]["code"] == "precondition_required" and s == 404, r)
    err, r, _ = ws("ws_batch", vb({"items": [{"action": "publish", "uid": UID, "documentId": d, "expected_version": g["version"], "set": {"note": "with"}}]}))
    check("publish item with set -> invalid (it was silently ignored)", err and r["items"][0]["error"]["code"] == "invalid" and "set" in r["items"][0]["error"]["message"], r)
    err, r, _ = ws("ws_batch", {"items": [
        {"uid": UID, "documentId": d, "ops": [{"op": "add", "field": "items", "data": {"label": "unchecked", "qty": 1}}]},
        {"action": "publish", "uid": UID, "documentId": d}]})
    check("a patch WITHOUT a version check does not let the publish item skip its version", err and r["items"][1]["error"]["code"] == "precondition_required", r)
    err, r, _ = ws("ws_batch", vb({"items": [
        {"ref": "p", "uid": UID, "documentId": d, "expected_version": g["version"], "set": {"note": "approved-in-batch"}},
        {"ref": "pub", "action": "publish", "uid": UID, "documentId": d}]}))
    s, b, _ = spike.rest(RA, "GET", "/api/pages/%s?status=published" % d)
    check("patch with expected_version, then publish of the same document without one: publishes what the patch left",
          not err and r["items"][1]["published_version"] == r["items"][0]["version"] and s == 200 and b["data"]["note"] == "approved-in-batch", [r, b])
    g2 = get(d)
    common.rest_put(RB, d, {"summary": "unreviewed"})
    err, r, _ = ws("ws_batch", {"items": [{"action": "publish", "uid": UID, "documentId": d, "expected_version": g2["version"]}]})
    check("stale publish item -> version_conflict without retry.expected_version", err and r["items"][0]["error"]["code"] == "version_conflict"
          and "expected_version" not in r["items"][0]["error"].get("retry", {}), r)


@T
def t_h1_list_preconditions():
    """Item 3 (N3): set on a to-many relation or a multiple media field needs expected_version."""
    a1, a2, a3 = author("H1 A1"), author("H1 A2"), author("H1 A3")
    i1, i2, i3 = (upload("h1-%d.png" % n, _png(40 + n), "image/png") for n in range(3))
    e, c, _ = ws("ws_create", {"uid": GAL, "data": {"title": "h1-lists", "contributors": [a1], "images": [i1["documentId"]]}})
    doc = c["documentId"]
    g = ws("ws_get", {"uid": GAL, "documentId": doc})[1]
    # a colleague adds a contributor and an image after the agent's read
    ws("ws_patch", {"uid": GAL, "documentId": doc, "expected_version": g["version"], "set": {"contributors": [a1, a2], "images": [i1["documentId"], i2["documentId"]]}}, B)
    err, r, _ = ws("ws_patch", {"uid": GAL, "documentId": doc, "set": {"contributors": [a1, a3]}})
    check("set of a to-many relation without expected_version -> precondition_required (no version in it)",
          err and _err(r).get("code") == "precondition_required" and _err(r).get("field") == "contributors" and "current_version" not in _err(r), r)
    err, r, _ = ws("ws_patch", {"uid": GAL, "documentId": doc, "set": {"images": [i1["documentId"], i3["documentId"]]}})
    check("set of a multiple media field without expected_version -> precondition_required", err and _err(r).get("code") == "precondition_required" and _err(r).get("field") == "images", r)
    now = ws("ws_get", {"uid": GAL, "documentId": doc})[1]
    check("the colleague's contributor and image are still there", sorted(now["data"]["contributors"]) == sorted([a1, a2]) and len(now["data"]["images"]) == 2, now["data"])
    err, r, _ = ws("ws_patch", {"uid": GAL, "documentId": doc, "expected_version": g["version"], "set": {"contributors": [a1, a3]}})
    check("with the stale version -> version_conflict", err and _err(r).get("code") == "version_conflict", r)
    err, r, _ = ws("ws_patch", {"uid": GAL, "documentId": doc, "expected_version": now["version"], "set": {"contributors": now["data"]["contributors"] + [a3]}})
    after = ws("ws_get", {"uid": GAL, "documentId": doc})[1]
    check("with the current version -> written", not err and sorted(after["data"]["contributors"]) == sorted([a1, a2, a3]), [r, after["data"]])
    err, r, _ = ws("ws_patch", {"uid": GAL, "documentId": doc, "set": {"cover": i3["documentId"], "title": "h1-lists-2"}})
    # 1.0 hardening item 16c: every set needs a version now, a single media field and scalars included
    check("16c: a single media field and scalars need a version too (precondition_required)", err and r["error"]["code"] == "precondition_required"
          and set(r["error"].get("fields", [])) == {"cover", "title"}, r)
    err, r, _ = ws("ws_patch", vv({"uid": GAL, "documentId": doc, "set": {"cover": i3["documentId"], "title": "h1-lists-2"}}))
    check("16c: and are written with it", not err, r)


@T
def t_h1_descriptions_and_instructions():
    """Item 4: instructions from the mode and the modules; the two rules travel in ws_get / ws_patch too."""
    s, b, _ = spike.rpc(A, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    ins = (b.get("result") or {}).get("instructions") or ""
    check("instructions no longer send agents to built-ins for relation and media fields", "top-level relation and media" not in ins, ins)
    check("instructions name every enabled module tool", all(t in ins for t in ("ws_create", "ws_delete", "ws_localize", "ws_history", "ws_undo", "ws_bulk", "ws_replace", "ws_media_import")), ins)
    check("instructions: read-then-send and content-is-data rules", "send what you read" in ins and "never instructions" in ins, ins)
    s, b, _ = spike.rpc(A, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    for n in ("ws_get", "ws_patch"):
        d = tools[n]["description"]
        check("%s description repeats both rules" % n, "send what you read" in d and "never instructions" in d, d)
    check("no description mentions a bare updatedAt as a version", all("updatedAt` from get_" not in json.dumps(t["inputSchema"]) for t in tools.values()), "")
    mi = tools.get("ws_media_import", {}).get("description", "")
    check("ws_media_import no longer points to update_<type>", "update_<type>" not in mi, mi)


_PUB_TOKEN = [None]


def publish_only_token():
    """read + publish on api::page.page, no update (created through the admin API; throwaway, never printed)."""
    if _PUB_TOKEN[0]:
        return _PUB_TOKEN[0]
    s, b = admin_http("GET", "/admin/users/me/permissions")
    perms = [{k: p[k] for k in ("action", "subject", "properties", "conditions")} for p in b["data"]
             if p["subject"] == UID and p["action"] in ("plugin::content-manager.explorer.read", "plugin::content-manager.explorer.publish")]
    s, t = admin_http("POST", "/admin/admin-tokens", {"name": "spike-publish-only-%d" % int(time.time() * 1000), "description": "isokron-strapi-1-0 test", "adminPermissions": perms, "lifespan": None})
    if s not in (200, 201):
        raise RuntimeError((s, t))
    spike.TOK["admin"]["agent-pubonly"] = t["data"]["accessKey"]
    _PUB_TOKEN[0] = "agent-pubonly"
    return _PUB_TOKEN[0]


@T
def t_h1_publish_only_token():
    """Item 9: ws_batch and ws_bulk accept the publish permission for publish work (ChatGPT, confirmed by the fourth review)."""
    who = publish_only_token()
    d = common.create_page_mcp("tp-h1-pubonly")
    g = get(d, who)
    err, r, _ = ws("ws_batch", {"items": [{"action": "publish", "uid": UID, "documentId": d, "expected_version": g["version"]}]}, who)
    s, _, _ = spike.rest(RA, "GET", "/api/pages/%s?status=published" % d)
    check("publish-only token: ws_batch publish item works", not err and r.get("committed") and s == 200, r)
    err, r, _ = ws("ws_batch", vb({"items": [{"uid": UID, "documentId": d, "expected_version": get(d, who)["version"], "set": {"note": "no"}}]}), who)
    check("publish-only token: a patch item is still refused (forbidden)", err and r["items"][0]["error"]["code"] == "forbidden", r)
    s, b, _ = spike.rpc(who, "tools/list")
    names = {t["name"] for t in b["result"]["tools"]}
    check("publish-only token sees ws_batch (and ws_bulk when the module is on)", "ws_batch" in names and ("ws_bulk" in names or "ws_bulk" not in {t["name"] for t in spike.rpc(A, "tools/list")[1]["result"]["tools"]}), sorted(names))
    if "ws_bulk" in names:
        title = "tp-h1-pubonly-bulk-%d" % int(time.time() * 1000)
        d2 = common.create_page_mcp(title)
        # 1.0 hardening item 17: a job starts from its dry run's plan_token
        a = {"uid": UID, "action": "publish", "filters": {"title": {"$eq": title}}}
        err, p, _ = ws("ws_bulk", dict(a, dry_run=True), who)
        err, r, _ = ws("ws_bulk", dict(a, plan_token=(p or {}).get("plan_token")), who)
        check("publish-only token: ws_bulk action publish works", not err and r.get("status") == "done" and r["totals"].get("ok") == 1, [p, r])
        err, r, _ = ws("ws_bulk", {"uid": UID, "filters": {"title": {"$eq": title}}, "set": {"note": "x"}, "dry_run": True}, who)
        check("publish-only token: ws_bulk patch refused", err and _err(r).get("code") == "forbidden", r)


@T
def t_h1_position_and_idempotency_scope():
    """Item 9: position {} refused plainly (N24); idempotency scope after resolving the default locale (N25)."""
    doc = common.create_page_mcp("tp-h1-pos")
    err, r, _ = ws("ws_patch", {"uid": UID, "documentId": doc, "ops": [{"op": "add", "field": "items", "data": {"label": "p", "qty": 1}, "position": {}}]})
    # Strapi versions whose zod refuses {} already answer with a schema error; the others reach the engine's check
    check("position {} -> refused naming position (never row_not_found 'Row undefined')", err and "Row undefined" not in json.dumps(r)
          and (_err(r).get("code") == "invalid" and "position must be" in _err(r).get("message", "") or "position" in str(r)), r)
    gd = create_guide("h1-idem-scope", locales=("en",))
    key = "h1-scope-" + gd
    args = {"uid": GUID, "documentId": gd, "ops": [{"op": "add", "field": "items", "data": {"label": "once-scope", "qty": 1}}], "idempotency_key": key}
    e1, r1, _ = ws("ws_patch", dict(args, locale="en"))
    e2, r2, _ = ws("ws_patch", args)  # the same request, default locale left out
    rows = [i for i in guide_rest(gd, "en")["items"] if i["label"] == "once-scope"]
    check("same key with the default locale named, then omitted: replayed, written once", not e1 and not e2 and r2.get("replayed") is True and len(rows) == 1, [r1, r2, len(rows)])


def _token(label, perms):
    """A throwaway admin token with these permissions (never printed); returns its label in spike.TOK."""
    s, t = admin_http("POST", "/admin/admin-tokens", {"name": "spike-%s-%d" % (label, int(time.time() * 1000)), "description": "isokron-strapi-1-0 test", "adminPermissions": perms, "lifespan": None})
    if s not in (200, 201):
        raise RuntimeError((s, t))
    spike.TOK["admin"][label] = t["data"]["accessKey"]
    return label


def _owner_perms(subject, actions):
    s, b = admin_http("GET", "/admin/users/me/permissions")
    return [{k: p[k] for k in ("action", "subject", "properties", "conditions")} for p in b["data"] if p["subject"] == subject and p["action"] in actions]


@T
def t_h1_history_entry_read():
    """Item 9 (fourth review N19): ws_history checks read permission per entry, also for types without i18n."""
    perms = _owner_perms(UID, ("plugin::content-manager.explorer.read",))
    for p in perms:
        p["conditions"] = ["admin::is-creator"]
    who = _token("h1-own-pages", perms)
    s, b, _ = spike.rest(RA, "POST", "/api/pages", {"data": {"title": "h1 not mine", "note": "x"}})   # API token: no admin creator
    other = b["data"]["documentId"]
    mine = common.create_page_mcp("tp-h1-mine")                                                  # created by the admin user
    e, r1, _ = ws("ws_patch", vv({"uid": UID, "documentId": other, "set": {"note": "y"}}))
    e, r2, _ = ws("ws_patch", vv({"uid": UID, "documentId": mine, "set": {"note": "y"}}))
    e, h1, _ = ws("ws_history", {"receipt_id": r1["receipt_id"]}, who)
    e2, h2, _ = ws("ws_history", {"receipt_id": r2["receipt_id"]}, who)
    check("own-entries token: a receipt on another user's entry is not listed", not e and h1.get("receipts") == [], h1)
    check("own-entries token: a receipt on its own entry is listed", not e2 and len(h2.get("receipts", [])) == 1, h2)


@T
def t_h1_uid_conflict_hidden_entry():
    """Item 9 (fourth review N23): uid_conflict / unique_conflict name the other document only when the token may read it."""
    perms = _owner_perms("api::story.story", ("plugin::content-manager.explorer.read", "plugin::content-manager.explorer.create"))
    for p in perms:
        if p["action"].endswith(".read"):
            p["conditions"] = ["admin::is-creator"]
    who = _token("h1-own-stories", perms)
    tag = "h1u%d" % int(time.time() * 1000)
    s, b, _ = spike.rest(RA, "POST", "/api/stories?locale=en", {"data": {"title": "Hidden " + tag, "slug": "hidden-" + tag, "externalId": "ext-" + tag}})
    hidden = b["data"]["documentId"]
    e, r, _ = ws("ws_create", {"uid": "api::story.story", "locale": "en", "data": {"title": "Mine " + tag, "slug": "hidden-" + tag}}, who)
    check("uid_conflict on an entry the token cannot read: no documentId, not in the message", e and _err(r).get("code") == "uid_conflict"
          and "documentId" not in _err(r) and hidden not in json.dumps(r), r)
    e, r, _ = ws("ws_create", {"uid": "api::story.story", "locale": "en", "data": {"title": "Mine2 " + tag, "externalId": "ext-" + tag}}, who)
    check("unique_conflict on an entry the token cannot read: no documentId", e and _err(r).get("code") == "unique_conflict" and hidden not in json.dumps(r), r)
    check("conflict messages hold no field values (they are in `value`)", "ext-" + tag not in _err(r).get("message", "") and _err(r).get("value") == "ext-" + tag, r)
    e, r, _ = ws("ws_create", {"uid": "api::story.story", "locale": "en", "data": {"title": "Again " + tag, "slug": "hidden-" + tag}})
    check("a token that can read it still gets the documentId", e and _err(r).get("code") == "uid_conflict" and _err(r).get("documentId") == hidden, r)


@T
def t_h1_undo_create_restricted_token():
    """Item 8 (fourth review N15): history hashes the full draft, so a token that cannot read every field can undo its create."""
    perms = _owner_perms(UID, ("plugin::content-manager.explorer.read", "plugin::content-manager.explorer.create",
                               "plugin::content-manager.explorer.update", "plugin::content-manager.explorer.delete"))
    for p in perms:
        if p["action"].endswith(".read"):
            p["properties"] = dict(p.get("properties") or {}, fields=[f for f in (p.get("properties") or {}).get("fields", []) if f != "note"])
    who = _token("h1-nonote-reader", perms)
    e, c, _ = ws("ws_create", {"uid": UID, "data": {"title": "h1 restricted create", "summary": "s"}}, who)
    check("restricted token created a page with a receipt", not e and c.get("receipt_id"), c)
    e, u, _ = ws("ws_undo", {"receipt_id": c["receipt_id"]}, who)
    check("... and can undo that create (no false 'changed since it was created')", not e and u["items"][0]["op"] == "deleted", u)
    g = ws("ws_get", {"uid": UID, "documentId": c["documentId"]})
    check("the page is gone", g[0], g[1])


_AUTHOR = [None]


def author_role_token():
    """Like Strapi's Author role: create on page and story; read/update/delete/publish on them only for entries its
    user created (admin::is-creator); read on authors. Phase 0 finding N-A (throwaway token, never printed)."""
    if _AUTHOR[0]:
        return _AUTHOR[0]
    perms = []
    for subject in (UID, "api::story.story"):
        for p in _owner_perms(subject, tuple("plugin::content-manager.explorer." + a for a in ("create", "read", "update", "delete", "publish"))):
            if not p["action"].endswith(".create"):
                p["conditions"] = ["admin::is-creator"]
            perms.append(p)
    perms += _owner_perms("api::author.author", ("plugin::content-manager.explorer.read",))
    _AUTHOR[0] = _token("h1-author-role", perms)
    return _AUTHOR[0]


@T
def t_h1_author_role_token():
    """Item 10a (Phase 0 N-A, N-B): a token limited to its own entries (admin::is-creator) can use writesafe on them,
    and only on them; ws_history shows it its own receipts (localized types too) and nobody else's."""
    who = author_role_token()
    e, c, _ = ws("ws_create", {"uid": UID, "data": {"title": "h1 author own", "note": "n0", "summary": "s0"}}, who)
    check("author token creates a page", not e and c.get("created"), c)
    own = c["documentId"]
    s, b, _ = spike.rest(RA, "POST", "/api/pages", {"data": {"title": "h1 author other", "note": "x"}})   # API token: no admin creator
    other = b["data"]["documentId"]
    e, g, _ = ws("ws_get", {"uid": UID, "documentId": own}, who)
    check("ws_get of its own entry works (was forbidden: createdBy was not loaded for the condition)", not e and g.get("data", {}).get("note") == "n0", g)
    e, r, _ = ws("ws_get", {"uid": UID, "documentId": other}, who)
    check("ws_get of another user's entry stays forbidden", e and _err(r).get("code") == "forbidden", r)
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": other, "set": {"note": "no"}}), who)
    check("ws_patch of another user's entry stays forbidden", e and _err(r).get("code") == "forbidden", r)
    if not g.get("version"):
        return
    e, p1, _ = ws("ws_patch", {"uid": UID, "documentId": own, "expected_version": g["version"], "set": {"note": "n1"}, "return": "full"}, who)
    check("ws_patch of its own entry works, return: full shows its fields", not e and (p1.get("document") or {}).get("note") == "n1", p1)
    common.rest_put(RB, own, {"note": "colleague"})
    e, r, _ = ws("ws_patch", {"uid": UID, "documentId": own, "expected_version": p1.get("version"), "set": {"note": "n2"}}, who)
    check("a conflict on its own entry shows the current value (sanitizeOutput sees the creator)", e and _err(r).get("code") == "version_conflict" and _err(r).get("current", {}).get("note") == "colleague", r)
    g2 = ws("ws_get", {"uid": UID, "documentId": own}, who)[1]
    e, p2, _ = ws("ws_patch", {"uid": UID, "documentId": own, "expected_version": g2.get("version"), "set": {"summary": "s1"}}, who)
    e2, h, _ = ws("ws_history", {"receipt_id": p2.get("receipt_id"), "include_before": True}, who)
    items = (h.get("receipts") or [{}])[0].get("items", [{}]) if not e2 else [{}]
    check("ws_history lists its own receipt with the before values", not e and not e2 and len(h.get("receipts", [])) == 1 and items[0].get("before", {}).get("fields", {}).get("summary") == "s0", h)
    e, u, _ = ws("ws_undo", {"receipt_id": p2.get("receipt_id")}, who)
    check("ws_undo of its own patch works", not e and u.get("items", [{}])[0].get("op") == "restored", u)
    e, pub, _ = ws("ws_publish", {"uid": UID, "documentId": own, "expected_version": ws("ws_get", {"uid": UID, "documentId": own}, who)[1].get("version")}, who)
    check("ws_publish of its own entry works", not e and pub.get("ok"), pub)
    e, c2, _ = ws("ws_create", {"uid": UID, "data": {"title": "h1 author undo create"}}, who)
    e2, u2, _ = ws("ws_undo", {"receipt_id": c2.get("receipt_id")}, who)
    check("ws_undo of its own create deletes it (no false 'changed since')", not e and not e2 and u2.get("items", [{}])[0].get("op") == "deleted", [c2, u2])
    e, d, _ = ws("ws_delete", {"uid": UID, "documentId": own, "expected_version": ws("ws_get", {"uid": UID, "documentId": own}, who)[1].get("version")}, who)
    check("ws_delete of its own entry works", not e and d.get("deleted") is True, d)
    # localized type (Phase 0 N-B): its own receipts are listed, other entries' are not
    tag = "h1a%d" % int(time.time() * 1000)
    e, sc, _ = ws("ws_create", {"uid": "api::story.story", "locale": "en", "data": {"title": "Own " + tag}}, who)
    gs = ws("ws_get", {"uid": "api::story.story", "documentId": sc.get("documentId"), "locale": "en"}, who)[1]
    e, sp, _ = ws("ws_patch", {"uid": "api::story.story", "documentId": sc.get("documentId"), "locale": "en", "expected_version": gs.get("version"), "set": {"summary": "mine"}}, who)
    e2, hs, _ = ws("ws_history", {"receipt_id": sp.get("receipt_id")}, who)
    check("localized type: ws_history lists its own receipt", not e and not e2 and len(hs.get("receipts", [])) == 1, [sp, hs])
    s, b, _ = spike.rest(RA, "POST", "/api/stories?locale=en", {"data": {"title": "Other " + tag}})
    e, so, _ = ws("ws_patch", vv({"uid": "api::story.story", "documentId": b["data"]["documentId"], "locale": "en", "set": {"summary": "a"}}))
    e2, ho, _ = ws("ws_history", {"receipt_id": so.get("receipt_id")}, who)
    check("localized type: another user's receipt is not listed", not e2 and ho.get("receipts") == [], ho)


# ---------------------------------------------------------------- phase 1 review fixes
@T
def t_h1r_guard_refuses_whole_relation_and_media_lists():
    """Review must-fix 1: under guard, built-in update_<type> must not replace a to-many relation or a multiple media
    field whole (no version): a colleague's added contributor was dropped and the call answered ok."""
    if os.environ.get("WRITESAFE_BUILTIN_UPDATES", "guard") != "guard":
        return
    a1, a2, a3 = author("H1R A1"), author("H1R A2"), author("H1R A3")
    i1, i2 = (upload("h1r-%d.png" % n, _png(70 + n), "image/png") for n in range(2))
    e, c, _ = ws("ws_create", {"uid": GAL, "data": {"title": "h1r-guard", "contributors": [a1, a2], "images": [i1["documentId"]]}})
    doc = c["documentId"]
    # a whole to-many list: Strapi's {set: [...]} (a plain array where the schema takes one); multiple media: a list
    for field, val in (("contributors", {"set": [a1, a3]}), ("contributors", {"set": None}), ("images", [i2["id"]])):
        e2, r2, _, _ = spike.tool(A, "update_gallery", {"documentId": doc, "data": {"title": "h1r-guard", field: val}})
        try:
            r2 = json.loads(r2) if isinstance(r2, str) else r2
        except Exception:
            pass
        check("guard: update_gallery refuses %s = %s (use_ws_patch)" % (field, json.dumps(val)[:40]), e2 and _err(r2).get("code") == "use_ws_patch" and field in _err(r2).get("fields", []), r2)
    # bare forms (null, an id, a list of ids): Strapi 5.47 to 5.62's own schema refuses them for a to-many relation before
    # any handler; either way nothing may change (the guard refuses them too, unit-tested)
    for field, val in (("contributors", None), ("contributors", a3), ("contributors", [a1, a3]), ("images", None)):
        e2, r2, _, _ = spike.tool(A, "update_gallery", {"documentId": doc, "data": {"title": "h1r-guard", field: val}})
        check("bare %s = %s is refused (schema or guard)" % (field, json.dumps(val)[:40]), e2, r2)
    now = ws("ws_get", {"uid": GAL, "documentId": doc})[1]["data"]
    check("the colleague's contributor and the image are still there", sorted(now["contributors"]) == sorted([a1, a2]) and len(now["images"]) == 1, now)
    e2, r2, _, _ = spike.tool(A, "update_gallery", {"documentId": doc, "data": {"title": "h1r-guard-2"}})
    check("guard: scalar fields still go through update_gallery", not e2, r2)
    e2, r2, _, _ = spike.tool(A, "update_gallery", {"documentId": doc, "data": {"title": "h1r-guard-2", "contributors": {"connect": [a3]}}})
    now = ws("ws_get", {"uid": GAL, "documentId": doc})[1]["data"]
    check("guard: connect on a to-many relation (keeps the other links) still goes through", not e2 and sorted(now["contributors"]) == sorted([a1, a2, a3]), [r2, now.get("contributors")])
    s, b, _ = spike.rpc(A, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    check("guard descriptions no longer promise relation and media fields", "relation and media" not in tools["update_gallery"]["description"], tools["update_gallery"]["description"][-300:])
    s, b, _ = spike.rpc(A, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    ins = (b.get("result") or {}).get("instructions") or ""
    check("instructions no longer say built-ins accept relation and media fields", "relation and media" not in ins, ins)


@T
def t_h1r_batch_publish_other_locale():
    """Review: the batch publish exception is per document AND locale."""
    gd = create_guide("h1r-bpub-locale")
    fr = gget(gd, "fr")
    err, r, _ = ws("ws_batch", vb({"items": [
        {"uid": GUID, "documentId": gd, "locale": "fr", "expected_version": fr["version"], "set": {"note": "fr checked"}},
        {"action": "publish", "uid": GUID, "documentId": gd, "locale": "en"}]}))
    s, _, _ = spike.rest(RA, "GET", "/api/guides/%s?status=published&locale=en" % gd)
    check("a checked patch of fr does not let a publish of en skip its version", err and r["items"][1]["error"]["code"] == "precondition_required" and s == 404, r)
    fr = gget(gd, "fr")
    err, r, _ = ws("ws_batch", vb({"items": [
        {"uid": GUID, "documentId": gd, "locale": "fr", "expected_version": fr["version"], "set": {"note": "fr checked 2"}},
        {"action": "publish", "uid": GUID, "documentId": gd, "locale": "fr"}]}))
    pub = guide_rest(gd, "fr", "published")
    check("... a publish of fr after it does (publishes what the patch left)", not err and pub and pub["note"] == "fr checked 2", [r, pub])


@T
def t_h1r_undo_unreadable_entry():
    """Review item 10: ws_undo checks read permission per entry; a conflict on an entry the token cannot read shows
    nothing of it (no documentId, fields or version)."""
    who = author_role_token()
    s, b, _ = spike.rest(RA, "POST", "/api/pages", {"data": {"title": "h1r undo other", "note": "n0"}})
    other = b["data"]["documentId"]
    e, r, _ = ws("ws_patch", vv({"uid": UID, "documentId": other, "set": {"note": "agent"}}))
    common.rest_put(RB, other, {"note": "colleague"})
    e, u, _ = ws("ws_undo", {"receipt_id": r["receipt_id"]}, who)
    blob = json.dumps(u)
    check("undo of another user's entry: refused without its documentId, field names or version", e and _err(u).get("code") == "forbidden"
          and other not in blob and "note" not in blob and "current_version" not in blob, u)
    common.rest_put(RB, other, {"note": "agent"})
    e, u, _ = ws("ws_undo", {"receipt_id": r["receipt_id"]}, who)
    check("... also when nothing changed since (forbidden, nothing undone)", e and _err(u).get("code") == "forbidden" and common.rest_get(RA, other)["note"] == "agent", u)


@T
def t_h1r_condition_on_related_field():
    """Review, 10a: a permission condition that reads a related document's field (reviewer.name), not only createdBy."""
    probe_on = "plugin::probe.reviewer-is-cond" in json.dumps(admin_http("GET", "/admin/permissions")[1])
    if not probe_on:
        check("probe condition registered (WRITESAFE_TEST_PROBE=true)", False)
        return
    perms = _owner_perms(UID, ("plugin::content-manager.explorer.read", "plugin::content-manager.explorer.update"))
    for p in perms:
        p["conditions"] = ["plugin::probe.reviewer-is-cond"]
    who = _token("h1r-reviewer-cond", perms)
    cond_rev, other_rev = author("Cond Reviewer"), author("Someone Else")
    mine = common.create_page_mcp("tp-h1r-cond-yes")
    ws("ws_patch", vv({"uid": UID, "documentId": mine, "set": {"reviewer": cond_rev}}))
    theirs = common.create_page_mcp("tp-h1r-cond-no")
    ws("ws_patch", vv({"uid": UID, "documentId": theirs, "set": {"reviewer": other_rev}}))
    e, g, _ = ws("ws_get", {"uid": UID, "documentId": mine}, who)
    check("condition on reviewer.name: the matching entry is readable", not e and g.get("version"), g)
    e, r, _ = ws("ws_get", {"uid": UID, "documentId": theirs}, who)
    check("... the other entry is forbidden", e and _err(r).get("code") == "forbidden", r)
    if g.get("version"):
        e, p, _ = ws("ws_patch", {"uid": UID, "documentId": mine, "expected_version": g["version"], "set": {"summary": "cond ok"}}, who)
        check("... and writable", not e and p.get("ok"), p)


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    json.dump(results, open(os.path.join(HERE, "results", os.environ.get("TEST_RESULTS", "test_plugin.json")), "w"), indent=1, default=str)
    fails = [r for r in results if not r["pass"]]
    if os.environ.get("BY_GROUP"):
        groups = {}
        for r in results:
            g = groups.setdefault(r["group"], [0, 0]); g[0 if r["pass"] else 1] += 1
        for g, (ok, bad) in groups.items():
            print("  %-40s %d/%d" % (g, ok, ok + bad))
    print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
    sys.exit(1 if fails else 0)
