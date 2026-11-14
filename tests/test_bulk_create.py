"""Functional tests for the bulk-and-create modules (ws_create, ws_delete, ws_bulk, ws_replace, the `copy` row op),
against a running Strapi with the spike tokens plus scripts/setup_bulk_tokens.mjs.

Run: python3 tests/test_bulk_create.py   (exit 1 on any failure; writes tests/results/test_bulk_create<-TAG>.json)
ONLY=t_create,t_copy python3 tests/test_bulk_create.py runs the tests whose names contain one of those strings.
BULK_RESTART_CMD="<command that starts Strapi again>" and BULK_PID_FILE=<pid file> enable the kill-and-resume test.
MODULES_OFF=1 checks a server started with WRITESAFE_MODULES='{"bulk":false,"create":false,"delete":false,"replace":false,"copy":false}'.
"""
import json, os, signal, subprocess, sys, threading, time, traceback, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "spike"))
import spike, common
from common import vv, vb, ident  # 1.0 hardening items 16b and 16c
from spike import A, B, RA, RB

PAGE = "api::page.page"
STORY = "api::story.story"
GUIDE = "api::guide.guide"
RUN = uuid.uuid4().hex[:6]
results = []
CURRENT = [None]
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]


def check(name, cond, detail=None):
    results.append({"group": CURRENT[0], "test": name, "pass": bool(cond), "detail": detail if not cond else None})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:900]))


def ws(tool, args, who=A):
    err, r, n, full = spike.tool(who, tool, args)
    if err and isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    return err, r


def code(r):
    return ((r or {}).get("error") or {}).get("code") if isinstance(r, dict) else None


def T(fn):
    if ONLY and not any(o in fn.__name__ for o in ONLY):
        return fn
    if os.environ.get("MODULES_OFF") and fn.__name__ != "t_modules_off":
        return fn
    CURRENT[0] = fn.__name__
    try:
        fn()
    except Exception:
        check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-1200:])
    return fn


def concurrent(calls):
    out = [None] * len(calls)
    bar = threading.Barrier(len(calls))

    def run(i):
        bar.wait()
        out[i] = calls[i]()
    ts = [threading.Thread(target=run, args=(i,)) for i in range(len(calls))]
    [t.start() for t in ts]
    [t.join() for t in ts]
    return out


def wget(uid, doc, locale=None, who=A, fields=None):
    a = {"uid": uid, "documentId": doc}
    if locale:
        a["locale"] = locale
    if fields:
        a["fields"] = fields
    e, r = ws("ws_get", a, who)
    if e:
        raise RuntimeError(r)
    return r


def rest_list(plural, query):
    s, b, _ = spike.rest(RA, "GET", "/api/%s?%s" % (plural, query))
    if s != 200:
        raise RuntimeError((s, b))
    return b["data"]


def story_count(field, value, locale="en"):
    return len(rest_list("stories", "status=draft&locale=%s&filters[%s][$eq]=%s&pagination[pageSize]=100" % (locale, field, value)))


def pages_with(prefix):
    return rest_list("pages", "status=draft&filters[title][$startsWith]=%s&pagination[pageSize]=200&sort=id:asc&populate=*" % prefix)


def no_keys(v):
    if isinstance(v, list):
        return [no_keys(x) for x in v]
    if isinstance(v, dict):
        return {k: no_keys(x) for k, x in v.items() if k not in ("_key", "id")}
    return v


def story_data(title, ext, **kw):
    d = {"title": title, "externalId": ext, "summary": "about " + title,
         "seo": {"metaTitle": "meta " + title},
         "items": [{"label": "i1", "qty": 1}, {"label": "i2", "qty": 2}],
         "sections": [{"__component": "blocks.hero", "heading": "Hero " + title}, {"__component": "blocks.text", "body": "text"}],
         "body": [common.para("first"), common.para("second")]}
    d.update(kw)
    return d


# ------------------------------------------------------------------ catalog and modules

