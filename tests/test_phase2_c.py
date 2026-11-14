"""Functional tests for writesafe hardening phase 2, stream C (modules): item 10 (publish and delete dry runs are true
previews), item 12 (ws_localize: explicit source-to-target row map, target-only rows kept) and item 14 (media: cleanup
after a failed index insert, dedup across replicas).

Needs a running Strapi with every module on and the test probe plugin (WRITESAFE_TEST_PROBE=true), after the token and
fixture scripts (ci/run_suite.sh does all of it). Item 14's replica test starts a second Strapi from APP_DIR on
REPLICA_PORT (default PORT + 9) against the same database: Postgres and MySQL only (SQLite apps are one process).
Run: python3 tests/test_phase2_c.py   (exit 1 on any failure; writes tests/results/test_phase2_c-<DB_LABEL>.json)
ONLY=t_c10,t_c14 runs a subset."""
import base64, json, os, random, struct, subprocess, sys, threading, time, traceback, urllib.request, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "spike"))
import spike, common
from spike import A, B, RA

PAGE = "api::page.page"
ART = "api::article.article"
STORY = "api::story.story"
RUN = "%x" % random.getrandbits(32)
APP_DIR = os.environ.get("APP_DIR") or os.path.join(HERE, "..", "app")
FILES_PORT = int(os.environ.get("MEDIA_TEST_PORTS", "2047,2048,2049").split(",")[0])
DB_LABEL = os.environ.get("DB_LABEL", "sqlite")
results = []
CURRENT = [None]
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]


def check(name, cond, detail=None, skip=False):
    status = "skip" if skip else ("pass" if cond else "fail")
    results.append({"group": CURRENT[0], "test": name, "pass": bool(cond) or skip, "status": status, "detail": None if (cond and not skip) else detail})
    tag = {"pass": "PASS ", "fail": "FAIL ", "skip": "SKIP "}[status]
    print(tag + name + ("" if status == "pass" else "  " + json.dumps(detail, default=str, ensure_ascii=False)[:900]))


def T(fn):
    if ONLY and not any(o in fn.__name__ for o in ONLY):
        return fn
    CURRENT[0] = fn.__name__
    try:
        fn()
    except Exception:
        check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-1500:])
    return fn


def ws(tool, args, who=A, base=None):
    if base:
        st, body, _ = spike.rpc(who, "tools/call", {"name": tool, "arguments": args}, base=base)
        res = body.get("result") if isinstance(body, dict) else None
        if res is None:
            return True, body
        if res.get("isError"):
            return True, json.loads(res["content"][0]["text"])
        return False, res.get("structuredContent")
    err, r, _, _ = spike.tool(who, tool, args)
    if err and isinstance(r, str):
        try:
            r = json.loads(r)
        except Exception:
            pass
    return err, r


def code(r):
    return ((r or {}).get("error") or {}).get("code") if isinstance(r, dict) else None


def wget(uid, doc, loc=None, who=A):
    a = {"uid": uid, "documentId": doc}
    if loc:
        a["locale"] = loc
    e, r = ws("ws_get", a, who)
    if e:
        raise RuntimeError(r)
    return r


def rest(method, path, data=None, who=RA, ok=(200, 201)):
    s, b, _ = spike.rest(who, method, path, {"data": data} if data is not None else None)
    if ok and s not in ok:
        raise RuntimeError((method, path, s, b))
    return s, (b or {}).get("data") if isinstance(b, dict) else b


def probe(path, body=None):
    s, b, _ = spike.rest(RA, "POST", "/api/probe/" + path, body or {})
    if s != 200:
        raise RuntimeError(("probe", path, s, b))
    return b


READS = {"findOne", "findMany", "findFirst", "count"}


def recorded(doc=None, uid=None):
    """Writing Document Service middleware calls (reads left out) for one document, and writing database lifecycle
    events (find/count left out) on one type, since the last reset."""
    es = probe("recorder", {"reset": True})["entries"]
    mw = [e for e in es if e["kind"] == "middleware" and e["action"] not in READS and (doc is None or e.get("documentId") == doc)]
    lc = [e for e in es if e["kind"] == "lifecycle" and "Find" not in e["action"] and "Count" not in e["action"] and (uid is None or e["uid"] == uid)]
    return mw, lc


