"""Stale form guard (X4) and the content revision (D1): the second review's end-to-end checks, against a running test
app (env as tests/test_stale_form.py: SPIKE_BASE, SPIKE_ADMIN, SPIKE_TOKENS, DB_LABEL; ci/run_suite.sh runs it after
test_stale_form). Reuses test_stale_form.py's helpers without running its checks. "info" lines are observations.
  python3 tests/test_stale_form_review.py [name ...]   (default: all)
Names: d1_if_match d1_publish d1_shared d1_noop d1_discard d1_two_locales v2_token rest_between prune_nohdr s5_restricted merged_resave"""
import json, os, sys, threading, time, urllib.request
os.environ["ONLY"] = "__review2_none__"
sys.path.insert(0, os.environ.get("WS_TESTS", os.path.dirname(os.path.abspath(__file__))))
import test_stale_form as S  # noqa: E402
L, spike, RA = S.L, S.spike, S.RA
PAGE, GUIDE = S.PAGE, S.GUIDE
OUT = []


def check(name, cond, detail=None):
    OUT.append({"test": name, "pass": bool(cond), "detail": None if cond else detail})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:1500]), flush=True)


def info(name, detail):
    print("info " + name + "  " + json.dumps(detail, default=str)[:1500], flush=True)


def ecode(r):
    return ((r or {}).get("error") or {}).get("code") if isinstance(r, dict) else None


def published(doc):
    s, b, _ = spike.rest(RA, "GET", "/api/pages/%s?status=published" % doc)
    return s == 200 and bool((b or {}).get("data"))


# ---------------------------------------------------------------- D1
def d1_if_match():
    """A -> B -> A with if_match instead of expected_version: the implicit record is keyed on the if_match VALUES, which
    the content revision cannot change, so the second request is identical to the first. It must not be answered as a
    replay with nothing applied: it is refused with replay_superseded (nothing written)."""
    doc = S.new_page(S.TAG + " r2-ifm")
    req = {"uid": PAGE, "documentId": doc, "if_match": {"note": "draft"}, "set": {"note": "review"}}
    e1, p1 = L.ws("ws_patch", req)
    s, b, _ = spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc, {"data": {"note": "draft"}})  # B puts it back
    back = S.draft(doc)["note"]
    e2, p2 = L.ws("ws_patch", req)  # A, from a fresh read (note is "draft" again): the same request
    after = S.draft(doc)["note"]
    # MWS-RES-1: never an ok "replayed" answer for a change that is not in effect. The strict reading (#38's stop-gap,
    # agreed with revision 3): refused with replay_superseded, nothing written; re-send with an idempotency_key to apply
    refused = e2 and ecode(p2) == "replay_superseded" and after == "draft"
    check("D1 via if_match: A -> B -> A, the same if_match write is refused (replay_superseded), nothing written, never answered as a replay",
          not e1 and s == 200 and back == "draft" and refused,
          {"first": (e1, (p1 or {}).get("ok")), "rest": s, "note_before_second": back, "second_err": e2,
           "second_replayed": (p2 or {}).get("replayed"), "second_hint": (p2 or {}).get("hint"), "note_after_second": after})


def d1_publish():
    """ws_publish V -> someone unpublishes -> a fresh read gives the same draft token (publish/unpublish never move the
    content revision) -> ws_publish with it is the identical request. It must not be answered as a replay while the
    entry stays unpublished: it is refused with replay_superseded (nothing written)."""
    doc = S.new_page(S.TAG + " r2-pub")
    v0 = L.wget(PAGE, doc)["version"]
    e1, p1 = L.ws("ws_publish", {"uid": PAGE, "documentId": doc, "expected_version": v0})
    pub1 = published(doc)
    s, b = S.ED.http("POST", S.cm(PAGE, doc, "unpublish"), {})
    pub2 = published(doc)
    v1 = L.wget(PAGE, doc)["version"]
    e2, p2 = L.ws("ws_publish", {"uid": PAGE, "documentId": doc, "expected_version": v1})
    pub3 = published(doc)
    refused = e2 and ecode(p2) == "replay_superseded" and not pub3
    check("D1 via publish: publish -> unpublish -> the same ws_publish is refused (replay_superseded), still unpublished, never answered as a replay",
          not e1 and pub1 and s == 200 and not pub2 and refused,
          {"publish1": (e1, pub1), "unpublish": (s, pub2), "same_token_after_unpublish": v1 == v0, "publish2_err": e2,
           "publish2_replayed": (p2 or {}).get("replayed"), "published_after": pub3})