@T
def t_catalog():
    s, b, raw = spike.rpc(A, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    for n in ("ws_create", "ws_delete", "ws_bulk", "ws_replace", "ws_job"):
        check("catalog lists " + n, n in tools)
        if n in tools:
            check(n + " args are strict", tools[n]["inputSchema"].get("additionalProperties") is False, tools[n]["inputSchema"].get("additionalProperties"))
    ops = tools["ws_patch"]["inputSchema"]["properties"]["ops"]["items"]
    check("ws_patch ops accept the copy op", "copy" in ops["properties"]["op"]["enum"], ops["properties"]["op"])
    # phase 4: ws_job is the one tool over the caller's own jobs; nothing else exposes the receipt or job store
    check("receipt and job store not exposed as tools (besides ws_job)", not any(("receipt" in n or "job" in n) and n != "ws_job" for n in tools), sorted(tools))


@T
def t_modules_off():
    if not os.environ.get("MODULES_OFF"):
        return
    s, b, raw = spike.rpc(A, "tools/list")
    names = [t["name"] for t in b["result"]["tools"]]
    check("modules off: no ws_create/ws_delete/ws_bulk/ws_replace/ws_job registered", not any(n in names for n in ("ws_create", "ws_delete", "ws_bulk", "ws_replace", "ws_job")), names)
    check("modules off: core ws_* tools still registered", all(n in names for n in ("ws_get", "ws_patch", "ws_publish", "ws_batch")), names)
    ops = [t for t in b["result"]["tools"] if t["name"] == "ws_patch"][0]["inputSchema"]["properties"]["ops"]["items"]
    check("modules off: copy op not offered", "copy" not in ops["properties"]["op"]["enum"], ops["properties"]["op"])


# ------------------------------------------------------------------ ws_create

@T
def t_create_basic():
    e, r = ws("ws_create", {"uid": STORY, "data": story_data("Create Basic %s" % RUN, "cb-" + RUN)})
    check("create ok with components, zone and blocks", not e and r["created"] is True and r["existed"] is False, r)
    check("receipt is compact (< 400 bytes)", len(json.dumps(r, separators=(",", ":"))) < 400, len(json.dumps(r)))
    check("default locale reported (locale_defaulted)", r.get("locale") == "en" and r.get("locale_defaulted") is True, r)
    check("slug generated from title like the admin", r.get("generated", {}).get("slug") == "create-basic-%s" % RUN, r)
    g = wget(STORY, r["documentId"])
    check("version in receipt equals ws_get version", g["version"] == r["version"], [g["version"], r["version"]])
    check("rows created", len(g["rows"]["items"]) == 2 and len(g["rows"]["sections"]) == 2 and len(g["rows"]["body"]) == 2, g["rows"])
    check("draft only (not published)", not rest_list("stories", "status=published&locale=en&filters[externalId][$eq]=cb-" + RUN), None)
    e, r2 = ws("ws_create", {"uid": STORY, "data": {"title": "x", "externalId": "cbk-" + RUN, "items": [dict(g["data"]["items"][0])]}})
    check("rows copied from a ws_get read (with _key) are created as new rows", not e and wget(STORY, r2["documentId"])["rows"]["items"][0] != g["rows"]["items"][0], r2)


@T
def t_create_upsert():
    ext = "up-" + RUN
    e, r1 = ws("ws_create", {"uid": STORY, "data": story_data("Upsert %s" % RUN, ext), "unique_by": "externalId"})
    e2, r2 = ws("ws_create", {"uid": STORY, "data": story_data("Upsert changed %s" % RUN, ext), "unique_by": "externalId"})
    check("first upsert creates", not e and r1["created"], r1)
    check("second upsert returns the existing document (existed: true)", not e2 and r2["existed"] is True and r2["created"] is False and r2["documentId"] == r1["documentId"], r2)
    # review must-fix 2 (N2 again): no version without the content it stands for
    check("existing document: no version without its content; the hint says to read it with ws_get", "version" not in r2 and "document" not in r2
          and "ws_get" in r2.get("hint", ""), r2)
    e5, r5 = ws("ws_create", {"uid": STORY, "data": story_data("Upsert changed %s" % RUN, ext), "unique_by": "externalId", "return": "full"})
    check("with return: full the version comes with the document it stands for", not e5 and r5.get("existed") and r5.get("version") == wget(STORY, r1["documentId"])["version"]
          and (r5.get("document") or {}).get("externalId") == ext, r5)
    check("differing fields reported", "title" in r2.get("differs", []), r2)
    check("exactly one document with that externalId", story_count("externalId", ext) == 1, story_count("externalId", ext))
    e3, r3 = ws("ws_create", {"uid": STORY, "data": {"title": "Upsert Slug %s" % RUN, "externalId": "us-" + RUN}, "unique_by": "slug"})
    e4, r4 = ws("ws_create", {"uid": STORY, "data": {"title": "Upsert Slug %s" % RUN, "externalId": "us2-" + RUN}, "unique_by": "slug"})
    check("upsert by a generated slug: second call finds the first", not e3 and not e4 and r4.get("existed") is True and r4["documentId"] == r3["documentId"], [r3, r4])
    e5, r5 = ws("ws_create", {"uid": STORY, "data": {"title": "t"}, "unique_by": "externalId"})
    check("unique_by without a value refused (invalid)", e5 and code(r5) == "invalid", r5)
    e6, r6 = ws("ws_create", {"uid": STORY, "data": {"title": "t", "summary": "s"}, "unique_by": "summary"})
    check("unique_by on a non-key field type (text) refused", e6 and code(r6) == "invalid", r6)


@T
def t_create_uid():
    title = "Same Title %s" % RUN
    e, r1 = ws("ws_create", {"uid": STORY, "data": {"title": title, "externalId": "u1-" + RUN}})
    e, r2 = ws("ws_create", {"uid": STORY, "data": {"title": title, "externalId": "u2-" + RUN}})
    base = "same-title-%s" % RUN
    check("generated slug of a taken title gets the next free suffix (as the admin)", r1["generated"]["slug"] == base and r2["generated"]["slug"] == base + "-1", [r1, r2])
    e, r3 = ws("ws_create", {"uid": STORY, "data": {"title": "other", "slug": base, "externalId": "u3-" + RUN}})
    check("a given slug that is taken -> uid_conflict with a free suggestion", e and code(r3) == "uid_conflict" and r3["error"]["suggestion"] == base + "-2", r3)
    e, r4 = ws("ws_create", {"uid": STORY, "data": {"title": "other", "slug": "bad slug!", "externalId": "u4-" + RUN}})
    check("a slug with invalid characters refused", e and code(r4) == "invalid", r4)
    e, r5 = ws("ws_create", {"uid": STORY, "data": {"title": "other", "slug": base, "externalId": "u5-" + RUN}, "locale": "fr"})
    check("the same slug in another locale is free (uniqueness is per locale)", not e and r5["created"], r5)
    e, r6 = ws("ws_create", {"uid": STORY, "data": {"title": "dup ext", "externalId": "u1-" + RUN}})
    check("a unique field (externalId) that is taken -> unique_conflict", e and code(r6) == "unique_conflict", r6)


@T
def t_create_locale():
    ext = "loc-" + RUN
    e, r1 = ws("ws_create", {"uid": STORY, "data": {"title": "Loc %s" % RUN, "externalId": ext}, "unique_by": "externalId"})
    e, r2 = ws("ws_create", {"uid": STORY, "locale": "fr", "data": {"title": "Loc fr %s" % RUN, "externalId": ext}, "unique_by": "externalId"})
    check("upsert looks only in the named locale: fr creates a new document", not e and r2["created"] and r2["locale"] == "fr" and r2["documentId"] != r1["documentId"], r2)
    check("a match in another locale is reported, not turned into a new locale", r2.get("same_value_in_other_locales") == [{"documentId": r1["documentId"], "locale": "en"}], r2)
    check("no locale_defaulted when the locale is named", "locale_defaulted" not in r2, r2)
    s, b, _ = spike.rest(RA, "GET", "/api/stories/%s?status=draft&locale=fr" % r1["documentId"])
    check("the en document got no fr locale", s == 404, [s, b])
    # "nl" is not a locale of the test app (fr and de are: the l10n tests add de)
    e, r3 = ws("ws_create", {"uid": STORY, "locale": "nl", "data": {"title": "x"}})
    check("unknown locale refused", e and code(r3) == "invalid", r3)
    e, r4 = ws("ws_create", {"uid": PAGE, "locale": "fr", "data": {"title": "x"}})
    check("locale on a non-localized type refused", e and code(r4) == "invalid", r4)


@T
def t_create_validation_and_dry_run():
    e, r = ws("ws_create", {"uid": PAGE, "data": {"title": "v", "nmae": 1}})
    check("unknown field refused", e and code(r) == "invalid" and "nmae" in r["error"]["message"], r)
    e, r = ws("ws_create", {"uid": PAGE, "data": {"title": "v", "sections": [{"__component": "shared.item", "label": "x"}]}})
    check("component not allowed in the zone refused", e and code(r) == "invalid", r)
    e, r = ws("ws_create", {"uid": PAGE, "data": {"title": "v", "credits": [{"role": "r", "author": "nope-doc"}]}})
    check("unknown relation target inside a component refused", e and code(r) == "invalid", r)
    e, r = ws("ws_create", {"uid": PAGE, "data": {"title": "v", "items": [{"label": "x", "qty": "NaN"}]}})
    check("Strapi validation error surfaces as invalid", e and code(r) == "invalid", r)
    e, r = ws("ws_create", {"uid": "api::homepage.homepage", "data": {"title": "v"}})
    check("single type refused with a pointer to write_<type>", e and code(r) == "unsupported", r)
    ext = "dry-" + RUN
    e, r = ws("ws_create", {"uid": STORY, "data": story_data("Dry %s" % RUN, ext), "dry_run": True})
    check("dry run returns a receipt marked dry_run, written false", not e and r["dry_run"] and r["written"] is False and r["version"] is None, r)
    check("dry run created nothing", story_count("externalId", ext) == 0)


@T
def t_create_permissions():
    e, r = ws("ws_create", {"uid": PAGE, "data": {"title": "perm", "note": "secret"}}, who="agent-cnn")
    check("a field the token may not create refuses the create (not dropped)", e and code(r) == "forbidden" and "note" in r["error"]["message"], r)
    e, r = ws("ws_create", {"uid": PAGE, "data": {"title": "perm ok %s" % RUN}}, who="agent-cnn")
    check("the same token can create without that field", not e and r["created"], r)
    e, r = ws("ws_create", {"uid": PAGE, "data": {"title": "ro"}}, who="agent-ro")
    check("a read-only token cannot create (tool not available to it, or forbidden)", e and (code(r) == "forbidden" or "ws_create" in json.dumps(r)), r)
    e, r = ws("ws_create", {"uid": STORY, "data": {"title": "x"}}, who="agent-cnn")
    check("no create permission on the type -> forbidden", e and code(r) == "forbidden", r)


@T
def t_create_idempotency():
    key = "create-key-" + RUN
    a = {"uid": STORY, "data": {"title": "Idem %s" % RUN, "externalId": "idem-" + RUN}, "idempotency_key": key}
    e1, r1 = ws("ws_create", a)
    e2, r2 = ws("ws_create", a)
    check("retry with the same key replays the receipt", not e1 and not e2 and r2.get("replayed") is True and r2["documentId"] == r1["documentId"], [r1, r2])
    b = dict(a); b["data"] = {"title": "other", "externalId": "idem2-" + RUN}
    e3, r3 = ws("ws_create", b)
    check("same key, different request -> idempotency_key_reused", e3 and code(r3) == "idempotency_key_reused", r3)


@T
def t_create_concurrent_upserts():
    bad = []
    for rnd in range(5):
        ext = "cc-%s-%d" % (RUN, rnd)
        res = concurrent([lambda: ws("ws_create", {"uid": STORY, "data": story_data("Conc %s %d" % (RUN, rnd), ext), "unique_by": "externalId"})] * 6)
        created = [r for e, r in res if not e and r.get("created")]
        existed = [r for e, r in res if not e and r.get("existed")]
        ids = {r["documentId"] for e, r in res if not e}
        n = story_count("externalId", ext)
        if len(created) != 1 or len(existed) != 5 or len(ids) != 1 or n != 1:
            bad.append({"round": rnd, "created": len(created), "existed": len(existed), "ids": list(ids), "in_db": n, "errors": [r for e, r in res if e]})
    check("5 rounds x 6 simultaneous identical upserts: one created, five existed:true, one document", not bad, bad)
    title = "Race Slug %s" % RUN
    res = concurrent([lambda i=i: ws("ws_create", {"uid": STORY, "data": {"title": title, "externalId": "rs-%s-%d" % (RUN, i)}}) for i in range(4)])
    slugs = sorted(r.get("generated", {}).get("slug") for e, r in res if not e)
    base = "race-slug-%s" % RUN
    check("4 simultaneous creates with the same title get 4 distinct slugs", slugs == sorted([base, base + "-1", base + "-2", base + "-3"]), [r for e, r in res])
    res = concurrent([lambda: ws("ws_create", {"uid": STORY, "data": {"title": "Race Up %s" % RUN, "externalId": "ru-" + RUN}, "unique_by": "slug"})] * 4)
    check("4 simultaneous upserts by generated slug: one document", len({r["documentId"] for e, r in res if not e}) == 1 and sum(1 for e, r in res if not e and r["created"]) == 1, res)


# ------------------------------------------------------------------ ws_delete

@T
def t_delete_basic():
    e, c = ws("ws_create", {"uid": PAGE, "data": {"title": "Del %s" % RUN, "note": "n", "items": [{"label": "a", "qty": 1}],
                                                  "sections": [{"__component": "blocks.hero", "heading": "h"}], "seo": {"metaTitle": "m"}}})
    doc = c["documentId"]
    g = wget(PAGE, doc)
    e, r = ws("ws_delete", {"uid": PAGE, "documentId": doc})
    # hardening item 1 (fourth review N2): no version without the content it stands for
    check("delete without expected_version -> precondition_required, no current_version, says to read with ws_get", e and code(r) == "precondition_required"
          and "current_version" not in r["error"] and "ws_get" in r["error"]["message"] and r["error"]["requires_reread"] is True, r)
    common.rest_put(RB, doc, {"note": "colleague"})
    e, r = ws("ws_delete", {"uid": PAGE, "documentId": doc, "expected_version": g["version"]})
    check("stale delete -> version_conflict, nothing deleted", e and code(r) == "version_conflict" and r["error"]["current"].get("note") == "colleague", r)
    check("stale delete: retry carries no version, only the advice to re-read and confirm", "expected_version" not in r["error"].get("retry", {}) and "ws_get" in r["error"]["retry"]["hint"], r)
    check("document still there", common.rest_get(RA, doc)["note"] == "colleague")
    g2 = wget(PAGE, doc)
    e, r = ws("ws_delete", {"uid": PAGE, "documentId": doc, "expected_version": g2["version"], "dry_run": True})
    check("dry run deletes nothing", not e and r["dry_run"] and common.rest_get(RA, doc)["title"], r)
    e, r = ws("ws_delete", {"uid": PAGE, "documentId": doc, "expected_version": g2["version"]})
    check("delete with the current version ok", not e and r["deleted"] is True and r["previous_version"] == g2["version"], r)
    s, b, _ = spike.rest(RA, "GET", "/api/pages/%s?status=draft" % doc)
    check("document gone", s == 404, s)
    e, r2 = ws("ws_delete", {"uid": PAGE, "documentId": doc, "expected_version": g2["version"]})
    # 1.0 hardening item 16d: the same versioned delete is answered with the first reply (replayed); without the version
    # it is already_absent
    check("deleting again is ok (the same versioned request: the first reply, replayed)", not e and r2.get("replayed") is True and r2["deleted"] is True, r2)
    e, r3 = ws("ws_delete", {"uid": PAGE, "documentId": doc, "force": True})
    check("deleting again (another request) is ok with deleted: false, already_absent: true", not e and r3["deleted"] is False and r3["already_absent"] is True, r3)
    rec = r["recreate"][0]
    check("receipt carries ws_create arguments to recreate", rec["tool"] == "ws_create" and rec["args"]["data"]["note"] == "colleague", rec)
    e, r3 = ws("ws_create", rec["args"])
    g3 = wget(PAGE, r3["documentId"])
    check("recreate gives the same content (new ids)", no_keys(g3["data"]) == no_keys(g2["data"]), [no_keys(g3["data"]), no_keys(g2["data"])])


@T
def t_delete_locales():
    e, c = ws("ws_create", {"uid": GUIDE, "data": {"title": "G %s" % RUN, "items": [{"label": "en", "qty": 1}]}})
    doc = c["documentId"]
    s, b, _ = spike.rest(RA, "PUT", "/api/guides/%s?locale=fr&status=draft" % doc, {"data": {"title": "G fr"}})
    ven, vfr = wget(GUIDE, doc, "en")["version"], wget(GUIDE, doc, "fr")["version"]
    e, r = ws("ws_delete", {"uid": GUIDE, "documentId": doc, "expected_version": ven})
    check("localized type without locale or all_locales refused", e and code(r) == "invalid", r)
    e, r = ws("ws_delete", {"uid": GUIDE, "documentId": doc, "all_locales": True, "expected_version": {"en": ven}})
    check("all_locales with a version map missing a locale -> version_conflict", e and code(r) == "version_conflict" and "fr" in r["error"]["message"], r)
    e, r = ws("ws_delete", {"uid": GUIDE, "documentId": doc, "locale": "fr", "expected_version": vfr})
    check("delete one locale (fr)", not e and r["deleted"] and r["locales"] == ["fr"], r)
    s1, _, _ = spike.rest(RA, "GET", "/api/guides/%s?locale=fr&status=draft" % doc)
    s2, _, _ = spike.rest(RA, "GET", "/api/guides/%s?locale=en&status=draft" % doc)
    check("fr gone, en kept", s1 == 404 and s2 == 200, [s1, s2])
    s, b, _ = spike.rest(RA, "PUT", "/api/guides/%s?locale=fr&status=draft" % doc, {"data": {"title": "G fr again"}})
    ven, vfr = wget(GUIDE, doc, "en")["version"], wget(GUIDE, doc, "fr")["version"]
    e, r = ws("ws_delete", {"uid": GUIDE, "documentId": doc, "all_locales": True, "expected_version": {"en": ven, "fr": vfr}})
    check("all_locales with every version deletes every locale", not e and r["deleted"] and r["locales"] == ["en", "fr"] and len(r["recreate"]) == 2, r)


@T
def t_delete_permissions_and_idempotency():
    doc = common.create_page_mcp("del-perm-" + RUN)
    v = wget(PAGE, doc)["version"]
    e, r = ws("ws_delete", {"uid": PAGE, "documentId": doc, "expected_version": v}, who="agent-nonote")
    check("token without delete permission cannot delete", e, r)
    check("document kept", common.rest_get(RA, doc)["title"])
    key = "del-key-" + RUN
    e1, r1 = ws("ws_delete", {"uid": PAGE, "documentId": doc, "expected_version": v, "idempotency_key": key})
    e2, r2 = ws("ws_delete", {"uid": PAGE, "documentId": doc, "expected_version": v, "idempotency_key": key})
    check("retry with the same key replays the first receipt (deleted: true)", not e1 and not e2 and r2.get("replayed") and r2["deleted"] is True, [r1, r2])
    e, r = ws("ws_delete", {"uid": PAGE, "documentId": common.create_page_mcp("del-force-" + RUN), "force": True})
    check("force: true deletes without a version", not e and r["deleted"], r)


@T
def t_delete_race():
    """A version-checked delete racing a colleague's patch of the same localized draft: either the delete is refused
    (version_conflict) or the patch finds nothing; never both succeed (that would delete a change nobody saw)."""
    bad = []
    for rnd in range(15):
        e, c = ws("ws_create", {"uid": GUIDE, "data": {"title": "race %s %d" % (RUN, rnd)}})
        doc = c["documentId"]
        v = wget(GUIDE, doc, "en")["version"]
        patch = {"uid": GUIDE, "documentId": doc, "set": {"note": "colleague"}, "expected_version": v}   # the colleague read v too
        res = concurrent([lambda: ws("ws_delete", {"uid": GUIDE, "documentId": doc, "locale": "en", "expected_version": v}),
                          lambda: ws("ws_patch", patch, who=B)])
        (e1, r1), (e2, r2) = res
        if not e1 and not e2:
            bad.append({"round": rnd, "delete": r1, "patch": r2})
        elif e1 and code(r1) not in ("version_conflict",) or e2 and code(r2) not in ("not_found", "version_conflict"):
            bad.append({"round": rnd, "unexpected": [r1, r2]})
    check("15 races of delete vs a colleague's patch: never both succeed; refusals are version_conflict / not_found", not bad, bad)


# ------------------------------------------------------------------ ws_bulk

def make_pages(prefix, n, **kw):
    return [common.create_page_mcp("%s-%02d" % (prefix, i), **kw) for i in range(n)]


def dry(tool, args, who=A):
    """The dry run of a job (1.0 hardening item 17: it returns the plan_token a start needs)."""
    return ws(tool, dict(args, dry_run=True), who)


def job(tool, args, who=A, **start):
    """Dry run, then start with its plan_token. `start` adds run arguments (max_chunks, chunk_size, ...) to the start
    only. Returns (err, reply) of the start, or of the dry run when it failed or matched nothing."""
    e, d = dry(tool, args, who)
    if e or not d.get("plan_token"):
        return e, d
    return ws(tool, dict(args, plan_token=d["plan_token"], **start), who)


def job_status(jid, who=A, **kw):
    """ws_job {action: "status"} (phase 4: status_only, items and cursor moved there from ws_bulk / ws_replace)."""
    return ws("ws_job", dict({"action": "status", "job_id": jid}, **kw), who)


def bulk(args, who=A, **start):
    return job("ws_bulk", args, who, **start)


def finish(tool, r, who=A, **kw):
    for _ in range(20):
        if not isinstance(r, dict) or r.get("status") != "running":
            break
        e, r = ws(tool, dict({"job_id": r["job_id"]}, **kw), who)
    return r


def sql(q):
    """One statement against the instance's database (the job tables; read-write)."""
    import sqlite3
    if os.environ.get("SPIKE_MYSQL"):
        pw = json.load(open(os.environ.get("SPIKE_MYSQL_SECRET") or os.path.join(spike.ROOT, ".secrets", "mysql.json")))["password"]
        out = subprocess.run(["docker", "exec", "-i", "-e", "MYSQL_PWD", os.environ["SPIKE_MYSQL_CONTAINER"], "mysql", "-u" + os.environ.get("SPIKE_MYSQL_USER", "root"), "-N", "-B",
                              os.environ.get("SPIKE_DB_NAME", "strapi"), "-e", "SET SESSION sql_mode='ANSI_QUOTES'; " + q], env=dict(os.environ, MYSQL_PWD=pw), capture_output=True, text=True, check=True).stdout
        return [l.split("\t") for l in out.splitlines() if l]
    if os.environ.get("SPIKE_PG"):
        out = subprocess.run(["docker", "exec", os.environ["SPIKE_PG_CONTAINER"], "psql", "-U", os.environ.get("SPIKE_PG_USER", "postgres"), "-d", os.environ.get("SPIKE_DB_NAME", "strapi"), "-At", "-F", "\t", "-c", q],
                             capture_output=True, text=True, check=True).stdout
        return [l.split("\t") for l in out.splitlines() if l]
    c = sqlite3.connect(common.DB, timeout=30)
    try:
        rows = c.execute(q).fetchall()
        c.commit()
        return [[str(x) for x in r] for r in rows]
    finally:
        c.close()


def probe(path, body=None):
    s, b, _ = spike.rest(RA, "POST", "/api/probe/" + path, body or {})
    return b if s == 200 else None


@T
def t_bulk_dry_run_and_run():
    pre = "bk1-%s" % RUN
    docs = make_pages(pre, 7)
    base = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "bulk summary"}}
    e, r = dry("ws_bulk", base)
    check("dry run counts the matches", not e and r["match_count"] == 7 and r["dry_run"] and r["written"] is False, r)
    check("dry run previews 5 changes with before/after, spread first..last", len(r["preview"]) == 5 and r["preview"][0]["before"]["summary"] == "s" and r["preview"][0]["after"]["summary"] == "bulk summary"
          and [p["position"] for p in r["preview"]] == [0, 2, 3, 5, 6], r.get("preview"))
    check("dry run returns a plan_token and its expiry", r.get("plan_token", "").startswith("wsp1.") and r.get("expires_at"), r)
    check("dry run wrote nothing", all(p["summary"] == "s" for p in pages_with(pre)))
    e, r = ws("ws_bulk", dict(base, plan_token=r["plan_token"], chunk_size=3, max_chunks=1))
    check("first call runs one chunk and says running, with a job_id", not e and r["status"] == "running" and r["processed"] == 3 and r["job_id"] and r.get("next"), r)
    check("per-item status for the chunk", [i["status"] for i in r["items"]] == ["ok"] * 3 and all(i["version"] for i in r["items"]), r["items"])
    jid = r["job_id"]
    e, r2 = ws("ws_bulk", {"job_id": jid})
    check("resume with job_id finishes the job", not e and r2["status"] == "done" and r2["processed"] == 7 and r2["totals"]["ok"] == 7, r2)
    check("every page written once", all(p["summary"] == "bulk summary" for p in pages_with(pre)))
    e, r3 = job_status(jid, items="all")
    check("ws_job status items: all lists every item of the job", not e and len(r3["items"]) == 7 and {i["documentId"] for i in r3["items"]} == set(docs) and r3["items_scope"] == "all", r3)
    e, r3b = job_status(jid)
    check("ws_job status by default lists only problems (none here), totals from the job's counters", not e and r3b["items"] == [] and r3b["items_scope"] == "problems" and r3b["totals"]["ok"] == 7, r3b)
    e, r4 = bulk(base)
    check("re-running the same change: every document unchanged (not written again)", not e and r4["totals"].get("unchanged") == 7 and r4["totals"].get("ok") == 0, r4)
    e, r5 = ws("ws_bulk", {"job_id": jid}, who=B)
    check("another token cannot resume or read the job", e and code(r5) == "not_found", r5)