def is_published(path):
    s, b, _ = spike.rest(RA, "GET", path)
    return s == 200 and bool((b or {}).get("data"))


# ================================================================ item 10: publish and delete dry runs are previews
@T
def t_c10_publish_dry_run_is_a_preview():
    doc = common.create_page_mcp("c10-pub-" + RUN)
    g = wget(PAGE, doc)
    probe("recorder", {"reset": True})
    e, r = ws("ws_publish", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "dry_run": True})
    mw, lc = recorded(doc, PAGE)
    check("publish dry run answers ok, dry_run, written false, with the live diff", not e and r.get("dry_run") is True and r.get("written") is False and "diff" in r, r)
    check("publish dry run says it is a preview (publish not called)", not e and r.get("preview") is True, r)
    check("publish dry run: no Document Service middleware ran for the document", not mw, mw)
    check("publish dry run: no database lifecycle ran on the type", not lc, lc)
    check("publish dry run published nothing", not is_published("/api/pages/%s?status=published" % doc))
    # the real publish still works, and runs Strapi's publish (proves the recorder sees it)
    e, r2 = ws("ws_publish", {"uid": PAGE, "documentId": doc, "expected_version": g["version"]})
    mw, lc = recorded(doc, PAGE)
    check("real publish: middleware 'publish' and lifecycles recorded (the recorder works)", not e and any(m["action"] == "publish" for m in mw) and lc, [r2, mw, len(lc)])


@T
def t_c10_publish_dry_run_validates_like_publish():
    # a draft without its required title: Strapi refuses the publish; the preview must say so too, without publishing
    s, d = rest("POST", "/api/pages?status=draft", {"summary": "no title " + RUN})
    doc = d["documentId"]
    g = wget(PAGE, doc)
    probe("recorder", {"reset": True})
    e1, dry = ws("ws_publish", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "dry_run": True})
    mw, _ = recorded(doc, PAGE)
    e2, real = ws("ws_publish", {"uid": PAGE, "documentId": doc, "expected_version": g["version"]})
    check("missing required field: real publish refused (invalid)", e2 and code(real) == "invalid", real)
    check("missing required field: the dry run refuses with the same code and names the field", e1 and code(dry) == "invalid" and "title" in json.dumps(dry["error"].get("details")), dry)
    check("the refused preview ran no middleware", not mw, mw)
    # unique field: two stories with one externalId; the second cannot be published, the first can be republished
    ext = "c10-uniq-" + RUN
    s, s1 = rest("POST", "/api/stories?status=draft&locale=en", {"title": "Uniq one " + RUN, "externalId": ext})
    g1 = wget(STORY, s1["documentId"], "en")
    e, r = ws("ws_publish", {"uid": STORY, "documentId": s1["documentId"], "locale": "en", "expected_version": g1["version"]})
    check("first story published", not e, r)
    s, s2 = rest("POST", "/api/stories?status=draft&locale=en", {"title": "Uniq two " + RUN, "externalId": ext})
    g2 = wget(STORY, s2["documentId"], "en")
    e1, dry = ws("ws_publish", {"uid": STORY, "documentId": s2["documentId"], "locale": "en", "expected_version": g2["version"], "dry_run": True})
    e2, real = ws("ws_publish", {"uid": STORY, "documentId": s2["documentId"], "locale": "en", "expected_version": g2["version"]})
    check("unique clash: real publish refused (invalid)", e2 and code(real) == "invalid", real)
    check("unique clash: the dry run refuses the same way", e1 and code(dry) == "invalid", dry)
    g1 = wget(STORY, s1["documentId"], "en")
    e, r = ws("ws_publish", {"uid": STORY, "documentId": s1["documentId"], "locale": "en", "expected_version": g1["version"], "dry_run": True})
    check("republish preview of the already-published story is valid (its own live row is not a clash)", not e and r.get("dry_run"), r)


