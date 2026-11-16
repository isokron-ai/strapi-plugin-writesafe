"""Stale admin form guard (bench task X4; config staleFormGuard, default on; server/compat/stale-form.js, server/rebase.js,
admin/form-base.mjs), against a running Strapi, every database.

An editor's Content Manager form loaded before an agent's write must not write its old values over the agent's change
behind a 200. Each "tab" here is a client that echoes the version its form was loaded at (X-Writesafe-Version on the
load, X-Writesafe-Base on Save, publish and discard), as the admin panel's fetch wrapper does. The checks:
  - X4 itself: form loaded, ws_patch (Coffee 12), the stale Save (title changed) -> 200, Coffee 12 AND the new title,
    and the response names the agent's change it kept; barrier-ordered too (the Save waits for the agent's lock);
  - merges: disjoint top-level and component fields, rows the editor added while the agent edited another list, rows
    the agent added while the editor edited a row, localized entries and non-localized fields, single types;
  - 409 (nothing saved): the same field changed on both sides (message names the field and both values), both sides
    changing a list's rows, edit against delete, a publish or discard with agent changes the editor has not seen, a
    form without the base header while the entry has journal entries, an opaque change (REST) since the load;
  - unchanged: an editor alone, two editors (last Save wins), a form loaded after the agent's write, a dry run, REST
    and other writers outside the plugin with staleFormGuard { otherWriters: false }, bulk publish, plain unpublish, a form
    without the header on an entry no agent wrote;
  - review fixes: an edit inside a row the agent removed (B1), a header-less Save or publish across the agent's commit
    (B2), concurrent writers on fresh documents (S1), concurrent discards of fresh documents (N2), an agent-deleted
    locale (S2), journal pruning (base_too_old);
  - two tabs: the stale tab is merged against its own base (a newer tab does not mask it);
  - in the database: Strapi restarted between the agent's write and the Save still merges or refuses; with a component
    lifecycle subscriber (PROBE_LOCK_COVERAGE) X4 still merges; staleFormGuard: false restores Strapi's behaviour.
Run: python3 tests/test_stale_form.py (env as for tests/test_plugin.py; ci/run_suite.sh runs it with WS_RESTART_CMD)."""
import json, os, signal, subprocess, sys, threading, time, traceback, urllib.error, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "stress"))
import lockarms as L  # noqa: E402
from lockarms import spike, RA  # noqa: E402

results = []
CURRENT = [None]
PAGE, GUIDE, HOME = "api::page.page", "api::guide.guide", "api::homepage.homepage"
DB_LABEL = L.DB_LABEL
TAG = "sf-%s-%d" % (DB_LABEL, int(time.time()) % 100000)
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]


def check(name, cond, detail=None):
    results.append({"group": CURRENT[0], "test": name, "pass": bool(cond), "detail": detail if not cond else None})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:1200]), flush=True)


def T(fn):
    if ONLY and not any(o in fn.__name__ for o in ONLY):
        return fn
    CURRENT[0] = fn.__name__
    try:
        fn()
    except Exception:
        check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-1200:])
    return fn


