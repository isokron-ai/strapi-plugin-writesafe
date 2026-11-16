"""Functional tests for 1.0 hardening stream F (Phase 3 items 20 and 21), against a running Strapi with every module on
(ci/run_suite.sh):

  item 20  ref-level add/remove ops for to-many relations and multiple media, in ws_patch and ws_bulk, and a safe path for
           nested lists (a single component, a row's `update` op): ref ops with `path`, or a precondition.
  item 21  undo as a job: chunked and resumable, on_conflict "skip" by default (conflicts listed with their before values,
           filtered for the token), per-document before-image cap, a job byte budget shown in the dry runs.

Run: python3 tests/test_undo_refops.py   (exit 1 on any failure; writes tests/results/test_undo_refops<-TAG>.json)
ONLY=t_ref python3 tests/test_undo_refops.py runs the tests whose names contain one of those strings.
WS_RESTART_CMD (a command that starts Strapi again and waits until it is healthy) and WS_PID_FILE (the running Strapi's
pid) enable the kill-and-resume part of t_undo_job_scale; without them that part runs as an interrupted call (max_chunks)
and says so. UNDO_SCALE_DOCS (default 1050) sets the size of the scale test.
Needs the server env of ci/run_suite.sh: WRITESAFE_BULK_MAX_DOCUMENTS >= UNDO_SCALE_DOCS and
WRITESAFE_HISTORY_MAX_JOB_BEFORE_BYTES=1000000 (the job byte budget test).
"""
import base64, json, os, signal, sqlite3, subprocess, sys, threading, time, traceback, urllib.error, urllib.request, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "spike"))
import spike, common
from spike import A, B, RA, RB

PAGE = "api::page.page"
GAL = "api::gallery.gallery"
RUN = uuid.uuid4().hex[:6]
results = []
CURRENT = [None]
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]
N_SCALE = int(os.environ.get("UNDO_SCALE_DOCS", "1050"))
JOB_BUDGET = int(os.environ.get("WRITESAFE_HISTORY_MAX_JOB_BEFORE_BYTES", "1000000"))


def check(name, cond, detail=None):
    results.append({"group": CURRENT[0], "test": name, "pass": bool(cond), "detail": detail if not cond else None})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str, ensure_ascii=False)[:1200]), flush=True)


def T(fn):
    if ONLY and not any(o in fn.__name__ for o in ONLY):
        return fn
    CURRENT[0] = fn.__name__
    t0 = time.time()
    try:
        fn()
    except Exception:
        check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-1500:])
    print("  (%s: %.1fs)" % (fn.__name__, time.time() - t0), flush=True)
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
    return ((r or {}).get("error") or {}) if isinstance(r, dict) else {}


def code(r):
    return err_of(r).get("code")


def wget(uid, doc, who=A):
    e, r = ws("ws_get", {"uid": uid, "documentId": doc}, who)
    if e:
        raise RuntimeError(r)
    return r


def no_force(r):
    """Undo replies never offer force (Phase 1 rule): no `force` key and no hint text naming it."""
    s = json.dumps(r)
    return '"force"' not in s and "force: true" not in s and "force:true" not in s


# ---------------------------------------------------------------- fixtures
_JWT = [None]


def admin_http(method, path, body=None):
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
        return e.code, json.loads(e.read() or b"null")


def owner_perms(subject, actions=None):
    s, b = admin_http("GET", "/admin/users/me/permissions")
    return [{k: p[k] for k in ("action", "subject", "properties", "conditions")} for p in b["data"]
            if p["subject"] == subject and (actions is None or p["action"] in actions)]


def make_token(label, perms):
    """A throwaway admin token with these permissions (never printed); returns its label in spike.TOK."""
    if label in spike.TOK["admin"]:
        return label
    s, t = admin_http("POST", "/admin/admin-tokens", {"name": "spike-%s-%d" % (label, int(time.time() * 1000)), "description": "isokron-strapi-1-0 test (stream F)", "adminPermissions": perms, "lifespan": None})
    if s not in (200, 201):
        raise RuntimeError((s, t))
    spike.TOK["admin"][label] = t["data"]["accessKey"]
    return label


CM = "plugin::content-manager.explorer."
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def upload(name):
    """Uploads a 1x1 PNG; returns (numeric id, documentId). ws_get shows media as file documentIds."""
    bnd = uuid.uuid4().hex
    body = (("--%s\r\nContent-Disposition: form-data; name=\"files\"; filename=\"%s\"\r\nContent-Type: image/png\r\n\r\n" % (bnd, name)).encode()
            + PNG + ("\r\n--%s--\r\n" % bnd).encode())
    req = urllib.request.Request(spike.BASE + "/api/upload", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + spike._token(RA), "Content-Type": "multipart/form-data; boundary=" + bnd})
    f = json.loads(urllib.request.urlopen(req, timeout=60).read())[0]
    return f["id"], f["documentId"]


def author(name):
    s, b, _ = spike.rest(RA, "POST", "/api/authors", {"data": {"name": name}})
    if s not in (200, 201):
        raise RuntimeError((s, b))
    return b["data"]["documentId"]


def gallery(title, **data):
    e, c = ws("ws_create", {"uid": GAL, "data": dict(title=title, **data)})
    if e:
        raise RuntimeError(c)
    return c["documentId"]


def refs_of(r):
    return [(x.get("op"), x.get("ref"), x.get("status")) for x in (r or {}).get("refs", [])]


def page_rest(title, **data):
    s, b, _ = spike.rest(RA, "POST", "/api/pages?status=draft", {"data": dict(title=title, **data)})
    if s not in (200, 201):
        raise RuntimeError((s, b))
    return b["data"]["documentId"]


def pages_with(prefix, extra=""):
    out, page = [], 1
    while True:
        s, b, _ = spike.rest(RA, "GET", "/api/pages?status=draft&filters[title][$startsWith]=%s%s&fields[0]=title&fields[1]=summary&pagination[pageSize]=100&pagination[page]=%d&sort=id:asc" % (prefix, extra, page))
        out += b["data"]
        if page >= b["meta"]["pagination"]["pageCount"]:
            return out
        page += 1


def history_items(receipt_id, who=A):
    """Every item of every receipt of a job (or one receipt), paged through ws_history."""
    items, cursor = [], None
    for _ in range(500):
        a = {"receipt_id": receipt_id, "limit": 100}
        if cursor:
            a["cursor"] = cursor
        e, h = ws("ws_history", a, who)
        if e:
            raise RuntimeError(h)
        for r in h["receipts"]:
            items += r["items"]
        cursor = h.get("next_cursor")
        if not cursor:
            return items
    return items


def bulk_start(args, who=A, dry=None, **start):
    """ws_bulk start from a plan (phase 3 E): the dry run's plan_token, then the same call with it. `dry`: a dry-run
    reply already in hand. `start`: run arguments for the start only. Returns (err, reply) of the start (or the dry run
    when it failed or matched nothing)."""
    if dry is None:
        e, dry = ws("ws_bulk", dict(args, dry_run=True), who)
        if e:
            return e, dry
    if not dry.get("plan_token"):
        return False, dry
    return ws("ws_bulk", dict(args, plan_token=dry["plan_token"], **start), who)


def bulk_finish(e, j, who=A):
    for _ in range(200):
        if e or j.get("status") != "running":
            return e, j
        e, j = ws("ws_bulk", {"job_id": j["job_id"]}, who)
    return e, j


def run_undo_job(args, who=A, rounds=200):
    """Starts or resumes an undo job and calls again with its undo_job_id until it is no longer running."""
    e, r = ws("ws_undo", args, who)
    for _ in range(rounds):
        if e or r.get("status") != "running":
            return e, r
        e, r = ws("ws_undo", {"undo_job_id": r["undo_job_id"]}, who)
    return e, r