@T
def t_bulk_plan_token():
    """Item 17 (fourth review N17): filter_required unless allow_all; a start needs the dry run's plan token, bound to the
    request, the token holder and the exact matched set; the job id is derived from it."""
    pre = "bkp-%s" % RUN
    docs = make_pages(pre, 3)
    base = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "planned"}}
    for flt in (None, {}):
        a = {"uid": PAGE, "set": {"summary": "everything"}}
        if flt is not None:
            a["filters"] = flt
        e, r = ws("ws_bulk", dict(a, dry_run=True))
        check("no filter (%s) -> filter_required, also on a dry run" % json.dumps(flt), e and code(r) == "filter_required", r)
    e, r = ws("ws_bulk", {"uid": PAGE, "set": {"summary": "everything"}, "allow_all": True, "dry_run": True, "max_documents": 1})
    check("allow_all: true lifts filter_required (here the caller's max_documents refuses the size)", e and code(r) == "too_many_documents", r)
    e, r = ws("ws_bulk", base)
    check("a start without plan_token -> plan_required, nothing written", e and code(r) == "plan_required" and r["error"]["requires_reread"] is False, r)
    e, r = ws("ws_bulk", dict(base, plan_token="wsp1.bogus.token"))
    check("a malformed plan_token -> plan_required", e and code(r) == "plan_required", r)
    e, d = dry("ws_bulk", base)
    tok = d["plan_token"]
    e, r = ws("ws_bulk", dict(base, set={"summary": "other"}, plan_token=tok))
    check("the token of another change -> plan_mismatch (request)", e and code(r) == "plan_mismatch" and r["error"]["reason"] == "request" and r["error"]["requires_reread"], r)
    e, r = ws("ws_bulk", dict(base, filters={"title": {"$startsWith": pre + "-0"}}, plan_token=tok))
    check("the token with another filter -> plan_mismatch (request)", e and code(r) == "plan_mismatch", r)
    e, r = ws("ws_bulk", dict(base, plan_token=tok), who=B)
    check("another API token cannot use this plan -> plan_mismatch", e and code(r) == "plan_mismatch", r)
    late = common.create_page_mcp(pre + "-late")
    e, r = ws("ws_bulk", dict(base, plan_token=tok))
    check("a document entered the filter after the dry run -> plan_mismatch (matches), nothing written", e and code(r) == "plan_mismatch" and r["error"]["reason"] == "matches"
          and r["error"]["planned_count"] == 3 and r["error"]["match_count"] == 4 and all(p["summary"] == "s" for p in pages_with(pre)), r)
    spike.rest(RB, "DELETE", "/api/pages/%s" % late)
    e, r1 = ws("ws_bulk", dict(base, plan_token=tok))
    check("the planned set is back: the start runs", not e and r1["status"] == "done" and r1["totals"]["ok"] == 3, r1)
    e, r2 = ws("ws_bulk", dict(base, plan_token=tok))
    check("the same start again (a lost reply) answers with the same job, resumed, nothing written twice", not e and r2["job_id"] == r1["job_id"] and r2.get("resumed") and r2["totals"]["ok"] == 3, r2)
    e, d2 = dry("ws_bulk", dict(base, set={"summary": "planned-2"}))
    e, r3 = ws("ws_bulk", dict(base, set={"summary": "planned-2"}, plan_token=d2["plan_token"]))
    check("another plan, another job id", not e and r3["job_id"] != r1["job_id"], r3)