@T
def t_c10_delete_dry_run_is_a_preview():
    doc = common.create_page_mcp("c10-del-" + RUN)
    g = wget(PAGE, doc)
    probe("recorder", {"reset": True})
    e, r = ws("ws_delete", {"uid": PAGE, "documentId": doc, "expected_version": g["version"], "dry_run": True})
    mw, lc = recorded(doc, PAGE)
    check("delete dry run answers ok, dry_run, written false, deleted false, with recreate", not e and r.get("dry_run") and r.get("written") is False and r.get("deleted") is False
          and r.get("would_delete") is True and r.get("recreate"), r)
    check("delete dry run: no Document Service middleware ran", not mw, mw)
    check("delete dry run: no database lifecycle ran", not lc, lc)
    check("delete dry run deleted nothing", common.rest_get(RA, doc)["title"] == "c10-del-" + RUN)
    # all locales of a localized document
    s, a = rest("POST", "/api/articles?status=draft&locale=en", {"title": "c10 art " + RUN})
    rest("PUT", "/api/articles/%s?status=draft&locale=fr" % a["documentId"], {"title": "c10 art fr " + RUN})
    vs = {l: wget(ART, a["documentId"], l)["version"] for l in ("en", "fr")}
    probe("recorder", {"reset": True})
    e, r = ws("ws_delete", {"uid": ART, "documentId": a["documentId"], "all_locales": True, "expected_version": vs, "dry_run": True})
    mw, lc = recorded(a["documentId"], ART)
    check("all_locales delete dry run: both locales previewed, nothing ran", not e and r.get("locales") == ["en", "fr"] and not mw and not lc, [r, mw, lc])
    check("all_locales delete dry run deleted nothing", wget(ART, a["documentId"], "fr")["data"]["title"] == "c10 art fr " + RUN)
    e, r = ws("ws_delete", {"uid": PAGE, "documentId": doc, "expected_version": g["version"]})
    mw, _ = recorded(doc, PAGE)
    check("real delete runs Strapi's delete (the recorder sees it)", not e and r["deleted"] and any(m["action"] == "delete" for m in mw), [r, mw])


@T
def t_c10_batch_and_bulk_publish_previews():
    doc = common.create_page_mcp("c10-batch-" + RUN)
    g = wget(PAGE, doc)
    probe("recorder", {"reset": True})
    e, r = ws("ws_batch", {"dry_run": True, "items": [{"uid": PAGE, "documentId": doc, "expected_version": g["version"], "set": {"note": "batched"}},
                                                     {"action": "publish", "uid": PAGE, "documentId": doc}]})
    mw, _ = recorded(doc, PAGE)
    check("batch dry run [patch, publish] answers ok", not e and r.get("dry_run") and r.get("committed") is False, r)
    check("batch dry run: the patch item ran Strapi's update (documented: patch dry runs roll back)", any(m["action"] == "update" for m in mw), mw)
    check("batch dry run: the publish item did not call Strapi's publish", not any(m["action"] == "publish" for m in mw), mw)
    title = "c10-bulk-" + RUN
    common.create_page_mcp(title)
    probe("recorder", {"reset": True})
    e, r = ws("ws_bulk", {"uid": PAGE, "action": "publish", "filters": {"title": {"$eq": title}}, "dry_run": True})
    mw, _ = recorded(None, PAGE)
    check("bulk publish dry run: Strapi's publish never called", not e and not any(m["action"] == "publish" for m in mw), [r, mw])


@T
def t_c10_dry_run_docs():
    s, b, _ = spike.rpc(A, "tools/list")
    tools = {t["name"]: t for t in b["result"]["tools"]}
    dr = lambda n: tools[n]["inputSchema"]["properties"]["dry_run"].get("description", "")
    check("ws_patch dry_run says lifecycle hooks and middlewares run, then roll back", "lifecycle" in dr("ws_patch") and "roll" in dr("ws_patch"), dr("ws_patch"))
    check("ws_publish dry_run says Strapi's publish is not called", "not call" in dr("ws_publish") or "never calls" in dr("ws_publish"), dr("ws_publish"))
    check("ws_delete dry_run says Strapi's delete is not called", "not call" in dr("ws_delete") or "never calls" in dr("ws_delete"), dr("ws_delete"))


