"""Lock-order checks (1.0 hardening stream B: item 11 with 16a, item 16), against a running Strapi, every database.
Short runs of the arms in tests/stress/lockarms.py (the full runs and their numbers: tests/stress/lock_soak.py):
  - the Document Service lock is installed and every Document Service writer passes it (the Content Manager's Save,
    publish, unpublish, discard and delete, REST, GraphQL, another plugin, Strapi's built-in MCP tools, ws_patch);
    raw knex does not; on SQLite it passes everything straight through;
  - it locks every locale's draft row (N6);
  - no deadlock and no admin HTTP 500 in any arm: admin Save against ws_patch (normal, +30 rows, nested component,
    dynamic-zone replacement, localized), admin against admin (same locale and across locales), admin delete and
    publish against ws_patch, two ws_batch calls, a ws_bulk chunk against an admin Save;
  - MySQL: concurrent writes on one localized document never read a stale snapshot (N10).
On rc.2 (main 946e8b9) the deadlock checks fail on Postgres and MySQL. LOCK_ROUNDS scales the rounds (default 1.0).
Run: python3 tests/test_locking.py (env as for tests/test_plugin.py; ci/run_suite.sh runs it)."""
import json, os, sys, traceback
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "stress"))
import lockarms as L  # noqa: E402

results = []
CURRENT = [None]
SQLITE = L.DB_LABEL == "sqlite"
SCALE = float(os.environ.get("LOCK_ROUNDS", "1"))
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]


def n(x):
    return max(1, int(round(x * SCALE)))


def check(name, cond, detail=None):
    results.append({"group": CURRENT[0], "test": name, "pass": bool(cond), "detail": detail if not cond else None})
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  " + json.dumps(detail, default=str)[:900]), flush=True)


def T(fn):
    if ONLY and not any(o in fn.__name__ for o in ONLY):
        return fn
    CURRENT[0] = fn.__name__
    try:
        fn()
    except Exception:
        check(fn.__name__ + " (crashed)", False, traceback.format_exc()[-900:])
    return fn


# Stream A (item 16b): row keys are bound to the row's content. The admin Save in these arms rewrites every item's label
# (and a publish with a body saves the draft first), so when it commits before the agent's row op, the agent's key
# read before the round is stale: stale_row_key is the expected answer then, never a deadlock or a lost write.
STALE_KEY = ("stale_row_key",)


def no_deadlock(label, agg, allow_agent=(), allow_admin_4xx=False):
    """The arm's verdict: no deadlock (writesafe retry on 40P01/ER_LOCK_DEADLOCK, or one in the Strapi log), no admin
    HTTP 500; the agent's errors only of the allowed codes; admin 4xx only where a stale form is expected."""
    short = {k: agg.get(k) for k in ("rounds", "deadlocks", "admin_500", "admin_other_errors", "admin_error_messages", "agent_errors",
                                     "agent_error_codes", "admin_ms_p50", "admin_ms_p95") if k in agg}
    check("%s: no deadlock (%d rounds)" % (label, agg["rounds"]), agg["deadlocks"] == 0, short)
    check("%s: no admin HTTP 500" % label, agg.get("admin_500", 0) == 0, short)
    if "admin_other_errors" in agg and not allow_admin_4xx:
        check("%s: no other admin error" % label, agg["admin_other_errors"] == 0, short)
    if "agent_errors" in agg:
        bad = [c for c in agg["agent_error_codes"] if c not in allow_agent]
        check("%s: agent errors only %s" % (label, list(allow_agent) or "none"), not bad, short)


@T
def t_lock_installed():
    s = L.lock_stats()
    check("lock-stats probe answers", bool(s), s)
    check("Document Service lock installed (documentServiceLock default on)", s and s["state"]["installed"] is True, s and s["state"])


@T
def t_lock_writer_coverage():
    cov = L.coverage(1)
    covered = {"content_manager_save": "update", "rest_put": "update", "graphql_update": "update", "plugin_document_service": "update",
               "builtin_mcp_update_page": "update", "cm_publish": "publish", "cm_unpublish": "unpublish", "cm_discard": "discardDraft",
               "cm_delete": "delete"}
    for w, recs in cov.items():
        r = recs[0]
        check("%s: write ok" % w, r["write_ok"], r)
        if SQLITE:
            if w != "raw_knex":
                check("%s: SQLite, passed straight through (no lock, no transaction)" % w, r["locked"] == 0 and r["sqlite_passthrough"] >= 1, r)
            continue
        if w == "raw_knex":
            check("raw_knex: NOT covered (bypasses the Document Service)", r["locked"] == 0 and r["already_held"] == 0 and not r["actions"], r)
        elif w == "ws_patch":
            check("ws_patch: its Document Service call finds the document already locked by writesafe (no second lock)",
                  r["locked"] == 0 and r["already_held"] >= 1 and "update" in r["actions"], r)
        else:
            check("%s: takes the lock (%s)" % (w, covered[w]), r["locked"] >= 1 and covered[w] in r["actions"], r)


@T
def t_lock_all_locales():
    st, new = L.guide_lock_rows()
    check("admin Save of a localized document (fr) ok", st == 200, st)
    if SQLITE:
        check("SQLite: no row lock", not [x for x in new if not x.get("held")], new)
        return
    took = [x for x in new if not x.get("held")]
    check("N6: the lock covers every locale's draft row (en and fr: 2 rows), not only the saved locale's",
          took and took[0]["action"] == "update" and took[0]["rows"] == 2, new)