# ================================================================ item 20: ref ops
@T
def t_ref_retag_many_to_many():
    """Design E / job (d): a re-tag (remove News, add Updates) through ref ops keeps every other link, also one a
    colleague added after the agent read; no version needed; adding an existing link or removing an absent one is a
    reported no-op."""
    news, updates, other1, other2, late = (author("F %s %s" % (n, RUN)) for n in ("News", "Updates", "Other1", "Other2", "Late"))
    g = gallery("ref-retag-%s" % RUN, contributors=[news, other1, other2])
    read = wget(GAL, g)
    # a colleague adds a contributor after the agent's read, without a version (ref ops never need one)
    e, rc = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": late}]}, B)
    check("colleague's ref add needs no version", not e and rc.get("ok") and refs_of(rc) == [("add", late, "added")], rc)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "remove", "field": "contributors", "ref": news}, {"op": "add", "field": "contributors", "ref": updates}]})
    now = wget(GAL, g)["data"]["contributors"]
    check("re-tag by ref ops: News removed, Updates added", not e and refs_of(r) == [("remove", news, "removed"), ("add", updates, "added")], r)
    check("every other link kept, the colleague's late one too (no whole-list replace)", sorted(now) == sorted([other1, other2, late, updates]) and news not in now, now)
    check("order: current links stay in place, the new one is appended", now == [other1, other2, late, updates], now)
    check("the reply names the field as changed and carries the new version", r.get("changed") == ["contributors"] and r.get("version") and r.get("version") != read["version"], r)
    v = wget(GAL, g)["version"]
    e, n = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": other1}, {"op": "remove", "field": "contributors", "ref": news}]})
    check("adding an existing link / removing an absent one: a reported no-op, nothing written",
          not e and n.get("ok") and n.get("unchanged") is True and refs_of(n) == [("add", other1, "already_linked"), ("remove", news, "not_linked")]
          and n.get("changed") == [] and wget(GAL, g)["version"] == v and not n.get("receipt_id"), n)
    e, d = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": news}, {"op": "add", "field": "contributors", "ref": news}]})
    check("the same ref twice: added, then already_linked", not e and refs_of(d) == [("add", news, "added"), ("add", news, "already_linked")], d)
    e, d = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": other2, "position": "start"}]})
    check("position on an existing link is not a move (no-op)", not e and refs_of(d) == [("add", other2, "already_linked")], d)
    e, d = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "remove", "field": "contributors", "ref": news}, {"op": "add", "field": "contributors", "ref": news, "position": "start"}]})
    check("position start puts the new link first", not e and wget(GAL, g)["data"]["contributors"][0] == news, [d, wget(GAL, g)["data"]["contributors"]])
    e, d = ws("ws_patch", {"uid": GAL, "documentId": g, "dry_run": True, "ops": [{"op": "remove", "field": "contributors", "ref": other1}]})
    check("dry run of a ref op: shows the change, writes nothing", not e and d.get("dry_run") and other1 in wget(GAL, g)["data"]["contributors"], d)


@T
def t_ref_errors_and_permissions():
    a1, a2 = author("F perm1 %s" % RUN), author("F perm2 %s" % RUN)
    g = gallery("ref-perm-%s" % RUN, contributors=[a1])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": "nosuchdoc%s" % RUN}]})
    check("unknown target: invalid, nothing written", e and code(r) == "invalid" and wget(GAL, g)["data"]["contributors"] == [a1], r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "remove", "field": "contributors", "ref": "nosuchdoc%s" % RUN}]})
    check("remove of an unknown target: the same answer (no oracle)", e and code(r) == "invalid", r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "title", "ref": a2}]})
    check("ref op on a scalar field: invalid", e and code(r) == "invalid", r)
    pg = common.create_page_mcp("ref-toone-%s" % RUN)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": pg, "ops": [{"op": "add", "field": "reviewer", "ref": a2}]})
    check("ref op on a to-one relation: invalid, says to use set", e and code(r) == "invalid" and "set" in err_of(r).get("message", ""), r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": a2, "data": {"x": 1}}]})
    check("ref and data together: invalid", e and code(r) == "invalid", r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "set": {"contributors": [a2]}, "ops": [{"op": "add", "field": "contributors", "ref": a2}]})
    check("one field in both set and ops: invalid", e and code(r) in ("invalid", "precondition_required"), r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "set": {"contributors": [a2]}})
    check("whole-list set without a version still needs one, and the reply points to ref ops", e and code(r) == "precondition_required" and "ref" in err_of(r).get("message", ""), r)
    # target permission: a token that may update galleries but not read authors
    gal_perms = owner_perms(GAL, (CM + "read", CM + "update"))
    noauth = make_token("f-noauthors", gal_perms)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": a2}]}, noauth)
    check("target permission: a token that cannot read authors cannot link one (same answer as unknown)", e and code(r) == "invalid" and a2 not in wget(GAL, g)["data"]["contributors"], r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "remove", "field": "contributors", "ref": a1}]}, noauth)
    check("... nor unlink one", e and code(r) == "invalid" and wget(GAL, g)["data"]["contributors"] == [a1], r)
    # field permission: update without `contributors`
    nofield = [dict(p, properties=dict(p["properties"], fields=[f for f in (p["properties"].get("fields") or []) if f != "contributors"])) if p["action"] == CM + "update" else p for p in gal_perms]
    nofield += owner_perms("api::author.author", (CM + "read",))
    nf = make_token("f-nocontrib", nofield)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": a2}]}, nf)
    check("field permission: a token that cannot update contributors is refused (forbidden)", e and code(r) == "forbidden" and a2 not in wget(GAL, g)["data"]["contributors"], r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": a1}]}, nf)
    check("... also for a no-op on that field (no oracle, no write)", e and code(r) == "forbidden", r)


@T
def t_ref_media_add_remove():
    f1, f2, f3, f4 = (upload("f-media-%d-%s.png" % (i, RUN)) for i in range(4))
    g = gallery("ref-media-%s" % RUN, images=[f1[1], f2[1]])
    wget(GAL, g)
    e, rc = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "images", "ref": f4[1]}]}, B)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "images", "ref": f3[1]}]})
    imgs = wget(GAL, g)["data"]["images"]
    check("media add by file documentId: appended, the colleague's file kept", not e and refs_of(r) == [("add", f3[1], "added")] and imgs == [f1[1], f2[1], f4[1], f3[1]], [r, imgs])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "images", "ref": f3[0]}, {"op": "remove", "field": "images", "ref": "nosuchfile%s" % RUN}]})
    check("media add of a linked file (by numeric id): no-op; unknown file: invalid", e and code(r) == "invalid", r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "images", "ref": f3[0]}]})
    check("media add of a linked file (by numeric id): already_linked, nothing written", not e and r.get("unchanged") and refs_of(r) == [("add", f3[0], "already_linked")], r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "remove", "field": "images", "ref": f1[1]}, {"op": "add", "field": "images", "ref": f1[1], "position": {"after": f4[1]}}]})
    imgs = wget(GAL, g)["data"]["images"]
    check("media remove, then add after a given file: moved there, others kept", not e and imgs == [f2[1], f4[1], f1[1], f3[1]], [r, imgs])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "remove", "field": "images", "ref": f2[0]}]})
    imgs = wget(GAL, g)["data"]["images"]
    check("media remove by numeric id", not e and imgs == [f4[1], f1[1], f3[1]], [r, imgs])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "remove", "field": "images", "ref": f2[1]}]})
    check("media remove of an unlinked file: not_linked", not e and refs_of(r) == [("remove", f2[1], "not_linked")], r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "cover", "ref": f2[1]}]})
    check("ref op on a single media field: invalid (use set)", e and code(r) == "invalid", r)
    e, h = ws("ws_history", {"documentId": g, "limit": 1})
    e, u = ws("ws_undo", {"receipt_id": h["receipts"][0]["receipt_id"]})
    check("ws_undo of a media ref op puts the file back in its place", not e and wget(GAL, g)["data"]["images"] == [f2[1], f4[1], f1[1], f3[1]], [u, wget(GAL, g)["data"]["images"]])


