"""1.0 hardening, phase 4 (the last items), end to end against a running Strapi: the ws_job tool (list, status, cancel,
undo; undo-job cancel), the arguments that moved there from ws_bulk / ws_replace (max_chunks stays on them: it paces a
call), publish "if_clean" on ws_patch,
ws_bulk and ws_replace, and per-field if_match on ws_patch and ws_batch items.

ci/run_suite.sh runs it in two phases, each on a fresh Strapi (same database and tokens):
  P4R_PHASE=main       the suite's usual config (every module on, approvals off)
  P4R_PHASE=approvals  WRITESAFE_APPROVALS_JSON with escalate.publish (automatic up to 4 documents) and
                       WRITESAFE_ADMIN_TOKENS=mcp-only: a ws_bulk patch with publish "if_clean" waits for an admin
The jobs are started by tokens made here (the owner's permissions minus admin::, as the README tells operators), so
"the caller's own jobs" is exact; agent-noauthor (no publish) and agent-noread (no read of note) come from
scripts/setup_hardening.mjs. WRITESAFE_TEST_PROBE=true is needed (common.one_chunk ends a call after one chunk through
the time budget).

Run: P4R_PHASE=main python3 tests/test_phase4_rest.py   (exit 1 on any failure; results in tests/results/)
ONLY=t_if_match python3 tests/test_phase4_rest.py runs the tests whose names contain one of those strings.
"""
import json, os, sys, traceback, urllib.error, urllib.request, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "spike"))
import spike, common
from spike import A, B, RA

PAGE = "api::page.page"
TOPIC = "api::topic.topic"
PHASE = os.environ.get("P4R_PHASE", "main")
RUN = uuid.uuid4().hex[:6]
results = []
CURRENT = [None]
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]
NOAUTHOR = "agent-noauthor"  # page read and update, no publish
NOREAD = "agent-noread"      # page update and publish, no read of note, seo.metaDescription or items


def check(name, cond, detail=None):
    results.append({"group": CURRENT[0], "phase": PHASE, "test": name, "pass": bool(cond), "detail": detail if not cond else None})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:900]), flush=True)


def T(phase):
    def deco(fn):
        if phase != PHASE or (ONLY and not any(o in fn.__name__ for o in ONLY)):
            return fn
        CURRENT[0] = fn.__name__
        try:
            fn()
        except Exception:
            check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-1500:])
        return fn
    return deco


def ws(tool, args, who):
    err, r, n, full = spike.tool(who, tool, args)
    if err and isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    return err, r


def code(r):
    return ((r or {}).get("error") or {}).get("code") if isinstance(r, dict) else None


def text(r):
    return r if isinstance(r, str) else json.dumps(r, default=str)


def start(tool, args, who, one=False, **run):
    """Dry run, then start with its plan_token (one=True: the time budget ends the start after one chunk; `run`:
    arguments for the start only, e.g. max_chunks). Returns (err, reply) of the start, or of the dry run when that
    failed."""
    e, d = ws(tool, dict(args, dry_run=True), who)
    if e or not isinstance(d, dict) or not d.get("plan_token"):
        return e, d
    if one:
        with common.one_chunk():
            return ws(tool, dict(args, plan_token=d["plan_token"], **run), who)
    return ws(tool, dict(args, plan_token=d["plan_token"], **run), who)


def job(who, action, job_id=None, **kw):
    a = {"action": action}
    if job_id is not None:
        a["job_id"] = job_id
    a.update(kw)
    return ws("ws_job", a, who)


# ------------------------------------------------------------------ admin session and tokens