@T
def t_bulk_snapshot_rows():
    """Item 18: the id snapshot is stored once as rows of the job tables; the job row keeps a cursor and counters (rc.2
    rewrote the whole job JSON, ids included, after every chunk)."""
    pre = "bks-%s" % RUN
    make_pages(pre, 7)
    e, r = bulk({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "rows"}}, chunk_size=2)
    jid = r.get("job_id")
    check("job done", not e and r["status"] == "done" and r["chunks_done"] == 4, r)
    items = sql("select count(*) from writesafe_bulk_items where job_id = '%s'" % jid)
    check("one item row per document", items and int(items[0][0]) == 7, items)
    states = sql("select state, count(*) from writesafe_bulk_items where job_id = '%s' group by state" % jid)
    check("item rows carry the outcome", dict((a, int(b)) for a, b in states) == {"ok": 7}, states)
    row = sql("select state, \"cursor\", total, n_ok, chunks, slot from writesafe_bulk_jobs where job_id = '%s'" % jid)
    check("the job row: state, cursor, total, counters; no active slot once done", row and row[0][:5] == ["done", "7", "7", "7", "4"] and row[0][5] in ("", "None", "NULL", "\\N"), row)
    old = sql("select count(*) from writesafe_receipts where \"key\" like 'bulkjob:%s%%'" % jid)
    check("no rc.2 job JSON in the receipts table", int(old[0][0]) == 0, old)


@T
def t_bulk_late_matches():
    """Item 18: documents created during the job are never touched; the end report counts them (still_matching,
    late_matches)."""
    pre = "bkl-%s" % RUN
    docs = make_pages(pre, 4)
    e, r = bulk({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "job"}}, chunk_size=2, max_chunks=1)
    check("job running after one chunk", not e and r["status"] == "running", r)
    new = [common.create_page_mcp(pre + "-new-%d" % i) for i in range(2)]
    r = finish("ws_bulk", r)
    check("job done on the planned 4 only", r.get("status") == "done" and r["total"] == 4 and r["totals"]["ok"] == 4, r)
    check("documents created mid-job not touched", all(common.rest_get(RA, d)["summary"] == "s" for d in new))
    rc = r.get("reconcile") or {}
    check("end report: still_matching counts the filter now, late_matches the 2 new ones (named)", rc.get("still_matching") == 6 and rc.get("late_matches") == 2 and set(rc.get("late_ids", [])) == set(new) and rc.get("note"), rc)


@T
def t_bulk_canary():
    """Item 18: the first chunk of a longer job is a canary; when it changes nothing (or fails), the job pauses."""
    pre = "bkc-%s" % RUN
    docs = make_pages(pre, 4)
    for d in docs[:2]:
        common.rest_put(RB, d, {"summary": "target"})
    e, r = bulk({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "target"}}, chunk_size=2)
    check("first chunk changed nothing -> paused_canary (an error the agent must look at)", e and code(r) == "paused_canary" and r["status"] == "paused" and r["processed"] == 2
          and r["paused"]["why"], r)
    jid = r.get("job_id")
    check("the rest is not written while paused", all(common.rest_get(RA, d)["summary"] == "s" for d in docs[2:]))
    e, r2 = ws("ws_bulk", {"job_id": jid})
    check("{job_id} alone does not resume a paused job", e and code(r2) == "paused_canary" and r2["processed"] == 2, r2)
    e, r3 = ws("ws_bulk", {"job_id": jid, "control": "resume"})
    check("control: resume continues to the end", not e and r3["status"] == "done" and r3["totals"]["ok"] == 2 and r3["totals"]["unchanged"] == 2, r3)


@T
def t_bulk_one_job_per_type_and_cancel():
    """Item 18: one active job per token and content type; cancel."""
    pre = "bkj-%s" % RUN
    docs = make_pages(pre, 6)
    a1 = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "first"}}
    e, r1 = bulk(a1, chunk_size=2, max_chunks=1)
    j1 = r1.get("job_id")
    check("job 1 running", not e and r1["status"] == "running", r1)
    a2 = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"note": "second"}}
    e, d2 = dry("ws_bulk", a2)
    e, r2 = ws("ws_bulk", dict(a2, plan_token=d2["plan_token"]))
    check("a second job of the same token on the same type -> job_running naming job 1", e and code(r2) == "job_running" and r2["error"]["job_id"] == j1, r2)
    e, rb = bulk(a2, who=B, chunk_size=6)
    check("another token's job on the same type is not blocked", not e and rb["status"] == "done", rb)
    e, c = ws("ws_job", {"action": "cancel", "job_id": j1})
    check("ws_job cancel: status cancelled", not e and c["status"] == "cancelled" and c["processed"] == 2 and c.get("cancelled") is True, c)
    check("documents after the cancel are not written", [common.rest_get(RA, d)["summary"] for d in docs] == ["first"] * 2 + ["s"] * 4)
    e, r = ws("ws_bulk", {"job_id": j1})
    check("a cancelled job cannot be resumed", e and code(r) == "job_cancelled", r)
    e, r2b = ws("ws_bulk", dict(a2, plan_token=d2["plan_token"]))
    check("after the cancel, the waiting plan starts", not e and r2b["status"] == "done", r2b)


@T
def t_bulk_events_and_undoable_in_dry_run():
    """Item 18: the dry run says how many events the job fires and whether ws_undo can revert it."""
    pre = "bke-%s" % RUN
    make_pages(pre, 3)
    e, r = dry("ws_bulk", {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "e"}})
    check("patch: entry.update, at most one per document", not e and r["events"]["per_document"] == ["entry.update"] and r["events"]["at_most"] == 3, r.get("events"))
    e, r = dry("ws_bulk", {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "action": "publish"})
    check("publish: entry.publish; not undoable", not e and r["events"]["per_document"] == ["entry.publish"] and r["events"]["at_most"] == 3 and r["undoable"] is False, r)


@T
def t_bulk_rows_and_publish():
    pre = "bk2-%s" % RUN
    docs = make_pages(pre, 4)
    before = {d: wget(PAGE, d)["rows"]["items"] for d in docs}
    e, r = bulk({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "ops": [{"op": "add", "field": "items", "data": {"label": "bulk-row", "qty": 9}, "position": "start"}]})
    check("bulk add-row op ok", not e and r["totals"]["ok"] == 4, r)
    ok_rows = all(wget(PAGE, d)["rows"]["items"][1:] == before[d] and wget(PAGE, d)["data"]["items"][0]["label"] == "bulk-row" for d in docs)
    check("existing rows keep their keys; the new row is first", ok_rows)
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "ops": [{"op": "update", "field": "items", "key": "x", "data": {}}], "dry_run": True})
    check("keyed row ops refused in bulk (keys differ per document)", e and code(r) == "invalid", r)
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "action": "publish", "set": {"note": "x"}, "dry_run": True})
    check("publish with set refused", e and code(r) == "invalid", r)
    e, r = bulk({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "action": "publish"})
    check("bulk publish ok", not e and r["totals"]["ok"] == 4 and all(i.get("published_version") for i in r["items"]), r)
    pub = rest_list("pages", "status=published&filters[title][$startsWith]=%s&pagination[pageSize]=50" % pre)
    check("all four published", len(pub) == 4, len(pub))


@T
def t_bulk_publish_binds_draft_version():
    """Item 19 (ChatGPT): bulk publish binds each document's exact draft version; a newer draft is a conflict for that
    document and is never published in its place."""
    pre = "bkv-%s" % RUN
    docs = make_pages(pre, 4)
    a = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "action": "publish"}
    e, d = dry("ws_bulk", a)
    common.rest_put(RB, docs[1], {"summary": "edited after the dry run"})
    e, r = ws("ws_bulk", dict(a, plan_token=d["plan_token"]))
    check("a draft edited between dry run and start -> plan_mismatch (matches), nothing published", e and code(r) == "plan_mismatch" and r["error"]["reason"] == "matches"
          and not rest_list("pages", "status=published&filters[title][$startsWith]=%s&pagination[pageSize]=50" % pre), r)
    e, d = dry("ws_bulk", a)
    e, r = ws("ws_bulk", dict(a, plan_token=d["plan_token"], chunk_size=1, max_chunks=1))
    check("job started; first document published", not e and r["status"] == "running" and r["items"][0]["status"] == "ok", r)
    common.rest_put(RB, docs[2], {"summary": "a newer draft"})
    r = finish("ws_bulk", r)
    st = {i["documentId"]: i for i in r.get("items", [])}
    check("the newer draft is a conflict for that document; the job goes on", r.get("status") == "done" and st[docs[2]]["status"] == "conflict" and st[docs[2]]["error"]["code"] == "version_conflict"
          and r["totals"]["ok"] == 3 and r["totals"]["conflict"] == 1 and [c["documentId"] for c in r.get("conflicts", [])] == [docs[2]], r)
    pub = {p["documentId"]: p for p in rest_list("pages", "status=published&filters[title][$startsWith]=%s&pagination[pageSize]=50" % pre)}
    check("the newer draft was not published; the others were (with the reviewed content)", set(pub) == {docs[0], docs[1], docs[3]} and pub[docs[1]]["summary"] == "edited after the dry run", list(pub))