# ================================================================ item 12: translation row map
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def upload(name):
    import uuid
    bnd = uuid.uuid4().hex
    body = (("--%s\r\nContent-Disposition: form-data; name=\"files\"; filename=\"%s\"\r\nContent-Type: image/png\r\n\r\n" % (bnd, name)).encode()
            + PNG + ("\r\n--%s--\r\n" % bnd).encode())
    req = urllib.request.Request(spike.BASE + "/api/upload", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + spike._token(RA), "Content-Type": "multipart/form-data; boundary=" + bnd})
    f = json.loads(urllib.request.urlopen(req, timeout=60).read())[0]
    return f["id"], f["documentId"]


FX = {}


def fx():
    if not FX:
        FX["ma"], FX["mad"] = upload("c12-a.png")
        FX["mb"], FX["mbd"] = upload("c12-b.png")
        FX["mfr"], FX["mfrd"] = upload("c12-fr.png")
        s, t = rest("POST", "/api/topics?locale=en", {"name": "C12 topic " + RUN})
        rest("PUT", "/api/topics/%s?locale=fr" % t["documentId"], {"name": "C12 sujet " + RUN})
        FX["topic"] = t["documentId"]
    return FX


def lplan(doc, **kw):
    e, p = ws("ws_localize", {"uid": ART, "documentId": doc, "locale": "fr", **kw})
    if e:
        raise RuntimeError(p)
    return p


def captions(view):
    return [(r.get("caption") or r.get("heading") or r.get("body")) for r in view["data"]["sections"]]


@T
def t_c12_reorder_and_insert_keep_target_values():
    f = fx()
    s, a = rest("POST", "/api/articles?status=draft&locale=en", {"title": "C12 order " + RUN, "sections": [
        {"__component": "blocks.hero", "heading": "Hero one"},
        {"__component": "l10n.figure", "caption": "Fig A", "image": f["ma"]},
        {"__component": "l10n.figure", "caption": "Fig B", "image": f["mb"]},
        {"__component": "blocks.hero", "heading": "Hero two"}]})
    doc = a["documentId"]
    p = lplan(doc)
    e, r = ws("ws_localize", {"uid": ART, "documentId": doc, "locale": "fr", "expected_source_version": p["source_version"],
                              "translations": {u["path"]: "FR " + u["source"] for u in p["units"]}})
    check("fr created from en", not e and r["created"], r)
    # fr editors: their own image on Fig A, their own relation on Fig B
    fr = wget(ART, doc, "fr")
    rk = fr["rows"]["sections"]
    e, r = ws("ws_patch", {"uid": ART, "documentId": doc, "locale": "fr", "ops": [
        {"op": "update", "field": "sections", "key": rk[1], "data": {"image": f["mfrd"]}},
        {"op": "update", "field": "sections", "key": rk[2], "data": {"topic": f["topic"]}}]}, B)
    check("fr-only choices stored (image on Fig A, topic on Fig B)", not e, r)
    # en editors: swap the two figures, move hero two first, insert a new figure at the end
    en = wget(ART, doc, "en")
    ek = en["rows"]["sections"]
    e, r = ws("ws_patch", {"uid": ART, "documentId": doc, "locale": "en", "ops": [
        {"op": "move", "field": "sections", "key": ek[2], "position": {"before": ek[1]}},
        {"op": "move", "field": "sections", "key": ek[3], "position": {"index": 0}},
        {"op": "add", "field": "sections", "component": "l10n.figure", "data": {"caption": "Fig N", "image": f["ma"]}}]}, B)
    check("en reordered and extended", not e, r)
    en = wget(ART, doc, "en")
    p2 = lplan(doc)
    check("plan: no ambiguous rows (the earlier ws_localize recorded the row map)", not p2.get("ambiguous_rows"), p2.get("ambiguous_rows"))
    check("plan: the row map pairs every earlier source row with its fr row", isinstance(p2.get("row_map"), dict) and len((p2["row_map"] or {}).get("sections", {})) == 5, p2.get("row_map"))
    new_unit = [u["path"] for u in p2["units"] if u["source"] == "Fig N"]
    e, r = ws("ws_localize", {"uid": ART, "documentId": doc, "locale": "fr", "expected_source_version": p2["source_version"], "expected_version": p2["target_version"],
                              "translations": {new_unit[0]: "FR Fig N"} if new_unit else {}})
    check("update ok", not e, r)
    fr2 = wget(ART, doc, "fr")
    check("fr follows the new en order", captions(fr2) == ["FR " + c for c in captions(en)], [captions(en), captions(fr2)])
    by = {x.get("caption"): x for x in fr2["data"]["sections"] if "caption" in x}
    check("fr's own image stays on Fig A", by.get("FR Fig A", {}).get("image") == f["mfrd"], by.get("FR Fig A"))
    check("fr's own relation stays on Fig B", by.get("FR Fig B", {}).get("topic") == f["topic"], by.get("FR Fig B"))
    check("Fig B keeps the source image it was copied with", by.get("FR Fig B", {}).get("image") == f["mbd"], by.get("FR Fig B"))
    check("the new row is copied from the source (its image)", by.get("FR Fig N", {}).get("image") == f["mad"], by.get("FR Fig N"))
    ident = lambda k: ":".join(k.split(":")[:2])   # row identity: ws_get keys carry a content MAC (stream A, 16b)
    ids1 = {x["caption"]: ident(k) for x, k in zip(fr["data"]["sections"], fr["rows"]["sections"]) if "caption" in x}
    ids2 = {x["caption"]: ident(k) for x, k in zip(fr2["data"]["sections"], fr2["rows"]["sections"]) if "caption" in x}
    check("matched fr rows keep their ids", ids1.get("FR Fig A") == ids2.get("FR Fig A") and ids1.get("FR Fig B") == ids2.get("FR Fig B"), [ids1, ids2])


