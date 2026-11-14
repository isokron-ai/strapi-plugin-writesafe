"""Builds the version x database table from CI (or local) results.

    python3 ci/matrix_report.py <results-dir> [out.md]

<results-dir> holds, per cell, `<version>-<db>.status` (one line: rc=<n> <summary>) and optionally
`<version>-<db>.json` (the suite's per-check results). Prints Markdown; also writes it to out.md if given.
"""
import glob, json, os, re, sys

d = sys.argv[1]
dbs = ["sqlite", "postgres", "mysql"]
cells, failing = {}, {}
for f in glob.glob(os.path.join(d, "**", "*.status"), recursive=True):
    m = re.match(r"(.+)-(sqlite|postgres|mysql)\.status$", os.path.basename(f))
    if not m:
        continue
    ver, db = m.groups()
    line = open(f).read().strip()
    rc = re.search(r"rc=(\d+)", line)
    rc = int(rc.group(1)) if rc else -1
    s = re.search(r"(\d+) passed, (\d+) failed", line)
    if rc == 0 and s:
        cells[(ver, db)] = "pass %s/%d" % (s.group(1), int(s.group(1)) + int(s.group(2)))
    elif s:
        cells[(ver, db)] = "FAIL %s/%d" % (s.group(1), int(s.group(1)) + int(s.group(2)))
    else:
        cells[(ver, db)] = {3: "FAIL (start)", 4: "FAIL (setup)", 5: "FAIL (prepare)"}.get(rc, "FAIL (rc=%d)" % rc)
    j = f[:-len(".status")] + ".json"
    if os.path.exists(j):
        try:
            bad = [r["test"] for r in json.load(open(j)) if not r["pass"]]
        except Exception:
            bad = []
        if bad:
            failing[(ver, db)] = bad


def vkey(v):
    return [int(x) if x.isdigit() else x for x in re.split(r"[.-]", v)]


vers = sorted({v for v, _ in cells}, key=vkey)
out = ["| Strapi | " + " | ".join(dbs) + " |", "|---|" + "---|" * len(dbs)]
for v in vers:
    out.append("| %s | %s |" % (v, " | ".join(cells.get((v, db), "not run") for db in dbs)))
if failing:
    out += ["", "Failing checks:"]
    for (v, db), bad in sorted(failing.items(), key=lambda x: (vkey(x[0][0]), x[0][1])):
        out.append("- %s %s: %s" % (v, db, "; ".join(bad[:12]) + (" (+%d more)" % (len(bad) - 12) if len(bad) > 12 else "")))
md = "\n".join(out) + "\n"
print(md)
if len(sys.argv) > 2:
    open(sys.argv[2], "w").write(md)
