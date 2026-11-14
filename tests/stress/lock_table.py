"""Markdown tables from tests/stress/results/<label>/*.json (tests/stress/lock_soak.py).
  python3 tests/stress/lock_table.py [label ...]   (default: every label folder)"""
import glob, json, os, sys
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
labels = sys.argv[1:] or sorted(d for d in os.listdir(R) if os.path.isdir(os.path.join(R, d)))
rows = []
for lb in labels:
    for f in sorted(glob.glob(os.path.join(R, lb, "*.json"))):
        a = json.load(open(f))["aggregate"]
        a["label"] = lb
        rows.append(a)
ORDER = ["normal", "heavy30", "nested", "dzset", "locale", "ava", "locale_ava", "delete", "publish", "solo", "batch", "agents_l10n", "bulk10_c10", "bulk25_c25", "coverage"]
rows.sort(key=lambda a: (ORDER.index(a["arm"]) if a["arm"] in ORDER else 99, a["arm"], a["db"], a["label"]))
two = [a for a in rows if "admin_ms_p50" in a and "bulk_ms_p50" not in a]
if two:
    print("| arm | db | build | rounds | deadlocks | admin 500 / other | agent errors | agent retries (stale) | admin p50 / p95 / max ms | agent p50 / p95 ms |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for a in two:
        print("| %s | %s | %s | %d | %d | %d / %d | %d%s | %d (%d) | %s / %s / %s | %s / %s |" % (
            a["arm"], a["db"], a["label"], a["rounds"], a["deadlocks"], a["admin_500"], a["admin_other_errors"], a["agent_errors"],
            (" (%s)" % ",".join(a["agent_error_codes"])) if a["agent_errors"] else "", a["agent_retries"], a["stale_snapshot_retries"],
            a["admin_ms_p50"], a["admin_ms_p95"], a["admin_ms_max"], a["agent_ms_p50"], a["agent_ms_p95"]))
bulk = [a for a in rows if "bulk_ms_p50" in a]
if bulk:
    print("\n| arm | db | build | rounds | deadlocks | admin 500 / other | bulk not done | chunks per job | admin p50 / p95 / max ms | bulk p50 / p95 ms |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for a in bulk:
        print("| %s | %s | %s | %d | %d | %d / %d | %d | %s | %s / %s / %s | %s / %s |" % (a["arm"], a["db"], a["label"], a["rounds"], a["deadlocks"], a["admin_500"],
              a["admin_other_errors"], a["bulk_not_done"], ",".join(map(str, a.get("bulk_chunks") or [])), a["admin_ms_p50"], a["admin_ms_p95"], a["admin_ms_max"], a["bulk_ms_p50"], a["bulk_ms_p95"]))
other = [a for a in rows if a["arm"] in ("batch", "agents_l10n")]
if other:
    print("\n| arm | db | build | rounds | deadlocks | ok / calls | errors | busy | retries (stale) | p50 / p95 / max ms |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for a in other:
        calls = a.get("calls", a["rounds"] * 2)
        okc = a.get("ok", a.get("both_ok", 0) * 2)
        print("| %s | %s | %s | %d | %d | %d / %d | %s | %s | %s (%s) | %s / %s / %s |" % (a["arm"], a["db"], a["label"], a["rounds"], a["deadlocks"], okc, calls,
              ",".join(a.get("errors") or []) or "–", a.get("busy", "–"), a.get("retries", a.get("agent_retries", 0)), a.get("stale_snapshot_retries", "–"),
              a["ms_p50"], a["ms_p95"], a["ms_max"]))
cov = [a for a in rows if a["arm"] == "coverage"]
for a in cov:
    print("\ncoverage %s %s:" % (a["db"], a["label"]))
    print("| writer | write ok | lock taken | already held | actions | rows locked | component writes in locked trx / outside |")
    print("|---|---|---|---|---|---|---|")
    for w, v in a["writers"].items():
        print("| %s | %s | %s | %s | %s | %s | %s / %s |" % (w, " ".join(v["write_ok"]), " ".join(v["locked"]), " ".join(v["already_held"]), " ".join(v["actions"]),
              " ".join(v["rows"]), " ".join(v["component_writes_in_locked_trx"]), " ".join(v["component_writes_outside"])))