# ---------------------------------------------------------------- an admin-panel tab
class Tab:
    """One browser tab of one admin user: its own memory of the version each form was loaded at."""
    def __init__(self, email, password, echo=True):
        self.email, self.password, self.jwt, self.echo, self.versions, self.last_headers = email, password, None, echo, {}, {}

    def login(self):
        req = urllib.request.Request(spike.BASE + "/admin/login", data=json.dumps({"email": self.email, "password": self.password}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        self.jwt = json.load(urllib.request.urlopen(req))["data"]["token"]
        return self

    def tab(self, echo=True):
        t = Tab(self.email, self.password, echo)
        t.jwt = self.jwt
        return t

    def http(self, method, path, body=None):
        if not self.jwt:
            self.login()
        key, action, q = L._entry(path)
        h = {"Authorization": "Bearer " + self.jwt, "Accept": "application/json"}
        if body is not None:
            h["Content-Type"] = "application/json"
        sends = key and ((method == "PUT" and not action) or (method == "POST" and action in ("publish", "discard", "unpublish")))
        if self.echo and sends and key in self.versions:
            h["X-Writesafe-Base"] = self.versions[key]
        req = urllib.request.Request(spike.BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                self.last_headers = dict(r.headers)
                v = r.headers.get("X-Writesafe-Version")
                # as admin/form-base.mjs: a merged Save's answer never moves the base (R2-S2); the next load does
                if key and v and ((method == "GET" and not action and q.get("status") != "published") or (sends and not r.headers.get("X-Writesafe-Merged"))):
                    self.versions[key] = v
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            self.last_headers = dict(e.headers)
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, raw.decode(errors="replace")[:500]

    def merged(self):
        m = self.last_headers.get("X-Writesafe-Merged")
        return json.loads(urllib.parse.unquote(m)) if m else []


ADMIN_SECRET = json.load(open(os.environ["SPIKE_ADMIN"]))
ED = Tab(ADMIN_SECRET["email"], ADMIN_SECRET["password"])


def second_editor():
    """A second super admin, created through the admin API's invite flow."""
    s, roles = ED.http("GET", "/admin/roles")
    sid = next(r["id"] for r in roles["data"] if r.get("code") == "strapi-super-admin")
    email = "%s-editor-b@example.test" % TAG
    pw = "Eb9" + os.urandom(12).hex()
    s, u = ED.http("POST", "/admin/users", {"firstname": "Editor", "lastname": "B", "email": email, "roles": [sid]})
    if s not in (200, 201):
        raise RuntimeError(("create user", s, u))
    req = urllib.request.Request(spike.BASE + "/admin/register", data=json.dumps({"registrationToken": u["data"]["registrationToken"],
                                 "userInfo": {"firstname": "Editor", "lastname": "B", "password": pw}}).encode(), headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req).read()
    return Tab(email, pw).login()


def cm(uid, doc=None, action=None, locale=None):
    base = "/content-manager/single-types/%s" % uid if doc is None else "/content-manager/collection-types/%s/%s" % (uid, doc)
    return base + ("/actions/" + action if action else "") + ("?locale=" + locale if locale else "")


def form(tab, uid, doc=None, locale=None):
    """Load the edit view's form (GET of the draft); returns (data, body the Save sends)."""
    s, b = tab.http("GET", cm(uid, doc, locale=locale))
    if s != 200:
        raise RuntimeError(("GET form", s, b))
    d = b["data"]
    return d, admin_form(uid, d)


def admin_form(uid, d):
    """The body the admin's Save sends for a loaded entry: without system fields, relations (the load answers a count)
    as an empty connect/disconnect, and the same inside components (review S7)."""
    out = {}
    for k, v in d.items():
        if k in L.DROP:
            continue
        out[k] = _relations_untouched(v)
    rel = {"reviewer", "author", "topic", "contributors", "supplier"}
    for k in rel & set(d):
        out[k] = {"connect": [], "disconnect": []}
    return out


def _relations_untouched(v):
    if isinstance(v, dict) and set(v) == {"count"}:
        return {"connect": [], "disconnect": []}
    if isinstance(v, dict):
        return {k: _relations_untouched(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_relations_untouched(x) for x in v]
    return v


def new_page(title):
    s, b, _ = spike.rest(RA, "POST", "/api/pages?status=draft", {"data": {"title": title, "summary": "Lunch.", "note": "draft",
                         "items": [{"label": "Coffee", "qty": 4}, {"label": "Tea", "qty": 2}, {"label": "Sandwiches", "qty": 10}],
                         "sections": [{"__component": "blocks.hero", "heading": "Team lunch", "subheading": "Friday"}]}})
    if s not in (200, 201):
        raise RuntimeError((s, b))
    return b["data"]["documentId"]


def draft(doc, uid=PAGE, locale=None):
    """The current draft, read the agent's way (ws_get)."""
    return L.wget(uid, doc, locale)["data"]


def row(d, label, field="items"):
    return next((x for x in d.get(field) or [] if x.get("label") == label), None)


def patch(uid, doc, locale=None, **kw):
    g = L.wget(uid, doc, locale)
    args = {"uid": uid, "documentId": doc, "expected_version": g["version"], **({"locale": locale} if locale else {}), **kw}
    e, r = L.ws("ws_patch", args)
    if e:
        raise RuntimeError(("ws_patch", r))
    return r


def coffee(doc, qty=12, dry=False):
    g = L.wget(PAGE, doc)
    k = next(x["_key"] for x in g["data"]["items"] if x["label"] == "Coffee")
    e, r = L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": qty}}],
                             **({"dry_run": True} if dry else {})})
    if e:
        raise RuntimeError(("ws_patch", r))
    return r


def set_row(body, label, **kw):
    body["items"] = [dict(x, **kw) if x.get("label") == label else x for x in body["items"]]
    return body


def err409(s, b, reason=None):
    err = ((b or {}).get("error") or {}) if isinstance(b, dict) else {}
    d = err.get("details") or {}
    return s == 409 and err.get("name") == "ConflictError" and d.get("code") == "stale_form" and (reason is None or d.get("reason") == reason)


def guard():
    return (L.lock_stats() or {}).get("staleForm") or {}


def gate(**kw):
    s, b, _ = spike.rest(RA, "POST", "/api/probe/x4-gate", kw)
    return b or {}


def run_threads(*fns):
    th = [threading.Thread(target=f) for f in fns]
    [t.start() for t in th]
    [t.join(120) for t in th]


def behind_gate(agent_call, editor_call):
    """The agent's write runs and stops before its commit (probe x4-gate, watched through files: on SQLite the probe's
    own token check would wait for the connection the write holds); the editor's request is sent while it waits and the
    agent is released 400 ms later. Returns {agent, editor, waiting, editor_ms}."""
    import tempfile, shutil
    d = tempfile.mkdtemp(prefix="x4gate-")
    gate(arm=True, dir=d)
    out = {}

    def agent():
        out["agent"] = agent_call()

    def editor():
        for _ in range(500):
            if os.path.exists(os.path.join(d, "waiting")):
                break
            time.sleep(0.01)
        out["waiting"] = os.path.exists(os.path.join(d, "waiting"))
        threading.Timer(0.4, lambda: open(os.path.join(d, "release"), "w").close()).start()
        t0 = time.time()
        out["editor"] = editor_call()
        out["editor_ms"] = round((time.time() - t0) * 1000)
    try:
        run_threads(agent, editor)
    finally:
        open(os.path.join(d, "release"), "w").close()
        gate(disarm=True)
        time.sleep(0.1)
        shutil.rmtree(d, ignore_errors=True)
    return out


# ---------------------------------------------------------------- checks
@T
def t_installed():
    st = guard().get("state") or {}
    check("stale form guard on by default, its tables ready", st.get("enabled") is True and st.get("ok") is True, st)
    s, b = ED.http("GET", cm(PAGE, new_page(TAG + " hdr")))
    check("the Content Manager load answers X-Writesafe-Version", s == 200 and ED.last_headers.get("X-Writesafe-Version") is not None, ED.last_headers)


@T
def t_x4_merge():
    doc = new_page(TAG + " x4")
    _, body = form(ED, PAGE, doc)
    body["title"] = "Team lunch (Friday)"
    coffee(doc)
    s, b = ED.http("PUT", cm(PAGE, doc), body)
    d = draft(doc)
    check("X4: the stale Save lands with 200, Coffee 12 AND the new title", s == 200 and row(d, "Coffee")["qty"] == 12 and d["title"] == "Team lunch (Friday)", (s, b, d.get("title"), d.get("items")))
    kept = ED.merged()
    check("X4: the response names the agent's change it kept by field and row position, not by a value (items row 1 qty 4 -> 12)", len(kept) == 1 and kept[0]["label"] == "items row 1 qty" and kept[0]["from"] == "4" and kept[0]["to"] == "12", kept)
    check("X4: the Save's reply carries the merged entry (the form shows Coffee 12)", s == 200 and row(b["data"], "Coffee")["qty"] == 12, b if s != 200 else row(b["data"], "Coffee"))
    if s == 200:
        s, b = ED.http("PUT", cm(PAGE, doc), dict({k: v for k, v in b["data"].items() if k not in L.DROP}, note="second save"))
        check("X4: a second Save from the merged form lands, no merge needed", s == 200 and not ED.merged() and row(draft(doc), "Coffee")["qty"] == 12, (s, b))
    # second review R2-S2: Strapi resets the form to the values the editor SENT (the agent's field at its old value)
    # until its refetch lands; a second Save or a Publish from that form must not drop the agent's change
    doc = new_page(TAG + " resave")
    _, body = form(ED, PAGE, doc)
    coffee(doc)
    s1, _ = ED.http("PUT", cm(PAGE, doc), dict(body, title="first save"))
    s2, b2 = ED.http("PUT", cm(PAGE, doc), dict(body, title="first save", note="second save"))
    d = draft(doc)
    check("R2-S2: merged Save, then a second Save of the form as Strapi reset it: the agent's Coffee 12 survives",
          s1 == 200 and s2 == 200 and row(d, "Coffee")["qty"] == 12 and d["note"] == "second save", (s1, s2, b2))
    doc = new_page(TAG + " save-publish")
    _, body = form(ED, PAGE, doc)
    coffee(doc)
    s1, _ = ED.http("PUT", cm(PAGE, doc), dict(body, title="saved"))
    s2, b2 = ED.http("POST", cm(PAGE, doc, "publish"), dict(body, title="saved"))
    check("R2-S2: merged Save, then Publish from the reset form before the refetch: refused (409 publish_unseen), Coffee 12 kept",
          s1 == 200 and err409(s2, b2, "publish_unseen") and row(draft(doc), "Coffee")["qty"] == 12, (s1, s2, b2))
    _, body = form(ED, PAGE, doc)  # the refetch
    s3, b3 = ED.http("POST", cm(PAGE, doc, "publish"), body)
    check("R2-S2: after the refetch the Publish goes through with Coffee 12", s3 == 200 and row(draft(doc), "Coffee")["qty"] == 12, (s3, b3))


@T
def t_x4_barrier():
    doc = new_page(TAG + " barrier")
    _, body = form(ED, PAGE, doc)
    g = L.wget(PAGE, doc)
    k = next(x["_key"] for x in g["data"]["items"] if x["label"] == "Coffee")
    out = behind_gate(lambda: L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 12}}]}),
                      lambda: ED.http("PUT", cm(PAGE, doc), dict(body, title="barrier title")))
    d = draft(doc)
    s, b = out["editor"]
    check("barrier (PUT): the Save is sent while the agent's write is uncommitted, waits for it, then merges: 200, Coffee 12 and the title",
          out.get("waiting") and not out["agent"][0] and s == 200 and out["editor_ms"] >= 300 and row(d, "Coffee")["qty"] == 12 and d["title"] == "barrier title",
          {"waiting": out.get("waiting"), "agent_err": out["agent"][0], "editor": out["editor"], "editor_ms": out["editor_ms"], "final": (d.get("title"), d.get("items"))})
    # single type
    spike.rest(RA, "PUT", "/api/homepage?status=draft", {"data": {"title": "Home", "items": [{"label": "Coffee", "qty": 4}]}})
    d0, body = form(ED, HOME)
    did = d0["documentId"]
    g = L.wget(HOME, did)
    k = next(x["_key"] for x in g["data"]["items"] if x["label"] == "Coffee")
    out = behind_gate(lambda: L.ws("ws_patch", {"uid": HOME, "documentId": did, "expected_version": g["version"], "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 12}}]}),
                      lambda: ED.http("PUT", cm(HOME), dict(body, title="barrier home")))
    d = draft(did, HOME)
    s, b = out["editor"]
    check("barrier (single type): 200, Coffee 12 and the title", out.get("waiting") and s == 200 and row(d, "Coffee")["qty"] == 12 and d["title"] == "barrier home", {"editor": out["editor"], "final": d})
    # publish
    doc = new_page(TAG + " barrier pub")
    _, body = form(ED, PAGE, doc)
    g = L.wget(PAGE, doc)
    k = next(x["_key"] for x in g["data"]["items"] if x["label"] == "Coffee")
    out = behind_gate(lambda: L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 12}}]}),
                      lambda: ED.http("POST", cm(PAGE, doc, "publish"), dict(body, title="published")))
    s, b = out["editor"]
    check("barrier (publish): a publish behind the agent's uncommitted write is refused (409 publish_unseen), Coffee 12 kept",
          out.get("waiting") and err409(s, b, "publish_unseen") and row(draft(doc), "Coffee")["qty"] == 12, (s, b))
    # the other order: the Save holds the lock first (its form is current), the agent's write lands on top
    doc = new_page(TAG + " save first")
    _, body = form(ED, PAGE, doc)
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="saved first"))
    coffee(doc)
    d = draft(doc)
    check("order Save then agent: both land", s == 200 and d["title"] == "saved first" and row(d, "Coffee")["qty"] == 12, (s, d))