@T
def t_bulk_savepoint_per_item():
    """Item 22 (N8): in mode continue a failing document is rolled back to its own savepoint; the chunk is not re-run, so
    the other documents of the chunk are written once (rc.2 re-ran the chunk once per failing document)."""
    f = probe("features")
    if not f:
        print("SKIP t_bulk_savepoint_per_item (no probe plugin)")
        return
    pre = "bksp-%s" % RUN
    docs = make_pages(pre, 4)
    common.rest_put(RB, docs[1], {"title": None})
    flt = {"$or": [{"title": {"$startsWith": pre}}, {"documentId": {"$eq": docs[1]}}]}
    before = probe("lifecycle-counts", {"documentIds": docs})["counts"]
    e, r = bulk({"uid": PAGE, "filters": flt, "action": "publish", "mode": "continue"}, chunk_size=4)
    check("continue: 3 published, 1 failed, in one chunk", not e and r["status"] == "done" and r["totals"]["ok"] == 3 and r["totals"]["failed"] == 1 and r["chunks_done"] == 1, r)
    after = probe("lifecycle-counts", {"documentIds": docs})["counts"]
    n = {d: after[d] - before[d] for d in docs}
    if not f.get("savepoint"):
        print("NOTE t_bulk_savepoint_per_item: this Strapi has no db.savepoint; the chunk re-run (rc.2) is the fallback: %s" % n)
        check("no savepoints: fallback re-run still writes each document once in the end", n[docs[0]] >= n[docs[2]] == n[docs[3]] > 0, n)
        return
    check("the document before the failing one was written once, like the ones after it (no chunk re-run)", n[docs[0]] == n[docs[2]] == n[docs[3]] > 0, n)


@T
def t_bulk_colleague_mid_job():
    pre = "bk3-%s" % RUN
    docs = make_pages(pre, 6)
    flt = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "agent"}}
    e, r = bulk(flt, chunk_size=2, max_chunks=1)
    jid = r["job_id"]
    # Between chunks: a colleague edits doc 3 (note + a new section), retitles doc 4 out of the filter, deletes doc 5.
    cur = common.rest_get(RB, docs[2])
    common.rest_put(RB, docs[2], {"note": "colleague", "sections": cur["sections"] + [{"__component": "blocks.text", "body": "COLLEAGUE"}]})
    common.rest_put(RB, docs[3], {"title": "moved-away-" + RUN})
    spike.rest(RB, "DELETE", "/api/pages/%s" % docs[4])
    e, r2 = ws("ws_bulk", {"job_id": jid})
    st = {i["documentId"]: i for i in r2["items"]}
    check("job finishes", not e and r2["status"] == "done", r2)
    v3 = common.rest_get(RA, docs[2])
    check("colleague's edit kept and agent's change applied on the same document", v3["note"] == "colleague" and v3["summary"] == "agent" and "COLLEAGUE" in json.dumps(v3["sections"]), v3)
    check("document that no longer matches the filter is skipped, not written", st[docs[3]]["status"] == "skipped" and st[docs[3]]["reason"] == "no_longer_matches" and common.rest_get(RA, docs[3])["summary"] == "s", st.get(docs[3]))
    check("deleted document is skipped", st[docs[4]]["status"] == "skipped" and st[docs[4]]["reason"] == "deleted", st.get(docs[4]))
    check("totals: 4 ok, 2 skipped", r2["totals"]["ok"] == 4 and r2["totals"]["skipped"] == 2, r2["totals"])
    e, s = job_status(jid)
    check("ws_job status (problems) lists the 2 skipped documents with their reasons", not e and sorted((i["documentId"], i["reason"]) for i in s["items"]) == sorted([(docs[3], "no_longer_matches"), (docs[4], "deleted")]), s)


@T
def t_bulk_concurrent_colleagues():
    """A job runs while colleagues keep adding sections to the same pages through REST: no colleague row may be lost and
    every page must get the agent's change."""
    pre = "bk4-%s" % RUN
    docs = make_pages(pre, 8)
    stop = threading.Event()
    added = []
    lock = threading.Lock()

    def colleague(i):
        n = 0
        while not stop.is_set():
            d = docs[(i + n) % len(docs)]
            cur = common.rest_get(RB, d)
            tag = "COL-%d-%d" % (i, n)
            s, b, _ = common.rest_put(RB, d, {"sections": common.strip_ids(cur["sections"]) + [{"__component": "blocks.text", "body": tag}]})
            if s == 200:
                with lock:
                    added.append((d, tag))
            n += 1
    args = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "ops": [{"op": "add", "field": "items", "data": {"label": "agent-row", "qty": 1}}], "mode": "continue"}
    e, d = dry("ws_bulk", args)
    ts = [threading.Thread(target=colleague, args=(i,), daemon=True) for i in range(2)]
    [t.start() for t in ts]
    try:
        e, r = ws("ws_bulk", dict(args, plan_token=d.get("plan_token"), chunk_size=2))
        time.sleep(0.3)
    finally:
        stop.set()  # also when the call fails: the colleagues must not run on after the test
        [t.join() for t in ts]
    check("job done under concurrent edits", not e and r["status"] == "done" and r["totals"]["ok"] == 8, r)
    # REST colleagues resend the whole zone (that is how the REST API works), so a colleague can drop another colleague's
    # row; what must hold is that the AGENT never drops one: the last sections state per page holds the agent's... item.
    lost_agent = [d for d in docs if sum(1 for it in common.rest_get(RA, d)["items"] if it["label"] == "agent-row") != 1]
    check("every page has exactly one agent row", not lost_agent, lost_agent)
    final = {d: json.dumps(common.rest_get(RA, d)["sections"]) for d in docs}
    last_tag = {}
    for d, tag in added:
        last_tag[d] = tag
    missing = [(d, t) for d, t in last_tag.items() if t not in final[d]]
    check("each page's last colleague section survived the job (%d colleague writes)" % len(added), not missing and len(added) > 0, missing)


@T
def t_bulk_stop_and_continue():
    pre = "bk5-%s" % RUN
    docs = make_pages(pre, 5)
    # A draft without its required title cannot be published: doc 3 fails the publish.
    common.rest_put(RB, docs[2], {"title": None})
    # its title is gone, so match it by documentId too: filter on a $or
    flt = {"$or": [{"title": {"$startsWith": pre}}, {"documentId": {"$eq": docs[2]}}]}
    e, r = bulk({"uid": PAGE, "filters": flt, "action": "publish"}, chunk_size=2)
    check("stop_on_error: the call is an error (job_stopped) naming the document", e and code(r) == "job_stopped" and r["error"]["documentId"] == docs[2], r)
    # review item 8: the message is the plugin's own text; the item's error (Strapi's or the driver's) stays in `cause`
    check("job_stopped message does not quote the item's error (it is in cause)", r["error"].get("cause", {}).get("message", "x") not in r["error"]["message"], r["error"])
    check("stop_on_error: documents before it are written, it and the rest are not", r.get("status") == "stopped" and r.get("processed") == 2
          and [i["status"] for i in r["items"]] == ["ok", "ok", "failed", "not_attempted"], r.get("items"))
    # review L1: the stopping document is a counted, listed failure while the job is stopped
    check("the stopping document is counted in totals.failed and listed in failures", r.get("totals", {}).get("failed") == 1
          and [f["documentId"] for f in r.get("failures", [])] == [docs[2]], r)
    e, sp = job_status(r["job_id"])
    check("ws_job status (problems) lists the stopping document", [(i["documentId"], i["status"]) for i in sp.get("items", [])] == [(docs[2], "failed")], sp)
    e, wrong = ws("ws_replace", {"job_id": r["job_id"]})
    check("a ws_bulk job is not found through ws_replace (review L3)", e and code(wrong) == "not_found", wrong)
    pub = {p["documentId"] for p in rest_list("pages", "status=published&filters[title][$startsWith]=%s&pagination[pageSize]=50" % pre)}
    check("published: the first two only", pub == set(docs[:2]), pub)
    e, s = job_status(r["job_id"], items="all")
    check("ws_job status (an error reply while the job is stopped) shows the stopped document as failed and the rest not attempted", code(s) == "job_stopped" and [i["status"] for i in s["items"]] == ["ok", "ok", "failed", "not_attempted", "not_attempted"], s)
    common.rest_put(RB, docs[2], {"title": pre + "-fixed"})
    e, r2 = ws("ws_bulk", {"job_id": r["job_id"]})
    # item 19: the fixed draft is newer than the one the plan bound, so it is a conflict, not published
    check("after the fix, resume retries from the failed document: its newer draft is a conflict (item 19), the rest is published", not e and r2["status"] == "done"
          and r2["totals"]["ok"] == 4 and r2["totals"]["conflict"] == 1 and r2["totals"]["failed"] == 0, r2)
    pre2 = "bk6-%s" % RUN
    docs2 = make_pages(pre2, 5)
    common.rest_put(RB, docs2[1], {"title": None})
    flt2 = {"$or": [{"title": {"$startsWith": pre2}}, {"documentId": {"$eq": docs2[1]}}]}
    e, r3 = bulk({"uid": PAGE, "filters": flt2, "action": "publish", "mode": "continue"}, chunk_size=2)
    check("continue: the failure in the first chunk pauses the job (canary)", e and code(r3) == "paused_canary" and r3["totals"]["ok"] == 1 and r3["totals"]["failed"] == 1, r3)
    e, r3 = ws("ws_bulk", {"job_id": r3["job_id"], "control": "resume"})
    check("continue: resumed, the job finishes with 4 ok and 1 failed, listed", not e and r3["status"] == "done" and r3["totals"]["ok"] == 4 and r3["totals"]["failed"] == 1
          and r3["failures"][0]["documentId"] == docs2[1], r3)
    pub2 = {p["documentId"] for p in rest_list("pages", "status=published&filters[title][$startsWith]=%s&pagination[pageSize]=50" % pre2)}
    check("continue: the other documents of the failing chunk were published", pub2 == set(docs2) - {docs2[1]}, pub2)


@T
def t_bulk_guards():
    pre = "bk7-%s" % RUN
    make_pages(pre, 4)
    base = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "g"}}
    e, r = dry("ws_bulk", dict(base, max_documents=3))
    check("more matches than max_documents -> too_many_documents, nothing written", e and code(r) == "too_many_documents" and r["error"]["match_count"] == 4, r)
    e, d = dry("ws_bulk", base)
    e, r = ws("ws_bulk", dict(base, plan_token=d["plan_token"], expected_count=3))
    check("expected_count differs -> count_changed", e and code(r) == "count_changed", r)
    check("nothing written by refused jobs", all(p["summary"] == "s" for p in pages_with(pre)))
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": {"note": {"$eq": "n0"}}, "set": {"summary": "g"}, "dry_run": True}, who="agent-noread")
    check("filter on a field the token cannot read is refused (no count oracle)", e and code(r) == "invalid", r)
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"nmae": 1}})
    check("unknown field refused before any write", e and code(r) == "invalid", r)
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": {"titel": {"$eq": "x"}}, "set": {"summary": "g"}, "dry_run": True})
    check("unknown filter field refused", e and code(r) == "invalid", r)
    e, r = ws("ws_bulk", {"job_id": "jdoesnotexist"})
    check("unknown job_id -> not_found", e and code(r) == "not_found", r)
    e, r = bulk({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"note": "x"}, "mode": "continue"}, who="agent-nonote")
    check("a field the token may not write: every item failed with forbidden", r.get("totals", {}).get("failed") == 4 and len(r.get("failures", [])) == 4 and all(f["error"]["code"] == "forbidden" for f in r.get("failures", [])), r)
    check("nothing written by the forbidden job", all(p["note"] == "n0" for p in pages_with(pre)))
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "g"}, "idempotency_key": "k" * 10})
    check("idempotency_key is gone from ws_bulk (the plan token is the key)", e, r)