@T
def t_admin_vs_patch():
    no_deadlock("admin Save vs ws_patch", L.two_writers("normal", n(30))["aggregate"], allow_agent=STALE_KEY)


@T
def t_admin_vs_heavy_patch():
    no_deadlock("admin Save vs ws_patch +30 rows", L.two_writers("normal", n(10), heavy=30)["aggregate"], allow_agent=STALE_KEY)


@T
def t_admin_vs_nested():
    no_deadlock("admin Save vs ws_patch of a nested component", L.two_writers("nested", n(10))["aggregate"], allow_agent=STALE_KEY)


@T
def t_admin_vs_dzset():
    # a form loaded before the agent replaced the zone holds ids of deleted rows: Strapi refuses it with a 400 (stale form)
    agg = L.two_writers("dzset", n(10))["aggregate"]
    no_deadlock("admin Save vs dynamic-zone replacement", agg, allow_agent=STALE_KEY, allow_admin_4xx=True)
    msgs = [m for m in agg["admin_error_messages"] if m]
    check("dynamic-zone replacement: any admin 4xx is the stale-form refusal", all("not related to the entity" in m or "component" in m.lower() for m in msgs), msgs)


@T
def t_admin_vs_locale_patch():
    agg = L.two_writers("locale", n(10))["aggregate"]
    no_deadlock("localized: admin Save en vs ws_patch fr", agg, allow_admin_4xx=True)


@T
def t_admin_vs_admin():
    no_deadlock("admin Save vs admin Save, same page", L.two_writers("ava", n(10))["aggregate"])


@T
def t_admin_vs_admin_locales():
    # each Save rewrites the other locale's non-localized rows (i18n sync); the second may hold dead ids: a 400
    no_deadlock("admin Save en vs admin Save fr", L.two_writers("locale_ava", n(10))["aggregate"], allow_agent=("http_400",), allow_admin_4xx=True)


@T
def t_admin_delete_vs_patch():
    no_deadlock("admin delete vs ws_patch", L.two_writers("delete", n(10))["aggregate"], allow_agent=("not_found",))


@T
def t_admin_publish_vs_patch():
    no_deadlock("admin publish vs ws_patch", L.two_writers("publish", n(10))["aggregate"], allow_agent=STALE_KEY)


@T
def t_batch_vs_batch():
    agg = L.batch_vs_batch(n(10))["aggregate"]
    check("two ws_batch calls in opposite orders: no deadlock, both ok every round", agg["deadlocks"] == 0 and agg["both_ok"] == agg["rounds"], agg)


@T
def t_batch25_vs_admin():
    # regression: on MySQL one IN (...) lock statement over 25 documents took the primary key and deadlocked the admin
    no_deadlock("25-item ws_batch vs admin Save of its last page", L.batch_vs_admin(n(5), n_docs=25)["aggregate"], allow_agent=STALE_KEY)


@T
def t_discard_vs_patch():
    # review of PR #15, item 2: discard recreates the draft rows; a waiting lock must take the new ones
    agg = L.discard_vs_patch(n(10))["aggregate"]
    no_deadlock("admin discard vs ws_patch", agg)
    check("admin discard vs ws_patch: no lock on zero rows of an existing page (the recreated rows are locked)", agg["empty_locks"] == 0 or L.DB_LABEL == "sqlite", agg)


@T
def t_order_locale_vs_move():
    # review of PR #15, item 1: only where custom order exists (Strapi 5.62 with the future flag); skipped elsewhere
    r = L.order_vs_locale(n(10))
    if r is None:
        check("custom order not available here (Strapi < 5.62 or flag off): add-locale vs move skipped", True)
        return
    agg = r["aggregate"]
    check("new locale vs custom-order move: no deadlock (%d rounds)" % agg["rounds"], agg["deadlocks"] == 0, agg)
    check("new locale vs custom-order move: no HTTP 500 on either side", agg["admin_500"] == 0 and "http_500" not in agg["agent_error_codes"], agg)


@T
def t_bulk_vs_admin():
    agg = L.bulk_vs_admin(n(3), n_docs=10, chunk=10)["aggregate"]
    no_deadlock("ws_bulk chunk vs admin Save", agg)
    check("ws_bulk: every job done", agg["bulk_not_done"] == 0, agg)


@T
def t_stale_snapshot():
    agg = L.agents_l10n(n(10), k=4)["aggregate"]
    check("4 concurrent ws_patch on one localized document: all ok, none busy", agg["ok"] == agg["calls"] and agg["busy"] == 0, agg)
    check("N10: no stale-snapshot re-run (the documents are locked before the transaction's first read)", agg["stale_snapshot_retries"] == 0, agg)
    check("no deadlock", agg["deadlocks"] == 0, agg)


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    tag = os.environ.get("RESULT_TAG", L.DB_LABEL)
    json.dump(results, open(os.path.join(HERE, "results", "test_locking-%s.json" % tag), "w"), indent=1, default=str)
    fails = [r for r in results if not r["pass"]]
    groups = {}
    for r in results:
        g = groups.setdefault(r["group"], [0, 0]); g[0 if r["pass"] else 1] += 1
    for g, (ok, bad) in groups.items():
        print("  %-40s %d/%d" % (g, ok, ok + bad))
    print("%d passed, %d failed" % (len(results) - len(fails), len(fails)))
    sys.exit(1 if fails else 0)
