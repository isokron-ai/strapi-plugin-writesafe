"""Functional tests for bulk-job approvals, the admin job API and the in-Strapi runner (1.0 hardening, Phase 4 stream G).

Run by ci/run_suite.sh in three phases, each on a fresh Strapi:
  JOBS_PHASE=approvals  WRITESAFE_APPROVALS_JSON = automatic up to 4 documents, two approvers above 8, ceiling 30,
                        requests and approvals expire after 10 s; the runner is off (agent-driven jobs)
  JOBS_PHASE=runner     the same tiers (ceiling 40, long expiry), the runner on with 3 workers, a 3 s lease
  JOBS_PHASE=retention  jobs and approval records kept 3.6 s (retention.jobHours 0.001), requests expire after 2 s;
                        approverQuietHours 1 (the others use 0)
  JOBS_PHASE=anymode    adminTokens 'any': approvals are off (third review B2)
The approvals, runner and retention phases run with adminTokens 'mcp-only': approvals need it.
Approval requests come from SAFE, a token with the owner's permissions minus every admin:: action: a token that can
manage admin users or roles is refused (approval_unsafe_token), which agent-a (a copy of a Super Admin) shows.
JOBS_RESTART_CMD / JOBS_PID_FILE let the runner phase kill Strapi hard and start it again (crash resume).
ONLY=t_two python3 tests/test_jobs_approval.py runs the tests whose names contain one of those strings.
"""
import json, os, signal, subprocess, sys, time, traceback, urllib.error, urllib.request, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "spike"))
import spike, common
from spike import A, RA

PAGE = "api::page.page"
RUN = uuid.uuid4().hex[:6]
PHASE = os.environ.get("JOBS_PHASE", "approvals")
TTL = 10
results = []
CURRENT = [None]
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]


def check(name, cond, detail=None):
    results.append({"group": CURRENT[0], "test": name, "pass": bool(cond), "detail": detail if not cond else None})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:900]), flush=True)


def T(phase):
    def deco(fn):
        if phase != PHASE or (ONLY and not any(o in fn.__name__ for o in ONLY)):
            return fn
        CURRENT[0] = fn.__name__
        global SAFE
        try:
            # one fresh safe token per test: stream E allows one active job per token and content type, and a job
            # waiting for approval holds that slot
            SAFE = safe_token("safe-" + fn.__name__)[0]
            fn()
        except Exception:
            check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-1500:])
        return fn
    return deco


def _call(tool, args, who):
    err, r, n, full = spike.tool(who, tool, args)
    if err and isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    return err, r


def plan_token(tool, args, who=None):
    """Stream E: a job starts from a dry run's plan_token. Returns (err, dry-run reply)."""
    return _call(tool, dict(args, dry_run=True), who or SAFE)


def ws(tool, args, who=None):
    who = who or SAFE
    # a start of ws_bulk/ws_replace: dry-run first and start with its plan_token (an error of the dry run is returned)
    if tool in ("ws_bulk", "ws_replace") and not args.get("job_id") and not args.get("dry_run") and "plan_token" not in args:
        e, d = plan_token(tool, args, who)
        if e or not isinstance(d, dict) or not d.get("plan_token"):
            return e, d
        args = dict(args, plan_token=d["plan_token"])
    return _call(tool, args, who)


def code(r):
    return ((r or {}).get("error") or {}).get("code") if isinstance(r, dict) else None


# ------------------------------------------------------------------ admin sessions

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


def login(email, password):
    s, b = http("POST", "/admin/login", {"email": email, "password": password})
    if s != 200:
        raise RuntimeError(("login", s, b))
    return b["data"]["token"]


SESS = {"owner": login(OWNER["email"], OWNER["password"])}


def safe_token(label):
    """An admin API token with the owner's permissions minus every admin:: action (users, roles, tokens, settings):
    what the README tells operators to give agents. Registered in spike.TOK under `label`."""
    s, me = http("GET", "/admin/users/me/permissions", None, SESS["owner"])
    perms = [{k: p.get(k) for k in ("action", "subject", "properties", "conditions")} for p in me["data"] if not p["action"].startswith("admin::")]
    s, t = http("POST", "/admin/admin-tokens", {"name": "%s-%s-%s" % (label, PHASE, RUN), "description": "stream G test", "adminPermissions": perms, "lifespan": None}, SESS["owner"])
    if s not in (200, 201):
        raise RuntimeError(("create token", s, t))
    spike.TOK["admin"][label] = t["data"]["accessKey"]
    return label, t["data"]["id"], perms


SAFE = safe_token("safe-agent")[0] if PHASE != "none" else A


ADMIN_PW = {}


def make_admin(label, role_code):
    s, roles = http("GET", "/admin/roles", None, SESS["owner"])
    role = next(r for r in roles["data"] if r["code"] == role_code)
    email = "%s-%s@example.test" % (label, RUN)
    pw = "Ws9" + uuid.uuid4().hex
    s, u = http("POST", "/admin/users", {"firstname": label, "lastname": "Tester", "email": email, "roles": [role["id"]]}, SESS["owner"])
    if s not in (200, 201):
        raise RuntimeError(("create admin", s, u))
    s, r = http("POST", "/admin/register", {"registrationToken": u["data"]["registrationToken"], "userInfo": {"firstname": label, "lastname": "Tester", "password": pw}})
    if s not in (200, 201):
        raise RuntimeError(("register admin", s, r))
    ADMIN_PW[u["data"]["id"]] = pw
    return login(email, pw), u["data"]["id"]


def adm(method, path, body=None, who="owner"):
    return http(method, path, body, SESS[who])