def d1_shared():
    """The residual (INDEX): a non-localized field written through fr reaches en through strapi.db.query, so en's content
    revision does not move. Shows (1) en's token returns after A -> B -> A through fr; (2) that is not a replay path for
    a request on en, because the agent's own en write moved en's revision; (3) a stale en token cannot overwrite."""
    g = L.make_guide(S.TAG + "-r2-sh")
    en0 = L.wget(GUIDE, g, "en")
    code0 = en0["data"].get("code")
    S.patch(GUIDE, g, "fr", set={"code": "SHARED-B"})
    en1 = L.wget(GUIDE, g, "en")
    S.patch(GUIDE, g, "fr", set={"code": code0})
    en2 = L.wget(GUIDE, g, "en")
    info("d1_shared: en token after A -> B -> A of a shared field through fr", {"en_code_mid": en1["data"].get("code"), "same_as_first": en2["version"] == en0["version"]})
    # stale token: en1 was read when code was SHARED-B; content is back to code0 now
    e, r = L.ws("ws_patch", {"uid": GUIDE, "documentId": g, "locale": "en", "expected_version": en1["version"], "set": {"note": "stale"}})
    check("D1 residual: a token read mid-way (content since changed through fr) is refused", e and ecode(r) == "version_conflict", r)
    # replay attempt: A writes code via en with en0, B reverts through fr, A re-reads and sends the identical request
    en3 = L.wget(GUIDE, g, "en")
    req = {"uid": GUIDE, "documentId": g, "locale": "en", "expected_version": en3["version"], "set": {"code": "SHARED-A"}}
    e1, p1 = L.ws("ws_patch", req)
    S.patch(GUIDE, g, "fr", set={"code": code0})
    en4 = L.wget(GUIDE, g, "en")
    e2, p2 = L.ws("ws_patch", dict(req, expected_version=en4["version"]))
    en5 = L.wget(GUIDE, g, "en")
    check("D1 residual: not a replay path (A's own en write moved en's revision; the fresh request is applied)",
          not e1 and en4["version"] != en3["version"] and not e2 and not (p2 or {}).get("replayed") and en5["data"].get("code") == "SHARED-A",
          {"e1": e1, "token_returned": en4["version"] == en3["version"], "e2": e2, "replayed": (p2 or {}).get("replayed"), "code": en5["data"].get("code")})


def d1_noop():
    """A content-unchanged write keeps the token (item 15): a REST PUT of the same scalar, and of the same component rows
    without ids (Strapi re-creates them with new ids)."""
    doc = S.new_page(S.TAG + " r2-noop")
    v0 = L.wget(PAGE, doc)
    s, b, _ = spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc, {"data": {"note": v0["data"]["note"]}})
    v1 = L.wget(PAGE, doc)
    items = [{"label": x["label"], "qty": x["qty"]} for x in v0["data"]["items"]]
    s2, b2, _ = spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc, {"data": {"items": items}})
    v2 = L.wget(PAGE, doc)
    check("D1: content-unchanged writes keep the token (same scalar; rows re-created with new ids)",
          s == 200 and s2 == 200 and v1["version"] == v0["version"] and v2["version"] == v0["version"],
          {"scalar_same": v1["version"] == v0["version"], "rows_same": v2["version"] == v0["version"]})