@T
def t_ref_bulk_retag():
    """ws_bulk accepts ref ops (no key): re-tag every matching gallery without dropping its other contributors."""
    news, updates, keep1, keep2 = (author("F bulk %s %s" % (n, RUN)) for n in ("News", "Updates", "Keep1", "Keep2"))
    pre = "ref-bulk-%s" % RUN
    tagged = [gallery("%s-%d" % (pre, i), contributors=[keep1, news, keep2] if i % 2 else [news]) for i in range(5)]
    untagged = [gallery("%s-u%d" % (pre, i), contributors=[keep1]) for i in range(2)]
    base = {"uid": GAL, "filters": {"$and": [{"title": {"$startsWith": pre}}, {"contributors": {"documentId": {"$eq": news}}}]},
            "ops": [{"op": "remove", "field": "contributors", "ref": news}, {"op": "add", "field": "contributors", "ref": updates}]}
    e, d = ws("ws_bulk", dict(base, dry_run=True))
    check("bulk dry run with ref ops: matches the tagged galleries only", not e and d.get("match_count") == 5, d)
    e, j = bulk_finish(*bulk_start(base, dry=d, expected_count=5, chunk_size=2))
    check("bulk re-tag job done, 5 ok", not e and j.get("status") == "done" and j["totals"].get("ok") == 5, j)
    ok_all = True
    for i, d_ in enumerate(tagged):
        c = wget(GAL, d_)["data"]["contributors"]
        want = [keep1, keep2, updates] if i % 2 else [updates]
        ok_all = ok_all and c == want
    check("every tagged gallery: News gone, Updates added, every other contributor kept in place", ok_all, [wget(GAL, d_)["data"]["contributors"] for d_ in tagged])
    check("untagged galleries untouched", all(wget(GAL, d_)["data"]["contributors"] == [keep1] for d_ in untagged))
    e, j2 = bulk_finish(*bulk_start(dict(base, filters={"title": {"$startsWith": pre}})))
    check("re-running the ref ops over every gallery: the re-tagged ones are unchanged (idempotent)",
          not e and j2.get("totals", {}).get("unchanged") == 5 and j2["totals"].get("ok") == 2, j2)
    e, x = ws("ws_bulk", dict(base, ops=[{"op": "add", "field": "slides", "key": "gallery.slide:1", "path": "people", "ref": news}]))
    check("bulk refuses keyed ops (row keys differ per document)", e and code(x) == "invalid", x)


# ================================================================ item 20: nested lists
@T
def t_nested_lists_single_component():
    a1, a2 = author("F nest1 %s" % RUN), author("F nest2 %s" % RUN)
    f1, f2 = upload("f-nest-1-%s.png" % RUN), upload("f-nest-2-%s.png" % RUN)
    g = gallery("nest-single-%s" % RUN, feature={"title": "T", "images": [f1[1]], "people": [a1], "steps": [{"note": "s1"}]})
    v = wget(GAL, g)["version"]
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "set": {"feature": {"people": [a2]}}})
    check("set of a single component that replaces a nested to-many relation: precondition_required naming feature.people",
          e and code(r) == "precondition_required" and "feature.people" in json.dumps(err_of(r)), r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "set": {"feature": {"steps": [{"note": "x"}]}}})
    check("... a nested repeatable: precondition_required naming feature.steps", e and code(r) == "precondition_required" and "feature.steps" in json.dumps(err_of(r)), r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "set": {"feature": {"images": [f2[1]]}}})
    check("... nested multiple media: precondition_required naming feature.images", e and code(r) == "precondition_required" and "feature.images" in json.dumps(err_of(r)), r)
    check("nothing written by the refused sets", wget(GAL, g)["version"] == v)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "feature", "path": "people", "ref": a2}]})
    f = wget(GAL, g)["data"]["feature"]
    check("ref op into a single component (path): people gets a2, a1 kept, other fields untouched", not e and f["people"] == [a1, a2] and f["title"] == "T" and f["images"] == [f1[1]] and [s["note"] for s in f["steps"]] == ["s1"], [r, f])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "feature", "path": "images", "ref": f2[1]}, {"op": "remove", "field": "feature", "path": "people", "ref": a1}]})
    f = wget(GAL, g)["data"]["feature"]
    check("ref ops on nested media and relation in one call", not e and f["images"] == [f1[1], f2[1]] and f["people"] == [a2], [r, f])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "feature", "path": "steps", "ref": a2}]})
    check("ref op on a nested repeatable: invalid (not a relation or media list)", e and code(r) == "invalid", r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "feature", "path": "nosuch", "ref": a2}]})
    check("ref op on an unknown path: invalid", e and code(r) == "invalid", r)
    v = wget(GAL, g)["version"]
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "expected_version": v, "set": {"feature": {"steps": [{"note": "x"}, {"note": "y"}]}}})
    check("with expected_version the nested repeatable may be replaced", not e and [s["note"] for s in wget(GAL, g)["data"]["feature"]["steps"]] == ["x", "y"], r)