@T
def t_conflict_same_field():
    doc = new_page(TAG + " same")
    _, body = form(ED, PAGE, doc)
    set_row(body, "Coffee", qty=6)
    coffee(doc, 12)
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="mine"))
    msg = ((b or {}).get("error") or {}).get("message", "") if isinstance(b, dict) else ""
    d = draft(doc)
    check("same field on both sides: 409 conflict naming the field and both values, nothing saved",
          err409(s, b, "conflict") and "items row 1 qty" in msg and "Coffee" not in msg and '"6"' in msg and '"12"' in msg and row(d, "Coffee")["qty"] == 12 and d["title"] != "mine", (s, b))
    _, body = form(ED, PAGE, doc)
    coffee(doc, 13)
    s, b = ED.http("PUT", cm(PAGE, doc), dict(set_row(body, "Coffee", qty=13), title="agree"))
    check("same field, same value on both sides: no conflict (200)", s == 200 and row(draft(doc), "Coffee")["qty"] == 13, (s, b))
    _, body = form(ED, PAGE, doc)
    patch(PAGE, doc, set={"title": "agent title"})
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="editor title"))
    check("top-level scalar on both sides: 409 conflict", err409(s, b, "conflict") and draft(doc)["title"] == "agent title", (s, b))
    _, body = form(ED, PAGE, doc)
    patch(PAGE, doc, set={"summary": "agent summary"})
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, note="editor note"))
    d = draft(doc)
    check("top-level scalars, disjoint: both land (200)", s == 200 and d["summary"] == "agent summary" and d["note"] == "editor note", (s, b))