def approvals(status=None):
    s, b = adm("GET", "/writesafe/approvals" + ("?status=" + status if status else ""))
    return b["data"] if s == 200 else (s, b)


def request_of(r):
    rid = r["approval"]["request_id"]
    s, b = adm("GET", "/writesafe/approvals/" + rid)
    return b["data"]


def decide(rid, decision, plan_hash, who="owner"):
    return adm("POST", "/writesafe/approvals/%s/%s" % (rid, decision), {"plan_hash": plan_hash}, who)


# ------------------------------------------------------------------ fixtures

def pages(prefix, n):
    return [common.create_page_mcp("%s-%02d" % (prefix, i), n_items=1, n_sections=1, n_paras=1) for i in range(n)]


def rows_with(prefix, label):
    """documentId -> how many `items` rows with this label (a job's ops add row must land exactly once)."""
    s, b, _ = spike.rest(RA, "GET", "/api/pages?status=draft&filters[title][$startsWith]=%s&populate=items&pagination[pageSize]=200" % prefix)
    return {p["documentId"]: sum(1 for it in (p.get("items") or []) if it.get("label") == label) for p in b["data"]}


def summaries(prefix):
    s, b, _ = spike.rest(RA, "GET", "/api/pages?status=draft&filters[title][$startsWith]=%s&pagination[pageSize]=200" % prefix)
    return [p["summary"] for p in b["data"]]


def bulk(prefix, **kw):
    a = {"uid": PAGE, "filters": {"title": {"$startsWith": prefix}}}
    a.update(kw)
    return a


def status(job, who=None):
    return ws("ws_bulk", {"job_id": job, "status_only": True}, who)[1]


def wait_for(fn, timeout=60, every=0.5):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(every)
    return fn()


# ================================================================== phase 1: approvals, agent-driven jobs

@T("approvals")
def t_rbac_and_catalog():
    s, b = adm("GET", "/admin/users/me/permissions")
    check("the 'Approve writesafe jobs' permission exists and a Super Admin has it",
          s == 200 and any(p["action"] == "plugin::writesafe.approve-jobs" for p in b["data"]), [p["action"] for p in (b or {}).get("data", []) if "writesafe" in p["action"]])
    s, b = http("GET", "/admin/permissions", None, SESS["owner"])
    flat = json.dumps(b)
    check("the action is listed for roles (Settings > Roles > Plugins)", s == 200 and "approve-jobs" in flat, s)
    SESS["editor"], _ = make_admin("editor", "strapi-editor")
    s, b = adm("GET", "/writesafe/approvals", None, "editor")
    check("an admin without the permission cannot open the approvals API (403)", s == 403, [s, b])


@T("approvals")
def t_unsafe_token_cannot_ask():
    pre = "gu1-%s" % RUN
    pages(pre, 5)
    before = len(approvals())
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "unsafe"}), A)  # agent-a: a Super Admin copy, can update admin users
    check("a token that can manage admin users is refused (approval_unsafe_token)", e and code(r) == "approval_unsafe_token" and "admin::users" in r["error"]["message"], r)
    check("nothing stored: no approval request, no job, nothing written", len(approvals()) == before and "unsafe" not in summaries(pre)
          and not any(j["status"] == "awaiting_approval" and j.get("total") == 5 and j["job_id"] == (r or {}).get("job_id") for j in adm("GET", "/writesafe/jobs")[1]["data"]), r)
    e, r2 = ws("ws_bulk", bulk(pre, set={"summary": "unsafe"}, dry_run=True), A)
    check("the dry run warns that this token cannot ask for approval", not e and r2.get("approval", {}).get("token_unsafe") is True, r2)


@T("approvals")
def t_admin_routes_closed_to_agent_token():
    """Approvals run only with adminTokens 'mcp-only' (third review B2): admin tokens authenticate on every admin route
    by default; with 'mcp-only' the agent's admin token is refused outside the MCP endpoint (users, tokens,
    content-manager), which keeps it inside writesafe's guarantees."""
    other, other_id = make_admin("other", "strapi-editor")
    pre = "gr1-%s" % RUN
    doc = pages(pre, 1)[0]
    tok = spike.TOK["admin"][A]
    for method, path, shown, body in (("GET", "/admin/users/me", None, None), ("GET", "/admin/users", None, None),
                                      ("GET", "/admin/users/%s" % other_id, "/admin/users/:id", None),
                                      ("GET", "/admin/admin-tokens", None, None),
                                      ("POST", "/admin/users", None, {"firstname": "M", "lastname": "A", "email": "m-%s@example.test" % RUN, "roles": [1]}),
                                      ("POST", "/admin/admin-tokens", None, {"name": "minted-%s" % RUN, "adminPermissions": [], "lifespan": None}),
                                      ("PUT", "/content-manager/collection-types/%s/%s" % (PAGE, doc),
                                       "/content-manager/collection-types/%s/:documentId" % PAGE, {"summary": "bypass"})):
        s, b = http(method, path, body, tok)
        check("mcp-only: the agent's admin token is refused on %s %s" % (method, shown or path), s in (401, 403), [s, b])
    check("nothing written through the content manager", "bypass" not in summaries(pre), summaries(pre))