@T
def t_nested_lists_row_update():
    a1, a2, a3 = author("F row1 %s" % RUN), author("F row2 %s" % RUN), author("F row3 %s" % RUN)
    f1, f2 = upload("f-row-1-%s.png" % RUN), upload("f-row-2-%s.png" % RUN)
    g = gallery("nest-row-%s" % RUN, slides=[{"caption": "s0", "images": [f1[1]], "people": [a1], "notes": [{"note": "n0"}]},
                                             {"caption": "s1", "people": [a2]}])
    rd = wget(GAL, g)
    k0, k1 = rd["rows"]["slides"]
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "update", "field": "slides", "key": k0, "data": {"caption": "s0 new"}}]})
    s0 = wget(GAL, g)["data"]["slides"][0]
    check("update op without a nested list: no version needed, nested lists kept", not e and s0["caption"] == "s0 new" and s0["people"] == [a1] and s0["images"] == [f1[1]] and [n["note"] for n in s0["notes"]] == ["n0"], [r, s0])
    rd = wget(GAL, g)
    k0 = rd["rows"]["slides"][0]
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "update", "field": "slides", "key": k0, "data": {"people": [a3]}}]})
    check("update op replacing a nested to-many relation without a version: precondition_required naming slides.people",
          e and code(r) == "precondition_required" and "slides.people" in json.dumps(err_of(r)) and "ref" in err_of(r).get("message", ""), r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "update", "field": "slides", "key": k0, "data": {"notes": [{"note": "x"}]}}]})
    check("... a nested repeatable: precondition_required naming slides.notes", e and code(r) == "precondition_required" and "slides.notes" in json.dumps(err_of(r)), r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "update", "field": "slides", "key": k0, "data": {"images": [f2[1]]}}]})
    check("... nested multiple media: precondition_required naming slides.images", e and code(r) == "precondition_required" and "slides.images" in json.dumps(err_of(r)), r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "update", "field": "slides", "key": k0, "data": {"caption": "echo", "people": [a1], "images": [f1[1]]}}]})
    check("an update op that echoes the nested lists unchanged needs no version", not e and wget(GAL, g)["data"]["slides"][0]["caption"] == "echo", r)
    rd = wget(GAL, g)
    k0, k1 = rd["rows"]["slides"]
    # a colleague edits the other row; the agent's nested ref ops on row 0 need no version and keep it
    e, rc = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "update", "field": "slides", "key": k1, "data": {"caption": "colleague"}}]}, B)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "slides", "key": k0, "path": "people", "ref": a3},
                                                              {"op": "add", "field": "slides", "key": k0, "path": "images", "ref": f2[1]},
                                                              {"op": "remove", "field": "slides", "key": k0, "path": "people", "ref": a1}]})
    sl = wget(GAL, g)["data"]["slides"]
    check("nested ref ops by row key + path: people and images edited in place, no version", not e and sl[0]["people"] == [a3] and sl[0]["images"] == [f1[1], f2[1]], [r, sl])
    check("... the colleague's edit of the other row kept, its links untouched", sl[1]["caption"] == "colleague" and sl[1]["people"] == [a2], sl[1])
    check("... the row's other nested list kept", [n["note"] for n in sl[0]["notes"]] == ["n0"], sl[0])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "slides", "path": "people", "ref": a1}]})
    check("nested ref op on a list field without key: invalid", e and code(r) == "invalid", r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "slides", "key": "gallery.slide:999999999", "path": "people", "ref": a1}]})
    check("nested ref op with an unknown row key: refused (row not found)", e and code(r) in ("row_not_found", "stale_row_key"), r)
    v = wget(GAL, g)["version"]
    k0 = wget(GAL, g)["rows"]["slides"][0]
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "expected_version": v, "ops": [{"op": "update", "field": "slides", "key": k0, "data": {"notes": [{"note": "a"}, {"note": "b"}]}}]})
    check("with expected_version the update op may replace a nested list", not e and [n["note"] for n in wget(GAL, g)["data"]["slides"][0]["notes"]] == ["a", "b"], r)
    # page.credits[].reviewers (existing schema) and a dynamic-zone row's multiple media
    pg = common.create_page_mcp("nest-page-%s" % RUN)
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": pg, "ops": [{"op": "add", "field": "credits", "data": {"role": "editor", "reviewers": [a1]}},
                                                               {"op": "add", "field": "sections", "component": "blocks.gallery", "data": {"title": "G", "images": [f1[1]]}}]})
    rd = wget(PAGE, pg)
    kc = rd["rows"]["credits"][0]
    kg = [k for k in rd["rows"]["sections"] if k.startswith("blocks.gallery:")][0]
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": pg, "ops": [{"op": "add", "field": "credits", "key": kc, "path": "reviewers", "ref": a2},
                                                               {"op": "add", "field": "sections", "key": kg, "path": "images", "ref": f2[1]}]})
    rd = wget(PAGE, pg)
    gs = [s for s in rd["data"]["sections"] if s["_key"].startswith("blocks.gallery:")][0]
    check("nested ref ops in a repeatable (credits.reviewers) and a dynamic-zone row (blocks.gallery images)",
          not e and rd["data"]["credits"][0]["reviewers"] == [a1, a2] and gs["images"] == [f1[1], f2[1]], [r, rd["data"]["credits"], gs])
    kg = [k for k in rd["rows"]["sections"] if k.startswith("blocks.gallery:")][0]
    e, r = ws("ws_patch", {"uid": PAGE, "documentId": pg, "ops": [{"op": "update", "field": "sections", "key": kg, "data": {"images": [f1[1]]}}]})
    check("update op on a dynamic-zone row replacing its media list without a version: precondition_required", e and code(r) == "precondition_required", r)


# ================================================================ item 21: undo with on_conflict skip (one receipt)
@T
def t_undo_conflicts_skipped_and_listed():
    p = [common.create_page_mcp("uc-%d-%s" % (i, RUN)) for i in range(3)]
    e, r = ws("ws_batch", {"items": [{"ref": "p%d" % i, "uid": PAGE, "documentId": d, "expected_version": wget(PAGE, d)["version"], "set": {"note": "agent %d" % i}} for i, d in enumerate(p)]})
    check("batch ok", not e and r.get("receipt_id"), r)
    common.rest_put(RB, p[1], {"note": "colleague"})
    e, u = ws("ws_undo", {"receipt_id": r["receipt_id"]})
    notes = [wget(PAGE, d)["data"]["note"] for d in p]
    check("on_conflict skip (default): the two unchanged documents are undone, the colleague's is kept", not e and u.get("ok") and notes == ["n0", "colleague", "n0"], [u, notes])
    c = (u or {}).get("conflicts") or []
    check("the skipped document is listed with changed_since and its before value", len(c) == 1 and c[0].get("documentId") == p[1] and c[0].get("changed_since") == ["note"]
          and c[0].get("before", {}).get("fields", {}).get("note") == "n0" and c[0].get("item") == "p1", c)
    check("the reply says two restored, one skipped, and offers no force", [i["op"] for i in u.get("items", [])] == ["restored", "restored"] and no_force(u), u)
    e, h = ws("ws_history", {"receipt_id": r["receipt_id"]})
    rec = h["receipts"][0]
    check("the receipt stays undoable for the skipped item only", not e and sorted(rec.get("undone_items", {}).keys()) == ["0", "2"] and rec.get("undoable") is True, rec)
    e, u2 = ws("ws_undo", {"receipt_id": r["receipt_id"]})
    check("undo again: only the conflict is left -> version_conflict with its before value, nothing undone, no force",
          e and code(u2) == "version_conflict" and err_of(u2).get("before", {}).get("fields", {}).get("note") == "n0" and wget(PAGE, p[1])["data"]["note"] == "colleague" and no_force(u2), u2)
    # on_conflict: stop keeps the old all-or-nothing rule
    q = [common.create_page_mcp("us-%d-%s" % (i, RUN)) for i in range(2)]
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": d, "expected_version": wget(PAGE, d)["version"], "set": {"note": "agent"}} for d in q]})
    common.rest_put(RB, q[0], {"note": "colleague"})
    e, u = ws("ws_undo", {"receipt_id": r["receipt_id"], "on_conflict": "stop"})
    check("on_conflict stop: one conflict refuses the whole undo (nothing undone), before values included, no force",
          e and code(u) == "version_conflict" and [wget(PAGE, d)["data"]["note"] for d in q] == ["colleague", "agent"] and no_force(u) and "before" in json.dumps(u), u)
    # before values filtered for the token: one that cannot read `summary` sees no summary value in a conflict
    perms = owner_perms(PAGE, (CM + "read", CM + "update"))
    noread = [dict(x, properties=dict(x["properties"], fields=[f for f in (x["properties"].get("fields") or []) if f != "summary"])) if x["action"] == CM + "read" else x for x in perms]
    tk = make_token("f-nosummary-read", noread)
    d = common.create_page_mcp("uf-%s" % RUN)
    d2 = common.create_page_mcp("uf2-%s" % RUN)
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": d, "expected_version": wget(PAGE, d)["version"], "set": {"summary": "SECRET-BEFORE-%s" % RUN}},
                                     {"uid": PAGE, "documentId": d2, "expected_version": wget(PAGE, d2)["version"], "set": {"note": "x"}}]})
    e, r2 = ws("ws_patch", {"uid": PAGE, "documentId": d, "expected_version": wget(PAGE, d)["version"], "set": {"summary": "agent-after"}})
    common.rest_put(RB, d, {"summary": "colleague-SECRET-%s" % RUN})
    e, u = ws("ws_undo", {"receipt_id": r2["receipt_id"]}, tk)
    blob = json.dumps(u)
    check("conflict for a token that cannot read the field: no before or current value of it", e and code(u) == "version_conflict" and "SECRET" not in blob, u)