@T
def t_rows():
    doc = new_page(TAG + " rows")
    _, body = form(ED, PAGE, doc)
    g = L.wget(PAGE, doc)
    patch(PAGE, doc, ops=[{"op": "update", "field": "sections", "key": g["rows"]["sections"][0], "data": {"subheading": "agent"}}])
    body["items"] = body["items"] + [{"label": "Cake", "qty": 1}]
    s, b = ED.http("PUT", cm(PAGE, doc), body)
    d = draft(doc)
    check("editor adds a row to items, agent edits a dynamic-zone section: both land", s == 200 and row(d, "Cake") and d["sections"][0]["subheading"] == "agent", (s, b))
    _, body = form(ED, PAGE, doc)
    patch(PAGE, doc, ops=[{"op": "add", "field": "items", "data": {"label": "Juice", "qty": 3}}])
    set_row(body, "Tea", qty=9)
    s, b = ED.http("PUT", cm(PAGE, doc), body)
    d = draft(doc)
    check("agent adds a row, editor edits another row of the same list: both land", s == 200 and row(d, "Juice") and row(d, "Tea")["qty"] == 9, (s, b, d.get("items")))
    _, body = form(ED, PAGE, doc)
    patch(PAGE, doc, ops=[{"op": "add", "field": "items", "data": {"label": "Water", "qty": 1}}])
    body["items"] = body["items"] + [{"label": "Soda", "qty": 1}]
    s, b = ED.http("PUT", cm(PAGE, doc), body)
    check("both add rows to one list: 409 (the list's rows changed on both sides)", err409(s, b, "conflict") and row(draft(doc), "Water") and not row(draft(doc), "Soda"), (s, b))
    _, body = form(ED, PAGE, doc)
    g = L.wget(PAGE, doc)
    kt = next(x["_key"] for x in g["data"]["items"] if x["label"] == "Tea")
    patch(PAGE, doc, ops=[{"op": "update", "field": "items", "key": kt, "data": {"qty": 99}}])
    body["items"] = [x for x in body["items"] if x.get("label") != "Tea"]
    s, b = ED.http("PUT", cm(PAGE, doc), body)
    check("editor removes the row the agent edited: 409 (edit against delete)", err409(s, b, "conflict") and row(draft(doc), "Tea")["qty"] == 99, (s, b))
    _, body = form(ED, PAGE, doc)
    g = L.wget(PAGE, doc)
    kt = next(x["_key"] for x in g["data"]["items"] if x["label"] == "Tea")
    patch(PAGE, doc, ops=[{"op": "remove", "field": "items", "key": kt}])
    set_row(body, "Tea", qty=1)
    s, b = ED.http("PUT", cm(PAGE, doc), body)
    check("agent removes the row the editor edited: 409 (edit against delete)", err409(s, b, "conflict") and not row(draft(doc), "Tea"), (s, b))
    _, body = form(ED, PAGE, doc)
    g = L.wget(PAGE, doc)
    kt = next(x["_key"] for x in g["data"]["items"] if x["label"] == "Coffee")
    patch(PAGE, doc, ops=[{"op": "remove", "field": "items", "key": kt}])
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, note="untouched rows"))
    check("agent removes a row the editor did not touch: merged, the row stays removed", s == 200 and not row(draft(doc), "Coffee") and draft(doc)["note"] == "untouched rows", (s, b))


@T
def t_editor_alone():
    doc = new_page(TAG + " alone")
    _, body = form(ED, PAGE, doc)
    st = []
    for i in range(4):
        s, b = ED.http("PUT", cm(PAGE, doc), set_row(dict(body, title="alone %d" % i), "Tea", qty=100 + i))
        st.append((s, bool(ED.merged())))
        if s == 200:
            body = {k: v for k, v in b["data"].items() if k not in L.DROP}
    check("editor alone: four Saves of one form without a reload: 200, no merge", st == [(200, False)] * 4, st)
    no = ED.tab(echo=False)
    _, body = form(no, PAGE, doc)
    s, b = no.http("PUT", cm(PAGE, doc), dict(body, title="no header"))
    check("a Save without the header on an entry no agent wrote: 200, as in Strapi", s == 200, (s, b))


@T
def t_two_editors():
    b_ed = second_editor()
    doc = new_page(TAG + " two")
    _, fa = form(ED, PAGE, doc)
    _, fb = form(b_ed, PAGE, doc)
    s1, _ = b_ed.http("PUT", cm(PAGE, doc), dict(fb, title="editor B"))
    s2, _ = ED.http("PUT", cm(PAGE, doc), dict(fa, title="editor A"))
    check("two editors: both Saves land, the last wins (as in Strapi)", (s1, s2) == (200, 200) and draft(doc)["title"] == "editor A", (s1, s2))


@T
def t_two_tabs():
    doc = new_page(TAG + " tabs")
    t1, t2 = ED.tab(), ED.tab()
    _, f1 = form(t1, PAGE, doc)
    coffee(doc, 12)
    _, f2 = form(t2, PAGE, doc)
    s2, _ = t2.http("PUT", cm(PAGE, doc), dict(f2, title="tab 2"))
    s1, b1 = t1.http("PUT", cm(PAGE, doc), dict(f1, note="tab 1"))
    d = draft(doc)
    check("two tabs: the newer tab saves; the stale tab is merged against its own base (Coffee 12 kept, its note lands)",
          s2 == 200 and s1 == 200 and row(d, "Coffee")["qty"] == 12 and d["note"] == "tab 1", (s2, s1, b1, d.get("title")))
    _, f1 = form(t1, PAGE, doc)
    coffee(doc, 14)
    _, f2 = form(t2, PAGE, doc)
    s1, b1 = t1.http("PUT", cm(PAGE, doc), set_row(f1, "Coffee", qty=5))
    check("two tabs: the stale tab changing the agent's field is refused (409), not masked by the newer tab", err409(s1, b1, "conflict") and row(draft(doc), "Coffee")["qty"] == 14, (s1, b1))


@T
def t_missing_header():
    doc = new_page(TAG + " nohdr")
    no = ED.tab(echo=False)
    _, body = form(no, PAGE, doc)
    coffee(doc)
    s, b = no.http("PUT", cm(PAGE, doc), dict(body, title="no header"))
    check("fail closed: a Save without the header while the entry has journal entries is refused (409 missing_base)", err409(s, b, "missing_base") and row(draft(doc), "Coffee")["qty"] == 12, (s, b))
    no.versions[L._entry(cm(PAGE, doc))[0]] = "999999"
    no.echo = True
    s, b = no.http("PUT", cm(PAGE, doc), dict(body, title="future base"))
    check("a base newer than the entry's revision is refused (409 bad_base)", err409(s, b, "bad_base"), (s, b))