def http(method, path, body=None, bearer=None):
    h = {"Accept": "application/json"}
    if bearer:
        h["Authorization"] = "Bearer " + bearer
    if body is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(spike.BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")[:500]


OWNER = json.load(open(os.environ["SPIKE_ADMIN"]))
s_, b_ = http("POST", "/admin/login", {"email": OWNER["email"], "password": OWNER["password"]})
if s_ != 200:
    raise SystemExit("admin login failed: %s %s" % (s_, str(b_)[:300]))
JWT = b_["data"]["token"]


def safe_token(label):
    """An admin API token with the owner's permissions minus every admin:: action (the README's agent token)."""
    s, me = http("GET", "/admin/users/me/permissions", None, JWT)
    perms = [{k: p.get(k) for k in ("action", "subject", "properties", "conditions")} for p in me["data"] if not p["action"].startswith("admin::")]
    s, t = http("POST", "/admin/admin-tokens", {"name": "p4r-%s-%s-%s" % (label, PHASE, RUN), "description": "phase 4 test", "adminPermissions": perms, "lifespan": None}, JWT)
    if s not in (200, 201):
        raise RuntimeError(("create token", s, t))
    spike.TOK["admin"][label] = t["data"]["accessKey"]
    return label


P = safe_token("p4r-owner")   # starts the jobs
Q = safe_token("p4r-other")   # another token with the same permissions: sees none of P's jobs


# ------------------------------------------------------------------ fixtures

def page(title, who=A):
    return common.create_page_mcp("%s %s" % (RUN, title), who, n_items=2, n_sections=1, n_paras=1)


def get(doc, who=P):
    e, r = ws("ws_get", {"uid": PAGE, "documentId": doc}, who)
    if e:
        raise RuntimeError(r)
    return r


def publish(doc, who=P):
    e, r = ws("ws_publish", {"uid": PAGE, "documentId": doc, "expected_version": get(doc, who)["version"]}, who)
    if e:
        raise RuntimeError(r)
    return r


def patch(doc, who=P, **kw):
    a = {"uid": PAGE, "documentId": doc}
    a.update(kw)
    return ws("ws_patch", a, who)


def draft(doc):
    s, b, _ = spike.rest(RA, "GET", "/api/pages/%s?status=draft&populate=*" % doc)
    return b["data"] if s == 200 else None


def live(doc):
    """The published version (REST), or None."""
    s, b, _ = spike.rest(RA, "GET", "/api/pages/%s?status=published" % doc)
    return (b or {}).get("data") if s == 200 else None


def by_prefix(prefix):
    return {"title": {"$startsWith": "%s %s" % (RUN, prefix)}}


def summaries(docs):
    return [draft(d)["summary"] for d in docs]


# ================================================================== main phase

@T("main")
def t_catalog():
    s, b, _ = spike.rpc(P, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    jt = tools.get("ws_job", {}).get("inputSchema", {})
    check("ws_job is listed, strict, with actions list, status, cancel and undo", jt.get("additionalProperties") is False
          and jt.get("properties", {}).get("action", {}).get("enum") == ["list", "status", "cancel", "undo"], jt)
    check("ws_job offers no force", "force" not in jt.get("properties", {}), sorted(jt.get("properties", {})))
    for n in ("ws_bulk", "ws_replace"):
        props = tools[n]["inputSchema"]["properties"]
        check(n + ": status_only, items and cursor are gone from the schema", not any(k in props for k in ("status_only", "items", "cursor")), sorted(props))
        check(n + ": max_chunks stays (pacing), an integer of at least 1", props.get("max_chunks", {}).get("minimum") == 1, props.get("max_chunks"))
        check(n + ": control offers only resume", props.get("control", {}).get("enum") == ["resume"], props.get("control"))
        check(n + ": job_id (continue) and publish \"if_clean\" are offered", "job_id" in props and props.get("publish", {}).get("enum") == ["if_clean"], sorted(props))
    pp = tools["ws_patch"]["inputSchema"]["properties"]
    check("ws_patch offers if_match and publish \"if_clean\"", "if_match" in pp and pp.get("publish", {}).get("enum") == ["if_clean"], sorted(pp))
    item = tools["ws_batch"]["inputSchema"]["properties"]["items"]["items"]
    check("ws_batch items offer if_match, not publish (\"if_clean\")", "if_match" in item.get("properties", {}) and "publish" not in item.get("properties", {}), sorted(item.get("properties", {})))
    s, b, _ = spike.rpc(P, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    ins = (b.get("result") or {}).get("instructions") or ""
    check("the instructions name ws_job, if_match and if_clean", all(x in ins for x in ("ws_job", "if_match", "if_clean")), ins[-1500:])


@T("main")
def t_old_arguments_name_ws_job():
    docs = [page("old-%d" % i) for i in range(3)]
    e, r = start("ws_bulk", {"uid": PAGE, "filters": by_prefix("old-"), "set": {"summary": "old args"}, "chunk_size": 1}, P, one=True)
    check("a one-chunk start leaves the job running (1 of 3)", not e and r.get("status") == "running" and r.get("processed") == 1, r)
    jid = r.get("job_id")
    for tool in ("ws_bulk", "ws_replace"):
        for extra in ({"status_only": True}, {"items": "all"}, {"cursor": "0"}, {"control": "cancel"}, {"max_chunks": 1, "status_only": True}):
            e, x = ws(tool, dict({"job_id": jid}, **extra), P)
            t = text(x)
            name = "control cancel" if "control" in extra else "+".join(sorted(extra))
            check("%s %s: refused as invalid, naming ws_job (max_chunks not named as moved)" % (tool, name),
                  e and "ws_job" in t and ("invalid" in t.lower()) and "max_chunks:" not in t and "max_chunks," not in t, x)
    e, st = job(P, "status", jid)
    check("... and none of them ran or cancelled anything (ws_job status: still running, 1 processed)", not e and st.get("status") == "running" and st.get("processed") == 1, st)
    check("... the documents after the first are untouched", summaries(docs).count("old args") == 1, summaries(docs))
    e, r = ws("ws_bulk", {"job_id": jid}, P)
    check("ws_bulk {job_id} still continues the job (to done)", not e and r.get("status") == "done" and r.get("processed") == 3, r)
    check("... every document written once", summaries(docs) == ["old args"] * 3, summaries(docs))


@T("main")
def t_max_chunks_paces_continuation():
    """max_chunks stays on ws_bulk and ws_replace (start and {job_id, max_chunks}): it paces a call; reading and
    cancelling moved to ws_job. A job left active by a failure is cancelled, so the next test can start its own."""
    docs = [page("mc-%d" % i) for i in range(5)]
    left = []
    try:
        e, r = start("ws_bulk", {"uid": PAGE, "filters": by_prefix("mc-"), "set": {"summary": "paced"}, "chunk_size": 1}, P, max_chunks=2)
        check("ws_bulk start with max_chunks 2 (chunk_size 1): running, 2 of 5 processed", not e and r.get("status") == "running" and r.get("processed") == 2 and r.get("chunks_done") == 2, r)
        jid = r.get("job_id")
        left.append(jid)
        check("... exactly 2 documents written", summaries(docs).count("paced") == 2, summaries(docs))
        e, r = ws("ws_bulk", {"job_id": jid, "max_chunks": 0}, P)
        check("max_chunks 0 is refused (an error naming max_chunks), nothing run", e and "max_chunks" in text(r) and summaries(docs).count("paced") == 2, r)
        e, r = ws("ws_bulk", {"job_id": jid, "max_chunks": 1}, P)
        check("ws_bulk {job_id, max_chunks: 1}: one more chunk (3 of 5), still running", not e and r.get("status") == "running" and r.get("processed") == 3 and r.get("chunks_done") == 3, r)
        check("... exactly 3 documents written", summaries(docs).count("paced") == 3, summaries(docs))
        e, st = job(P, "status", jid)
        check("ws_job status agrees (running, 3 processed)", not e and st.get("status") == "running" and st.get("processed") == 3, st)
        e, r = ws("ws_bulk", {"job_id": jid, "max_chunks": 10}, P)
        check("ws_bulk {job_id, max_chunks: 10}: runs only what is left (to done, 5 of 5)", not e and r.get("status") == "done" and r.get("processed") == 5 and r.get("chunks_done") == 5, r)
        check("... every document written once", summaries(docs) == ["paced"] * 5, summaries(docs))
        rargs = {"uid": PAGE, "filters": by_prefix("mc-"), "find": "paced", "replace": "PACED", "fields": ["summary"], "chunk_size": 1}
        e, r = start("ws_replace", rargs, P, max_chunks=1)
        check("ws_replace start with max_chunks 1: running, 1 of 5", not e and r.get("status") == "running" and r.get("processed") == 1, r)
        rj = r.get("job_id")
        left.append(rj)
        e, r = ws("ws_replace", {"job_id": rj, "max_chunks": 2}, P)
        check("ws_replace {job_id, max_chunks: 2}: two more chunks (3 of 5), still running", not e and r.get("status") == "running" and r.get("processed") == 3, r)
        check("... exactly 3 documents replaced", summaries(docs).count("PACED") == 3, summaries(docs))
        e, r = ws("ws_replace", {"job_id": rj}, P)
        check("ws_replace {job_id} without max_chunks finishes it (time budget)", not e and r.get("status") == "done" and r.get("processed") == 5 and summaries(docs) == ["PACED"] * 5, [r, summaries(docs)])
    finally:
        for j in left:
            if j:
                job(P, "cancel", j)  # no-op on a done job


@T("main")
def t_job_list_status_ownership():
    [page("list-%d" % i) for i in range(2)]
    e, j1 = start("ws_bulk", {"uid": PAGE, "filters": by_prefix("list-"), "set": {"note": "listed"}}, P)
    e2, j2 = start("ws_replace", {"uid": PAGE, "filters": by_prefix("list-"), "find": "listed", "replace": "LISTED", "fields": ["note"]}, P)
    check("a ws_bulk and a ws_replace job done", j1.get("status") == "done" and j2.get("status") == "done", [j1, j2])
    e3, u = job(P, "undo", j2["job_id"])
    check("ws_job undo of the replace job: an undo job, done", not e3 and u.get("tool") == "ws_undo" and u.get("status") == "done" and u.get("job_id") == u.get("undo_job_id"), u)
    e, l = job(P, "list", limit=10)
    ids = [x["job_id"] for x in l.get("jobs", [])]
    check("list: the token's newest jobs first (the undo job, the replace job, the bulk job)", not e and ids[:3] == [u.get("undo_job_id"), j2["job_id"], j1["job_id"]], l)
    one = {x["job_id"]: x for x in l.get("jobs", [])}
    b1 = one.get(j1["job_id"], {})
    check("list item of the bulk job: tool, action, uid, status, totals, timestamps, undoable", b1.get("tool") == "ws_bulk" and b1.get("action") == "patch" and b1.get("uid") == PAGE
          and b1.get("status") == "done" and b1.get("total") == 2 and b1.get("totals", {}).get("ok") == 2 and b1.get("created_at") and b1.get("updated_at") and b1.get("undoable") is True, b1)
    uu = one.get(u.get("undo_job_id"), {})
    check("list item of the undo job: tool ws_undo, undo_of the replace job", uu.get("tool") == "ws_undo" and uu.get("undo_of") == j2["job_id"] and uu.get("status") == "done", uu)
    check("list items carry no content (no spec, filter or values)", "LISTED" not in json.dumps(l) and "listed" not in json.dumps(l), l)
    e, p1 = job(P, "list", limit=2)
    e2, p2 = job(P, "list", limit=2, cursor=p1.get("next_cursor") or "0")
    check("list pages: limit 2 then next_cursor gives the third", [x["job_id"] for x in p1.get("jobs", [])] == ids[:2] and p1.get("next_cursor")
          and [x["job_id"] for x in p2.get("jobs", [])][:1] == ids[2:3], [p1, p2])
    e, lq = job(Q, "list")
    check("another token lists none of these jobs", not e and lq.get("jobs") == [], lq)
    for act in ("status", "cancel", "undo"):
        for jid in (j1["job_id"], u.get("undo_job_id")):
            e, r = job(Q, act, jid)
            check("another token: %s of %s job is not_found" % (act, "the bulk" if jid == j1["job_id"] else "the undo"), e and code(r) == "not_found", r)
    e, r = job(P, "status", "j_doesnotexist")
    check("an unknown job id is not_found too", e and code(r) == "not_found", r)
    e, st = job(P, "status", j1["job_id"], items="all")
    check("status of the bulk job: totals and every document (items all)", not e and st.get("status") == "done" and len(st.get("items", [])) == 2 and st.get("items_scope") == "all", st)
    e, su = job(P, "status", u.get("undo_job_id"))
    check("status of the undo job: tool ws_undo, its totals", not e and su.get("tool") == "ws_undo" and su.get("status") == "done" and su.get("totals", {}).get("restored") == 2, su)
    e, r = job(P, "list", job_id=j1["job_id"])
    check("each action takes only its own arguments (list with job_id: invalid)", e and code(r) == "invalid", r)
    e, r = job(P, "status")
    check("status without job_id: invalid", e and code(r) == "invalid", r)


@T("main")
def t_job_cancel():
    docs = [page("cancel-%d" % i) for i in range(3)]
    e, r = start("ws_bulk", {"uid": PAGE, "filters": by_prefix("cancel-"), "set": {"summary": "cancel me"}, "chunk_size": 1}, P, one=True)
    jid = r.get("job_id")
    check("job running after one chunk", not e and r.get("status") == "running" and r.get("processed") == 1, r)
    e, c = job(Q, "cancel", jid)
    check("another token cannot cancel it (not_found)", e and code(c) == "not_found", c)
    e, c = job(P, "cancel", jid)
    check("ws_job cancel: cancelled, after the chunk that was done (processed 1)", not e and c.get("cancelled") is True and c.get("status") == "cancelled" and c.get("processed") == 1, c)
    check("... what it wrote is kept, the rest untouched", summaries(docs).count("cancel me") == 1, summaries(docs))
    e, r = ws("ws_bulk", {"job_id": jid}, P)
    check("a cancelled job is not resumed (job_cancelled) and writes nothing", e and code(r) == "job_cancelled" and summaries(docs).count("cancel me") == 1, r)
    e, c2 = job(P, "cancel", jid)
    check("cancel again: nothing to cancel (cancelled false, a note)", not e and c2.get("cancelled") is False and c2.get("status") == "cancelled" and c2.get("note"), c2)
    e, u = job(P, "undo", jid)
    check("ws_job undo of the cancelled job reverts what it wrote", not e and u.get("status") == "done" and u.get("totals", {}).get("restored") == 1 and "cancel me" not in summaries(docs), [u, summaries(docs)])
    # a job running chunks cannot be undone yet (the undo would miss its later chunks)
    e, r = start("ws_bulk", {"uid": PAGE, "filters": by_prefix("cancel-"), "set": {"summary": "second"}, "chunk_size": 1}, P, one=True)
    e2, u2 = job(P, "undo", r.get("job_id"))
    check("ws_job undo of a running job: job_running, nothing undone", e2 and code(u2) == "job_running" and summaries(docs).count("second") == 1, u2)
    job(P, "cancel", r.get("job_id"))


@T("main")
def t_undo_job_cancel():
    docs = [page("ucancel-%d" % i) for i in range(3)]
    before = summaries(docs)
    e, r = start("ws_bulk", {"uid": PAGE, "filters": by_prefix("ucancel-"), "set": {"summary": "to undo"}}, P)
    jid = r.get("job_id")
    check("bulk job done over 3 documents", not e and r.get("status") == "done" and summaries(docs) == ["to undo"] * 3, r)
    e, d = job(P, "undo", jid, dry_run=True)
    check("ws_job undo dry_run: the plan, nothing undone", not e and summaries(docs) == ["to undo"] * 3, d)
    e, u = job(P, "undo", jid, chunk_size=1, max_chunks=1)
    uid_ = u.get("undo_job_id")
    check("ws_job undo with max_chunks 1: an undo job, running, one entry restored", not e and u.get("status") == "running" and u.get("totals", {}).get("restored") == 1
          and u.get("next", {}).get("job_id") == uid_, u)
    e, c = job(Q, "cancel", uid_)
    check("another token cannot cancel the undo job (not_found)", e and code(c) == "not_found", c)
    e, c = job(P, "cancel", uid_)
    check("ws_job cancel of the undo job: cancelled, what it reverted is reported (totals) and kept", not e and c.get("cancelled") is True and c.get("status") == "cancelled"
          and c.get("tool") == "ws_undo" and c.get("totals", {}).get("restored") == 1 and c.get("note"), c)
    now = summaries(docs)
    check("... one document reverted, two still patched", now.count("to undo") == 2 and len([x for x in now if x in before]) == 1, now)
    e, r = ws("ws_undo", {"undo_job_id": uid_}, P)
    check("ws_undo {undo_job_id} of the cancelled undo job: job_cancelled, nothing undone", e and code(r) == "job_cancelled" and summaries(docs) == now, r)
    e, r = job(P, "undo", uid_, max_chunks=1)
    # ws_job undo of a finished (here: cancelled) undo job is not a resume: it undoes what that job reverted
    check("... ws_job undo of the cancelled undo job is not a resume: a new undo job of it (undo_of the undo job)", not e and r.get("undo_of") == uid_ and r.get("undo_job_id") != uid_, r)
    check("... which puts its one revert back (every document patched again)", summaries(docs) == ["to undo"] * 3, summaries(docs))
    e, st = job(P, "status", uid_)
    check("ws_job status of the cancelled undo job: cancelled, restored 1", not e and st.get("status") == "cancelled" and st.get("totals", {}).get("restored") == 1, st)
    e, u2 = job(P, "undo", jid)
    check("a new undo of the bulk job finishes the rest", not e and u2.get("status") == "done" and u2.get("undo_job_id") != uid_, u2)
    check("... every document back to before the job", summaries(docs) == before, [summaries(docs), before])


# ------------------------------------------------------------------ publish "if_clean"

@T("main")
def t_if_clean_patch():
    clean, dirty, never = page("ic-clean"), page("ic-dirty"), page("ic-never")
    publish(clean)
    publish(dirty)
    e, r = patch(dirty, set={"note": "unpublished change"}, expected_version=get(dirty)["version"])
    check("dirty fixture: a draft change nobody published", not e, r)
    g = get(clean)
    e, d = patch(clean, set={"summary": "clean dry"}, expected_version=g["version"], publish="if_clean", dry_run=True)
    check("dry run: would_publish true, nothing written or published", not e and d.get("would_publish") is True and "published" not in d
          and draft(clean)["summary"] == "s" and live(clean)["summary"] == "s", d)
    e, r = patch(clean, set={"summary": "clean and live"}, expected_version=g["version"], publish="if_clean")
    check("clean draft: patched and published in the same write (published, published_version = version)", not e and r.get("published") is True
          and r.get("published_version") == r.get("version") and "publish_skipped" not in r, r)
    check("... the live version has the change", (live(clean) or {}).get("summary") == "clean and live", live(clean))
    g2 = get(clean)
    check("... and the draft reads as the version the reply gave", g2["version"] == r.get("version"), [g2["version"], r.get("version")])
    gd = get(dirty)
    e, r = patch(dirty, set={"summary": "dirty"}, expected_version=gd["version"], publish="if_clean")
    check("draft with other unpublished changes: written, not published (draft_had_other_changes)", not e and r.get("published") is False
          and r.get("publish_skipped") == "draft_had_other_changes", r)
    check("... live unchanged, draft has both changes", (live(dirty) or {}).get("summary") == "s" and (live(dirty) or {}).get("note") == "n0"
          and draft(dirty)["summary"] == "dirty" and draft(dirty)["note"] == "unpublished change", [live(dirty), draft(dirty)])
    e, r = patch(never, set={"summary": "never"}, expected_version=get(never)["version"], publish="if_clean")
    check("never published: written, not published (no_live_version)", not e and r.get("published") is False and r.get("publish_skipped") == "no_live_version" and live(never) is None, r)
    # no publish permission: refused before any write (also a dry run)
    ga = get(clean, NOAUTHOR)
    for dry in (True, False):
        e, r = patch(clean, NOAUTHOR, set={"summary": "no rights"}, expected_version=ga["version"], publish="if_clean", **({"dry_run": True} if dry else {}))
        check("token without publish permission: forbidden%s" % (" (dry run)" if dry else ""), e and code(r) == "forbidden", r)
    check("... nothing written", get(clean)["version"] == g2["version"] and draft(clean)["summary"] == "clean and live", draft(clean))
    e, r = patch(clean, NOAUTHOR, set={"summary": "draft only"}, expected_version=ga["version"])
    check("... the same token writes the draft without publish", not e and "published" not in r, r)
    e, r = patch(clean, set={"summary": "x"}, expected_version=get(clean)["version"], publish="always")
    check("publish takes only \"if_clean\"", e, r)
    # with allowForce on, force + if_clean publishes only a clean draft too (force skips the version, never the clean check)
    e, r = patch(dirty, set={"summary": "forced"}, force=True, publish="if_clean")
    check("force with if_clean on a dirty draft: written, still not published", not e and r.get("published") is False and r.get("publish_skipped") == "draft_had_other_changes"
          and (live(dirty) or {}).get("summary") == "s", r)
    # nothing changed: nothing written, nothing published
    gc = get(clean)
    e, r = patch(clean, set={"summary": gc["data"]["summary"]}, expected_version=gc["version"], publish="if_clean")
    check("a patch that changes nothing publishes nothing", not e and r.get("published") is not True, r)
    # ws_batch: publish is not an item argument (a publish item does that)
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": clean, "set": {"summary": "b"}, "expected_version": get(clean)["version"], "publish": "if_clean"}]}, P)
    check("ws_batch item with publish: refused", e, r)


@T("main")
def t_if_clean_bulk_and_replace():
    clean, dirty, never = page("icb-clean"), page("icb-dirty"), page("icb-never")
    publish(clean)
    publish(dirty)
    patch(dirty, set={"note": "pending"}, expected_version=get(dirty)["version"])
    args = {"uid": PAGE, "filters": by_prefix("icb-"), "set": {"summary": "bulk clean"}, "publish": "if_clean"}
    e, d = ws("ws_bulk", dict(args, dry_run=True), P)
    prev = {x.get("documentId"): x for x in (d.get("preview") or d.get("items") or [])}
    check("dry run: plan with publish if_clean, a publish note", not e and d.get("plan_token") and d.get("publish") == "if_clean" and d.get("publish_note"), d)
    check("dry run preview: would_publish per document (clean true, the others false)", (not prev) or (prev.get(clean, {}).get("would_publish") is True
          and all(prev.get(x, {}).get("would_publish") is False for x in (dirty, never) if x in prev)), prev)
    e, d2 = ws("ws_bulk", {"uid": PAGE, "filters": by_prefix("icb-"), "set": {"summary": "bulk clean"}, "dry_run": True}, P)
    e, r = ws("ws_bulk", dict(args, plan_token=d2.get("plan_token")), P)
    check("a plan made without publish cannot start a job with it (plan_mismatch)", e and code(r) == "plan_mismatch", r)
    e, r = ws("ws_bulk", dict(args, plan_token=d.get("plan_token")), P)
    check("job done; totals: ok 3, published 1, publish_skipped 2", not e and r.get("status") == "done" and r.get("totals", {}).get("ok") == 3
          and r.get("totals", {}).get("published") == 1 and r.get("totals", {}).get("publish_skipped") == 2, r)
    e, st = job(P, "status", r.get("job_id"), items="all")
    its = {x["documentId"]: x for x in st.get("items", [])}
    check("ws_job status items: published / publish_skipped per document", its.get(clean, {}).get("published") is True
          and its.get(dirty, {}).get("publish_skipped") == "draft_had_other_changes" and its.get(never, {}).get("publish_skipped") == "no_live_version", its)
    check("live: only the clean document has the change", (live(clean) or {}).get("summary") == "bulk clean" and (live(dirty) or {}).get("summary") == "s" and live(never) is None,
          [live(clean), live(dirty), live(never)])
    e, r = ws("ws_bulk", dict(args, dry_run=True), NOAUTHOR)
    check("ws_bulk with if_clean, token without publish permission: forbidden at the dry run", e and code(r) == "forbidden", r)
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": by_prefix("icb-"), "action": "publish", "publish": "if_clean", "dry_run": True}, P)
    check("action publish with publish if_clean: invalid", e and code(r) == "invalid", r)
    # ws_replace: the clean document (draft equal to live again after the bulk publish) is published
    e, r = start("ws_replace", {"uid": PAGE, "filters": by_prefix("icb-clean"), "find": "bulk clean", "replace": "replaced live", "fields": ["summary"], "publish": "if_clean"}, P)
    check("ws_replace with if_clean: done, the clean document published", not e and r.get("status") == "done" and r.get("totals", {}).get("published") == 1
          and (live(clean) or {}).get("summary") == "replaced live", [r, live(clean)])
    e, r = start("ws_replace", {"uid": PAGE, "filters": by_prefix("icb-dirty"), "find": "bulk clean", "replace": "replaced draft", "fields": ["summary"], "publish": "if_clean"}, P)
    check("ws_replace with if_clean on a dirty draft: written, publish_skipped 1, live unchanged", not e and r.get("totals", {}).get("publish_skipped") == 1
          and draft(dirty)["summary"] == "replaced draft" and (live(dirty) or {}).get("summary") == "s", r)
    e, r = ws("ws_replace", {"uid": PAGE, "filters": by_prefix("icb-"), "find": "x", "replace": "y", "publish": "if_clean", "dry_run": True}, NOAUTHOR)
    check("ws_replace with if_clean, token without publish permission: forbidden", e and code(r) == "forbidden", r)


# ------------------------------------------------------------------ if_match

@T("main")
def t_if_match_patch():
    doc = page("im")
    g = get(doc)
    s0, n0 = g["data"]["summary"], g["data"]["note"]
    # another writer changes a field this agent does not touch: if_match on its own field still applies (mergeable)
    e, r = patch(doc, B, set={"note": "other writer"}, expected_version=get(doc, B)["version"])
    check("fixture: another token changed note", not e, r)
    e, r = patch(doc, set={"summary": "mine"}, if_match={"summary": s0})
    check("set without expected_version, with if_match on that field: applied over another field's change", not e and r.get("ok") is not False and r.get("changed") == ["summary"], r)
    d = draft(doc)
    check("... both changes kept (summary mine, note other writer)", d["summary"] == "mine" and d["note"] == "other writer", d)
    # the field changed since it was read: version_conflict naming it in fields_changed, with the whole current state
    e, r = patch(doc, B, set={"summary": "theirs"}, if_match={"summary": "mine"})
    e, r = patch(doc, set={"summary": "stale"}, if_match={"summary": "mine"})
    err = (r or {}).get("error", {}) if isinstance(r, dict) else {}
    check("changed field: version_conflict with fields_changed [summary]", e and code(r) == "version_conflict" and err.get("fields_changed") == ["summary"], r)
    cur = err.get("current") or {}
    cur_data = cur.get("data", cur) if isinstance(cur, dict) else {}
    check("... current holds the whole document (that field's new value and the fields it did not name)", isinstance(cur_data, dict) and cur_data.get("summary") == "theirs" and cur_data.get("note") == "other writer" and "title" in cur_data, err.get("current"))
    check("... a retry version, and nothing written", (err.get("retry") or {}).get("expected_version") and draft(doc)["summary"] == "theirs", err)
    check("... the value is under data fields only, never in message or hint", "theirs" not in (err.get("message") or "") and "theirs" not in json.dumps(err.get("retry", {}).get("hint", "")), err)
    # a field written without an entry: precondition_required naming it
    e, r = patch(doc, set={"summary": "a", "note": "b"}, if_match={"summary": "theirs"})
    check("set of two fields with if_match on one: precondition_required naming the other", e and code(r) == "precondition_required" and "note" in json.dumps((r or {}).get("error", {}).get("fields") or (r or {}).get("error", {}).get("field")), r)
    e, r = patch(doc, unset=["note"], if_match={"note": "other writer"})
    check("unset with an if_match entry: applied", not e and draft(doc)["note"] in (None, ""), r)
    # refusals
    for label, a in (("with force", {"set": {"summary": "f"}, "if_match": {"summary": "theirs"}, "force": True}),
                     ("dotted path", {"set": {"summary": "f"}, "if_match": {"summary": "theirs", "seo.metaTitle": "meta"}}),
                     ("unknown field", {"set": {"summary": "f"}, "if_match": {"summary": "theirs", "nope": 1}}),
                     ("empty object", {"set": {"summary": "f"}, "if_match": {}})):
        e, r = patch(doc, **a)
        check("if_match %s: invalid, nothing written" % label, e and (code(r) == "invalid" or "if_match" in text(r)) and draft(doc)["summary"] == "theirs", r)
    # expected_version is still checked when both are sent
    e, r = patch(doc, set={"summary": "both"}, if_match={"summary": "theirs"}, expected_version="v2.stale")
    check("if_match with a stale expected_version: refused, nothing written", e and code(r) in ("version_conflict", "invalid") and draft(doc)["summary"] == "theirs", r)
    # a component compared as a whole (as ws_get returns it)
    g = get(doc)
    e, r = patch(doc, set={"seo": {"metaTitle": "new meta"}}, if_match={"seo": g["data"]["seo"]})
    check("component field: if_match with the value ws_get returned applies", not e and draft(doc)["seo"]["metaTitle"] == "new meta", r)
    e, r = patch(doc, set={"seo": {"metaTitle": "newer"}}, if_match={"seo": g["data"]["seo"]})
    check("... and the old value is a conflict naming seo", e and code(r) == "version_conflict" and (r.get("error") or {}).get("fields_changed") == ["seo"], r)
    # row ops keep their own rules (row keys), alongside an if_match set
    g = get(doc)
    k = g["rows"]["items"][0]
    e, r = patch(doc, set={"summary": "with rows"}, if_match={"summary": g["data"]["summary"]}, ops=[{"op": "update", "field": "items", "key": k, "data": {"label": "row edited"}}])
    check("row op by key together with an if_match set: applied", not e and draft(doc)["summary"] == "with rows" and draft(doc)["items"][0]["label"] == "row edited", r)
    # a field the token cannot read: refused, never compared (no oracle), whatever the value
    gn = get(doc)
    for v in (gn["data"].get("note"), "guess"):
        e, r = patch(doc, NOREAD, set={"note": "x"}, if_match={"note": v})
        check("if_match on a field the token cannot read (%s value): forbidden" % ("right" if v == gn["data"].get("note") else "wrong"), e and code(r) == "forbidden", r)
    check("... nothing written", get(doc)["version"] == gn["version"], None)
    e, r = patch(doc, NOREAD, set={"summary": "noread ok"}, if_match={"summary": gn["data"]["summary"]})
    check("the same token with if_match on a field it reads: applied", not e and draft(doc)["summary"] == "noread ok", r)


@T("main")
def t_if_match_batch():
    d1, d2 = page("imb-1"), page("imb-2")
    s1, s2 = get(d1)["data"]["summary"], get(d2)["data"]["summary"]
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": d1, "set": {"summary": "b1"}, "if_match": {"summary": s1}},
                                     {"uid": PAGE, "documentId": d2, "set": {"summary": "b2"}, "if_match": {"summary": s2}}]}, P)
    check("ws_batch patch items with if_match: both applied", not e and draft(d1)["summary"] == "b1" and draft(d2)["summary"] == "b2", r)
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": d1, "set": {"summary": "c1"}, "if_match": {"summary": "b1"}},
                                     {"uid": PAGE, "documentId": d2, "set": {"summary": "c2"}, "if_match": {"summary": "stale"}}]}, P)
    check("one item's if_match no longer holds: the batch is refused (version_conflict), nothing written", e and "version_conflict" in text(r)
          and draft(d1)["summary"] == "b1" and draft(d2)["summary"] == "b2", r)
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": d1, "set": {"summary": "d1", "note": "d1"}, "if_match": {"summary": "b1"}}]}, P)
    check("a batch item writing a field without an entry: precondition_required", e and "precondition_required" in text(r) and draft(d1)["summary"] == "b1", r)
    e, r = ws("ws_batch", {"items": [{"uid": PAGE, "documentId": d1, "action": "publish", "expected_version": get(d1)["version"], "if_match": {"summary": "b1"}}]}, P)
    check("a publish item with if_match: invalid", e and "invalid" in text(r), r)