@T
def t_c12_ambiguous_rows_refused_until_mapped():
    s, a = rest("POST", "/api/articles?status=draft&locale=en", {"title": "C12 amb " + RUN, "sections": [
        {"__component": "blocks.hero", "heading": "First"}, {"__component": "blocks.hero", "heading": "Second"}]})
    doc = a["documentId"]
    # fr made outside ws_localize (no row map recorded): two hero rows, which pair with which is unknown
    rest("PUT", "/api/articles/%s?status=draft&locale=fr" % doc, {"title": "C12 amb fr " + RUN, "sections": [
        {"__component": "blocks.hero", "heading": "Deuxième"}, {"__component": "blocks.hero", "heading": "Premier"}]})
    p = lplan(doc)
    amb = p.get("ambiguous_rows") or []
    check("plan lists the ambiguous pair (two hero rows each side)", len(amb) == 1 and amb[0].get("field") == "sections" and amb[0].get("component") == "blocks.hero"
          and len(amb[0].get("source", [])) == 2 and len(amb[0].get("target", [])) == 2, p)
    e, r = ws("ws_localize", {"uid": ART, "documentId": doc, "locale": "fr", "expected_source_version": p["source_version"], "expected_version": p["target_version"], "translations": {}})
    check("update refused with ambiguous_rows, nothing written", e and code(r) == "ambiguous_rows" and "row_map" in r["error"]["message"] and r["error"].get("ambiguous"), r)
    fr = wget(ART, doc, "fr")
    check("fr unchanged after the refusal", fr["version"] == p["target_version"], [fr["version"], p["target_version"]])
    # the agent maps them by meaning: en First -> fr Premier (2nd row), en Second -> fr Deuxième (1st row)
    src, tgt = amb[0]["source"], amb[0]["target"]
    e, r = ws("ws_localize", {"uid": ART, "documentId": doc, "locale": "fr", "expected_source_version": p["source_version"], "expected_version": p["target_version"],
                              "translations": {}, "row_map": {"sections": {src[0]: tgt[1], src[1]: tgt[0]}}})
    check("with an explicit row_map the update goes through", not e, r)
    fr = wget(ART, doc, "fr")
    check("rows now follow the source order with their own text", captions(fr) == ["Premier", "Deuxième"], captions(fr))
    p2 = lplan(doc)
    check("the next plan is unambiguous (map recorded)", not p2.get("ambiguous_rows"), p2.get("ambiguous_rows"))
    e, r = ws("ws_localize", {"uid": ART, "documentId": doc, "locale": "fr", "expected_source_version": p2["source_version"], "expected_version": p2["target_version"],
                              "translations": {}, "row_map": {"sections": {src[0]: "nope:1"}}})
    check("a row_map naming an unknown target row is refused", e and code(r) == "invalid", r)