@T
def t_loaded_after_and_dry_run():
    doc = new_page(TAG + " after")
    coffee(doc)
    _, body = form(ED, PAGE, doc)
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="after the agent"))
    check("a form loaded after the agent's write: 200, no merge", s == 200 and not ED.merged() and row(draft(doc), "Coffee")["qty"] == 12, (s, b))
    _, body = form(ED, PAGE, doc)
    rev0 = ED.versions[L._entry(cm(PAGE, doc))[0]]
    coffee(doc, 50, dry=True)
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="after a dry run"))
    check("an agent dry run leaves no journal entry (rolled back): 200, no merge, revision unchanged", s == 200 and not ED.merged() and ED.last_headers.get("X-Writesafe-Version") == rev0, (s, ED.last_headers.get("X-Writesafe-Version"), rev0))


@T
def t_other_writers():
    # owner decision (15 Nov 2026): writers outside the plugin leave an opaque entry by default (otherWriters, default
    # on): an older form refuses after them; staleFormGuard: { otherWriters: false } gives last-write-wins (t_restart)
    doc = new_page(TAG + " rest")
    _, body = form(ED, PAGE, doc)
    s, b, _ = spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc, {"data": {"summary": "rest"}})
    check("REST itself: unaffected (200)", s == 200, (s, b))
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="after rest"))
    check("default: a form loaded before a REST write: 409 other_writer, the REST change kept", err409(s, b, "other_writer") and draft(doc)["summary"] == "rest" and draft(doc)["title"] != "after rest", (s, b))
    _, body = form(ED, PAGE, doc)
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="after reload"))
    check("default: the same edit after a reload saves (200, the REST change kept)", s == 200 and draft(doc)["title"] == "after reload" and draft(doc)["summary"] == "rest", (s, b))
    no = ED.tab(echo=False)
    doc = new_page(TAG + " rest nohdr")
    _, body = form(no, PAGE, doc)
    s, b = no.http("PUT", cm(PAGE, doc), dict(body, title="no header before rest"))
    check("default: a Save without the header on an entry no writer journaled: 200", s == 200, (s, b))
    spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc, {"data": {"summary": "rest"}})
    s, b = no.http("PUT", cm(PAGE, doc), dict(body, title="no header after rest"))
    check("default: a Save without the header after a REST write: 409 missing_base (fail closed), the REST change kept", err409(s, b, "missing_base") and draft(doc)["summary"] == "rest", (s, b))
    s, b, _ = spike.rest(RA, "DELETE", "/api/pages/%s" % new_page(TAG + " rest delete"), None)
    check("REST delete itself: unaffected", s in (200, 204), (s, b))
    s, b = ED.http("POST", "/content-manager/collection-types/%s/actions/bulkPublish" % PAGE, {"documentIds": [doc]})
    check("Content Manager bulk publish: unaffected (no form)", s == 200, (s, b))


@T
def t_publish_discard():
    doc = new_page(TAG + " pub")
    _, body = form(ED, PAGE, doc)
    coffee(doc)
    s, b = ED.http("POST", cm(PAGE, doc, "publish"), dict(body, title="published stale"))
    check("publish from a form older than an agent write: 409 publish_unseen, nothing saved", err409(s, b, "publish_unseen") and row(draft(doc), "Coffee")["qty"] == 12 and draft(doc)["title"] != "published stale", (s, b))
    _, body = form(ED, PAGE, doc)
    s, b = ED.http("POST", cm(PAGE, doc, "publish"), dict(body, title="published fresh"))
    check("publish from a fresh form: 200", s == 200, (s, b))
    _, body = form(ED, PAGE, doc)
    coffee(doc, 21)
    s, b = ED.http("POST", cm(PAGE, doc, "discard"), {})
    check("discard from a stale form: 409 discard_unseen, the agent's draft kept", err409(s, b, "discard_unseen") and row(draft(doc), "Coffee")["qty"] == 21, (s, b))
    s, b = ED.http("POST", cm(PAGE, doc, "unpublish"), {"discardDraft": True})
    check("unpublish with discardDraft from a stale form: 409", err409(s, b, "discard_unseen") and row(draft(doc), "Coffee")["qty"] == 21, (s, b))
    other = ED.tab()
    _, ob = form(other, PAGE, doc)
    _, body = form(ED, PAGE, doc)
    s, b = ED.http("POST", cm(PAGE, doc, "discard"), {})
    check("discard from a fresh form: 200", s == 200 and row(draft(doc), "Coffee")["qty"] == 12, (s, b))
    s, b = other.http("PUT", cm(PAGE, doc), dict(ob, title="after the discard"))
    check("a tab loaded before a discard: 409 other_writer", err409(s, b, "other_writer"), (s, b))
    s, b = ED.http("POST", cm(PAGE, doc, "unpublish"), {})
    check("plain unpublish: 200", s == 200, (s, b))