@T("approvals")
def t_credential_change_blocks_approval():
    """An approver whose credentials (password, email, active flag, roles) changed after the request cannot approve
    it, however the change was made (here the owner changes the approver's password in the admin panel)."""
    who, who_id = make_admin("credchange", "strapi-super-admin")
    SESS["credchange"] = who
    pre = "gw1-%s" % RUN
    pages(pre, 5)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "after-change"}))
    time.sleep(1.1)
    pw = "Rs9" + uuid.uuid4().hex
    s, b = adm("PUT", "/admin/users/%s" % who_id, {"password": pw})
    check("the approver's password is changed after the request (owner's session)", s == 200, [s, b])
    SESS["credchange"] = login("credchange-%s@example.test" % RUN, pw)
    s, b = decide(r["approval"]["request_id"], "approve", r["approval"]["plan_hash"], "credchange")
    check("approving after a credential change is refused (approver_changed); nothing written", s == 403 and b["error"]["code"] == "approver_changed" and "after-change" not in summaries(pre), [s, b])
    decide(r["approval"]["request_id"], "reject", r["approval"]["plan_hash"])


@T("approvals")
def t_profile_edit_does_not_block():
    """Third review B4: the quiet period and the after-request check follow credentials only, not profile edits."""
    who, who_id = make_admin("renamer", "strapi-super-admin")
    SESS["renamer"] = who
    pre = "gp1-%s" % RUN
    pages(pre, 5)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "renamed"}))
    time.sleep(1.1)
    s, b = adm("PUT", "/admin/users/%s" % who_id, {"firstname": "Renamed", "lastname": "Profile"})
    check("the approver's name is edited after the request (owner's session)", s == 200, [s, b])
    s, b = decide(r["approval"]["request_id"], "approve", r["approval"]["plan_hash"], "renamer")
    check("and can still approve", s == 200 and b["data"]["status"] == "approved", [s, b])
    e, r2 = ws("ws_bulk", {"job_id": r["job_id"]})
    check("the job then runs", not e and r2["status"] == "done" and summaries(pre) == ["renamed"] * 5, r2)


@T("approvals")
def t_replace_dynamic_zone_approved():
    """Third review B1: a ws_replace job over dynamic-zone text can be approved, by an Editor (given the permission)
    and by a Super Admin."""
    s, roles = adm("GET", "/admin/roles")
    ed = next(x for x in roles["data"] if x["code"] == "strapi-editor")
    s, cur = adm("GET", "/admin/roles/%s/permissions" % ed["id"])
    perms = [{k: p.get(k) for k in ("action", "subject", "properties", "conditions")} for p in cur["data"]]
    if not any(p["action"] == "plugin::writesafe.approve-jobs" for p in perms):
        perms.append({"action": "plugin::writesafe.approve-jobs", "subject": None, "properties": {}, "conditions": []})
    s, b = adm("PUT", "/admin/roles/%s/permissions" % ed["id"], {"permissions": perms})
    check("the Editor role gets 'Approve writesafe jobs'", s == 200, [s, b])
    SESS["editor2"], _ = make_admin("editor2", "strapi-editor")
    for who, fields, pre in (("editor2", ["sections.body"], "gd8-%s" % RUN), ("owner", None, "gd9-%s" % RUN)):
        pages(pre, 6)
        a = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "find": "text 0", "replace": "zone text"}
        if fields:
            a["fields"] = fields
        e, r = ws("ws_replace", a)
        check("ws_replace over dynamic-zone text (%s) needs approval" % (fields or "every text field"), e and code(r) == "approval_required", r)
        s, b = decide(r["approval"]["request_id"], "approve", r["approval"]["plan_hash"], who)
        check("%s approves it" % ("an Editor" if who == "editor2" else "a Super Admin"), s == 200 and b["data"]["status"] == "approved", [s, b])
        e, r2 = ws("ws_replace", {"job_id": r["job_id"]})
        s3, b3, _ = spike.rest(RA, "GET", "/api/pages?status=draft&filters[title][$startsWith]=%s&populate=sections&pagination[pageSize]=50" % pre)
        bodies = [sec.get("body") for p in b3["data"] for sec in (p.get("sections") or []) if sec.get("__component") == "blocks.text"]
        check("the replace job runs and changes the zone text", not e and r2["status"] == "done" and bodies and all(x == "zone text" for x in bodies), [r2, bodies])

@T("approvals")
def t_dry_run_says_approval():
    pre = "ga1-%s" % RUN
    pages(pre, 6)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "x"}, dry_run=True))
    check("dry run of 6 (above automatic 4): approval required, one approver", not e and r["match_count"] == 6 and r.get("approval", {}).get("required") is True
          and r["approval"]["approvals_needed"] == 1, r)


@T("approvals")
def t_agent_cannot_approve():
    pre = "gb1-%s" % RUN
    pages(pre, 5)
    for extra in ({"approved": True}, {"approved_by": "admin"}, {"approval_id": "ar_x"}, {"human_approved": True}):
        e, r = ws("ws_bulk", bulk(pre, set={"summary": "forged"}, **extra))
        check("ws_bulk refuses the agent's approval argument %s (unknown key; nothing written)" % list(extra)[0], e and "forged" not in summaries(pre), r)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "forged"}))
    check("start of 5 -> approval_required, job stored but not run", e and code(r) == "approval_required" and r["status"] == "awaiting_approval" and r["processed"] == 0, r)
    check("the reply says the agent cannot approve", "Nothing you send can approve it" in r["error"]["message"], r["error"])
    job, rid, ph = r["job_id"], r["approval"]["request_id"], r["approval"]["plan_hash"]
    # the agent's own admin API token on the admin routes: Strapi accepts admin tokens there; the plugin does not
    for path, method, body in (("/writesafe/approvals/%s/approve" % rid, "POST", {"plan_hash": ph}), ("/writesafe/approvals", "GET", None), ("/writesafe/jobs", "GET", None), ("/writesafe/kill-switch", "PUT", {"on": True})):
        s, b = http(method, path, body, spike.TOK["admin"][A])
        check("agent token on %s %s is refused (403, session required)" % (method, path), s in (401, 403), [s, b])
    e, r2 = ws("ws_bulk", {"job_id": job})
    check("resume before approval: still approval_required, nothing written", e and code(r2) == "approval_required" and "forged" not in summaries(pre), r2)
    pre_b = "gb2-%s" % RUN
    pages(pre_b, 2)
    e, r3 = ws("ws_bulk", bulk(pre_b, set={"summary": "second"}))
    check("a job waiting for approval holds the token's slot: a second job on the type is refused (job_running)", e and code(r3) == "job_running" and r3["error"].get("job_id") == job, r3)
    req = request_of(r)
    check("the request records the requesting token and the plan", req["status"] == "pending" and req["requested_by"]["token_id"] and req["plan_hash"] == ph
          and req["count"] == 5 and req["manifest_root"] and len(req["samples"]) == 3 and req["samples"][0]["after"]["summary"] == "forged", req)
    check("the request lists no decision", req["decisions"] == [], req["decisions"])
    SESS.setdefault("pending_one", (job, rid, ph, pre, SAFE))