@T
def t_bulk_idempotent_start():
    pre = "bk8-%s" % RUN
    docs = make_pages(pre, 3)
    a = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "ops": [{"op": "add", "field": "items", "data": {"label": "idem-row", "qty": 1}}]}
    e, d = dry("ws_bulk", a)
    e1, r1 = ws("ws_bulk", dict(a, plan_token=d["plan_token"]))
    e2, r2 = ws("ws_bulk", dict(a, plan_token=d["plan_token"]))
    check("same plan token twice: same job, second call does not write again", not e1 and not e2 and r1["job_id"] == r2["job_id"] and r2.get("resumed") and r2["totals"]["ok"] == 3, [r1, r2])
    check("each page got the row once", all(sum(1 for it in common.rest_get(RA, d_)["items"] if it["label"] == "idem-row") == 1 for d_ in docs))
    pre2 = "bk9-%s" % RUN
    docs2 = make_pages(pre2, 6)
    a2 = {"uid": PAGE, "filters": {"title": {"$startsWith": pre2}}, "ops": [{"op": "add", "field": "items", "data": {"label": "race-row", "qty": 1}}]}
    e, d2 = dry("ws_bulk", a2)
    res = concurrent([lambda: ws("ws_bulk", dict(a2, plan_token=d2["plan_token"], chunk_size=1))] * 3)
    res = [finish("ws_bulk", r) for e_, r in res]
    counts = [sum(1 for it in common.rest_get(RA, d_)["items"] if it["label"] == "race-row") for d_ in docs2]
    check("3 simultaneous identical starts (and resumes) write each page exactly once", counts == [1] * 6, [counts, res])


N_KILL = int(os.environ.get("BULK_KILL_DOCS", "150"))


@T
def t_bulk_resume_after_kill():
    cmd, pidf = os.environ.get("BULK_RESTART_CMD"), os.environ.get("BULK_PID_FILE")
    if not cmd or not pidf:
        print("SKIP t_bulk_resume_after_kill (no BULK_RESTART_CMD)")
        return
    pre = "bk10-%s" % RUN
    docs = make_pages(pre, N_KILL)

    def written():
        s_, b_, _ = spike.rest(RA, "GET", "/api/pages?status=draft&filters[title][$startsWith]=%s&filters[items][label][$eq]=kill-row&pagination[pageSize]=1" % pre)
        return b_["meta"]["pagination"]["total"]
    a = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "ops": [{"op": "add", "field": "items", "data": {"label": "kill-row", "qty": 1}}]}
    e, d = dry("ws_bulk", a)
    a = dict(a, plan_token=d["plan_token"], chunk_size=1)
    out = {}

    def run():
        try:
            out["r"] = ws("ws_bulk", a)
        except Exception as ex:
            out["x"] = str(ex)
    t = threading.Thread(target=run)
    t.start()
    # Let a few chunks commit, then kill Strapi hard (time-based: on SQLite a status read would queue behind the job).
    time.sleep(float(os.environ.get("BULK_KILL_AFTER", "0.5")))
    # Kill only this instance: the npx wrapper from the pid file and whatever listens on this test's port.
    port = spike.BASE.rsplit(":", 1)[1].split("/")[0]
    pids = subprocess.run(["lsof", "-ti", "tcp:%s" % port, "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split()
    for pid in pids + [open(pidf).read().strip()]:
        try:
            os.kill(int(pid), signal.SIGKILL)
        except (ProcessLookupError, ValueError):
            pass
    t.join(timeout=60)
    time.sleep(1)
    subprocess.run(cmd, shell=True, check=True, stdout=subprocess.DEVNULL)
    written_before = written()
    check("the job was interrupted part way", 0 < written_before < N_KILL, written_before)
    e, r = ws("ws_bulk", a)  # the same start (same plan token): resumes the interrupted job
    r = finish("ws_bulk", r)
    counts = [sum(1 for it in common.rest_get(RA, d_)["items"] if it["label"] == "kill-row") for d_ in docs]
    check("after kill -9 and restart, resuming finishes the job", not e and r["status"] == "done", r)
    check("every page has the row exactly once (no chunk written twice or lost; %d were written before the kill)" % written_before, counts == [1] * N_KILL, counts)
    e, s = job_status(r["job_id"], items="all")
    ids = [i["documentId"] for i in s["items"]]
    while s.get("items_next"):
        e, s = job_status(r["job_id"], items="all", cursor=s["items_next"]["cursor"])
        ids += [i["documentId"] for i in s["items"]]
    check("the item rows list each document once", sorted(ids) == sorted(docs), len(ids))


@T
def t_bulk_review_findings():
    pre = "bk11-%s" % RUN
    docs = make_pages(pre, 3)
    common.rest_put(RB, docs[1], {"note": "special-" + RUN})
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": {"$and": [{"title": {"$startsWith": pre}}, {"note": {"$eq": "special-" + RUN}}]}, "set": {"summary": "x"}, "dry_run": True}, who="agent-nonote")
    check("filter on a field the token can read but not update still narrows the job (1 match, not 3)", not e and r["match_count"] == 1, r)
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": {"documentId": {"$eq": docs[0]}}, "set": {"note": "n0"}, "dry_run": True}, who="agent-noread")
    check("a correct guess of a field the token cannot read is not confirmed as 'unchanged'", not e and r["preview"][0]["status"] == "ok", r)
    a = {"uid": PAGE, "filters": {"$and": [{"title": {"$startsWith": pre}}, {"summary": {"$eq": "s"}}]}, "set": {"summary": "done"}}
    e, d = dry("ws_bulk", a)
    s1 = dict(a, plan_token=d["plan_token"], chunk_size=1, max_chunks=1, expected_count=3)
    e1, r1 = ws("ws_bulk", s1)
    e2, r2 = ws("ws_bulk", s1)
    check("retrying a started job with the same plan token resumes it even though written documents no longer match", not e1 and not e2 and r2["job_id"] == r1["job_id"] and r2.get("resumed") and r2["processed"] == 2, [r1, r2])
    b_ = dict(s1); b_.pop("max_chunks")
    e3, r3 = ws("ws_bulk", b_)
    check("... and finishes it (3 written once)", not e3 and r3["status"] == "done" and r3["totals"]["ok"] == 3 and all(p["summary"] == "done" for p in pages_with(pre)), r3)
    check("... and the end report sees the self-excluding filter empty", r3.get("reconcile", {}).get("still_matching") == 0 and r3["reconcile"]["late_matches"] == 0, r3.get("reconcile"))
    e, c = ws("ws_create", {"uid": STORY, "data": {"title": "Media %s" % RUN, "externalId": "md-" + RUN}})
    v = wget(STORY, c["documentId"])["version"]
    e, r = ws("ws_delete", {"uid": STORY, "documentId": c["documentId"], "locale": "en", "expected_version": v})
    e2, r2 = ws("ws_create", r["recreate"][0]["args"]) if not e else (True, None)
    check("recreate works for a type with a media field", not e and not e2 and r2["created"], [r, r2])


# ------------------------------------------------------------------ ws_replace

def acme_page(title):
    d = common.page_data(title)
    d["summary"] = "Acme makes things. ACME!"
    d["seo"] = {"metaTitle": "Acme meta", "metaDescription": "about acme"}
    d["items"] = [{"label": "Acme widget", "qty": 1}, {"label": "plain", "qty": 2}]
    d["sections"] = [{"__component": "blocks.hero", "heading": "Acme hero"}, {"__component": "blocks.text", "body": "Buy Acme now, Acme rocks"},
                     {"__component": "blocks.cta", "label": "go", "url": "https://acme.test/"}]
    d["body"] = [common.para("Intro to Acme"), {"type": "paragraph", "children": [{"type": "text", "text": "x "}, {"type": "text", "text": "Acme bold", "bold": True}]}]
    err, r, _, _ = spike.tool(A, "create_page", {"data": d})
    if err:
        raise RuntimeError(r)
    return r["data"]["documentId"]


def replace(args, who=A, **start):
    return job("ws_replace", args, who, **start)


@T
def t_replace_dry_run_and_run():
    pre = "rp1-%s" % RUN
    docs = [acme_page("%s-%d" % (pre, i)) for i in range(3)]
    plain = common.create_page_mcp(pre + "-plain")
    keys0 = {d: wget(PAGE, d)["rows"] for d in docs}
    a = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "find": "Acme", "replace": "Apex"}
    e, r = dry("ws_replace", a)
    check("dry run: documents and matches counted (case-sensitive)", not e and r["documents_matched"] == 3 and r["scanned"] == 4 and r["matches"] == 3 * 8 and r["scan_limit"] == 5000, r)
    check("dry run: matches by path include component, zone and blocks paths",
          r["matches_by_path"] == {"summary": 3, "seo.metaTitle": 3, "items.label": 3, "sections.heading": 3, "sections.body": 6, "body": 6}, r.get("matches_by_path"))
    check("dry run: samples with before/after and row keys", r["samples"] and r["samples"][0]["before"] != r["samples"][0]["after"] and any("key" in s for s in r["samples"]), r.get("samples"))
    check("dry run: a plan_token for the 3 documents with a match", r.get("plan_token") and r["match_count"] == 3, r)
    check("dry run wrote nothing", "Acme" in common.rest_get(RA, docs[0])["summary"])
    e, r0 = ws("ws_replace", a)
    check("a start without plan_token -> plan_required", e and code(r0) == "plan_required", r0)
    e, r2 = ws("ws_replace", dict(a, plan_token=r["plan_token"]))
    check("run replaces every match", not e and r2["status"] == "done" and r2["totals"]["ok"] == 3 and all(i["replaced"] == 8 for i in r2["items"]), r2)
    v = common.rest_get(RA, docs[0])
    blob = json.dumps({k: v[k] for k in ("summary", "seo", "items", "sections", "body")})
    check("no Acme left in the replaced fields; ACME (other case) and URL kept", "Acme" not in blob and "ACME" in blob and "acme.test" in blob and "about acme" in blob, blob)
    check("blocks formatting kept (bold flag)", v["body"][1]["children"][1] == {"type": "text", "text": "Apex bold", "bold": True}, v["body"])
    k1 = wget(PAGE, docs[0])["rows"]
    check("component and zone rows keep their keys (ids)", ident(k1["items"]) == ident(keys0[docs[0]]["items"]) and ident(k1["sections"]) == ident(keys0[docs[0]]["sections"]), [k1, keys0[docs[0]]])
    check("the document without matches was not part of the job", plain not in [i["documentId"] for i in r2["items"]])


@T
def t_replace_scope_regex_and_safety():
    pre = "rp2-%s" % RUN
    d = acme_page(pre)
    e, r = replace({"uid": PAGE, "filters": {"title": {"$eq": pre}}, "fields": ["items.label"], "find": "Acme", "replace": "Zed"})
    v = common.rest_get(RA, d)
    check("fields scope: only items.label changed", not e and v["items"][0]["label"] == "Zed widget" and "Acme" in v["summary"] and "Acme" in v["seo"]["metaTitle"], [r, v["items"], v["summary"]])
    e, r = replace({"uid": PAGE, "filters": {"title": {"$eq": pre}}, "fields": ["summary"], "find": "acme", "replace": "Acme Corp", "case_sensitive": False})
    check("case-insensitive literal", not e and common.rest_get(RA, d)["summary"] == "Acme Corp makes things. Acme Corp!", common.rest_get(RA, d)["summary"])
    e, r = replace({"uid": PAGE, "filters": {"title": {"$eq": pre}}, "fields": ["sections.body"], "find": r"Buy (\w+) now", "replace": "Get $1 today", "regex": True})
    check("regex with a group reference", not e and "Get Acme today, Acme rocks" in json.dumps(common.rest_get(RA, d)["sections"]), r)
    common.rest_put(RB, d, {"summary": "a" * 40 + "!"})
    t0 = time.time()
    e, r = ws("ws_replace", {"uid": PAGE, "filters": {"title": {"$eq": pre}}, "fields": ["summary"], "find": "(a+)+$", "replace": "", "regex": True, "dry_run": True})
    check("catastrophic backtracking is stopped by the time limit (regex_timeout)", e and code(r) == "regex_timeout" and time.time() - t0 < 10, [r, time.time() - t0])
    e, r = ws("ws_replace", {"uid": PAGE, "find": "x*", "replace": "y", "regex": True, "dry_run": True})
    check("a pattern matching empty text refused", e and code(r) == "invalid", r)
    e, r = ws("ws_replace", {"uid": PAGE, "find": "([", "replace": "y", "regex": True, "dry_run": True})
    check("an invalid regex refused", e and code(r) == "invalid", r)
    e, r = ws("ws_replace", {"uid": PAGE, "find": "a", "replace": "b", "fields": ["seo.nope"], "dry_run": True})
    check("an unknown text path refused with the allowed list", e and code(r) == "invalid" and "items.label" in r["error"]["allowed"], r)


@T
def t_replace_hidden_fields():
    pre = "rp3-%s" % RUN
    d = acme_page(pre)
    common.rest_put(RB, d, {"note": "Acme secret"})
    e, r = ws("ws_replace", {"uid": PAGE, "filters": {"title": {"$eq": pre}}, "find": "Acme", "replace": "Apex", "dry_run": True}, who="agent-noread")
    paths = r.get("matches_by_path", {})
    check("a token that cannot read note/items/seo.metaDescription gets no matches there", not e and "note" not in paths and "items.label" not in paths and "summary" in paths, r)
    e, r = ws("ws_replace", {"uid": PAGE, "filters": {"note": {"$contains": "Acme"}}, "find": "Acme", "replace": "Apex", "dry_run": True}, who="agent-noread")
    check("filtering on a field the token cannot read is refused", e and code(r) == "invalid", r)
    # hardening item 6 (Gemini review): explicit fields are checked in the plan, so the dry run already says it
    e, r = ws("ws_replace", {"uid": PAGE, "filters": {"title": {"$eq": pre}}, "fields": ["note"], "find": "Acme", "replace": "Apex", "dry_run": True}, who="agent-nonote")
    check("dry run with an explicit field the token cannot write -> forbidden up front, naming it", e and code(r) == "forbidden" and r["error"].get("fields") == ["note"], r)
    e, r = ws("ws_replace", {"uid": PAGE, "filters": {"title": {"$eq": pre}}, "fields": ["note"], "find": "Acme", "replace": "Apex"}, who="agent-nonote")
    check("replacing in a field the token cannot write: refused before any job starts, nothing written", e and code(r) == "forbidden" and "job_id" not in r and common.rest_get(RA, d)["note"] == "Acme secret", r)


@T
def t_replace_colleague_between_dry_run_and_run():
    pre = "rp4-%s" % RUN
    d1, d2, d3 = acme_page(pre + "-a"), acme_page(pre + "-b"), acme_page(pre + "-c")
    a = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "fields": ["summary", "sections.body"], "find": "Acme", "replace": "Apex"}
    e, r = dry("ws_replace", a)
    check("dry run sees 3 documents", r["documents_matched"] == 3, r)
    tok = r["plan_token"]
    e, r = ws("ws_replace", dict(a, plan_token=tok, chunk_size=1, max_chunks=1))
    check("job started; first document done", not e and r["status"] == "running" and r["items"][0]["documentId"] == d1, r)
    # Between chunks: the colleague fixes d2 by hand, and adds a new Acme row to d3.
    common.rest_put(RB, d2, {"summary": "fixed by colleague", "sections": [{"__component": "blocks.text", "body": "colleague"}]})
    cur3 = common.rest_get(RB, d3)
    common.rest_put(RB, d3, {"sections": cur3["sections"] + [{"__component": "blocks.text", "body": "new Acme row by colleague"}]})
    e, r = ws("ws_replace", {"job_id": r["job_id"]})
    st = {i["documentId"]: i for i in r.get("items", [])}
    check("document the colleague already fixed: unchanged (computed from its current text)", not e and st[d2]["status"] == "unchanged" and common.rest_get(RA, d2)["summary"] == "fixed by colleague", r)
    v3 = json.dumps(common.rest_get(RA, d3)["sections"])
    check("colleague's new row is kept and also replaced (current text at write time)", "new Apex row by colleague" in v3 and "Buy Apex now, Apex rocks" in v3 and "Acme hero" in v3, v3)
    common.rest_put(RB, d1, {"summary": "Acme again"})
    e, r = ws("ws_replace", dict(a, plan_token=tok))
    check("the old plan's start again only answers with its (finished) job; nothing written", not e and r.get("resumed") and r["status"] == "done" and common.rest_get(RA, d1)["summary"] == "Acme again", r)
    e, d = dry("ws_replace", a)
    common.rest_put(RB, d2, {"summary": "Acme too"})
    e, r = ws("ws_replace", dict(a, plan_token=d["plan_token"]))
    check("a document gained a match after the dry run -> plan_mismatch, nothing written", e and code(r) == "plan_mismatch" and common.rest_get(RA, d1)["summary"] == "Acme again", r)