# ================================================================== approvals phase (escalate.publish, mcp-only)

def approval_of(rid):
    s, b = http("GET", "/writesafe/approvals/" + rid, None, JWT)
    return b.get("data") if s == 200 and isinstance(b, dict) else (s, b)


@T("approvals")
def t_if_clean_escalates_and_owner_cancels():
    docs = [page("esc-%d" % i) for i in range(2)]
    for d in docs:
        publish(d)
    args = {"uid": PAGE, "filters": by_prefix("esc-"), "set": {"summary": "escalated"}, "publish": "if_clean"}
    e, d = ws("ws_bulk", dict(args, dry_run=True), P)
    ap = (d or {}).get("approval") or {}
    check("dry run of 2 documents with if_clean: approval required (reason publish), under the automatic count", not e and ap.get("required") is True and ap.get("reason") == "publish", d)
    e, r = ws("ws_bulk", dict(args, plan_token=d.get("plan_token")), P)
    check("start: approval_required, the job waits (awaiting_approval), nothing written", e and code(r) == "approval_required" and r.get("status") == "awaiting_approval"
          and summaries(docs) == ["s", "s"], r)
    jid, rid = r.get("job_id"), (r.get("approval") or {}).get("request_id")
    e, l = job(P, "list")
    check("ws_job list shows the waiting job", not e and any(x["job_id"] == jid and x["status"] == "awaiting_approval" for x in l.get("jobs", [])), l)
    e, st = job(Q, "status", jid)
    check("another token: not_found", e and code(st) == "not_found", st)
    e, c = job(Q, "cancel", jid)
    check("another token cannot cancel it (not_found)", e and code(c) == "not_found", c)
    e, c = job(P, "cancel", jid)
    check("the owner cancels the waiting job through ws_job", not e and c.get("cancelled") is True and c.get("status") == "cancelled", c)
    req = approval_of(rid)
    check("... its approval request is cancelled too", isinstance(req, dict) and req.get("status") == "cancelled", req)
    e, r = ws("ws_bulk", {"job_id": jid}, P)
    check("... and the job cannot be started any more; nothing written", e and code(r) in ("job_cancelled", "approval_cancelled") and summaries(docs) == ["s", "s"], r)
    s, b = http("POST", "/writesafe/approvals/%s/approve" % rid, {"plan_hash": (req or {}).get("planHash") or (req or {}).get("plan_hash")}, JWT)
    check("an admin cannot approve the cancelled request", s >= 400, [s, b])