@T
def t_single_type():
    spike.rest(RA, "PUT", "/api/homepage?status=draft", {"data": {"title": "Home", "items": [{"label": "Coffee", "qty": 4}]}})
    d, body = form(ED, HOME)
    did = d["documentId"]
    g = L.wget(HOME, did)
    k = next(x["_key"] for x in g["data"]["items"] if x["label"] == "Coffee")
    e, r = L.ws("ws_patch", {"uid": HOME, "documentId": did, "expected_version": g["version"], "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 77}}]})
    s, b = ED.http("PUT", cm(HOME), dict(body, title="Home merged"))
    d2 = draft(did, HOME)
    check("single type: a stale form merges (200): the agent's 77 and the new title", not e and s == 200 and row(d2, "Coffee")["qty"] == 77 and d2["title"] == "Home merged", (e, s, b))
    _, body = form(ED, HOME)
    patch(HOME, did, set={"title": "agent home"})
    s, b = ED.http("POST", cm(HOME, action="publish"), dict(body, note="pub"))
    check("single type: publish with unseen agent changes: 409", err409(s, b, "publish_unseen"), (s, b))


@T
def t_localized():
    doc = L.make_guide(TAG + "-g")
    _, en = form(ED, GUIDE, doc, "en")
    _, fr = form(ED, GUIDE, doc, "fr")
    patch(GUIDE, doc, "fr", set={"note": "agent fr"})
    s, b = ED.http("PUT", cm(GUIDE, doc, locale="en"), dict(en, title="en editor"))
    check("localized: agent wrote a localized field of fr; the en form saves with no merge", s == 200 and not ED.merged(), (s, b))
    s, b = ED.http("PUT", cm(GUIDE, doc, locale="fr"), dict(fr, title="fr editor"))
    d = draft(doc, GUIDE, "fr")
    check("localized: the stale fr form merges: the agent's note and the editor's title", s == 200 and d["note"] == "agent fr" and d["title"] == "fr editor", (s, b))
    _, en = form(ED, GUIDE, doc, "en")
    patch(GUIDE, doc, "fr", set={"code": "agent-shared"})
    s, b = ED.http("PUT", cm(GUIDE, doc, locale="en"), dict(en, title="en after shared"))
    d = draft(doc, GUIDE, "en")
    # Strapi's i18n copies every non-localized field to the other locales after a write, and re-creates their
    # non-localized component rows (guide.facts) with new ids: Strapi itself then refuses the stale en form's old row
    # ids (400), with or without the guard. Either way nothing is lost.
    msg = ((b or {}).get("error") or {}).get("message", "") if isinstance(b, dict) else ""
    check("localized: the agent wrote a non-localized field through fr; the stale en form merges (200) or Strapi refuses its re-created shared rows (400); code kept",
          d["code"] == "agent-shared" and ((s == 200 and d["title"] == "en after shared") or (s == 400 and "not related to the entity" in msg and d["title"] != "en after shared")), (s, b, d.get("code")))
    _, en = form(ED, GUIDE, doc, "en")
    patch(GUIDE, doc, "fr", set={"code": "agent-2"})
    s, b = ED.http("PUT", cm(GUIDE, doc, locale="en"), dict(en, code="editor-2"))
    check("localized: both change the non-localized field (through different locales): 409", err409(s, b, "conflict") and draft(doc, GUIDE, "en")["code"] == "agent-2", (s, b))


@T
def t_nested_delete():
    # review B1: the agent removes an item row; the stale form's only edit is inside that row (nested component, media,
    # relation): edit against delete is a conflict, never a 200 that drops the edit
    for what in ("meta", "relation"):
        doc = L.make_page(TAG + " nested-del " + what, nested=True, n_items=3, n_sections=1)
        _, body = form(ED, PAGE, doc)
        g = L.wget(PAGE, doc)
        e, r = L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "ops": [{"op": "remove", "field": "items", "key": g["data"]["items"][1]["_key"]}]})
        if e:
            raise RuntimeError(r)
        if what == "meta":
            body["items"][1]["meta"] = dict(body["items"][1].get("meta") or {}, note="EDITOR NESTED EDIT")
        else:
            body["items"][1]["meta"] = dict(body["items"][1].get("meta") or {}, flag=not (body["items"][1].get("meta") or {}).get("flag"))
        s, b = ED.http("PUT", cm(PAGE, doc), body)
        check("B1: an edit (%s) inside a row the agent removed: 409 conflict, the row stays removed" % what, err409(s, b, "conflict") and len(draft(doc)["items"]) == 2, (s, b))


@T
def t_missing_header_across_lock():
    # review B2: a publish WITHOUT the header whose lock wait spans the agent's commit (barrier). MySQL: the publish
    # controller's transaction read before the lock; the decision must come from the locked counter
    doc = new_page(TAG + " nohdr-pub")
    no = ED.tab(echo=False)
    _, body = form(no, PAGE, doc)
    g = L.wget(PAGE, doc)
    o = behind_gate(lambda: L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "set": {"note": "AGENT NOTE"}}),
                    lambda: no.http("POST", cm(PAGE, doc, "publish"), dict(body, title="published without header")))
    s, b = o["editor"]
    d = draft(doc)
    check("B2: a header-less publish across the agent's commit is refused (409 missing_base), the agent's note kept",
          o.get("waiting") and err409(s, b, "missing_base") and d.get("note") == "AGENT NOTE" and d.get("title") != "published without header", (o.get("waiting"), s, b, d.get("note")))
    doc = new_page(TAG + " nohdr-put")
    _, body = form(no, PAGE, doc)
    g = L.wget(PAGE, doc)
    o = behind_gate(lambda: L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "set": {"note": "AGENT NOTE"}}),
                    lambda: no.http("PUT", cm(PAGE, doc), dict(body, title="saved without header")))
    s, b = o["editor"]
    check("B2: a header-less Save across the agent's commit is refused (409 missing_base)", err409(s, b, "missing_base") and draft(doc).get("note") == "AGENT NOTE", (s, b))


@T
def t_concurrent_fresh_documents():
    # review S1: concurrent writers on different fresh documents never deadlock on the counter rows (MySQL gap locks)
    fails, total, errs = 0, 0, []
    for rd in range(4):
        docs = [new_page("%s fresh-%d-%d" % (TAG, rd, i)) for i in range(8)]
        res = [None] * 16

        def rest(i):
            res[i] = spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % docs[i], {"data": {"summary": "rest %d" % i}})[0]

        def agent(i):
            g = L.wget(PAGE, docs[i])
            e, r = L.ws("ws_patch", {"uid": PAGE, "documentId": docs[i], "expected_version": g["version"], "set": {"note": "agent %d" % i}})
            res[8 + i] = 200 if not e else (r.get("error") or {}).get("code") if isinstance(r, dict) else "error"
        th = [threading.Thread(target=rest, args=(i,)) for i in range(4)] + [threading.Thread(target=agent, args=(i,)) for i in range(4, 8)]
        [t.start() for t in th]
        [t.join(60) for t in th]
        for x in res[:4] + res[12:16]:
            total += 1
            if x != 200:
                fails += 1
                errs.append(x)
    check("S1: concurrent REST and agent writes on different fresh documents all succeed", fails == 0, {"failed": fails, "of": total, "codes": errs[:10]})


@T
def t_concurrent_discards_fresh():
    # second review N2 (X4 revision 3): two Content Manager discards of two documents that have no counter row yet (a
    # tab opened before the deploy, a client without the header) took a locking read of the missing row, then inserted
    # it: on MySQL the gap locks deadlocked. A form write now inserts the row before it locks it. 20 pairs of fresh
    # published documents (created over REST: no counter row), each pair discarded at the same moment, header-less.
    no = ED.tab(echo=False)
    codes, bad = [], []
    for rd in range(20):
        docs = []
        for i in range(2):
            s, b, _ = spike.rest(RA, "POST", "/api/pages", {"data": {"title": "%s discard-%d-%d" % (TAG, rd, i), "summary": "Lunch.", "note": "draft"}})
            if s not in (200, 201):
                raise RuntimeError(("create", s, b))
            docs.append(b["data"]["documentId"])
        if rd == 0:
            check("N2 setup: the fresh documents are published (a discard has a published version to go back to)",
                  all(spike.rest(RA, "GET", "/api/pages/%s" % d, None)[0] == 200 for d in docs), docs)
        res = [None, None]
        bar = threading.Barrier(2)

        def discard(i):
            bar.wait(10)
            res[i] = no.http("POST", cm(PAGE, docs[i], "discard"), {})
        run_threads(lambda: discard(0), lambda: discard(1))
        for i, r in enumerate(res):
            codes.append(r[0] if r else None)
            if not r or r[0] != 200:
                bad.append((docs[i], r))
    check("N2: 40 concurrent header-less discards of fresh documents (20 pairs): all 200, no deadlock",
          len(codes) == 40 and not bad, {"ok": sum(1 for c in codes if c == 200), "of": len(codes), "failed": [(d, (r or [None])[0], str((r or [None, None])[1])[:300]) for d, r in bad[:5]]})