@T("approvals")
def t_one_approver_then_agent_starts():
    job, rid, ph, pre, who = SESS["pending_one"]
    s, b = decide(rid, "approve", ph)
    check("a signed-in admin approves (bound to the plan hash shown)", s == 200 and b["data"]["status"] == "approved" and b["data"]["decisions"][0]["approver_id"], [s, b])
    e, r = ws("ws_bulk", {"job_id": job}, who)
    check("the agent's next call starts the approved job and runs it", not e and r["status"] == "done" and r["totals"]["ok"] == 5, r)
    check("every document written once", summaries(pre) == ["forged"] * 5, summaries(pre))
    check("the approval is used (single use)", request_of({"approval": {"request_id": rid}})["status"] == "consumed")
    s, b = decide(rid, "approve", ph)
    check("a used approval cannot be decided again", s == 409, [s, b])


@T("approvals")
def t_two_distinct_approvers():
    pre = "gc1-%s" % RUN
    pages(pre, 9)
    # the second admin exists before the request: an account created or changed after it cannot decide it
    SESS["second"], second_id = make_admin("approver2", "strapi-super-admin")
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "two"}))
    check("9 documents -> two approvers", e and code(r) == "approval_required" and r["approval"]["approvals_needed"] == 2, r)
    job, rid, ph = r["job_id"], r["approval"]["request_id"], r["approval"]["plan_hash"]
    s, b = decide(rid, "approve", ph)
    check("first approval: still pending", s == 200 and b["data"]["status"] == "pending", [s, b])
    s, b = decide(rid, "approve", ph)
    check("the same admin again: refused (already_decided)", s == 409 and b["error"]["code"] == "already_decided", [s, b])
    e, r2 = ws("ws_bulk", {"job_id": job})
    check("with one of two approvals the job does not start", e and code(r2) == "approval_required" and r2["approval"]["approvals_given"] == 1 and "two" not in summaries(pre), r2)
    s, b = decide(rid, "approve", ph, "second")
    check("a second, different admin approves: approved", s == 200 and b["data"]["status"] == "approved" and len({d["approver_id"] for d in b["data"]["decisions"]}) == 2, [s, b])
    e, r3 = ws("ws_bulk", {"job_id": job})
    check("then the job runs", not e and r3["status"] == "done" and summaries(pre) == ["two"] * 9, r3)


@T("approvals")
def t_wrong_plan_refused():
    pa, pb = "gd1-%s" % RUN, "gd2-%s" % RUN
    pages(pa, 5)
    pages(pb, 6)
    _, ra = ws("ws_bulk", bulk(pa, set={"summary": "plan-a"}))
    tb = safe_token("safe-plan-b")[0]  # a second job: another token (one waiting job per token and type)
    _, rb = ws("ws_bulk", bulk(pb, set={"summary": "plan-b"}), tb)
    rb["_who"] = tb
    s, b = decide(ra["approval"]["request_id"], "approve", rb["approval"]["plan_hash"])
    check("approving request A with plan B's hash is refused (plan_mismatch)", s == 409 and b["error"]["code"] == "plan_mismatch", [s, b])
    s, b = decide(ra["approval"]["request_id"], "approve", "0" * 64)
    check("a made-up plan hash is refused too", s == 409 and b["error"]["code"] == "plan_mismatch", [s, b])
    check("A is still pending, nothing written", request_of(ra)["status"] == "pending" and "plan-a" not in summaries(pa))
    s, b = decide(ra["approval"]["request_id"], "approve", None)
    check("a decision without a plan hash is refused", s == 400, [s, b])
    SESS["plan_b"] = rb


@T("approvals")
def t_reject():
    rb = SESS["plan_b"]
    s, b = decide(rb["approval"]["request_id"], "reject", rb["approval"]["plan_hash"])
    check("an admin rejects", s == 200 and b["data"]["status"] == "rejected", [s, b])
    e, r = ws("ws_bulk", {"job_id": rb["job_id"]}, rb["_who"])
    check("the agent's next call: approval_rejected, nothing written", e and code(r) == "approval_rejected" and "plan-b" not in summaries("gd2-%s" % RUN), r)