def d1_discard():
    """Published A; the agent sets B; an editor discards the draft (back to A). The agent's first request, resent
    with a fresh token, must be applied, and the token it held before its write must not match again."""
    doc = S.new_page(S.TAG + " r2-disc")
    v0 = L.wget(PAGE, doc)["version"]
    L.ws("ws_publish", {"uid": PAGE, "documentId": doc, "expected_version": v0})
    va = L.wget(PAGE, doc)["version"]
    e1, p1 = L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": va, "set": {"note": "B"}})
    _, _ = S.form(S.ED, PAGE, doc)
    s, b = S.ED.http("POST", S.cm(PAGE, doc, "discard"), {})
    vd = L.wget(PAGE, doc)
    e2, p2 = L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": vd["version"], "set": {"note": "B"}})
    after = S.draft(doc)["note"]
    check("D1 via discard: A -> B -> discard (A): token differs from A's first token, and the fresh write is applied",
          not e1 and s == 200 and vd["data"]["note"] == "draft" and vd["version"] != va and not e2 and not (p2 or {}).get("replayed") and after == "B",
          {"e1": e1, "discard": (s, b if s != 200 else None), "note_after_discard": vd["data"]["note"], "token_back": vd["version"] == va,
           "e2": e2, "replayed": (p2 or {}).get("replayed"), "after": after})


def d1_two_locales(rounds=12):
    """Concurrent ws_patch of en and fr of one guide (localized fields): each applied; each token from a read right
    after is accepted by the next write (no torn revision)."""
    g = L.make_guide(S.TAG + "-r2-2l")
    errs = []

    def w(loc, i):
        for _ in range(4):
            v = L.wget(GUIDE, g, loc)["version"]
            e, r = L.ws("ws_patch", {"uid": GUIDE, "documentId": g, "locale": loc, "expected_version": v, "set": {"note": "%s-%d" % (loc, i)}})
            if not e:
                return
            if ecode(r) != "version_conflict":
                errs.append((loc, i, r))
                return
        errs.append((loc, i, "4 version_conflicts in a row"))
    for i in range(rounds):
        ts = [threading.Thread(target=w, args=("en", i)), threading.Thread(target=w, args=("fr", i))]
        [t.start() for t in ts]
        [t.join() for t in ts]
    en, fr = S.draft(g, GUIDE, "en"), S.draft(g, GUIDE, "fr")
    check("D1: concurrent en/fr writes: all applied, no error but version_conflict retries", not errs and en["note"] == "en-%d" % (rounds - 1) and fr["note"] == "fr-%d" % (rounds - 1),
          {"errs": errs[:3], "en": en["note"], "fr": fr["note"]})


def v2_token():
    """A v2 token (pre-D1 format) after the upgrade: refused, and how."""
    doc = S.new_page(S.TAG + " r2-v2")
    v = L.wget(PAGE, doc)["version"]
    fake = "v2." + v[3:]
    e, r = L.ws("ws_patch", {"uid": PAGE, "documentId": doc, "expected_version": fake, "set": {"note": "x"}})
    err = (r or {}).get("error") or {}
    # its own code (X4 revision 3, N3): a token from before the upgrade, not "the document changed"
    check("v2 token: refused with version_format (requires_reread), not version_conflict; nothing written",
          e and err.get("code") == "version_format" and err.get("requires_reread") is True and S.draft(doc)["note"] == "draft",
          {"code": err.get("code"), "message": err.get("message"), "requires_reread": err.get("requires_reread")})


# ---------------------------------------------------------------- B3 (a), retention
def rest_between():
    """Agent write, then a REST write of another field, then the stale Save. The agent's change must survive. By default
    (otherWriters) the REST write makes the older form refuse (409 other_writer); with otherWriters: false the Save is
    merged and REST's change is last-write-wins."""
    doc = S.new_page(S.TAG + " r2-rb")
    _, body = S.form(S.ED, PAGE, doc)
    S.coffee(doc)  # agent: Coffee 4 -> 12
    s0, _, _ = spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc, {"data": {"summary": "rest summary"}})
    s, b = S.ED.http("PUT", S.cm(PAGE, doc), dict(body, title="editor title"))
    d = S.draft(doc)
    check("REST between agent write and stale Save: 409 other_writer (default) or 200 merged; the agent's Coffee 12 kept either way",
          s0 == 200 and S.row(d, "Coffee")["qty"] == 12 and ((s == 200 and d["title"] == "editor title") or S.err409(s, b, "other_writer")), {"s": s, "b": b if s != 200 else None, "coffee": S.row(d, "Coffee"), "title": d["title"]})
    info("rest_between: REST's summary after the stale Save (Strapi last-write-wins)", d.get("summary"))
    # REST re-creates the item rows (new ids) between the agent's row edit and a Save that edits a row
    doc = S.new_page(S.TAG + " r2-rb2")
    _, body = S.form(S.ED, PAGE, doc)
    S.coffee(doc)
    d0 = S.draft(doc)
    items = [{"label": x["label"], "qty": x["qty"]} for x in d0["items"]]
    s0, _, _ = spike.rest(RA, "PUT", "/api/pages/%s?status=draft" % doc, {"data": {"items": items}})
    s, b = S.ED.http("PUT", S.cm(PAGE, doc), S.set_row(body, "Tea", qty=99))
    d = S.draft(doc)
    check("REST re-created the rows between: the stale Save is refused (409) or keeps the agent's Coffee 12 (200)",
          S.err409(s, b) or (s == 200 and (S.row(d, "Coffee") or {}).get("qty") == 12), {"rest": s0, "s": s, "b": b if s != 200 else None, "items": [(x["label"], x["qty"]) for x in d["items"]]})


