"""Lock stress job (1.0 hardening stream B): the deadlock spike's arms at full length, with the numbers recorded.
Runs on one running Strapi (ci/run_suite.sh sets it up: SUITES=stress/lock_soak), one arm after the other:
  SOAK_ARMS   space-separated arms (default: every arm below)
  SOAK_LABEL  result label (default "b"), e.g. "main" for rc.2, "off" for documentServiceLock: false
  SOAK_SCALE  multiplies every round count (default 1)
Arms and rounds (as in the spike): normal 200, heavy 100 (+30 rows), ava 100, solo 50, nested 50, dzset 50, locale 50,
locale_ava 50, delete 50, publish 50, batch 50, bulk 30 (10 pages, chunk 10), bulk25 20 (25 pages, chunk 25: the default
chunk size), batch25 20 (a 25-item ws_batch vs an admin Save of its last page), discard 50 (admin discard vs ws_patch), order 50
(a new locale vs a custom-order move; needs Strapi 5.62 and STRAPI_FUTURE_CUSTOM_ORDER=true), agents_l10n 50 (4 writers), coverage 3 (needs PROBE_LOCK_COVERAGE=true for the component-write counts).
Writes tests/stress/results/<label>/<arm>_<db>.json and prints one line per arm; the verdict line counts arms with no
deadlock and no admin HTTP 500 (`N passed, M failed`, like the suites)."""
import json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lockarms as L  # noqa: E402

LABEL = os.environ.get("SOAK_LABEL", "b")
SCALE = float(os.environ.get("SOAK_SCALE", "1"))
ROUNDS = {"normal": 200, "heavy": 100, "ava": 100, "solo": 50, "nested": 50, "dzset": 50, "locale": 50, "locale_ava": 50,
          "delete": 50, "publish": 50, "batch": 50, "bulk": 30, "bulk25": 20, "batch25": 20, "discard": 50, "order": 50, "agents_l10n": 50, "coverage": 3}
ARMS = os.environ.get("SOAK_ARMS", " ".join(ROUNDS)).split()
OUT = os.path.join(HERE, "results", LABEL)
os.makedirs(OUT, exist_ok=True)


def rounds(arm):
    return max(1, int(round(ROUNDS[arm] * SCALE)))


def run_arm(arm, n):
    if arm in ("normal", "ava", "solo", "nested", "dzset", "locale", "locale_ava", "delete", "publish"):
        return L.two_writers(arm, n, tag="ls")
    if arm == "heavy":
        return L.two_writers("normal", n, heavy=30, tag="ls")
    if arm == "batch":
        return L.batch_vs_batch(n, tag="ls")
    if arm == "discard":
        return L.discard_vs_patch(n, tag="ls")
    if arm == "order":
        r = L.order_vs_locale(n, tag="ls")
        return r if r is not None else {"aggregate": {"arm": "order_locale_vs_move", "db": L.DB_LABEL, "rounds": 0, "deadlocks": 0, "skipped": "custom order not available (Strapi < 5.62 or STRAPI_FUTURE_CUSTOM_ORDER unset)"}, "rounds": []}
    if arm == "batch25":
        return L.batch_vs_admin(n, n_docs=25, tag="ls")
    if arm == "bulk":
        return L.bulk_vs_admin(n, n_docs=10, chunk=10, tag="ls")
    if arm == "bulk25":
        return L.bulk_vs_admin(n, n_docs=25, chunk=25, tag="ls")
    if arm == "agents_l10n":
        return L.agents_l10n(n, k=4, tag="ls")
    if arm == "coverage":
        cov = L.coverage(n, tag="ls")
        keys = ("write_ok", "locked", "already_held", "sqlite_passthrough", "actions", "rows", "component_writes_in_locked_trx", "component_writes_outside")
        return {"aggregate": {"arm": "coverage", "db": L.DB_LABEL, "rounds": n, "deadlocks": 0,
                              "writers": {w: {k: sorted({json.dumps(x[k]) for x in v}) for k in keys} for w, v in cov.items()}}, "rounds": cov}
    return None


passed, failed = 0, 0
for arm in ARMS:
    t0 = time.time()
    try:
        r = run_arm(arm, rounds(arm)) if arm in ROUNDS else None
    except Exception:
        import traceback
        print("FAIL %s crashed: %s" % (arm, traceback.format_exc()[-1500:]), flush=True)
        failed += 1
        continue
    if r is None:
        print("FAIL unknown arm %s" % arm)
        failed += 1
        continue
    agg = r["aggregate"]
    agg.update({"label": LABEL, "strapi": os.environ.get("STRAPI_VERSION_LABEL"), "seconds": round(time.time() - t0)})
    stats = L.lock_stats()
    if stats:
        agg["lock_installed"] = stats["state"]["installed"]
        agg["lock_wait_ms_max"] = stats["middleware"]["waitMsMax"]
        waits = [x["waitMs"] for x in stats["middleware"]["recent"] if not x.get("held")]
        if waits:  # the lock statement's time in the middleware, last 100 Document Service writes of this arm
            agg["lock_stmt_ms_p50"], agg["lock_stmt_ms_p95"] = L.pct(waits, 0.5), L.pct(waits, 0.95)
    json.dump(r, open(os.path.join(OUT, "%s_%s.json" % (arm, L.DB_LABEL)), "w"), indent=1, default=str)
    # not_found is the right answer when the admin's delete won (arm delete); anywhere else it is a false one
    bad = ("http_500",) if arm == "delete" else ("not_found", "http_500")
    ok = agg.get("deadlocks", 0) == 0 and agg.get("admin_500", 0) == 0 and not [c for c in agg.get("agent_error_codes", []) if c in bad] \
        and agg.get("empty_locks", 0) == 0
    passed, failed = passed + ok, failed + (not ok)
    print(("PASS " if ok else "FAIL ") + json.dumps({k: v for k, v in agg.items() if k not in ("admin_error_messages", "writers")}, default=str), flush=True)
print("%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