# ================================================================ item 21: undo as a job at scale, kill and resume
def kill_strapi():
    port = spike.BASE.rsplit(":", 1)[1].split("/")[0]
    pids = subprocess.run(["lsof", "-ti", "tcp:%s" % port, "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split()
    pidf = os.environ.get("WS_PID_FILE")
    if pidf and os.path.exists(pidf):
        pids.append(open(pidf).read().strip())
    for pid in pids:
        try:
            os.kill(int(pid), signal.SIGKILL)
        except (ProcessLookupError, ValueError):
            pass


class MemSampler:
    """Heap and RSS of the running Strapi, sampled in-process by the probe plugin (/api/probe/memory; review item M7)."""
    def start(self):
        s_, self.first, _ = spike.rest(RA, "POST", "/api/probe/memory", {"reset": True})

    def stop(self):
        s_, self.last, _ = spike.rest(RA, "POST", "/api/probe/memory", {})

    def line(self):
        mb = lambda v: round(v / 1048576) if v else None
        f, l = self.first or {}, self.last or {}
        return "heap start %s MB, peak %s MB; RSS start %s MB, peak %s MB (%s samples)" % (mb(f.get("heapUsed")), mb(l.get("peakHeapUsed")), mb(f.get("rss")), mb(l.get("peakRss")), l.get("samples"))


@T
def t_undo_job_scale():
    pre = "uj-%s" % RUN
    t0 = time.time()
    docs = [page_rest("%s-%04d" % (pre, i), summary="s", note="n0") for i in range(N_SCALE)]
    print("  created %d pages in %.1fs" % (len(docs), time.time() - t0), flush=True)
    base = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "bulk-%s" % RUN}, "chunk_size": 25}
    e, dj = ws("ws_bulk", dict(base, dry_run=True, max_documents=N_SCALE))
    und = (dj or {}).get("undo_budget") or {}
    check("bulk dry run shows the undo byte budget next to undoable (per document, per job, estimate)", not e and dj.get("match_count") == N_SCALE and dj.get("undoable") is True
          and und.get("per_document_bytes") and und.get("job_budget_bytes") and und.get("estimated_bytes", 0) > 0 and und.get("within_budget") is True, dj)
    e, j = bulk_finish(*bulk_start(dict(base, max_documents=N_SCALE), dry=dj, expected_count=N_SCALE))
    check("bulk job over %d documents done" % N_SCALE, not e and j.get("status") == "done" and j["totals"].get("ok") == N_SCALE, j)
    job = j["job_id"]
    colleague = [docs[3], docs[N_SCALE // 2], docs[-2]]
    for d in colleague:
        common.rest_put(RB, d, {"summary": "colleague-%s" % RUN})
    e, dr = ws("ws_undo", {"receipt_id": job, "dry_run": True})
    check("undo dry run of the job: a job plan with entries, bytes, budget, chunks and a preview; nothing written",
          not e and dr.get("dry_run") and dr.get("job") is True and dr.get("total") == N_SCALE and dr.get("bytes", 0) > 0
          and dr.get("budget", {}).get("per_document_bytes") and dr.get("chunks") == -(-N_SCALE // 25) and len(dr.get("preview", [])) == 5
          and pages_with(pre, "&filters[summary][$eq]=s") == [], dr)
    restart, pidf = os.environ.get("WS_RESTART_CMD"), os.environ.get("WS_PID_FILE")
    args = {"receipt_id": job, "agent": "undo-job-bot"}
    if restart and pidf:
        out = {}

        def run():
            try:
                out["r"] = ws("ws_undo", args)
            except Exception as ex:
                out["x"] = str(ex)
        t = threading.Thread(target=run)
        t.start()
        # Let some chunks commit, then kill Strapi hard in the middle of the job (time-based, as the bulk kill test).
        deadline = time.time() + 60
        time.sleep(float(os.environ.get("UNDO_KILL_AFTER", "2.0")))
        kill_strapi()
        t.join(timeout=120)
        time.sleep(1)
        subprocess.run(restart, shell=True, check=True, stdout=subprocess.DEVNULL)
        restored_before = len(pages_with(pre, "&filters[summary][$eq]=s"))
        check("the undo job was interrupted part way by kill -9 (%d of %d restored)" % (restored_before, N_SCALE - 3), 0 < restored_before < N_SCALE - 3, [restored_before, out])
        sampler = MemSampler()
        sampler.start()
        e, r = ws("ws_undo", args)  # same request: resumes the interrupted undo job
        check("the same undo call resumes the interrupted job (resumed, same kind of id)", not e and r.get("resumed") is True and r.get("undo_job_id"), r)
    else:
        print("SKIP kill part of t_undo_job_scale (no WS_RESTART_CMD/WS_PID_FILE): interrupting with max_chunks instead", flush=True)
        sampler = MemSampler()
        sampler.start()
        e, r = ws("ws_undo", dict(args, max_chunks=3))
        check("first call runs 3 chunks and says running, with an undo_job_id and a next hint", not e and r.get("status") == "running" and r.get("undo_job_id") and r.get("next") and no_force(r), r)
        e, r = ws("ws_undo", args)
        check("the same undo call resumes the running job", not e and r.get("resumed") is True, r)
    for _ in range(200):
        if e or r.get("status") != "running":
            break
        e, r = ws("ws_undo", {"undo_job_id": r["undo_job_id"]})
    sampler.stop()
    print("MEASURE undo job of %d documents (resumed part): %s" % (N_SCALE, sampler.line()), flush=True)
    uj = r.get("undo_job_id")
    check("undo job done", not e and r.get("status") == "done", r)
    check("totals: every document restored except the 3 the colleague changed, which are conflicts",
          r.get("totals", {}).get("restored") == N_SCALE - 3 and r.get("totals", {}).get("conflicts") == 3, r.get("totals"))
    rows = pages_with(pre)
    by = {x["documentId"]: x["summary"] for x in rows}
    check("every document back to its value before the job, the colleague's three kept",
          all(by[d] == ("colleague-%s" % RUN if d in colleague else "s") for d in docs), [d for d in docs if by[d] != ("colleague-%s" % RUN if d in colleague else "s")][:10])
    e, s = ws("ws_undo", {"undo_job_id": uj, "status_only": True})
    sc = (s or {}).get("conflicts") or []
    check("status_only lists the 3 conflicts with their before values, no force", not e and sorted(c["documentId"] for c in sc) == sorted(colleague)
          and all(c.get("before", {}).get("fields", {}).get("summary") == "s" and c.get("changed_since") == ["summary"] for c in sc) and no_force(s), s)
    items = history_items(uj)
    restored = [i["documentId"] for i in items]
    check("each document restored exactly once across the undo job's chunk receipts (no chunk applied twice, none lost)",
          len(restored) == N_SCALE - 3 and len(set(restored)) == N_SCALE - 3 and not set(restored) & set(colleague), [len(restored), len(set(restored))])
    e, h = ws("ws_history", {"receipt_id": uj, "limit": 1})
    check("undo chunk receipts are grouped under the undo job id, name what they undo and carry the agent",
          not e and h["receipts"][0].get("group") == uj and h["receipts"][0].get("undo_of") == job and h["receipts"][0].get("agent") == "undo-job-bot", h)
    e, again = run_undo_job({"receipt_id": job})
    check("undoing the job again: only the 3 conflicts are tried again, still skipped, nothing else touched",
          not e and again.get("status") == "done" and again["totals"].get("restored", 0) == 0 and again["totals"].get("conflicts") == 3, again)
    # undo of the undo job (itself a job) puts the bulk change back on the documents it restored
    e, red = run_undo_job({"receipt_id": uj})
    rows = pages_with(pre)
    check("undo of the undo job re-applies the bulk change (as a job), skipping nothing",
          not e and red.get("status") == "done" and red["totals"].get("restored") == N_SCALE - 3
          and all(x["summary"] in ("bulk-%s" % RUN, "colleague-%s" % RUN) for x in rows), red)


@T
def t_undo_job_stop_mode_and_ownership():
    pre = "ujs-%s" % RUN
    docs = [page_rest("%s-%02d" % (pre, i), summary="s") for i in range(8)]
    e, j = bulk_finish(*bulk_start({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "b"}, "chunk_size": 3}))
    check("bulk job done", not e and j.get("status") == "done", j)
    common.rest_put(RB, docs[2], {"summary": "colleague"})
    e, u = ws("ws_undo", {"receipt_id": j["job_id"], "on_conflict": "stop", "chunk_size": 2})
    check("on_conflict stop: the undo job stops at the conflict (newest first), listing it with its before value (an error reply, as a stopped ws_bulk job)",
          e and u.get("status") == "stopped" and u.get("ok") is False and err_of(u).get("code") == "job_stopped"
          and (err_of(u).get("conflict") or {}).get("documentId") == docs[2] and (err_of(u).get("conflict") or {}).get("before", {}).get("fields", {}).get("summary") == "s" and no_force(u), u)
    sums = [x["summary"] for x in pages_with(pre)]
    check("documents after the conflict (in undo order) restored, the rest not yet", sums[3:] == ["s"] * 5 and sums[2] == "colleague" and sums[:2] == ["b", "b"], sums)
    e, o = ws("ws_undo", {"undo_job_id": u["undo_job_id"]}, B)
    check("another token cannot resume or read the undo job", e and code(o) == "not_found", o)
    common.rest_put(RB, docs[2], {"summary": "b"})
    e, u2 = ws("ws_undo", {"undo_job_id": u["undo_job_id"]})
    check("after the colleague's change is gone, resuming the stopped job finishes it", not e and u2.get("status") == "done" and [x["summary"] for x in pages_with(pre)] == ["s"] * 8, u2)


# ================================================================ item 21: per-document cap and job byte budget
@T
def t_undo_byte_budget():
    pre = "ub-%s" % RUN
    big = "y" * 300000
    docs = [page_rest("%s-%d" % (pre, i), summary=(big if i == 1 else "s")) for i in range(3)]
    b1 = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "small"}}
    e, d = ws("ws_bulk", dict(b1, dry_run=True))
    und = (d or {}).get("undo_budget") or {}
    check("bulk dry run: the estimate counts the oversized document as not undoable", not e and und.get("over_document_cap") == 1 and und.get("within_budget") is False, d)
    e, j = bulk_finish(*bulk_start(b1, dry=d))
    e, h = ws("ws_history", {"receipt_id": j["job_id"], "include_before": True})
    rec = h["receipts"][0]
    its = {i["documentId"]: i for i in rec["items"]}
    check("per-document cap: only the oversized document loses its before-image; the chunk's others keep theirs",
          not e and len(h["receipts"]) == 1 and its[docs[1]].get("too_large_to_undo") is True and "before" not in its[docs[1]]
          and its[docs[0]].get("before", {}).get("fields", {}).get("summary") == "s" and rec.get("undoable") is True and not rec.get("too_large_to_undo"), h)
    e, u = run_undo_job({"receipt_id": j["job_id"]})
    sums = [x["summary"] for x in pages_with(pre)]
    check("undo of that job: the two others restored, the oversized one skipped as too_large", not e and sums == ["s", "small", "s"]
          and (u.get("totals", {}).get("too_large") == 1 or any(s.get("reason") == "too_large" for s in u.get("skipped", []))), [u, sums])
    # job budget: WRITESAFE_HISTORY_MAX_JOB_BEFORE_BYTES (1,000,000 in ci/run_suite.sh) over a job's before-images
    pre2 = "ub2-%s" % RUN
    mid = "z" * 200000
    n = 7
    docs2 = [page_rest("%s-%d" % (pre2, i), summary=mid) for i in range(n)]
    b2 = {"uid": PAGE, "filters": {"title": {"$startsWith": pre2}}, "set": {"summary": "small"}, "chunk_size": 2}
    e, d = ws("ws_bulk", dict(b2, dry_run=True))
    und = (d or {}).get("undo_budget") or {}
    check("bulk dry run: the job's estimate is over the job budget -> not within budget, with the numbers",
          not e and und.get("job_budget_bytes") == JOB_BUDGET and und.get("estimated_bytes", 0) > JOB_BUDGET and und.get("within_budget") is False and und.get("note"), d)
    e, j = bulk_finish(*bulk_start(b2, dry=d))
    items = history_items(j["job_id"])
    kept = [i for i in items if not i.get("too_large_to_undo")]
    check("the job keeps before-images until the budget is used, across chunks; the rest are marked too_large_to_undo",
          0 < len(kept) < n and len(kept) * 200000 <= JOB_BUDGET, [len(kept), len(items)])
    e, dr = ws("ws_undo", {"receipt_id": j["job_id"], "dry_run": True})
    check("undo dry run shows bytes and how many entries cannot be undone", not e and dr.get("not_undoable") == n - len(kept) and dr.get("budget", {}).get("per_job_bytes") == JOB_BUDGET, dr)
    e, u = run_undo_job({"receipt_id": j["job_id"]})
    sums = [x["summary"] for x in pages_with(pre2)]
    check("undo restores exactly the documents with a before-image", not e and sums.count(mid) == len(kept) and sums.count("small") == n - len(kept), [u, len(kept)])