@T
def t_agent_delete_locale():
    # review S2: the agent deletes a locale; a form of that locale loaded before must not re-create it
    doc = L.make_guide(TAG + "-del")
    _, fr = form(ED, GUIDE, doc, "fr")
    g = L.wget(GUIDE, doc, "fr")
    e, r = L.ws("ws_delete", {"uid": GUIDE, "documentId": doc, "locale": "fr", "expected_version": g["version"]})
    if e:
        raise RuntimeError(("ws_delete", r))
    s, b = ED.http("PUT", cm(GUIDE, doc, locale="fr"), dict(fr, title="stale fr save"))
    sg, gb = ED.http("GET", cm(GUIDE, doc, locale="fr"))
    exists = sg == 200 and bool(((gb or {}).get("data") or {}).get("id"))
    check("S2: a stale form of a locale the agent deleted is refused (409), the locale stays deleted", err409(s, b, "other_writer") and not exists, (s, b, exists))


@T
def t_prune():
    # retention: journal entries pruned; a form whose base is older than what was pruned gets 409 base_too_old
    doc = new_page(TAG + " prune")
    _, body = form(ED, PAGE, doc)
    coffee(doc)
    time.sleep(0.2)
    s0, pb, _ = spike.rest(RA, "POST", "/api/probe/stale-prune", {"hours": 0.00001})
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="after prune"))
    check("prune: entries removed, and a form older than them is refused (409 base_too_old)", s0 == 200 and (pb or {}).get("pruned", 0) >= 1 and err409(s, b, "base_too_old"), (s0, pb, s, b))
    _, body = form(ED, PAGE, doc)
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="after reload"))
    check("prune: after a reload the form saves", s == 200 and row(draft(doc), "Coffee")["qty"] == 12, (s, b))


@T
def t_d1_aba():
    # self-test D1: versions were content hashes, so after A -> B -> A the old token came back and a fresh ws_patch was
    # answered as an implicit replay (ok, nothing written). The token now binds the draft's content revision.
    doc = new_page(TAG + " aba")
    r0 = L.wget(PAGE, doc)
    e, p1 = L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": r0["version"], "set": {"note": "review"}})
    r1 = L.wget(PAGE, doc)
    e2, p2 = L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": r1["version"], "set": {"note": "draft"}}) if not e else (True, None)
    r2 = L.wget(PAGE, doc)
    check("D1: after A -> B -> A the version token differs from the first read's", not e and not e2 and r2["data"]["note"] == "draft" and r2["version"] != r0["version"], (r0["version"], r2["version"]))
    e3, p3 = L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": r2["version"], "set": {"note": "review"}})
    r3 = L.wget(PAGE, doc)
    check("D1: a fresh ws_patch from the fresh read is applied (not answered as a replay)", not e3 and not (p3 or {}).get("replayed") and r3["data"]["note"] == "review", p3)
    e4, p4 = L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": r0["version"], "set": {"note": "stale"}})
    check("D1: the first read's token is stale now (version_conflict), though the content once matched it", e4 and ((p4 or {}).get("error") or {}).get("code") == "version_conflict", p4)
    _, body = form(ED, PAGE, doc)
    s, b = ED.http("PUT", cm(PAGE, doc), body)  # the same content
    r5 = L.wget(PAGE, doc)
    check("D1: an admin Save of the same content keeps the token (content, not writes: item 15)", s == 200 and r5["version"] == r3["version"], (s, r3["version"], r5["version"]))
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, note="draft"))
    s2, b2 = ED.http("PUT", cm(PAGE, doc), dict(body, note="review"))
    r6 = L.wget(PAGE, doc)
    check("D1: A -> B -> A through admin Saves also gives a new token", s == 200 and s2 == 200 and r6["data"]["note"] == "review" and r6["version"] != r5["version"], (s, s2, r5["version"], r6["version"]))
    s, b, _ = spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc, {"data": {"note": "draft"}})
    s2, b2, _ = spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc, {"data": {"note": "review"}})
    r7 = L.wget(PAGE, doc)
    check("D1: A -> B -> A through REST gives a new token", s == 200 and s2 == 200 and r7["version"] != r6["version"], (s, s2, r6["version"], r7["version"]))
    # D1 through if_match (second review R2-B1): the implicit record is keyed on the if_match values, which no revision
    # changes; the stop-gap (PR #38, replay_superseded) refuses the identical request once its write is out of effect
    doc2 = new_page(TAG + " aba-ifm")
    req = {"uid": PAGE, "documentId": doc2, "if_match": {"note": "draft"}, "set": {"note": "review"}}
    e1, p1 = L.ws("ws_patch", req)
    spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc2, {"data": {"note": "draft"}})
    e2, p2 = L.ws("ws_patch", req)
    code2 = ((p2 or {}).get("error") or {}).get("code") if isinstance(p2, dict) else None
    check("D1 via if_match: A -> B -> A, the identical request is not a false success (replay_superseded, nothing written)",
          not e1 and e2 and code2 == "replay_superseded" and draft(doc2)["note"] == "draft", (p1, p2))
    e3, p3 = L.ws("ws_patch", {**req, "idempotency_key": "%s-ifm" % TAG})
    check("D1 via if_match: resent with an idempotency_key, it applies", not e3 and draft(doc2)["note"] == "review", p3)
    # D1 through publish: publish, an editor unpublishes, the identical ws_publish (the draft token did not move)
    doc3 = new_page(TAG + " aba-pub")
    v0 = L.wget(PAGE, doc3)["version"]
    e1, p1 = L.ws("ws_publish", {"uid": PAGE, "documentId": doc3, "expected_version": v0})
    s, b = ED.http("POST", cm(PAGE, doc3, "unpublish"), {})
    v1 = L.wget(PAGE, doc3)["version"]
    e2, p2 = L.ws("ws_publish", {"uid": PAGE, "documentId": doc3, "expected_version": v1})
    code2 = ((p2 or {}).get("error") or {}).get("code") if isinstance(p2, dict) else None
    live = spike.rest(RA, "GET", "/api/pages/%s" % doc3, None)[0] == 200
    check("D1 via publish: publish -> unpublish -> the identical ws_publish is not a false success (replay_superseded, still unpublished)",
          not e1 and s == 200 and v1 == v0 and e2 and code2 == "replay_superseded" and not live, (p1, s, p2, live))
    e3, p3 = L.ws("ws_publish", {"uid": PAGE, "documentId": doc3, "expected_version": v1, "idempotency_key": "%s-pub" % TAG})
    live = spike.rest(RA, "GET", "/api/pages/%s" % doc3, None)[0] == 200
    check("D1 via publish: resent with an idempotency_key, it publishes", not e3 and live, p3)
    g = L.make_guide(TAG + "-d1")
    en0 = L.wget(GUIDE, g, "en")["version"]
    patch(GUIDE, g, "fr", set={"note": "fr only"})
    check("D1: a write to fr does not change en's token (revisions are per locale)", L.wget(GUIDE, g, "en")["version"] == en0, en0)