def prune_nohdr():
    """After pruning, a header-less Save of an entry that had agent changes: 409 (pruned_rev > 0), never a silent overwrite."""
    doc = S.new_page(S.TAG + " r2-prn")
    no = S.ED.tab(echo=False)
    _, body = S.form(no, PAGE, doc)
    S.coffee(doc)
    time.sleep(0.2)
    s0, pb, _ = spike.rest(RA, "POST", "/api/probe/stale-prune", {"hours": 0.00001})
    s, b = no.http("PUT", S.cm(PAGE, doc), dict(body, title="nohdr after prune"))
    d = S.draft(doc)
    check("retention: header-less Save after the journal was pruned: 409, Coffee 12 kept", S.err409(s, b) and S.row(d, "Coffee")["qty"] == 12,
          {"prune": (s0, pb), "s": s, "reason": (((b or {}).get("error") or {}).get("details") or {}).get("reason") if isinstance(b, dict) else b, "coffee": S.row(d, "Coffee")})
    # with a header: base older than pruned -> base_too_old; base equal to the last pruned revision -> merge or pass
    _, body2 = S.form(S.ED, PAGE, doc)  # base = current revision (all pruned)
    S.coffee(doc, qty=13)
    s, b = S.ED.http("PUT", S.cm(PAGE, doc), dict(body2, title="base at pruned rev"))
    d = S.draft(doc)
    check("retention: a form loaded after the prune merges the next agent write (Coffee 13 kept)", s == 200 and S.row(d, "Coffee")["qty"] == 13, (s, b if s != 200 else None, S.row(d, "Coffee")))


# ---------------------------------------------------------------- S5 with a restricted role
def _admin(method, path, body=None):
    return S.ED.http(method, path, body)


def restricted_editor(hidden=("items.label",)):
    """An editor role that can read and update api::page.page, every field but `hidden` (field-level permissions)."""
    fields = ["title", "summary", "note", "body", "seo.metaTitle", "seo.metaDescription", "items.qty", "items.label", "items.meta.note", "items.meta.flag",
              "sections", "credits", "screens", "cover", "reviewer"]
    seo = json.load(open(os.path.join(os.path.dirname(os.environ.get("WS_TESTS", os.path.dirname(os.path.abspath(__file__)))), "app/src/components/shared/seo.json")))["attributes"]
    fields = [f for f in fields if not f.startswith("seo.")] + ["seo." + k for k in seo]
    fields = [f for f in fields if f not in hidden]
    s, r = _admin("POST", "/admin/roles", {"name": "r2-restricted-%s" % S.TAG, "description": "review"})
    if s not in (200, 201):
        raise RuntimeError(("role", s, r))
    rid = r["data"]["id"]
    perms = [{"action": "plugin::content-manager.explorer." + a, "subject": PAGE, "properties": {"fields": fields}, "conditions": []} for a in ("read", "update", "create")]
    perms.append({"action": "plugin::content-manager.explorer.publish", "subject": PAGE, "properties": {}, "conditions": []})
    s, r = _admin("PUT", "/admin/roles/%s/permissions" % rid, {"permissions": perms})
    if s != 200:
        raise RuntimeError(("perms", s, r))
    email = "%s-restricted@example.test" % S.TAG
    pw = "Rr9" + os.urandom(12).hex()
    s, u = _admin("POST", "/admin/users", {"firstname": "Re", "lastname": "Stricted", "email": email, "roles": [rid]})
    if s not in (200, 201):
        raise RuntimeError(("user", s, u))
    req = urllib.request.Request(spike.BASE + "/admin/register", data=json.dumps({"registrationToken": u["data"]["registrationToken"],
                                 "userInfo": {"firstname": "Re", "lastname": "Stricted", "password": pw}}).encode(), headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req).read()
    return S.Tab(email, pw).login()