@T
def t_c12_target_only_rows_kept():
    s, a = rest("POST", "/api/articles?status=draft&locale=en", {"title": "C12 keep " + RUN, "sections": [
        {"__component": "blocks.hero", "heading": "Top"}, {"__component": "blocks.text", "body": "Body"}]})
    doc = a["documentId"]
    p = lplan(doc)
    e, r = ws("ws_localize", {"uid": ART, "documentId": doc, "locale": "fr", "expected_source_version": p["source_version"],
                              "translations": {u["path"]: "FR " + u["source"] for u in p["units"]}})
    fr = wget(ART, doc, "fr")
    e, r = ws("ws_patch", {"uid": ART, "documentId": doc, "locale": "fr", "ops": [
        {"op": "add", "field": "sections", "component": "blocks.quote", "data": {"text": "Seulement en français"}, "position": {"after": fr["rows"]["sections"][0]}}]}, B)
    check("fr-only quote added between the rows", not e, r)
    en = wget(ART, doc, "en")
    e, r = ws("ws_patch", {"uid": ART, "documentId": doc, "locale": "en", "set": {"title": "C12 keep (edited) " + RUN}, "expected_version": en["version"]}, B)
    p2 = lplan(doc)
    only = p2.get("target_only_rows") or []
    check("plan lists the fr-only row and says it is kept", len(only) == 1 and only[0].get("field") == "sections" and only[0].get("component") == "blocks.quote" and only[0].get("action") == "keep", p2)
    e, r = ws("ws_localize", {"uid": ART, "documentId": doc, "locale": "fr", "expected_source_version": p2["source_version"], "expected_version": p2["target_version"],
                              "translations": {"title": "FR keep (edited)"}})
    fr2 = wget(ART, doc, "fr")
    check("a re-sync keeps the fr-only row in place", not e and captions(fr2) == ["FR Top", None, "FR Body"] and fr2["data"]["sections"][1].get("text") == "Seulement en français", [r, fr2["data"]["sections"]])
    check("the receipt reports it kept, not removed", not e and (r.get("rows") or {}).get("sections", {}).get("removed") == 0 and (r.get("rows") or {}).get("sections", {}).get("kept") == 1, r)
    # a source row removed in en: its fr row is kept too, unless remove_extra_rows
    en = wget(ART, doc, "en")
    e, r = ws("ws_patch", {"uid": ART, "documentId": doc, "locale": "en", "ops": [{"op": "remove", "field": "sections", "key": en["rows"]["sections"][1]}]}, B)
    p3 = lplan(doc)
    reasons = sorted(x.get("reason") for x in p3.get("target_only_rows") or [])
    check("plan: two target-only rows (fr-only, source row removed)", reasons == ["only_in_target", "source_row_removed"], p3.get("target_only_rows"))
    p4 = lplan(doc, remove_extra_rows=True)
    check("plan with remove_extra_rows says they would be removed", all(x.get("action") == "remove" for x in p4.get("target_only_rows") or [{}]), p4.get("target_only_rows"))
    e, r = ws("ws_localize", {"uid": ART, "documentId": doc, "locale": "fr", "expected_source_version": p3["source_version"], "expected_version": p3["target_version"],
                              "translations": {}, "remove_extra_rows": True})
    fr3 = wget(ART, doc, "fr")
    check("remove_extra_rows: only the source's rows are left", not e and captions(fr3) == ["FR Top"] and (r.get("rows") or {}).get("sections", {}).get("removed") == 2, [r, captions(fr3)])


# ================================================================ item 14: media
def mkpng(tag):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x00\x00\x00" * 4 for _ in range(4))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)) + chunk(b"tEXt", b"c\x00" + tag.encode())
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


FILES = {}