# ------------------------------------------------------------------ copy op

@T
def t_copy_in_place():
    doc = common.create_page_mcp("cp1-" + RUN)
    g = wget(PAGE, doc)
    s0 = g["rows"]["sections"]
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "sections", "key": s0[1]}]})
    g2 = wget(PAGE, doc)
    s1 = g2["rows"]["sections"]
    check("copy ok, receipt lists the new row key", not e and len(r["rows"]["sections"]["added"]) == 1, r)
    check("duplicate placed right after its source, with a new id", s1[:2] == s0[:2] and s1[2] == r["rows"]["sections"]["added"][0] and s1[2] not in s0 and s1[3:] == s0[2:], [s0, s1])
    check("duplicate has the same content", no_keys(g2["data"]["sections"][2]) == no_keys(g2["data"]["sections"][1]), g2["data"]["sections"])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "items", "keys": [g2["rows"]["items"][0], g2["rows"]["items"][2]], "position": "start"}]})
    g3 = wget(PAGE, doc)
    labels = [x["label"] for x in g3["data"]["items"]]
    check("several keys copied in order at a position", not e and labels == ["item 0", "item 2", "item 0", "item 1", "item 2"], labels)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "body", "key": g3["rows"]["body"][0], "position": "end"}]})
    b = common.rest_get(RA, doc)["body"]
    check("a blocks node can be copied", not e and b[-1] == b[0] and len(b) == 3, b)


@T
def t_copy_between_documents_and_locales():
    a1 = ws("ws_create", {"uid": "api::author.author", "data": {"name": "Ann %s" % RUN}})[1]["documentId"]
    a2 = ws("ws_create", {"uid": "api::author.author", "data": {"name": "Bob %s" % RUN}})[1]["documentId"]
    src = ws("ws_create", {"uid": PAGE, "data": {"title": "cp-src-" + RUN, "credits": [{"role": "writer", "author": a1, "reviewers": [a1, a2]}],
                                                 "sections": [{"__component": "blocks.quote", "text": "q", "author": a2}]}})[1]["documentId"]
    dst = common.create_page_mcp("cp-dst-" + RUN)
    gs = wget(PAGE, src)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": dst, "ops": [
        {"op": "copy", "field": "credits", "key": gs["rows"]["credits"][0], "from": {"documentId": src}},
        {"op": "copy", "field": "sections", "key": gs["rows"]["sections"][0], "from": {"documentId": src}, "position": "start"}]})
    gd = wget(PAGE, dst)
    check("rows copied from another document", not e and len(gd["data"]["credits"]) == 1, r)
    check("relations kept in the copy (to-one and to-many)", gd["data"]["credits"][0]["author"] == a1 and sorted(gd["data"]["credits"][0]["reviewers"]) == sorted([a1, a2]) and gd["data"]["sections"][0]["author"] == a2, gd["data"])
    check("copies are new rows (source keys unchanged and not reused)", gd["rows"]["credits"][0] != gs["rows"]["credits"][0] and wget(PAGE, src)["rows"] == gs["rows"], [gd["rows"], gs["rows"]])
    e, c = ws("ws_create", {"uid": GUIDE, "data": {"title": "Gcp %s" % RUN, "items": [{"label": "en row", "qty": 1}]}})
    gdoc = c["documentId"]
    spike.rest(RA, "PUT", "/api/guides/%s?locale=fr&status=draft" % gdoc, {"data": {"title": "Gcp fr"}})
    gen = wget(GUIDE, gdoc, "en")
    e, r = ws("ws_patch", {"uid": GUIDE, "documentId": gdoc, "locale": "fr", "ops": [{"op": "copy", "field": "items", "key": gen["rows"]["items"][0], "from": {"locale": "en"}}]})
    gfr = wget(GUIDE, gdoc, "fr")
    check("rows copied from another locale of the same document", not e and [x["label"] for x in gfr["data"]["items"]] == ["en row"] and gfr["rows"]["items"][0] != gen["rows"]["items"][0], [r, gfr])
    check("source locale unchanged", wget(GUIDE, gdoc, "en")["version"] == gen["version"])
    e, r = ws("ws_patch", {"uid": GUIDE, "documentId": gdoc, "locale": "fr", "ops": [{"op": "copy", "field": "items", "key": wget(PAGE, dst)["rows"]["items"][0], "from": {"uid": PAGE, "documentId": dst}}]})
    check("rows copied across content types (same component)", not e and len(wget(GUIDE, gdoc, "fr")["data"]["items"]) == 2, r)