@T("approvals")
def t_if_clean_approved_runs_and_counts():
    clean, dirty = page("appr-clean"), page("appr-dirty")
    publish(clean)
    publish(dirty)
    patch(dirty, set={"note": "pending"}, expected_version=get(dirty)["version"])
    [page("apprplain-%d" % i) for i in range(2)]
    e, plain = start("ws_bulk", {"uid": PAGE, "filters": by_prefix("apprplain-"), "set": {"note": "no publish"}}, P)
    check("a job without publish under automaticMax: automatic (no approval)", not e and plain.get("status") == "done" and plain.get("totals", {}).get("ok") == 2, plain)
    args = {"uid": PAGE, "filters": by_prefix("appr-"), "set": {"summary": "approved"}, "publish": "if_clean"}
    e, r = start("ws_bulk", args, P)
    check("if_clean job waits for approval", e and code(r) == "approval_required", r)
    jid, ap = r.get("job_id"), r.get("approval") or {}
    s, b = http("POST", "/writesafe/approvals/%s/approve" % ap.get("request_id"), {"plan_hash": ap.get("plan_hash")}, JWT)
    check("the owner admin approves it", s in (200, 201), [s, b])
    e, r = ws("ws_bulk", {"job_id": jid}, P)
    check("approved: the agent starts it with {job_id}; done, published 1, publish_skipped 1", not e and r.get("status") == "done"
          and r.get("totals", {}).get("published") == 1 and r.get("totals", {}).get("publish_skipped") == 1, r)
    check("live: the clean document published, the other not", (live(clean) or {}).get("summary") == "approved" and (live(dirty) or {}).get("summary") == "s", [live(clean), live(dirty)])
    e, l = job(P, "list", limit=1)
    check("ws_job list: the job, done", not e and l.get("jobs", [{}])[0].get("job_id") == jid and l["jobs"][0].get("status") == "done", l)
    e, r = start("ws_replace", {"uid": PAGE, "filters": by_prefix("appr-"), "find": "approved", "replace": "again", "fields": ["summary"], "publish": "if_clean"}, P)
    check("ws_replace with if_clean waits for approval too", e and code(r) == "approval_required", r)
    if r.get("job_id"):
        job(P, "cancel", r["job_id"])
    e, r = patch(clean, set={"summary": "single"}, expected_version=get(clean)["version"], publish="if_clean")
    check("ws_patch with if_clean is one document: no approval, published", not e and r.get("published") is True, r)


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    tag = os.environ.get("RESULT_TAG", "")
    json.dump(results, open(os.path.join(HERE, "results", "test_phase4_rest-%s%s.json" % (PHASE, "-" + tag if tag else "")), "w"), indent=1, default=str)
    fails = [r for r in results if not r["pass"]]
    groups = {}
    for r in results:
        g = groups.setdefault(r["group"], [0, 0]); g[0 if r["pass"] else 1] += 1
    for g, (ok, bad) in groups.items():
        print("  %-45s %d/%d" % (g, ok, ok + bad))
    print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
    sys.exit(1 if fails else 0)