@T("approvals")
def t_expired():
    pre = "ge1-%s" % RUN
    pages(pre, 5)
    _, r = ws("ws_bulk", bulk(pre, set={"summary": "late"}))
    time.sleep(TTL + 1)
    s, b = decide(r["approval"]["request_id"], "approve", r["approval"]["plan_hash"])
    check("a request not decided in time cannot be approved (expired)", s == 409 and b["error"]["code"] == "expired", [s, b])
    e, r2 = ws("ws_bulk", {"job_id": r["job_id"]})
    check("the agent is told it expired; nothing written", e and code(r2) == "approval_expired" and "late" not in summaries(pre), r2)
    pre2 = "ge2-%s" % RUN
    pages(pre2, 5)
    _, r = ws("ws_bulk", bulk(pre2, set={"summary": "late2"}))
    s, b = decide(r["approval"]["request_id"], "approve", r["approval"]["plan_hash"])
    check("approved in time", s == 200 and b["data"]["status"] == "approved", [s, b])
    time.sleep(TTL + 1)
    e, r3 = ws("ws_bulk", {"job_id": r["job_id"]})
    check("an approval not used in time cannot start the job (approval_expired); nothing written", e and code(r3) == "approval_expired" and "late2" not in summaries(pre2), r3)


@T("approvals")
def t_over_admin_ceiling():
    pre = "gf1-%s" % RUN
    pages(pre, 31)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "too many"}))
    check("above the admin ceiling (30): too_many_documents, no request", e and code(r) == "too_many_documents" and r["error"]["max_documents"] == 30, r)


@T("approvals")
def t_pause_resume_cancel_agent_job():
    pre = "gg1-%s" % RUN
    pages(pre, 4)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "paced"}, chunk_size=1, max_chunks=1))
    check("an automatic job (4 documents) runs one chunk", not e and r["status"] == "running" and r["processed"] == 1, r)
    job = r["job_id"]
    s, b = adm("POST", "/writesafe/jobs/%s/pause" % job, {})
    check("an admin pauses it", s == 200 and b["data"]["status"] == "paused", [s, b])
    e, r2 = ws("ws_bulk", {"job_id": job})
    check("the agent cannot run a paused job (job_paused); nothing more written", e and code(r2) == "job_paused" and summaries(pre).count("paced") == 1, r2)
    e, r2b = ws("ws_bulk", {"job_id": job, "control": "resume"})
    check("nor resume an admin's pause with control: resume (job_paused)", e and code(r2b) == "job_paused" and summaries(pre).count("paced") == 1, r2b)
    s, b = adm("POST", "/writesafe/jobs/%s/resume" % job, {})
    check("the admin resumes it", s == 200 and b["data"]["status"] == "running", [s, b])
    e, r3 = ws("ws_bulk", {"job_id": job, "max_chunks": 1})
    check("the agent continues it", not e and r3["processed"] == 2, r3)
    s, b = adm("POST", "/writesafe/jobs/%s/cancel" % job, {})
    e, r4 = ws("ws_bulk", {"job_id": job})
    check("an admin cancels it: the agent cannot continue (job_cancelled)", s == 200 and e and code(r4) == "job_cancelled" and summaries(pre).count("paced") == 2, [s, r4])
    s, b = adm("GET", "/writesafe/jobs")
    check("the jobs list shows it, without its document list", s == 200 and any(j["job_id"] == job and j["status"] == "cancelled" and "ids" not in j for j in b["data"]), s)


@T("approvals")
def t_kill_switch_agent_job():
    pre = "gh1-%s" % RUN
    pages(pre, 3)
    s, b = adm("PUT", "/writesafe/kill-switch", {"on": True})
    check("an admin stops all bulk jobs", s == 200 and b["data"]["on"] is True, [s, b])
    e, d = plan_token("ws_bulk", bulk(pre, set={"summary": "killed"}))
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "killed"}, plan_token=d["plan_token"]))
    check("a job started now writes nothing (jobs_stopped)", e and code(r) == "jobs_stopped" and "killed" not in summaries(pre), r)
    s, b = adm("PUT", "/writesafe/kill-switch", {"on": False})
    e, r2 = ws("ws_bulk", bulk(pre, set={"summary": "killed"}, plan_token=d["plan_token"]))
    check("switch off: the same start (same plan_token) resumes the job and finishes it", not e and r2["status"] == "done" and summaries(pre) == ["killed"] * 3, r2)


# helpers shared with the runner phase (the T decorator runs a test where it is defined)
def admin_job(job):
    s, b = adm("GET", "/writesafe/jobs")
    return next((j for j in b["data"] if j["job_id"] == job), None) if s == 200 else None


def approve_now(r, who=("owner",)):
    for w in who:
        s, b = decide(r["approval"]["request_id"], "approve", r["approval"]["plan_hash"], w)
        if s != 200:
            raise RuntimeError(("approve failed", w, s, b))


@T("approvals")
def t_undo_jobs_not_approval_tier():
    """Stream F's undo jobs share E's job tables (tool ws_undo) but are not approval-tier bulk jobs: the undo of an
    approved 6-document job (above the automatic tier, 4) runs without approval, also while the kill switch is on (the
    switch stops forward bulk changes, so an undo can repair them); the jobs page lists it and leaves its control to
    the agent."""
    pre = "gundo1-%s" % RUN
    pages(pre, 6)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "undo me"}))
    approve_now(r)
    e, r = ws("ws_bulk", {"job_id": r["job_id"]})
    for _ in range(20):
        if e or r.get("status") != "running":
            break
        e, r = ws("ws_bulk", {"job_id": r["job_id"]})
    check("an approved 6-document job ran", not e and r["status"] == "done" and summaries(pre) == ["undo me"] * 6, r)
    adm("PUT", "/writesafe/kill-switch", {"on": True})
    try:
        e, u = ws("ws_undo", {"receipt_id": r["job_id"], "chunk_size": 2})
        for _ in range(20):
            if e or u.get("status") != "running":
                break
            e, u = ws("ws_undo", {"undo_job_id": u["undo_job_id"]})
        check("its undo runs as an undo job without approval, with the kill switch on, and restores every document",
              not e and u.get("undo_job_id") and u.get("status") == "done" and "undo me" not in summaries(pre)
              and code(u) not in ("approval_required", "jobs_stopped"), u)
        uj = (u or {}).get("undo_job_id")
        lj = admin_job(uj) if uj else None
        check("the jobs page lists the undo job as an undo job", lj and lj.get("tool") == "ws_undo" and lj.get("kind") == "undo" and not lj.get("approval"), lj)
        s, b = adm("POST", "/writesafe/jobs/%s/pause" % uj, {})
        check("the admin cannot pause, resume or cancel an undo job (not_supported): the agent controls it",
              s == 409 and b["error"]["code"] == "not_supported", [s, b])
    finally:
        adm("PUT", "/writesafe/kill-switch", {"on": False})