class Files(BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.split("?")[0].rsplit("/", 1)[-1]
        body = FILES.get(name)
        if body is None:
            self.send_response(404); self.end_headers(); return
        if self.path.startswith("/slow/"):
            time.sleep(1.5)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


_SRV = [None]


def files_server():
    if not _SRV[0]:
        srv = ThreadingHTTPServer(("127.0.0.1", FILES_PORT), Files)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        _SRV[0] = srv
    return "http://127.0.0.1:%d" % FILES_PORT


def file_count():
    e, r = ws("ws_media_find", {"limit": 1})
    return r["total"]


@T
def t_c14_failed_index_insert_cleans_up():
    base = files_server()
    name = "c14-clean-%s.png" % RUN
    FILES[name] = mkpng("clean-" + RUN)
    n0 = file_count()
    probe("fail-next", {"uid": "plugin::writesafe.media-import"})
    e, r = ws("ws_media_import", {"items": [{"url": base + "/files/" + name}]})
    item = (r.get("items") or [{}])[0] if isinstance(r, dict) else {}
    check("the import item fails when the index insert fails", item.get("status") == "failed", r)
    n1 = file_count()
    check("no file is left in the Media Library (uploaded file removed)", n1 == n0, [n0, n1])
    e, r = ws("ws_media_import", {"items": [{"url": base + "/files/" + name}]})
    item = (r.get("items") or [{}])[0]
    check("a retry imports it once (created), and it is indexed", not e and item.get("status") == "created" and file_count() == n0 + 1, r)
    e, f = ws("ws_media_find", {"source_url": base + "/files/" + name})
    check("the retried file is found by its source", not e and f["total"] == 1, f)


def start_replica(port):
    log = open(os.path.join(os.environ.get("WORK", "/tmp"), "strapi-replica-%s.log" % DB_LABEL), "a")
    env = dict(os.environ, PORT=str(port), HOST="127.0.0.1", SERVE_ADMIN_PANEL="false", NODE_ENV="test")
    p = subprocess.Popen(["node", "--max-old-space-size=4096", "node_modules/@strapi/strapi/bin/strapi.js", "start"], cwd=APP_DIR, env=env, stdout=log, stderr=log)
    base = "http://127.0.0.1:%d" % port
    for _ in range(180):
        try:
            if urllib.request.urlopen(base + "/_health", timeout=2).status == 204:
                return p, base
        except Exception:
            pass
        if p.poll() is not None:
            raise RuntimeError("replica exited")
        time.sleep(1)
    p.kill()
    raise RuntimeError("replica not healthy")


@T
def t_c14_dedup_across_replicas():
    if DB_LABEL == "sqlite":
        check("dedup across replicas (Postgres/MySQL only: SQLite apps run one process)", True, "sqlite", skip=True)
        return
    base = files_server()
    port = int(os.environ.get("REPLICA_PORT") or int(os.environ.get("PORT", "1337")) + 9)
    p, rbase = start_replica(port)
    try:
        for round_ in range(3):
            name = "c14-replica-%s-%d.png" % (RUN, round_)
            FILES[name] = mkpng("replica-%s-%d" % (RUN, round_))
            url = base + "/slow/" + name
            out = [None, None]

            def go(i, b):
                out[i] = ws("ws_media_import", {"items": [{"url": url}]}, base=b)
            t1 = threading.Thread(target=go, args=(0, None))
            t2 = threading.Thread(target=go, args=(1, rbase))
            t1.start(); t2.start(); t1.join(); t2.join()
            st = sorted(((o[1] or {}).get("items") or [{}])[0].get("status") for o in out)
            ids = {((o[1] or {}).get("items") or [{}])[0].get("id") for o in out}
            e, f = ws("ws_media_find", {"source_url": url})
            check("round %d: two replicas importing one file at once store it once (created + existing)" % round_, st == ["created", "existing"] and len(ids) == 1, [out, f.get("total") if isinstance(f, dict) else f])
    finally:
        p.terminate()
        try:
            p.wait(30)
        except Exception:
            p.kill()


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    json.dump(results, open(os.path.join(HERE, "results", "test_phase2_c-%s.json" % DB_LABEL), "w"), indent=1, default=str)
    fails = [r for r in results if not r["pass"]]
    if os.environ.get("BY_GROUP"):
        groups = {}
        for r in results:
            g = groups.setdefault(r["group"], [0, 0]); g[0 if r["pass"] else 1] += 1
        for g, (ok, bad) in groups.items():
            print("  %-48s %d/%d" % (g, ok, ok + bad))
    print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
    sys.exit(1 if fails else 0)
