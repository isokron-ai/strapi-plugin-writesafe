"""Lock-order arms (1.0 hardening stream B: item 11 with 16a, item 16), shared by tests/test_locking.py (short runs,
pass/fail in every matrix cell) and tests/stress/lock_soak.py (full runs, recorded results). Ported from the deadlock
spike (branch spike/deadlock-order, tests/phase0/t5_deadlock_soak.py, t7_spike_acceptance.py, t8_v3_coverage.py).

Each round starts two writers at the same moment (a barrier, plus a random 0..JITTER_MS delay on one side,
alternating) and records what each got, how long it took, and what the Strapi log says about deadlocks and
writesafe's retries in that round. Arms:
  normal     admin Save (Content Manager PUT of the whole form) against ws_patch (one items row, one sections row, summary)
  heavy      the same, the agent also adds `heavy` rows (default 30)
  nested     the agent edits a component inside a repeatable row (items[k].meta)
  dzset      the agent replaces the whole dynamic zone (set sections, force): rows deleted and re-inserted
  locale     api::guide.guide: the admin saves `en` changing the non-localized `code`; the agent patches `fr`'s `code`
  ava        two admin Saves of the same page
  locale_ava two admin Saves at once, `en` and `fr`, each changing the non-localized `code`
  delete     admin delete (Content Manager DELETE) against ws_patch, a fresh page per round
  publish    admin publish (Content Manager publish action, with the form) against ws_patch
  solo       admin Save, then ws_patch, one after the other: no contention (the cost)
  batch      two ws_batch calls over the same 5 pages, items in opposite orders
  bulk       a ws_bulk chunk (BULK_DOCS pages, chunk_size BULK_CHUNK) against an admin Save of one page in the chunk
  agents_l10n  K concurrent ws_patch calls on one localized document (MySQL's stale snapshot, N10)
Environment (set by ci/run_suite.sh): SPIKE_BASE, SPIKE_TOKENS, SPIKE_ADMIN (admin.json), STRAPI_LOG, DB_LABEL.
"""
import json, os, random, re, sys, threading, time, urllib.error, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "spike"))
import spike, common  # noqa: E402
from spike import A, RA  # noqa: E402

DB_LABEL = os.environ.get("DB_LABEL", "sqlite")
PAGE, GUIDE = "api::page.page", "api::guide.guide"
LOG = os.environ.get("STRAPI_LOG")
JITTER = float(os.environ.get("JITTER_MS", "15")) / 1000
DROP = {"id", "documentId", "createdAt", "updatedAt", "publishedAt", "createdBy", "updatedBy", "localizations", "status", "locale", "reviewer", "cover"}
DL_CODES = ("40P01", "ER_LOCK_DEADLOCK")


# ---------------------------------------------------------------- clients
def ws(tool, args, who=A):
    err, r, n, full = spike.tool(who, tool, args)
    if err and isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    if len(spike.LOG) > 200:
        del spike.LOG[:]
    return err, r


def code(r):
    return ((r or {}).get("error") or {}).get("code") if isinstance(r, dict) else None


def wget(uid, doc, locale=None):
    e, r = ws("ws_get", {"uid": uid, "documentId": doc, **({"locale": locale} if locale else {})})
    if e:
        raise RuntimeError(r)
    return r


_JWT = [None]