# ================================================================ second-agent review of PR #18 (each red first)
def sql(q):
    """Run one statement against the instance's database (read-write)."""
    if os.environ.get("SPIKE_MYSQL"):
        pw = json.load(open(os.environ.get("SPIKE_MYSQL_SECRET") or os.path.join(spike.ROOT, ".secrets", "mysql.json")))["password"]
        out = subprocess.run(["docker", "exec", "-i", "-e", "MYSQL_PWD", os.environ["SPIKE_MYSQL_CONTAINER"], "mysql", "-u" + os.environ.get("SPIKE_MYSQL_USER", "root"), "-N", "-B",
                              os.environ.get("SPIKE_DB_NAME", "strapi"), "-e", "SET SESSION sql_mode='ANSI_QUOTES'; " + q], env=dict(os.environ, MYSQL_PWD=pw), capture_output=True, text=True, check=True).stdout
        return [l.split("\t") for l in out.splitlines() if l]
    if os.environ.get("SPIKE_PG"):
        out = subprocess.run(["docker", "exec", *common.pg_exec_env(), os.environ["SPIKE_PG_CONTAINER"], "psql", "-U", os.environ.get("SPIKE_PG_USER", "postgres"), "-d", os.environ.get("SPIKE_DB_NAME", "strapi"), "-At", "-F", "\t", "-c", q],
                             capture_output=True, text=True, check=True).stdout
        return [l.split("\t") for l in out.splitlines() if l]
    c = sqlite3.connect(common.DB, timeout=30)
    try:
        rows = c.execute(q).fetchall()
        c.commit()
        return [[str(x) for x in r] for r in rows]
    finally:
        c.close()


def age_rows(where, hours):
    if os.environ.get("SPIKE_MYSQL"):
        sql("update writesafe_receipts set created_at = created_at - interval %d hour, updated_at = updated_at - interval %d hour where %s" % (hours, hours, where))
    elif os.environ.get("SPIKE_PG"):
        sql("update writesafe_receipts set created_at = created_at - interval '%d hours', updated_at = updated_at - interval '%d hours' where %s" % (hours, hours, where))
    else:
        sql("update writesafe_receipts set created_at = created_at - %d, updated_at = updated_at - %d where %s" % (hours * 3600000, hours * 3600000, where))


def keys_like(pattern):
    return [r[0] for r in sql("select \"key\" from writesafe_receipts where \"key\" like '%s'" % pattern)]