@T
def t_copy_errors_and_permissions():
    doc = common.create_page_mcp("cp-err-" + RUN)
    g = wget(PAGE, doc)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "sections", "key": "blocks.hero:999999"}]})
    check("unknown key -> row_not_found with current keys", e and code(r) == "row_not_found" and r["error"]["current_keys"] == ident(g["rows"]["sections"]), r)   # identities, no MAC (review finding 1)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "items", "key": g["rows"]["sections"][0], "from": {"field": "sections"}}]})
    check("zone row of another component into a repeatable field refused", e and code(r) == "invalid", r)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "sections", "key": g["rows"]["body"][0], "from": {"field": "body"}}]})
    check("blocks node into a zone refused", e and code(r) == "invalid", r)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "sections", "key": g["rows"]["sections"][0], "data": {"heading": "x"}}]})
    check("copy with data refused (edit the copy with update)", e and code(r) == "invalid", r)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "sections", "key": g["rows"]["sections"][0], "from": {"documentId": "nope"}}]})
    check("missing source document -> not_found", e and code(r) == "not_found", r)
    other = common.create_page_mcp("cp-err2-" + RUN)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": other, "ops": [{"op": "copy", "field": "items", "key": g["rows"]["items"][0], "from": {"documentId": doc}}]}, who="agent-noread")
    check("source row with fields the token cannot read -> forbidden, nothing written", e and code(r) == "forbidden" and len(wget(PAGE, other)["rows"]["items"]) == 3, r)
    e, c = ws("ws_create", {"uid": GUIDE, "data": {"title": "Gperm %s" % RUN, "items": [{"label": "g", "qty": 1}]}})
    gg = wget(GUIDE, c["documentId"])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": other, "ops": [{"op": "copy", "field": "items", "key": gg["rows"]["items"][0], "from": {"uid": GUIDE, "documentId": c["documentId"]}}]}, who="agent-nonote")
    check("source type the token cannot read -> forbidden", e and code(r) == "forbidden", r)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "dry_run": True, "ops": [{"op": "copy", "field": "sections", "key": g["rows"]["sections"][0]}]})
    check("copy in a dry run writes nothing", not e and r["dry_run"] and wget(PAGE, doc)["rows"] == g["rows"], r)


@T
def t_copy_nested_component():
    src = ws("ws_create", {"uid": PAGE, "data": {"title": "cp-nest-" + RUN, "items": [{"label": "with meta", "qty": 1, "meta": {"note": "secret", "flag": True}}]}})[1]["documentId"]
    dst = common.create_page_mcp("cp-nest-dst-" + RUN)
    gs = wget(PAGE, src)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": dst, "ops": [{"op": "copy", "field": "items", "key": gs["rows"]["items"][0], "from": {"documentId": src}}]})
    gd = wget(PAGE, dst)
    meta = gd["data"]["items"][-1].get("meta") or {}
    check("a row with a nested component is copied with its nested values", not e and meta.get("note") == "secret" and meta.get("flag") is True, [r, gd["data"]["items"]])
    e2, r2 = ws("ws_patch", {"uid": PAGE, "documentId": dst, "ops": [{"op": "update", "field": "items", "key": gd["rows"]["items"][-1], "data": {"meta": {"note": "changed in copy"}}}]})
    check("the nested component of the copy is its own row (changing it leaves the source alone)", not e2 and wget(PAGE, src)["data"]["items"][0]["meta"]["note"] == "secret", [r2, wget(PAGE, src)["data"]["items"]])
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": dst, "ops": [{"op": "copy", "field": "items", "key": gs["rows"]["items"][0], "from": {"documentId": src}}]}, who="agent-nometa")
    check("a nested sub-field the token cannot read (items.meta.note) refuses the copy", e and code(r) == "forbidden" and "meta" in r["error"]["message"], r)


@T
def t_copy_keeps_colleague_rows_and_batch():
    doc = common.create_page_mcp("cp-col-" + RUN)
    g = wget(PAGE, doc)
    cur = common.rest_get(RB, doc)
    common.rest_put(RB, doc, {"sections": common.strip_ids(cur["sections"]) + [{"__component": "blocks.text", "body": "COLLEAGUE"}]})
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "sections", "key": g["rows"]["sections"][0]}]}]})
    secs = json.dumps(common.rest_get(RA, doc)["sections"])
    # REST put recreated the zone rows (new ids), so the key read before is gone: copy must refuse, not guess.
    check("copy after the source row was replaced by a colleague -> refused (row_not_found), colleague's row kept", e and r["items"][0].get("error", {}).get("code") == "row_not_found" and "COLLEAGUE" in secs, r)
    g2 = wget(PAGE, doc)
    common.rest_put(RB, doc, {"note": "colleague note"})
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": doc, "ops": [{"op": "copy", "field": "sections", "key": g2["rows"]["sections"][-1]}]}]})
    v = common.rest_get(RA, doc)
    check("copy in ws_batch ok; colleague's later field change kept", not e and json.dumps(v["sections"]).count("COLLEAGUE") == 2 and v["note"] == "colleague note", r)



@T
def t_history_integration():
    """Integration (v1-core with #5): ws_create, ws_delete and ws_bulk report their writes to the history module, so
    ws_history lists them and ws_undo reverts them; a colleague's edit after a job is left alone by the job's undo."""
    s_, b_, _ = spike.rpc(A, "tools/list")
    if "ws_undo" not in [t["name"] for t in b_["result"]["tools"]]:
        print("SKIP t_history_integration (history module off)")
        return
    # ws_create -> undo deletes it
    e, c = ws("ws_create", {"uid": PAGE, "data": {"title": "hist-create-%s" % RUN, "summary": "s"}, "agent": "create-bot"})
    check("ws_create reply carries a receipt_id", not e and str(c.get("receipt_id", "")).startswith("r_"), c)
    e, h = ws("ws_history", {"receipt_id": c.get("receipt_id")})
    rec = (h.get("receipts") or [{}])[0]
    check("ws_history: create entry, agent label, undoable", not e and rec.get("tool") == "ws_create" and rec.get("agent") == "create-bot"
          and rec["items"][0]["op"] == "create" and rec.get("undoable") is True, h)
    e, u = ws("ws_undo", {"receipt_id": c["receipt_id"]})
    s1, _, _ = spike.rest(RA, "GET", "/api/pages/%s?status=draft" % c["documentId"])
    check("ws_undo of ws_create deletes the created document", not e and u["items"][0]["op"] == "deleted" and s1 == 404, [u, s1])
    # ws_delete (all locales) -> undo recreates every locale with the same documentId
    e, c2 = ws("ws_create", {"uid": GUIDE, "data": {"title": "HG %s" % RUN, "items": [{"label": "en", "qty": 1}]}})
    doc = c2["documentId"]
    spike.rest(RA, "PUT", "/api/guides/%s?locale=fr&status=draft" % doc, {"data": {"title": "HG fr"}})
    ven, vfr = wget(GUIDE, doc, "en")["version"], wget(GUIDE, doc, "fr")["version"]
    e, d = ws("ws_delete", {"uid": GUIDE, "documentId": doc, "all_locales": True, "expected_version": {"en": ven, "fr": vfr}})
    e2, h2 = ws("ws_history", {"receipt_id": d.get("receipt_id")})
    ops = sorted((i["op"], i["locale"]) for i in ((h2.get("receipts") or [{}])[0].get("items") or []))
    check("ws_delete all_locales: one receipt, a delete entry per locale", not e and not e2 and ops == [("delete", "en"), ("delete", "fr")], h2)
    e, u = ws("ws_undo", {"receipt_id": d["receipt_id"]})
    en, fr = wget(GUIDE, doc, "en"), wget(GUIDE, doc, "fr")
    check("ws_undo of ws_delete recreates both locales (same documentId, content back)", not e and sorted(i["op"] for i in u["items"]) == ["recreated", "recreated"]
          and en["data"]["title"] == "HG %s" % RUN and fr["data"]["title"] == "HG fr", [u, en["data"].get("title"), fr["data"].get("title")])
    # ws_bulk job in 3 chunks -> history groups it under the job id
    pre = "bkh-%s" % RUN
    docs = make_pages(pre, 5)
    e, j = bulk({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "bulk-hist"}, "agent": "bulk-bot"}, chunk_size=2)
    check("bulk job done", not e and j.get("status") == "done" and j.get("job_id"), j)
    e, h3 = ws("ws_history", {"receipt_id": j.get("job_id"), "limit": 10})
    recs = h3.get("receipts") or []
    check("ws_history by job_id lists the 3 chunk receipts (5 documents), agent on each", not e and len(recs) == 3 and sum(len(r["items"]) for r in recs) == 5
          and all(r.get("group") == j["job_id"] and r.get("agent") == "bulk-bot" for r in recs), h3)
    # a colleague edits one document after the job. 1.0 hardening item 21: the undo of a job is a resumable undo job that
    # leaves a document changed since alone and lists it (on_conflict "skip"), instead of refusing the whole job.
    common.rest_put(RB, docs[2], {"summary": "colleague-after-job"})
    e, u1 = ws("ws_undo", {"receipt_id": j["job_id"], "documentId": docs[0]})
    check("undo one document of the job", not e and common.rest_get(RA, docs[0])["summary"] == "s", u1)
    e, u = ws("ws_undo", {"receipt_id": j["job_id"]})
    sums = [common.rest_get(RA, d)["summary"] for d in docs]
    check("job undo: the colleague's document skipped and listed (conflicts), the rest reverted, the one undone before not touched again",
          not e and u.get("status") == "done" and u["totals"]["restored"] == 3 and u["totals"]["conflicts"] == 1 and u["totals"]["already_undone"] == 1
          and [c["documentId"] for c in u.get("conflicts", [])] == [docs[2]] and sums == ["s", "s", "colleague-after-job", "s", "s"], [u, sums])
    e, u2 = ws("ws_undo", {"receipt_id": j["job_id"], "force": True})
    sums = [common.rest_get(RA, d)["summary"] for d in docs]
    check("force undo of the rest of the job: every document back to its value before the job (colleague's edit overwritten)",
          not e and sums == ["s"] * 5 and "overwrote" in json.dumps(u2), [u2, sums])
    e, u3 = ws("ws_undo", {"receipt_id": j["job_id"]})
    check("undoing the job again -> already_undone", e and code(u3) == "already_undone", u3)


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    tag = os.environ.get("RESULT_TAG", "")
    json.dump(results, open(os.path.join(HERE, "results", "test_bulk_create%s.json" % ("-" + tag if tag else "")), "w"), indent=1, default=str)
    fails = [r for r in results if not r["pass"]]
    groups = {}
    for r in results:
        g = groups.setdefault(r["group"], [0, 0]); g[0 if r["pass"] else 1] += 1
    for g, (ok, bad) in groups.items():
        print("  %-45s %d/%d" % (g, ok, ok + bad))
    print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
    sys.exit(1 if fails else 0)