def s5_restricted():
    """The editor may read items.qty but not items.label. The agent changes Coffee's qty; her stale form changes it too
    (409) or changes the title (merge note). Neither message nor header may carry the row's label value."""
    ed = restricted_editor()
    doc = S.new_page(S.TAG + " r2-s5")
    d, body = S.form(ed, PAGE, doc)
    info("s5: the restricted editor's form rows", [sorted(x.keys()) for x in body.get("items", [])][:1])
    S.coffee(doc)
    body2 = json.loads(json.dumps(body))
    body2["items"][0]["qty"] = 7
    s, b = ed.http("PUT", S.cm(PAGE, doc), body2)
    msg = json.dumps(b) if not isinstance(b, str) else b
    check("S5: a 409 to an editor who cannot read items.label does not carry its value ('Coffee')", s == 409 and "Coffee" not in msg, {"s": s, "body": b})
    d, body = S.form(ed, PAGE, doc)
    S.coffee(doc, qty=14)
    s, b = ed.http("PUT", S.cm(PAGE, doc), dict(body, title="restricted title"))
    merged = ed.merged()
    check("S5: the merge note (X-Writesafe-Merged) to that editor does not carry items.label's value", s == 200 and "Coffee" not in json.dumps(merged), {"s": s, "merged": merged})


def merged_resave():
    """S4 follow-on: after a merged Save (200, X-Writesafe-Merged), the wrapper stores the Save's answered version as
    the base, but Strapi's DocumentActions resets the form to the values the editor SENT (resetForm(latestValues)) and
    shows the merged entry only when the invalidation refetch lands. A second Save from that form (refetch not landed
    or failed) carries the stale agent field with the new base: no journal entry after it, so it passes."""
    doc = S.new_page(S.TAG + " r2-mrs")
    _, body = S.form(S.ED, PAGE, doc)
    S.coffee(doc)  # agent: Coffee 4 -> 12
    sent = dict(body, title="first save")
    s1, _ = S.ED.http("PUT", S.cm(PAGE, doc), sent)
    merged = S.ED.merged()
    c1 = S.row(S.draft(doc), "Coffee")["qty"]
    s2, b2 = S.ED.http("PUT", S.cm(PAGE, doc), dict(sent, title="second save"))  # the form as Strapi left it
    c2 = S.row(S.draft(doc), "Coffee")["qty"]
    check("merged Save, then a second Save from the form as Strapi resets it (the sent values): the agent's Coffee 12 survives",
          s1 == 200 and c1 == 12 and s2 == 200 and c2 == 12, {"first": s1, "merged": merged, "coffee_after_first": c1, "second": s2, "coffee_after_second": c2})


ALL = [d1_if_match, d1_publish, d1_shared, d1_noop, d1_discard, d1_two_locales, v2_token, rest_between, prune_nohdr, s5_restricted, merged_resave]
if __name__ == "__main__":
    names = sys.argv[1:]
    for fn in ALL:
        if names and fn.__name__ not in names:
            continue
        try:
            fn()
        except Exception as ex:
            import traceback
            check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-1500:])
    p = sum(1 for o in OUT if o["pass"])
    print("review2 e2e (%s): %d passed, %d failed" % (S.DB_LABEL, p, len(OUT) - p))
    out = os.environ.get("REVIEW2_OUT")
    if out:
        json.dump(OUT, open(out, "w"), indent=1)