def admin_jwt():
    if not _JWT[0]:
        a = json.load(open(os.environ.get("SPIKE_ADMIN") or os.path.join(ROOT, ".secrets", "admin.json")))
        req = urllib.request.Request(spike.BASE + "/admin/login", data=json.dumps({"email": a["email"], "password": a["password"]}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        _JWT[0] = json.load(urllib.request.urlopen(req))["data"]["token"]
    return _JWT[0]


def admin_http(method, path, body=None, timeout=120):
    h = {"Authorization": "Bearer " + admin_jwt(), "Accept": "application/json"}
    if body is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(spike.BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")[:500]


def cm_path(uid, doc, locale=None, action=None):
    return "/content-manager/collection-types/%s/%s%s%s" % (uid, doc, "/actions/" + action if action else "", "?locale=" + locale if locale else "")


def err_text(b):
    if isinstance(b, dict):
        return str((b.get("error") or {}).get("message") or b)[:300]
    return str(b)[:300]


def lock_stats():
    s, b, _ = spike.http(RA, "POST", "/api/probe/lock-stats", {}, log=False)
    return b if s == 200 else None


# ---------------------------------------------------------------- log
def log_pos():
    return os.path.getsize(LOG) if LOG and os.path.exists(LOG) else 0


def log_since(pos):
    if not LOG or not os.path.exists(LOG):
        return ""
    with open(LOG, errors="replace") as f:
        f.seek(pos)
        return f.read()


def scan(lg, tool):
    codes = re.findall(r"\[writesafe\] %s: (\S+) on attempt \d+; retrying" % re.escape(tool), lg)
    return {"retry_codes": codes, "deadlock_lines": len(re.findall(r"deadlock", lg, re.I))}


def pct(vals, q):
    v = sorted(vals)
    return v[min(len(v) - 1, int(round(q * (len(v) - 1))))] if v else None


# ---------------------------------------------------------------- fixtures
def make_page(tag, nested=False, n_items=6, n_sections=6):
    data = common.page_data(tag, n_items=n_items, n_sections=n_sections)
    if nested:
        for j, x in enumerate(data["items"]):
            x["meta"] = {"note": "m%d" % j, "flag": False}
    e, r, _, _ = spike.tool(A, "create_page", {"data": data})
    if e:
        raise RuntimeError(r)
    return r["data"]["documentId"]


def make_guide(tag):
    s, b, _ = spike.rest(RA, "POST", "/api/guides?status=draft&locale=en", {"data": {"title": tag, "code": "C0",
                         "items": [{"label": "one", "qty": 1}], "facts": [{"label": "f%d" % j, "qty": j} for j in range(4)]}})
    if s not in (200, 201):
        raise RuntimeError((s, b))
    d = b["data"]["documentId"]
    spike.rest(RA, "PUT", "/api/guides/%s?status=draft&locale=fr" % d, {"data": {"title": tag + "-fr"}})
    return d


def cm_body(d, r, loc=False):
    body = {k: v for k, v in d.items() if k not in DROP}
    body["title"] = "admin save %d" % r
    if "items" in d:
        body["items"] = [{**x, "label": "%s/a%d" % ((x.get("label") or "").split("/")[0], r)} for x in d["items"]]
    if "sections" in d:
        body["sections"] = [dict(x) for x in d["sections"]]
    if loc:
        body["code"] = "admin-code %d" % r
    return body


# ---------------------------------------------------------------- admin vs agent (and admin vs admin)
def two_writers(mode, rounds, heavy=0, tag="lk"):
    """One arm of admin-vs-agent rounds. Returns {aggregate, rounds}."""
    loc = mode in ("locale", "locale_ava")
    uid = GUIDE if loc else PAGE
    fresh = mode in ("delete",)
    docs = [] if fresh else [make_guide("%s-%s-g%d" % (tag, DB_LABEL, i)) if loc else make_page("%s-%s-%s-%d" % (tag, DB_LABEL, mode, i), nested=(mode == "nested")) for i in range(4)]
    out = []
    t_start = time.time()
    for r in range(rounds):
        doc = make_page("%s-%s-del-%d-%d" % (tag, DB_LABEL, r, int(time.time() * 1000) % 100000), n_items=4, n_sections=4) if fresh else docs[r % len(docs)]
        for _ in range(3):
            s, cur = admin_http("GET", cm_path(uid, doc, "en" if loc else None))
            if s == 200 and isinstance(cur, dict) and cur.get("data"):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("admin GET %s %s -> %s %s" % (uid, doc, s, str(cur)[:300]))
        g = wget(GUIDE, doc, "fr") if loc else wget(PAGE, doc)
        body = cm_body(cur["data"], r, loc)
        body_fr = None
        if mode == "locale_ava":
            s, cur_fr = admin_http("GET", cm_path(GUIDE, doc, "fr"))
            body_fr = dict(cm_body(cur_fr["data"], r, loc), title=cur_fr["data"]["title"], code="fr-code %d" % r)
        res = {"round": r}
        solo = mode == "solo"
        barrier = threading.Barrier(1 if solo else 2)
        d_admin = random.random() * JITTER if r % 2 else 0
        d_agent = random.random() * JITTER if not r % 2 else 0
        pos = log_pos()

        def admin():
            barrier.wait()
            time.sleep(d_admin)
            t0 = time.time()
            if mode == "delete":
                st, b = admin_http("DELETE", cm_path(PAGE, doc))
            elif mode == "publish":
                st, b = admin_http("POST", cm_path(PAGE, doc, action="publish"), body)
            else:
                st, b = admin_http("PUT", cm_path(uid, doc, "en" if loc else None), body)
            res["admin"] = {"status": st, "ms": round((time.time() - t0) * 1000), "error": None if st == 200 else err_text(b)}

        def agent_args():
            if mode == "locale":
                return {"uid": GUIDE, "documentId": doc, "locale": "fr", "set": {"code": "agent %d" % r}, "force": True}
            k = g["rows"]["items"][r % len(g["rows"]["items"])]
            ks = g["rows"]["sections"][0]
            if mode == "nested":
                return {"uid": PAGE, "documentId": doc, "set": {"summary": "agent %d" % r}, "force": True,
                        "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 1000 + r, "meta": {"note": "agent %d" % r, "flag": True}}}]}
            if mode == "dzset":
                secs = [{kk: vv for kk, vv in x.items() if kk not in ("_key", "id")} for x in g["data"]["sections"]][::-1]
                secs[0] = {"__component": "blocks.text", "body": "agent %d" % r}
                return {"uid": PAGE, "documentId": doc, "set": {"summary": "agent %d" % r, "sections": secs}, "force": True,
                        "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 1000 + r}}]}
            return {"uid": PAGE, "documentId": doc, "set": {"summary": "agent %d" % r}, "force": True,
                    "ops": [{"op": "update", "field": "items", "key": k, "data": {"qty": 1000 + r}},
                            {"op": "update", "field": "sections", "key": ks, "data": {"body": "agent %d" % r}}]
                    + [{"op": "add", "field": "items", "data": {"label": "heavy", "qty": 0}} for _ in range(heavy)]}

        def agent():
            barrier.wait()
            time.sleep(d_agent)
            t0 = time.time()
            if mode in ("ava", "locale_ava"):
                if mode == "locale_ava":
                    st, b = admin_http("PUT", cm_path(GUIDE, doc, "fr"), body_fr)
                else:
                    st, b = admin_http("PUT", cm_path(PAGE, doc), dict(body, title=cur["data"]["title"], summary="agent %d" % r))
                res["ws"] = {"ok": st == 200, "ms": round((time.time() - t0) * 1000), "code": None if st == 200 else "http_%d" % st,
                             "message": None if st == 200 else err_text(b)}
                return
            e, rr = ws("ws_patch", agent_args())
            res["ws"] = {"ok": not e, "ms": round((time.time() - t0) * 1000), "code": code(rr) if e else None,
                         "message": None if not e else (((rr or {}).get("error") or {}).get("message") if isinstance(rr, dict) else str(rr))}

        if solo:
            admin()
            agent()
        else:
            th = [threading.Thread(target=admin), threading.Thread(target=agent)]
            [t.start() for t in th]
            [t.join() for t in th]
        time.sleep(0.05)
        res.update(scan(log_since(pos), "ws_patch"))
        if mode not in ("delete",) and not loc:
            try:
                after = common.rest_get(RA, doc)
                res["agent_edit_kept"] = any(x.get("qty") == 1000 + r for x in after.get("items") or [])
            except Exception:
                res["agent_edit_kept"] = None
        out.append(res)
        if heavy:
            gh = wget(PAGE, doc)
            rm = [{"op": "remove", "field": "items", "key": x["_key"]} for x in gh["data"]["items"] if x.get("label") == "heavy"]
            if rm:
                ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": rm})
    return {"aggregate": aggregate_two(out, mode, heavy, time.time() - t_start), "rounds": out}


def aggregate_two(rounds, mode, heavy, secs):
    def deadlocked(x):
        return any(c in DL_CODES for c in x["retry_codes"]) or x["deadlock_lines"] > 0
    adm = [x["admin"] for x in rounds]
    agt = [x["ws"] for x in rounds]
    return {
        "arm": mode if not heavy else "heavy%d" % heavy, "db": DB_LABEL, "rounds": len(rounds), "seconds": round(secs),
        "deadlocks": sum(1 for x in rounds if deadlocked(x)),
        "admin_500": sum(1 for a in adm if a["status"] >= 500),
        "admin_other_errors": sum(1 for a in adm if a["status"] != 200 and a["status"] < 500),
        "admin_error_messages": sorted({a["error"] for a in adm if a["status"] != 200}),
        "agent_errors": sum(1 for a in agt if not a["ok"]),
        "agent_error_codes": sorted({str(a["code"]) for a in agt if not a["ok"]}),
        "agent_retries": sum(len(x["retry_codes"]) for x in rounds),
        "stale_snapshot_retries": sum(1 for x in rounds for c in x["retry_codes"] if c == "STALE_SNAPSHOT"),
        "admin_overwrote_agent": sum(1 for x in rounds if x["admin"]["status"] == 200 and x["ws"]["ok"] and x.get("agent_edit_kept") is False),
        "admin_ms_p50": pct([a["ms"] for a in adm], 0.5), "admin_ms_p95": pct([a["ms"] for a in adm], 0.95), "admin_ms_max": max(a["ms"] for a in adm),
        "agent_ms_p50": pct([a["ms"] for a in agt], 0.5), "agent_ms_p95": pct([a["ms"] for a in agt], 0.95), "agent_ms_max": max(a["ms"] for a in agt),
    }


# ---------------------------------------------------------------- writesafe against writesafe
def batch_vs_batch(rounds, tag="lk"):
    docs = [common.create_page_mcp("%s-%s-b-%d" % (tag, DB_LABEL, i), n_items=4) for i in range(5)]
    out = []
    t_start = time.time()
    for r in range(rounds):
        gs = {d: wget(PAGE, d) for d in docs}

        def items(order, who):
            return [{"ref": "%s%d" % (who, i), "uid": PAGE, "documentId": d, "set": {"seo": {"metaTitle": "%s %d" % (who, r)}}, "force": True,
                     "ops": [{"op": "update", "field": "items", "key": gs[d]["rows"]["items"][0 if who == "A" else 1], "data": {"qty": r}}]}
                    for i, d in enumerate(order)]
        res = {"round": r}
        bar = threading.Barrier(2)
        pos = log_pos()

        def run(who, order):
            bar.wait()
            t0 = time.time()
            e, rr = ws("ws_batch", {"items": items(order, who)})
            res[who] = {"ok": not e, "code": code(rr) if e else None, "ms": round((time.time() - t0) * 1000)}
        th = [threading.Thread(target=run, args=("A", docs)), threading.Thread(target=run, args=("B", docs[::-1]))]
        [t.start() for t in th]
        [t.join() for t in th]
        time.sleep(0.05)
        res.update(scan(log_since(pos), "ws_batch"))
        out.append(res)
    ms = [x[w]["ms"] for x in out for w in "AB"]
    return {"aggregate": {
        "arm": "batch", "db": DB_LABEL, "rounds": len(out), "seconds": round(time.time() - t_start),
        "deadlocks": sum(1 for x in out if any(c in DL_CODES for c in x["retry_codes"]) or x["deadlock_lines"]),
        "both_ok": sum(1 for x in out if x["A"]["ok"] and x["B"]["ok"]),
        "errors": sorted({str(x[w]["code"]) for x in out for w in "AB" if not x[w]["ok"]}),
        "agent_retries": sum(len(x["retry_codes"]) for x in out),
        "ms_p50": pct(ms, 0.5), "ms_p95": pct(ms, 0.95), "ms_max": max(ms)}, "rounds": out}


def agents_l10n(rounds, k=4, tag="lk"):
    """K concurrent ws_patch calls (row adds, no version) on one localized document, the locale list read first (N10)."""
    doc = make_guide("%s-%s-n10" % (tag, DB_LABEL))
    out = []
    t_start = time.time()
    for r in range(rounds):
        res = {"round": r, "calls": []}
        bar = threading.Barrier(k)
        pos = log_pos()

        def one(i):
            bar.wait()
            t0 = time.time()
            e, rr = ws("ws_patch", {"uid": GUIDE, "documentId": doc, "locale": "fr" if i % 2 else "en",
                                    "ops": [{"op": "add", "field": "facts", "data": {"label": "a%d-%d" % (r, i), "qty": i}}]})
            res["calls"].append({"ok": not e, "code": code(rr) if e else None, "ms": round((time.time() - t0) * 1000)})
        th = [threading.Thread(target=one, args=(i,)) for i in range(k)]
        [t.start() for t in th]
        [t.join() for t in th]
        time.sleep(0.05)
        res.update(scan(log_since(pos), "ws_patch"))
        out.append(res)
        if r % 5 == 4:  # keep the list short
            g = wget(GUIDE, doc, "en")
            rm = [{"op": "remove", "field": "facts", "key": x["_key"]} for x in g["data"].get("facts") or [] if str(x.get("label", "")).startswith("a")]
            if rm:
                ws("ws_patch", {"uid": GUIDE, "documentId": doc, "locale": "en", "ops": rm})
    calls = [c for x in out for c in x["calls"]]
    final = wget(GUIDE, doc, "en")
    return {"aggregate": {
        "arm": "agents_l10n", "db": DB_LABEL, "rounds": len(out), "writers": k, "seconds": round(time.time() - t_start),
        "calls": len(calls), "ok": sum(1 for c in calls if c["ok"]), "errors": sorted({str(c["code"]) for c in calls if not c["ok"]}),
        "busy": sum(1 for c in calls if c["code"] == "busy"),
        "deadlocks": sum(1 for x in out if any(c in DL_CODES for c in x["retry_codes"]) or x["deadlock_lines"]),
        "stale_snapshot_retries": sum(1 for x in out for c in x["retry_codes"] if c == "STALE_SNAPSHOT"),
        "retries": sum(len(x["retry_codes"]) for x in out),
        "ms_p50": pct([c["ms"] for c in calls], 0.5), "ms_p95": pct([c["ms"] for c in calls], 0.95), "ms_max": max(c["ms"] for c in calls),
        "facts_rows_now": len(final["data"].get("facts") or [])}, "rounds": out}


def batch_vs_admin(rounds, n_docs=25, tag="lk"):
    """A ws_batch over n_docs pages (a row op on each) against an admin Save of the LAST page. The batch locks every
    page first, then each item re-reads its page; on MySQL a lock over many documents in one IN (...) statement took
    another index than the single-document lock and deadlocked here (found with an uncapped 25-document bulk chunk)."""
    out = []
    t_start = time.time()
    docs = [common.create_page_mcp("%s-%s-ba-%02d" % (tag, DB_LABEL, i), n_items=2, n_sections=2) for i in range(n_docs)]
    target = docs[-1]
    for r in range(rounds):
        gs = {d: wget(PAGE, d) for d in docs}
        s, cur = admin_http("GET", cm_path(PAGE, target))
        body = {k: v for k, v in cur["data"].items() if k not in DROP}
        body["summary"] = "admin %d" % r
        res = {"round": r}
        bar = threading.Barrier(2)
        pos = log_pos()

        def admin():
            bar.wait()
            time.sleep(0.03)
            t0 = time.time()
            st, b = admin_http("PUT", cm_path(PAGE, target), body)
            res["admin"] = {"status": st, "ms": round((time.time() - t0) * 1000), "error": None if st == 200 else err_text(b)}

        def batch():
            bar.wait()
            t0 = time.time()
            e, rr = ws("ws_batch", {"items": [{"ref": "i%d" % i, "uid": PAGE, "documentId": d,
                                               "ops": [{"op": "update", "field": "items", "key": gs[d]["rows"]["items"][0], "data": {"qty": r}}]}
                                              for i, d in enumerate(docs)]})
            res["ws"] = {"ok": not e, "code": code(rr) if e else None, "ms": round((time.time() - t0) * 1000)}
        th = [threading.Thread(target=admin), threading.Thread(target=batch)]
        [t.start() for t in th]
        [t.join() for t in th]
        time.sleep(0.05)
        res.update(scan(log_since(pos), "ws_batch"))
        out.append(res)
    agg = aggregate_two(out, "batch%d_admin" % n_docs, 0, time.time() - t_start)
    return {"aggregate": agg, "rounds": out}


def discard_vs_patch(rounds, tag="lk"):
    """Review of PR #15, item 2: an admin discard (deletes the draft rows and recreates them from the published ones)
    against ws_patch of the same page. A FOR UPDATE that waited on the old rows must lock the new ones: the agent never
    gets not_found, and no lock is taken on zero rows of a page that exists."""
    out = []
    t_start = time.time()
    doc = make_page("%s-%s-disc" % (tag, DB_LABEL), n_items=3, n_sections=3)
    admin_http("POST", cm_path(PAGE, doc, action="publish"), {})
    for r in range(rounds):
        s, cur = admin_http("GET", cm_path(PAGE, doc))
        admin_http("PUT", cm_path(PAGE, doc), {k: v for k, v in dict(cur["data"], summary="draft %d" % r).items() if k not in DROP})
        s0 = lock_stats()
        res = {"round": r}
        bar = threading.Barrier(2)
        pos = log_pos()
        d_admin = random.random() * JITTER if r % 2 else 0
        d_agent = random.random() * JITTER if not r % 2 else 0

        def admin():
            bar.wait()
            time.sleep(d_admin)
            t0 = time.time()
            st, b = admin_http("POST", cm_path(PAGE, doc, action="discard"), {})
            res["admin"] = {"status": st, "ms": round((time.time() - t0) * 1000), "error": None if st == 200 else err_text(b)}

        def agent():
            bar.wait()
            time.sleep(d_agent)
            t0 = time.time()
            e, rr = ws("ws_patch", {"uid": PAGE, "documentId": doc, "set": {"note": "agent %d" % r}, "force": True})
            res["ws"] = {"ok": not e, "ms": round((time.time() - t0) * 1000), "code": code(rr) if e else None}
        th = [threading.Thread(target=admin), threading.Thread(target=agent)]
        [t.start() for t in th]
        [t.join() for t in th]
        time.sleep(0.05)
        res.update(scan(log_since(pos), "ws_patch"))
        s1 = lock_stats()
        if s0 and s1:
            seen = sum(1 for x in s0["middleware"]["recent"] if x["documentId"] == doc)
            new = [x for x in s1["middleware"]["recent"] if x["documentId"] == doc][seen:]
            res["empty_locks"] = sum(1 for x in new if not x.get("held") and x.get("rows") == 0)
            res["changed_locks"] = sum(1 for x in new if x.get("changed"))
            res["rows_changed"] = (s1["engine"].get("rowsChanged") or 0) - (s0["engine"].get("rowsChanged") or 0)
        out.append(res)
    agg = aggregate_two(out, "discard", 0, time.time() - t_start)
    agg["empty_locks"] = sum(x.get("empty_locks", 0) for x in out)
    agg["changed_locks"] = sum(x.get("changed_locks", 0) for x in out)
    agg["rows_changed_under_wait"] = sum(x.get("rows_changed", 0) for x in out)
    return {"aggregate": agg, "rounds": out}


def custom_order_on(uid=GUIDE):
    """Turn on Content Manager custom order for a type (Strapi 5.62+, future flag unstableCustomOrder). False if absent."""
    s, b = admin_http("GET", "/content-manager/content-types/%s/configuration" % uid)
    if s != 200:
        return False
    ct = b["data"]["contentType"]
    # what the admin panel sends back: list metadatas without the mainField it adds for relations
    metas = {k: {**v, "list": {kk: vv for kk, vv in (v.get("list") or {}).items() if kk != "mainField"}} for k, v in ct["metadatas"].items()}
    body = {"settings": dict(ct["settings"], customOrder=True), "metadatas": metas, "layouts": ct["layouts"]}
    s, b = admin_http("PUT", "/content-manager/content-types/%s/configuration" % uid, body)
    if s != 200:
        return False
    s, b = admin_http("GET", "/content-manager/content-types/%s/configuration" % uid)
    return s == 200 and (b["data"]["contentType"]["settings"] or {}).get("customOrder") is True


def order_vs_locale(rounds, tag="lk"):
    """Review of PR #15, item 1 (5.62 custom order): an admin Save that creates a new locale (de) of a guide against a
    custom-order move that shifts that guide's rows. Custom order's move() takes the type's order lock and then rewrites
    positions; a new locale's row gets its position under the same lock, after the row exists. Returns None when custom
    order is not available on this Strapi."""
    if not custom_order_on(GUIDE):
        return None
    docs = [make_guide("%s-%s-ord-%d-%d" % (tag, DB_LABEL, i, int(time.time() * 1000) % 100000)) for i in range(3)]
    target = docs[1]
    out = []
    t_start = time.time()
    for r in range(rounds):
        s, lst = admin_http("GET", "/content-manager/collection-types/%s?page=1&pageSize=100&locale=en" % GUIDE)
        order = [x["documentId"] for x in (lst or {}).get("results", []) if x["documentId"] in docs]
        if len(order) < 3:
            order = docs
        mover, anchor = order[-1], order[0]
        res = {"round": r}
        bar = threading.Barrier(2)
        pos = log_pos()

        def admin():
            bar.wait()
            t0 = time.time()
            st, b = admin_http("PUT", cm_path(GUIDE, target, "de"), {"title": "de %d" % r})
            res["admin"] = {"status": st, "ms": round((time.time() - t0) * 1000), "error": None if st == 200 else err_text(b)}

        def move():
            bar.wait()
            t0 = time.time()
            st, b = admin_http("POST", "/content-manager/collection-types/%s/%s/actions/move?locale=en" % (GUIDE, mover), {"before": anchor})
            res["ws"] = {"ok": st == 200, "ms": round((time.time() - t0) * 1000), "code": None if st == 200 else "http_%d" % st,
                         "message": None if st == 200 else err_text(b)}
        th = [threading.Thread(target=admin), threading.Thread(target=move)]
        [t.start() for t in th]
        [t.join() for t in th]
        time.sleep(0.05)
        res.update(scan(log_since(pos), "ws_patch"))
        out.append(res)
        admin_http("DELETE", cm_path(GUIDE, target, "de"))
    agg = aggregate_two(out, "order_locale_vs_move", 0, time.time() - t_start)
    return {"aggregate": agg, "rounds": out}


# ---------------------------------------------------------------- bulk chunk against an admin Save
def bulk_vs_admin(rounds, n_docs=10, chunk=10, target_index=None, tag="lk"):
    out = []
    t_start = time.time()
    for r in range(rounds):
        pre = "%s-%s-k%d-%d" % (tag, DB_LABEL, r, int(time.time() * 1000) % 1000000)
        docs = [common.create_page_mcp("%s-%03d" % (pre, i), n_items=4, n_sections=4) for i in range(n_docs)]
        target = docs[target_index if target_index is not None else min(n_docs - 1, chunk - 1)]
        s, cur = admin_http("GET", cm_path(PAGE, target))
        body = {k: v for k, v in cur["data"].items() if k not in DROP}
        body["title"] = cur["data"]["title"]  # keeps the prefix: the bulk filter must still match
        body["summary"] = "admin %d" % r
        body["items"] = [{**x, "label": (x.get("label") or "") + "/a"} for x in cur["data"]["items"]]
        res = {"round": r}
        bar = threading.Barrier(2)
        # a job starts from its dry run's plan token (1.0 hardening item 17); the dry run runs before the race
        args = {"uid": PAGE, "filters": {"title": {"$startsWith": pre}}, "set": {"seo": {"metaTitle": "bulk %d" % r}},
                "ops": [{"op": "add", "field": "items", "data": {"label": "bulk", "qty": 1}}]}
        _, plan = ws("ws_bulk", dict(args, dry_run=True))
        pos = log_pos()

        def admin():
            bar.wait()
            time.sleep(0.03)  # the chunk starts first
            t0 = time.time()
            st, b = admin_http("PUT", cm_path(PAGE, target), body)
            res["admin"] = {"status": st, "ms": round((time.time() - t0) * 1000), "error": None if st == 200 else err_text(b)}

        def bulk():
            bar.wait()
            t0 = time.time()
            e, rr = ws("ws_bulk", dict(args, plan_token=(plan or {}).get("plan_token"), chunk_size=chunk, expected_count=n_docs))
            res["bulk"] = {"ok": not e and (rr or {}).get("status") == "done", "code": code(rr) if e else (rr or {}).get("status"),
                           "chunks": (rr or {}).get("chunks_done"), "totals": (rr or {}).get("totals"), "ms": round((time.time() - t0) * 1000)}
        th = [threading.Thread(target=admin), threading.Thread(target=bulk)]
        [t.start() for t in th]
        [t.join() for t in th]
        time.sleep(0.05)
        res.update(scan(log_since(pos), "ws_bulk"))
        out.append(res)
    adm = [x["admin"] for x in out]
    return {"aggregate": {
        "arm": "bulk%d_c%d" % (n_docs, chunk), "db": DB_LABEL, "rounds": len(out), "seconds": round(time.time() - t_start),
        "deadlocks": sum(1 for x in out if any(c in DL_CODES for c in x["retry_codes"]) or x["deadlock_lines"]),
        "admin_500": sum(1 for a in adm if a["status"] >= 500), "admin_other_errors": sum(1 for a in adm if a["status"] != 200 and a["status"] < 500),
        "admin_error_messages": sorted({a["error"] for a in adm if a["status"] != 200}),
        "bulk_not_done": sum(1 for x in out if not x["bulk"]["ok"]), "bulk_codes": sorted({str(x["bulk"]["code"]) for x in out}),
        "bulk_chunks": sorted({x["bulk"]["chunks"] for x in out if x["bulk"]["chunks"] is not None}),
        "admin_ms_p50": pct([a["ms"] for a in adm], 0.5), "admin_ms_p95": pct([a["ms"] for a in adm], 0.95), "admin_ms_max": max(a["ms"] for a in adm),
        "bulk_ms_p50": pct([x["bulk"]["ms"] for x in out], 0.5), "bulk_ms_p95": pct([x["bulk"]["ms"] for x in out], 0.95)}, "rounds": out}


# ---------------------------------------------------------------- writer coverage
WRITERS = ["content_manager_save", "rest_put", "graphql_update", "plugin_document_service", "builtin_mcp_update_page", "ws_patch", "raw_knex",
           "cm_publish", "cm_unpublish", "cm_discard", "cm_delete"]


def items_with_ids(doc, tag):
    d = common.rest_get(RA, doc)
    return [{"id": x["id"], "label": "%s-%d" % (tag, i), "qty": x["qty"]} for i, x in enumerate(d["items"])]


def writer(name, doc):
    tag = "%s-%d" % (name, int(time.time() * 1000) % 100000)
    if name == "content_manager_save":
        s, cur = admin_http("GET", cm_path(PAGE, doc))
        body = {k: v for k, v in cur["data"].items() if k not in DROP}
        body["items"] = [{**x, "label": tag} for x in cur["data"]["items"]]
        st, b = admin_http("PUT", cm_path(PAGE, doc), body)
        return st == 200, st
    if name == "rest_put":
        st, b, _ = common.rest_put(RA, doc, {"summary": tag, "items": items_with_ids(doc, tag)})
        return st == 200, st
    if name == "graphql_update":
        q = "mutation($id: ID!, $data: PageInput!) { updatePage(documentId: $id, data: $data) { documentId } }"
        st, b, _ = spike.http(RA, "POST", "/graphql", {"query": q, "variables": {"id": doc, "data": {"summary": tag, "items": items_with_ids(doc, tag)}}}, log=False)
        return st == 200 and not (b or {}).get("errors"), (b or {}).get("errors") or st
    if name == "plugin_document_service":
        st, b, _ = spike.http(RA, "POST", "/api/probe/document-update", {"uid": PAGE, "documentId": doc, "data": {"summary": tag, "items": items_with_ids(doc, tag)}}, log=False)
        return st == 200, st
    if name == "builtin_mcp_update_page":
        v = common.mcp_get(A, doc)  # update_page requires the title; guard mode lets scalar fields through
        e, r, _, _ = spike.tool(A, "update_page", {"documentId": doc, "data": {"title": v["title"], "summary": tag}})
        return not e, None if not e else str(r)[:200]
    if name == "ws_patch":
        g = wget(PAGE, doc)
        e, r = ws("ws_patch", {"uid": PAGE, "documentId": doc, "ops": [{"op": "update", "field": "items", "key": g["rows"]["items"][0], "data": {"label": tag}}]})
        return not e, None if not e else r
    if name == "raw_knex":
        st, b, _ = spike.http(RA, "POST", "/api/probe/raw-update", {"uid": PAGE, "documentId": doc, "set": {"summary": tag}}, log=False)
        return st == 200, st
    if name == "cm_publish":
        st, b = admin_http("POST", cm_path(PAGE, doc, action="publish"), {})
        return st == 200, st
    if name == "cm_unpublish":
        st, b = admin_http("POST", cm_path(PAGE, doc, action="unpublish"), {})
        return st == 200, st
    if name == "cm_discard":
        admin_http("POST", cm_path(PAGE, doc, action="publish"), {})
        admin_http("PUT", cm_path(PAGE, doc), {"summary": tag})
        st, b = admin_http("POST", cm_path(PAGE, doc, action="discard"), {})
        return st == 200, st
    if name == "cm_delete":
        st, b = admin_http("DELETE", cm_path(PAGE, doc))
        return st == 200, st
    raise ValueError(name)


def coverage(rounds=1, tag="lk"):
    """Per writer: did the write pass the Document Service lock (taken, or already held by writesafe), with which action
    and how many rows; and (PROBE_LOCK_COVERAGE=true) did its component writes run inside a locked transaction."""
    out = {}
    for rnd in range(rounds):
        doc = common.create_page_mcp("%s-%s-cov-%d" % (tag, DB_LABEL, rnd), n_items=3)
        for w in WRITERS:
            s0 = lock_stats()
            ok, detail = writer(w, doc)
            time.sleep(0.05)
            s1 = lock_stats()
            mine = [x for x in s1["middleware"]["recent"] if x["documentId"] == doc]
            seen0 = sum(1 for x in s0["middleware"]["recent"] if x["documentId"] == doc)
            new = mine[seen0:] if len(mine) >= seen0 else mine
            rec = {"write_ok": ok, "detail": detail if not ok else None,
                   "locked": s1["middleware"]["locked"] - s0["middleware"]["locked"],
                   "already_held": s1["middleware"]["alreadyHeld"] - s0["middleware"]["alreadyHeld"],
                   "sqlite_passthrough": s1["middleware"]["sqlite"] - s0["middleware"]["sqlite"],
                   "actions": [x["action"] for x in new], "rows": [x.get("rows") for x in new],
                   "component_writes_in_locked_trx": s1["coverage"]["inLockedTrx"] - s0["coverage"]["inLockedTrx"],
                   "component_writes_outside": s1["coverage"]["inOtherTrx"] - s0["coverage"]["inOtherTrx"] + s1["coverage"]["noTrx"] - s0["coverage"]["noTrx"]}
            out.setdefault(w, []).append(rec)
    return out


def guide_lock_rows():
    """N6: how many rows an admin Save of one locale of a two-locale document locks (expected: both locales' drafts)."""
    doc = make_guide("lk-%s-n6" % DB_LABEL)
    s0 = lock_stats()
    s, cur = admin_http("GET", cm_path(GUIDE, doc, "fr"))
    body = {k: v for k, v in cur["data"].items() if k not in DROP}
    body["title"] = "n6 fr"
    st, b = admin_http("PUT", cm_path(GUIDE, doc, "fr"), body)
    s1 = lock_stats()
    seen0 = sum(1 for x in s0["middleware"]["recent"] if x["documentId"] == doc)
    new = [x for x in s1["middleware"]["recent"] if x["documentId"] == doc][seen0:]
    return st, new