# ================================================================== phase 2: the runner

@T("runner")
def t_runner_runs_approved_job():
    pre = "gr1-%s" % RUN
    pages(pre, 6)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "bg"}, chunk_size=2))
    check("approval_required, with a hint that the server runs it once approved", e and code(r) == "approval_required" and "by itself" in r["next"]["hint"], r)
    s, b = decide(r["approval"]["request_id"], "approve", r["approval"]["plan_hash"])
    check("approval starts it in the background", s == 200 and b["started"] is True, [s, b])
    st = wait_for(lambda: (lambda x: x if x.get("status") == "done" else None)(status(r["job_id"])), 60)
    check("the runner finishes it without the agent", st and st["status"] == "done" and summaries(pre) == ["bg"] * 6, st)
    j = admin_job(r["job_id"])
    check("the lease is released and the job marked done", j and j["lease"]["state"] == "done" and j["lease"]["worker"] is None, j)


@T("runner")
def t_runner_job_not_driven_by_agent():
    pre = "gr2-%s" % RUN
    pages(pre, 6)
    adm("PUT", "/writesafe/kill-switch", {"on": True})  # hold the runner so the job stays running
    _, r = ws("ws_bulk", bulk(pre, set={"summary": "hold"}, chunk_size=1))
    approve_now(r)
    e, r2 = ws("ws_bulk", {"job_id": r["job_id"]})
    check("the agent's resume of a runner job reports it (runner: true) and writes nothing itself", not e and r2.get("runner") is True and r2["processed"] == 0 and "hold" not in summaries(pre), r2)
    adm("PUT", "/writesafe/kill-switch", {"on": False})
    st = wait_for(lambda: (lambda x: x if x.get("status") == "done" else None)(status(r["job_id"])), 60)
    check("kill switch off: the runner finishes it", st and summaries(pre) == ["hold"] * 6, st)