def bulk_job(pre, n, chunk=2, summary="b"):
    docs = [page_rest("%s-%02d" % (pre, i), summary="s") for i in range(n)]
    e, j = bulk_finish(*bulk_start({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": summary}, "chunk_size": chunk}))
    if e or j.get("status") != "done":
        raise RuntimeError(j)
    return docs, j["job_id"]


@T
def t_review_h1_dry_run_and_status_only_never_write():
    pre = "rh1-%s" % RUN
    docs, job = bulk_job(pre, 6)
    e, u = ws("ws_undo", {"receipt_id": job, "max_chunks": 1, "chunk_size": 2})
    check("an undo job left running", not e and u.get("status") == "running", u)
    before = [x["summary"] for x in pages_with(pre)]
    e, r = ws("ws_undo", {"undo_job_id": u["undo_job_id"], "dry_run": True})
    check("dry_run with undo_job_id is refused (invalid) and runs nothing", e and code(r) == "invalid" and [x["summary"] for x in pages_with(pre)] == before, r)
    e, r = ws("ws_undo", {"receipt_id": job, "status_only": True})
    check("status_only without undo_job_id is refused (invalid) and runs nothing", e and code(r) == "invalid" and [x["summary"] for x in pages_with(pre)] == before, r)
    e, s = ws("ws_undo", {"undo_job_id": u["undo_job_id"], "status_only": True})
    check("status_only with undo_job_id still reads the job", not e and s.get("status") == "running" and [x["summary"] for x in pages_with(pre)] == before, s)
    # phase 4: ws_undo keeps status_only and max_chunks for undo jobs; ws_job reads the same undo job too
    e, s2 = ws("ws_job", {"action": "status", "job_id": u["undo_job_id"]})
    check("ws_job status of the undo job reads it (same state) and runs nothing", not e and s2.get("status") == "running" and s2.get("tool") == "ws_undo"
          and [x["summary"] for x in pages_with(pre)] == before, s2)
    run_undo_job({"undo_job_id": u["undo_job_id"]})


@T
def t_review_m1_marks_survive_concurrent_undos():
    """A job chunk and per-document undos mark entries of the SAME receipt at the same time: no mark may be lost."""
    pre = "rm1-%s" % RUN
    docs, job = bulk_job(pre, 8, chunk=8)
    out = {}

    def jobrun():
        out["job"] = ws("ws_undo", {"receipt_id": job, "chunk_size": 1})

    def one(d):
        out[d] = ws("ws_undo", {"receipt_id": job, "documentId": d})
    ts = [threading.Thread(target=jobrun)] + [threading.Thread(target=one, args=(d,)) for d in docs[:4]]
    [t.start() for t in ts]
    [t.join() for t in ts]
    e, h = ws("ws_history", {"receipt_id": job})
    # under load the bulk job's time budget can split the 8 documents across several chunk receipts (item indices
    # restart at 0 in each): every entry of EVERY receipt of the job must be marked
    recs = [r for r in (h.get("receipts") or []) if not r.get("undo_of")]
    per = [(len(r.get("items") or []), len(r.get("undone_items") or {}), r.get("undoable")) for r in recs]
    covered = {it.get("documentId") for r in recs for it in (r.get("items") or [])}
    check("every entry of every receipt of the job is marked undone exactly by someone (no mark lost to a stale read)",
          bool(recs) and covered == set(docs) and sum(n for n, _, _ in per) == 8 and all(u is False for _, _, u in per)
          and all(set((r.get("undone_items") or {}).keys()) == {str(i) for i in range(len(r.get("items") or []))} for r in recs),
          [[(r.get("receipt_id"), r.get("undone_items")) for r in recs], out.get("job")])
    check("every document back to its value", [x["summary"] for x in pages_with(pre)] == ["s"] * 8)


@T
def t_review_m2_unreadable_entries_never_named():
    """A token limited to its own entries undoes a job over other users' entries: publish and too-large entries are
    skipped without naming them, in the run and in the dry-run preview."""
    perms = owner_perms(PAGE, (CM + "read", CM + "update", CM + "publish"))
    for p in perms:
        p["conditions"] = ["admin::is-creator"]
    who = make_token("f-own-pages", perms)
    pre = "rm2-%s" % RUN
    docs = [page_rest("%s-%d" % (pre, i), summary="s") for i in range(3)]   # API token: no admin creator, not "own"
    e, j = bulk_finish(*bulk_start({"uid": PAGE, "action": "publish", "filters": {"title": {"$startsWith": pre}}}))
    check("bulk publish job done", not e and j.get("status") == "done", j)
    e, d = ws("ws_undo", {"receipt_id": j["job_id"], "dry_run": True}, who)
    blob = json.dumps(d)
    check("dry-run preview names none of the unreadable documents", not any(x in blob for x in docs), d)
    e, u = ws("ws_undo", {"receipt_id": j["job_id"]}, who)
    blob = json.dumps(u)
    check("the run names none of them either (counted as unreadable)", not any(x in blob for x in docs) and (u.get("totals") or {}).get("unreadable") == 3, u)


@T
def t_review_m3_large_batch_stop_is_all_or_nothing():
    p = [page_rest("rm3-%s-%02d" % (RUN, i), note="n0") for i in range(26)]
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": d, "expected_version": wget(PAGE, d)["version"], "set": {"note": "agent"}} for d in p]})
    check("26-item batch ok", not e and r.get("receipt_id"), r)
    common.rest_put(RB, p[0], {"note": "colleague"})
    e, u = ws("ws_undo", {"receipt_id": r["receipt_id"], "on_conflict": "stop"})
    notes = [wget(PAGE, d)["data"]["note"] for d in p]
    check("on_conflict stop on a 26-item receipt: one transaction, nothing undone", e and code(u) == "version_conflict" and notes == ["colleague"] + ["agent"] * 25, [u, notes[:3]])
    e, u = ws("ws_undo", {"receipt_id": r["receipt_id"]})
    notes = [wget(PAGE, d)["data"]["note"] for d in p]
    check("a single receipt up to 100 items stays inline (skip): the reply lists the conflict, the rest undone", not e and "undo_job_id" not in u
          and len(u.get("conflicts", [])) == 1 and notes == ["colleague"] + ["n0"] * 25, [u.get("undo_job_id"), notes[:3]])


@T
def t_review_m4_noop_on_missing_component_writes_nothing():
    a1 = author("F m4 %s" % RUN)
    pre = "rm4-%s" % RUN
    gs = [gallery("%s-%d" % (pre, i)) for i in range(3)]
    v = wget(GAL, gs[0])["version"]
    e, r = ws("ws_patch", {"uid": GAL, "documentId": gs[0], "ops": [{"op": "remove", "field": "feature", "path": "people", "ref": a1}]})
    check("remove from a missing single component: unchanged, nothing written", not e and r.get("unchanged") is True and wget(GAL, gs[0])["version"] == v
          and wget(GAL, gs[0])["data"].get("feature") is None, [r, wget(GAL, gs[0])["data"].get("feature")])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": gs[0], "ops": [{"op": "add", "field": "feature", "path": "people", "ref": a1}, {"op": "remove", "field": "feature", "path": "people", "ref": a1}]})
    check("add then remove on a missing component nets to nothing", not e and r.get("unchanged") is True and wget(GAL, gs[0])["data"].get("feature") is None, r)
    e, j = bulk_finish(*bulk_start({"uid": GAL, "filters": {"title": {"$startsWith": pre}}, "ops": [{"op": "remove", "field": "feature", "path": "people", "ref": a1}]}))
    check("bulk re-tag over documents without the component: every one unchanged, nothing written", not e and j.get("totals", {}).get("unchanged") == 3 and j["totals"].get("ok") == 0
          and all(wget(GAL, g)["data"].get("feature") is None for g in gs), j)
    if j.get("status") in ("paused", "stopped", "running"):
        ws("ws_job", {"action": "cancel", "job_id": j["job_id"]})  # the canary paused it (nothing changed): release the slot


@T
def t_review_m5_relation_ops_edit_only_their_link():
    """Ref ops on a relation send connect/disconnect, so a link written by another path at the same moment survives."""
    keep = [author("F m5 keep%d %s" % (i, RUN)) for i in range(2)]
    ext = [author("F m5 ext%d %s" % (i, RUN)) for i in range(12)]
    mine = [author("F m5 mine%d %s" % (i, RUN)) for i in range(12)]
    g = gallery("rm5-%s" % RUN, contributors=keep)
    errs = []

    def agent():
        for m in mine:
            e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "add", "field": "contributors", "ref": m}]})
            if e:
                errs.append(r)

    def other():
        for x in ext:
            s_, b_, _ = spike.rest(RA, "PUT", "/api/galleries/%s?status=draft" % g, {"data": {"contributors": {"connect": [x]}}})
            if s_ != 200:
                errs.append((s_, b_))
    ts = [threading.Thread(target=agent), threading.Thread(target=other)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    now = set(wget(GAL, g)["data"]["contributors"])
    check("every link kept: the agent's, the other writer's (connect) and the old ones", not errs and now == set(keep + ext + mine), [errs[:2], len(now), sorted(set(keep + ext + mine) - now)[:3]])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "dry_run": True, "ops": [{"op": "remove", "field": "contributors", "ref": keep[0]}, {"op": "add", "field": "contributors", "ref": keep[0], "position": "start"}]})
    check("remove then add with position: a move to the start (dry run)", not e and r.get("diff") is not None, r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "ops": [{"op": "remove", "field": "contributors", "ref": keep[1]}, {"op": "add", "field": "contributors", "ref": keep[1], "position": "start"}]})
    check("... and for real: the link moved to the start, nothing else changed", not e and wget(GAL, g)["data"]["contributors"][0] == keep[1] and set(wget(GAL, g)["data"]["contributors"]) == now, r)