def restart_strapi(cmd, pidf, env=None):
    """Stop the running Strapi (its pid file), start it again with WS_RESTART_CMD (waits until healthy)."""
    try:
        os.kill(int(open(pidf).read().strip()), signal.SIGTERM)
    except (OSError, ValueError):
        pass
    for _ in range(60):
        try:
            urllib.request.urlopen(spike.BASE + "/_health", timeout=2)
            time.sleep(0.5)
        except Exception:
            break
    r = subprocess.run([cmd], capture_output=True, text=True, timeout=300, env={**os.environ, **(env or {})})
    if r.returncode != 0:
        raise RuntimeError(("restart", r.returncode, r.stderr[-300:]))
    ED.jwt = None
    L._JWT[0] = None


@T
def t_stats():
    sf = (guard().get("stats") or {})
    check("guard counters: versions served, agent writes journaled, merges", sf.get("versionsServed", 0) > 0 and sf.get("journalEntries", 0) > 0 and sf.get("merged", 0) > 0, sf)


@T
def t_restart():
    restart, pidf = os.environ.get("WS_RESTART_CMD"), os.environ.get("WS_PID_FILE")
    if not restart or not pidf:
        print("SKIP t_restart (no WS_RESTART_CMD/WS_PID_FILE)", flush=True)
        return
    doc = new_page(TAG + " restart")
    _, body = form(ED, PAGE, doc)
    t2 = ED.tab()
    _, body2 = form(t2, PAGE, doc)
    coffee(doc)
    restart_strapi(restart, pidf)
    s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="after restart"))
    d = draft(doc)
    check("restart: the agent writes, Strapi restarts, the stale Save still merges (200, Coffee 12 and the title; the journal is in the database)",
          s == 200 and row(d, "Coffee")["qty"] == 12 and d["title"] == "after restart", (s, b))
    t2.jwt = ED.jwt
    s, b = t2.http("PUT", cm(PAGE, doc), set_row(body2, "Coffee", qty=3))
    check("restart: a stale tab changing the agent's field is still refused (409)", err409(s, b, "conflict") and row(draft(doc), "Coffee")["qty"] == 12, (s, b))
    # a component lifecycle subscriber makes Strapi rewrite unchanged component rows: X4 must still merge
    restart_strapi(restart, pidf, {"PROBE_LOCK_COVERAGE": "true"})
    try:
        doc = new_page(TAG + " subscriber")
        _, body = form(ED, PAGE, doc)
        coffee(doc)
        s, b = ED.http("PUT", cm(PAGE, doc), dict(body, title="with subscriber"))
        d = draft(doc)
        check("with a component lifecycle subscriber: X4 still merges (200, Coffee 12 and the title)", s == 200 and row(d, "Coffee")["qty"] == 12 and d["title"] == "with subscriber", (s, b))
        # opt-out: staleFormGuard { otherWriters: false } gives Strapi's last-write-wins for REST writes again
        restart_strapi(restart, pidf, {"WRITESAFE_STALE_FORM_OTHER_WRITERS": "false"})
        doc3 = new_page(TAG + " other writers")
        _, body = form(ED, PAGE, doc3)
        spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc3, {"data": {"summary": "rest"}})
        s, b = ED.http("PUT", cm(PAGE, doc3), dict(body, title="after rest"))
        check("staleFormGuard { otherWriters: false }: a form loaded before a REST write saves as in Strapi (200, last write wins)", s == 200 and draft(doc3)["title"] == "after rest", (s, b))
        no = ED.tab(echo=False)
        doc4 = new_page(TAG + " other writers nohdr")
        _, body = form(no, PAGE, doc4)
        spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc4, {"data": {"summary": "rest"}})
        s, b = no.http("PUT", cm(PAGE, doc4), dict(body, title="no header after rest"))
        check("staleFormGuard { otherWriters: false }: a Save without the header after only a REST write: 200 (nothing journaled)", s == 200, (s, b))
        # with the guard off (config), Strapi's behaviour: the stale form writes Coffee 4 back behind a 200
        restart_strapi(restart, pidf, {"WRITESAFE_STALE_FORM_GUARD": "false"})
        doc2 = new_page(TAG + " off")
        _, body = form(ED, PAGE, doc2)
        coffee(doc2)
        s, b = ED.http("PUT", cm(PAGE, doc2), dict(body, title="guard off"))
        check("staleFormGuard: false: Saves behave as in Strapi (200; the stale form writes Coffee 4 back)", s == 200 and row(draft(doc2), "Coffee")["qty"] == 4, (s, b))
    finally:
        restart_strapi(restart, pidf)
    check("guard back on after the restart", (guard().get("state") or {}).get("enabled") is True, guard())


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    tag = os.environ.get("RESULT_TAG", DB_LABEL)
    json.dump(results, open(os.path.join(HERE, "results", "test_stale_form-%s.json" % tag), "w"), indent=1, default=str)
    fails = [r for r in results if not r["pass"]]
    groups = {}
    for r in results:
        g = groups.setdefault(r["group"], [0, 0]); g[0 if r["pass"] else 1] += 1
    for g, (ok, bad) in groups.items():
        print("  %-40s %d/%d" % (g, ok, ok + bad))
    print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
    sys.exit(1 if fails else 0)