@T("runner")
def t_runner_crash_resume():
    cmd, pidf = os.environ.get("JOBS_RESTART_CMD"), os.environ.get("JOBS_PID_FILE")
    if not cmd or not pidf:
        print("SKIP t_runner_crash_resume (no JOBS_RESTART_CMD)")
        return
    pre = "gr3-%s" % RUN
    pages(pre, 24)
    SESS["second"], _ = make_admin("approver2r", "strapi-super-admin")
    _, r = ws("ws_bulk", bulk(pre, ops=[{"op": "add", "field": "items", "data": {"label": "crash-row", "qty": 1}}], chunk_size=2))
    approve_now(r, ("owner", "second") if r["approval"]["approvals_needed"] == 2 else ("owner",))
    got = wait_for(lambda: (lambda x: x if x.get("processed", 0) >= 4 else None)(status(r["job_id"])), 60, 0.1)
    before = got["processed"] if got else None
    port = spike.BASE.rsplit(":", 1)[1].split("/")[0]
    pids = subprocess.run(["lsof", "-ti", "tcp:%s" % port, "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split()
    for pid in set(pids + [open(pidf).read().strip()]):
        try:
            os.kill(int(pid), signal.SIGKILL)
        except Exception:
            pass
    time.sleep(1)
    check("Strapi killed mid-job (SIGKILL) after %s documents" % before, before is not None and before < 24, before)
    rc = subprocess.run([cmd]).returncode
    SESS["owner"] = login(OWNER["email"], OWNER["password"])
    if "second" in SESS:
        del SESS["second"]
    check("Strapi started again", rc == 0, rc)
    st = wait_for(lambda: (lambda x: x if x.get("status") == "done" else None)(status(r["job_id"])), 90)
    counts = rows_with(pre, "crash-row")
    check("after the restart the runner resumes and finishes the job", st and st["status"] == "done" and st["processed"] == 24, st)
    check("every document got the row exactly once (no chunk ran twice, none skipped)", len(counts) == 24 and all(v == 1 for v in counts.values()), counts)
    j = admin_job(r["job_id"])
    check("the lease was taken over after it expired (fence >= 2)", j and j["lease"]["fence"] >= 2, j and j["lease"])


@T("runner")
def t_runner_three_workers_two_jobs():
    p1, p2 = "gr4-%s" % RUN, "gr5-%s" % RUN
    pages(p1, 7)
    pages(p2, 7)
    adm("PUT", "/writesafe/kill-switch", {"on": True})
    jobs = []
    whos = []
    for p in (p1, p2):
        who = safe_token("safe-" + p)[0]  # one token per job (one active job per token and type)
        _, r = ws("ws_bulk", bulk(p, ops=[{"op": "add", "field": "items", "data": {"label": "w-row", "qty": 1}}], chunk_size=1), who)
        approve_now(r)
        jobs.append(r["job_id"])
        whos.append(who)
    adm("PUT", "/writesafe/kill-switch", {"on": False})
    done = wait_for(lambda: all(status(j, w).get("status") == "done" for j, w in zip(jobs, whos)), 90)
    c1, c2 = rows_with(p1, "w-row"), rows_with(p2, "w-row")
    check("two jobs run by three competing workers both finish", done, [status(j, w) for j, w in zip(jobs, whos)])
    check("every document of both jobs got its row exactly once", len(c1) == 7 and len(c2) == 7 and all(v == 1 for v in list(c1.values()) + list(c2.values())), [c1, c2])
    ev = [admin_job(j)["lease"]["events"] for j in jobs]
    chunks = [[e for e in x if e.get("e") == "chunk"] for x in ev]
    check("each chunk start (cursor) appears once per job in the runner log", all(len({c["from"] for c in cs}) == len(cs) for cs in chunks), chunks)


@T("runner")
def t_runner_permission_revoked_pauses():
    # a dedicated token, so the shared agent tokens keep their rights
    _, tid, perms = safe_token("revoke-me")
    s, t = adm("GET", "/admin/admin-tokens/%s" % tid)
    pre = "gr6-%s" % RUN
    pages(pre, 30)
    SESS["second"], _ = make_admin("approver2p", "strapi-super-admin")
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "perm"}, chunk_size=1), "revoke-me")
    check("the token asks for a 30-document job", e and code(r) == "approval_required", r)
    adm("PUT", "/writesafe/kill-switch", {"on": True})
    approve_now(r, ("owner", "second") if r["approval"]["approvals_needed"] == 2 else ("owner",))
    adm("PUT", "/writesafe/kill-switch", {"on": False})
    wait_for(lambda: status(r["job_id"], "revoke-me").get("processed", 0) >= 2, 60, 0.1)
    # take away update on pages from the token (Settings > API tokens): the next chunk must not run
    less = [p for p in perms if not (p["subject"] == PAGE and p["action"].endswith("explorer.update"))]
    s, b = adm("PUT", "/admin/admin-tokens/%s" % tid, {"name": t["data"]["name"], "description": "stream G test", "adminPermissions": less})
    check("the token's update permission on pages is removed mid-job", s == 200, [s, b])
    st = wait_for(lambda: (lambda x: x if x.get("status") == "paused" else None)(status(r["job_id"], "revoke-me")), 30, 0.2)
    n_paused = summaries(pre).count("perm")
    check("the runner pauses the job with permission_changed", st and st["status"] == "paused" and st.get("pause_reason") == "permission_changed", st)
    time.sleep(2)
    check("nothing is written after the pause", summaries(pre).count("perm") == n_paused and n_paused < 30, [n_paused])
    j = admin_job(r["job_id"])
    check("the admin page shows why", j and j["pause_reason"] == "permission_changed" and j["lease"]["state"] == "paused", j)
    # a deleted token: resuming is refused (the token cannot be used any more)
    adm("DELETE", "/admin/admin-tokens/%s" % tid)
    s, b = adm("POST", "/writesafe/jobs/%s/resume" % r["job_id"], {})
    check("resuming a job whose token was deleted is refused (token_unusable)", s == 409 and b["error"]["code"] == "token_unusable", [s, b])
    adm("POST", "/writesafe/jobs/%s/cancel" % r["job_id"], {})


# ================================================================== phase 3: retention (jobHours 0.001 = 3.6 s),
# adminTokens 'mcp-only', approverQuietHours 1

@T("retention")
def t_mcp_only_admin_tokens():
    doc = common.create_page_mcp("gm1-%s" % RUN, n_items=1, n_sections=1, n_paras=1)
    tok = spike.TOK["admin"][A]
    for method, path, body in (("GET", "/admin/users/me", None), ("GET", "/admin/users", None),
                               ("PUT", "/content-manager/collection-types/api::page.page/%s" % doc, {"title": "bypass"}),
                               ("POST", "/content-manager/collection-types/api::page.page/actions/bulkPublish", {"documentIds": [doc]}),
                               ("POST", "/admin/admin-tokens", {"name": "x-%s" % RUN, "adminPermissions": [], "lifespan": None}),
                               ("GET", "/writesafe/jobs", None)):
        s, b = http(method, path, body, tok)
        check("mcp-only: the agent's admin token is refused on %s %s" % (method, path), s in (401, 403), [s, b])
    e, r = ws("ws_get", {"uid": PAGE, "documentId": doc}, A)
    check("mcp-only: the same token still works over MCP", not e and r.get("documentId") == doc, r)
    s, b = adm("GET", "/admin/users/me")
    check("mcp-only: an admin session still works", s == 200)
    s, b = adm("GET", "/writesafe/jobs")
    check("the jobs page reports adminTokens mcp-only", s == 200 and b.get("admin_tokens") == "mcp-only", b.get("admin_tokens") if isinstance(b, dict) else b)
    e, r = ws("ws_schema", {})
    check("ws_schema reports adminTokens mcp-only", not e and r.get("admin_tokens") == "mcp-only", r)


@T("retention")
def t_quiet_period_refuses_recent_account():
    pre = "gq1-%s" % RUN
    pages(pre, 5)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "quiet"}))
    s, b = decide(r["approval"]["request_id"], "approve", r["approval"]["plan_hash"])
    check("an admin whose account was created less than approverQuietHours (1 h) ago cannot approve", s == 403 and b["error"]["code"] in ("approver_changed", "requester_cannot_approve"), [s, b])
    s, lst = adm("GET", "/writesafe/approvals")
    check("the page data says when the viewer's account last changed", s == 200 and lst["me"].get("account_changed_at") and lst["me"].get("quiet_hours") == 1, lst.get("me"))
    s, b = decide(r["approval"]["request_id"], "reject", r["approval"]["plan_hash"])
    check("a rejection is allowed in the quiet period", s == 200 and b["data"]["status"] == "rejected", [s, b])