@T
def t_review_m6_undo_of_a_running_job_is_refused():
    pre = "rm6-%s" % RUN
    docs = [page_rest("%s-%02d" % (pre, i), summary="s") for i in range(6)]
    e, j = bulk_start({"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"summary": "b"}, "chunk_size": 2}, max_chunks=1)
    check("bulk job left running", not e and j.get("status") == "running", j)
    e, u = ws("ws_undo", {"receipt_id": j["job_id"]})
    check("undo of a running bulk job: refused (job_running), nothing undone", e and code(u) == "job_running" and [x["summary"] for x in pages_with(pre)][:2] == ["b", "b"], u)
    e, u = ws("ws_undo", {"receipt_id": j["job_id"], "documentId": docs[0]})
    check("... also one document of it", e and code(u) == "job_running", u)
    e, j2 = bulk_finish(*ws("ws_bulk", {"job_id": j["job_id"]}))
    e, u = run_undo_job({"receipt_id": j["job_id"]})
    check("once the job is done its undo runs", not e and u.get("status") == "done" and [x["summary"] for x in pages_with(pre)] == ["s"] * 6, u)
    docs2, job2 = bulk_job("rm6b-%s" % RUN, 6)
    e, uj = ws("ws_undo", {"receipt_id": job2, "max_chunks": 1, "chunk_size": 2})
    e, uu = ws("ws_undo", {"receipt_id": uj["undo_job_id"]})
    check("undo of a running undo job: refused (job_running)", e and code(uu) == "job_running", uu)
    run_undo_job({"undo_job_id": uj["undo_job_id"]})


@T
def t_review_l1_clearing_nested_lists_needs_a_version():
    a1 = author("F l1 %s" % RUN)
    g = gallery("rl1-%s" % RUN, feature={"title": "T", "people": [a1]}, contributors=[a1])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "set": {"feature": None}})
    check("set of a single component holding lists to null without a version: precondition_required", e and code(r) == "precondition_required", r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "unset": ["feature"]})
    check("unset of that component without a version: precondition_required", e and code(r) == "precondition_required", r)
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "unset": ["contributors"]})
    check("unset of a to-many relation without a version: precondition_required (as set: [] is)", e and code(r) == "precondition_required", r)
    check("nothing cleared", wget(GAL, g)["data"]["contributors"] == [a1] and wget(GAL, g)["data"]["feature"]["people"] == [a1])
    e, r = ws("ws_patch", {"uid": GAL, "documentId": g, "expected_version": wget(GAL, g)["version"], "unset": ["contributors"]})
    check("with expected_version it may be cleared", not e and wget(GAL, g)["data"]["contributors"] == [], r)


@T
def t_review_l2_ref_target_in_the_write_locale():
    s_, b_, _ = spike.rest(RA, "POST", "/api/topics?locale=fr", {"data": {"name": "F fr only %s" % RUN}})
    fr_only = b_["data"]["documentId"]
    e, c = ws("ws_create", {"uid": "api::article.article", "locale": "en", "data": {"title": "rl2-%s" % RUN}})
    art = c["documentId"]
    g = ws("ws_get", {"uid": "api::article.article", "documentId": art, "locale": "en"})[1]
    e, r = ws("ws_patch", {"uid": "api::article.article", "documentId": art, "locale": "en", "expected_version": g["version"], "set": {"topic": fr_only}})
    check("a relation target that exists only in another locale is refused (invalid), not linked", e and code(r) == "invalid", r)


def job_row(job_id):
    r = sql("select slot, state from writesafe_bulk_jobs where job_id = '%s'" % job_id)
    return r[0] if r else None


def age_job(job_id, hours):
    if os.environ.get("SPIKE_MYSQL"):
        sql("update writesafe_bulk_jobs set updated_at = updated_at - interval %d hour where job_id = '%s'" % (hours, job_id))
    elif os.environ.get("SPIKE_PG"):
        sql("update writesafe_bulk_jobs set updated_at = updated_at - interval '%d hours' where job_id = '%s'" % (hours, job_id))
    else:
        sql("update writesafe_bulk_jobs set updated_at = updated_at - %d where job_id = '%s'" % (hours * 3600000, job_id))


@T
def t_review_l3_pointer_pruned_with_its_job():
    """Undo jobs live in the bulk job tables (phase 3 E): the slot (one active undo per caller, receipt and mode) is on the
    job row and released when it is done; the store's retention removes an idle job with its items."""
    pre = "rl3-%s" % RUN
    docs, job = bulk_job(pre, 4)
    e, u = ws("ws_undo", {"receipt_id": job, "max_chunks": 1, "chunk_size": 1})
    uj = u["undo_job_id"]
    row = job_row(uj)
    check("a running undo job holds its slot on its job row", row and row[1] == "running" and row[0].startswith("undo|"), row)
    e, r = ws("ws_undo", {"receipt_id": job})
    check("the same call resumes that job (resumed) and finishes it", not e and r.get("undo_job_id") == uj and r.get("resumed") is True and r.get("status") == "done", r)
    row = job_row(uj)
    check("a done undo job releases its slot", row and row[1] == "done" and row[0] in (None, "", "None", "NULL"), row)
    items = sql("select count(*) from writesafe_bulk_items where job_id = '%s'" % uj)[0][0]
    check("one item row per undone entry", int(items) == 4, items)
    age_job(uj, 80)
    ws("ws_history", {"limit": 1})
    check("an undo job idle 80 h is deleted with its items by the store's retention", job_row(uj) is None
          and int(sql("select count(*) from writesafe_bulk_items where job_id = '%s'" % uj)[0][0]) == 0, job_row(uj))


@T
def t_review_l6_marks_kept_when_nothing_is_written():
    e, c = ws("ws_create", {"uid": PAGE, "data": {"title": "rl6-%s" % RUN, "summary": "s"}})
    spike.rest(RA, "DELETE", "/api/pages/%s" % c["documentId"])
    e, u = ws("ws_undo", {"receipt_id": c["receipt_id"]})
    check("undo of a create whose document is gone: already_gone", not e and u["items"][0]["op"] == "already_gone", u)
    e, u2 = ws("ws_undo", {"receipt_id": c["receipt_id"]})
    check("the receipt is marked undone even though nothing was written: a second undo is already_undone", e and code(u2) == "already_undone", u2)

if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    tag = os.environ.get("RESULT_TAG", "")
    json.dump(results, open(os.path.join(HERE, "results", "test_undo_refops%s.json" % ("-" + tag if tag else "")), "w"), indent=1, default=str)
    fails = [r for r in results if not r["pass"]]
    groups = {}
    for r in results:
        g = groups.setdefault(r["group"], [0, 0]); g[0 if r["pass"] else 1] += 1
    for g, (ok, bad) in groups.items():
        print("  %-45s %d/%d" % (g, ok, ok + bad))
    print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
    sys.exit(1 if fails else 0)