@T("retention")
def t_filter_too_long():
    pre = "gz1-%s" % RUN
    pages(pre, 5)
    pad = {"$or": [{"title": {"$startsWith": pre}}] + [{"title": {"$eq": "pad-%05d-%s" % (i, "x" * 40)}} for i in range(400)]}
    e, r = ws("ws_bulk", {"uid": PAGE, "filters": pad, "set": {"summary": "padded"}})
    check("a request whose filter is over the stored limit is refused (filter_too_long), nothing stored", e and code(r) == "filter_too_long" and "padded" not in summaries(pre), r)

def gone_job(job, who=None):
    e, r = ws("ws_bulk", {"job_id": job, "status_only": True}, who)
    return e and code(r) == "not_found"


@T("retention")
def t_retention_prunes_with_records():
    pa, pq, pr = "gt1-%s" % RUN, "gt2-%s" % RUN, "gt3-%s" % RUN
    pages(pa, 5); pages(pq, 3); pages(pr, 5)
    ta, tq, tr, tf = [safe_token("safe-ret-" + x)[0] for x in "aqrf"]  # one token per job (one slot each)
    _, ra = ws("ws_bulk", bulk(pa, set={"summary": "ret-a"}), ta)       # waits; its request expires (2 s)
    e, rq = ws("ws_bulk", bulk(pq, set={"summary": "ret-q"}, chunk_size=1, max_chunks=1), tq)
    adm("POST", "/writesafe/jobs/%s/pause" % rq["job_id"], {})          # paused by an admin, then idle
    _, rr = ws("ws_bulk", bulk(pr, set={"summary": "ret-r"}), tr)
    decide(rr["approval"]["request_id"], "reject", rr["approval"]["plan_hash"])
    time.sleep(1.0)
    pf = "gt4-%s" % RUN
    pages(pf, 5)
    check("before the prune: every job and record is there", not gone_job(ra["job_id"], ta) and not gone_job(rq["job_id"], tq), [ra, rq])
    # stream E never prunes a job younger than a plan token's life plus a minute (planTtlSeconds 5 here): 65 s
    time.sleep(67.0)
    _, rf = ws("ws_bulk", bulk(pf, set={"summary": "ret-f"}), tf)       # a fresh request, made just now
    ws("ws_history", {"limit": 1})                                       # runs the prune (pruneEverySeconds 0)
    time.sleep(0.5)
    s1, _ = adm("GET", "/writesafe/approvals/" + ra["approval"]["request_id"])
    s2, _ = adm("GET", "/writesafe/approvals/" + rr["approval"]["request_id"])
    s3, _ = adm("GET", "/writesafe/approvals/" + rf["approval"]["request_id"])
    check("a waiting job whose request expired is pruned with its request", gone_job(ra["job_id"], ta) and s1 == 404, [s1])
    check("a rejected request is pruned with its decisions and its job", gone_job(rr["job_id"], tr) and s2 == 404, [s2])
    check("an idle paused job is pruned (long horizon 4.3 s here)", gone_job(rq["job_id"], tq))
    check("a fresh waiting request and its job stay", s3 == 200 and not gone_job(rf["job_id"], tf), [s3])


# ================================================================== phase 4: adminTokens "any" (approvals off)

@T("anymode")
def t_any_mode_refuses_approval_tier():
    pre = "ga9-%s" % RUN
    pages(pre, 6)
    before = len(approvals())
    e, d = ws("ws_bulk", bulk(pre, set={"summary": "any"}, dry_run=True))
    check("dry run: the job would need approval, which needs adminTokens mcp-only", not e and d.get("approval", {}).get("needs_mcp_only") is True, d)
    e, r = ws("ws_bulk", bulk(pre, set={"summary": "any"}))
    check("start: refused with approval_needs_mcp_only, naming the setting", e and code(r) == "approval_needs_mcp_only" and "adminTokens" in r["error"]["message"], r)
    check("no approval request, nothing written", len(approvals()) == before and "any" not in summaries(pre))
    s, b = adm("GET", "/writesafe/jobs")
    check("the jobs page explains why approvals are off", s == 200 and b.get("approvals", {}).get("active") is False and b["approvals"].get("reason") == "needs_mcp_only", b.get("approvals") if isinstance(b, dict) else b)
    pre2 = "ga8-%s" % RUN
    pages(pre2, 3)
    e, r2 = ws("ws_bulk", bulk(pre2, set={"summary": "small"}))
    check("a job within the automatic tier still runs", not e and r2["status"] == "done", r2)
    e, sc = ws("ws_schema", {})
    check("ws_schema does not mention the admin-token mode when it is 'any'", not e and "admin_tokens" not in sc, sc.get("admin_tokens") if isinstance(sc, dict) else sc)


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    tag = os.environ.get("RESULT_TAG", "")
    json.dump(results, open(os.path.join(HERE, "results", "test_jobs_approval-%s%s.json" % (PHASE, "-" + tag if tag else "")), "w"), indent=1, default=str)
    fails = [r for r in results if not r["pass"]]
    groups = {}
    for r in results:
        g = groups.setdefault(r["group"], [0, 0]); g[0 if r["pass"] else 1] += 1
    for g, (ok, bad) in groups.items():
        print("  %-45s %d/%d" % (g, ok, ok + bad))
    print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
    sys.exit(1 if fails else 0)
