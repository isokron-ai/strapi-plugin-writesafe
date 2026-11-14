"""Pre-push secret scan: fails if any tracked/staged file contains a value from .secrets/ or a token-shaped string.
Prints only file names and pattern names, never the matched value."""
import json, os, re, subprocess, sys
root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
vals = []
sd = os.path.join(root, ".secrets")
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k != "email": walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
    elif isinstance(o, str) and len(o) >= 12:
        vals.append(o)
for f in os.listdir(sd) if os.path.isdir(sd) else []:
    try: walk(json.load(open(os.path.join(sd, f))))
    except Exception: pass
envf = os.path.join(root, "app", ".env")
if os.path.exists(envf):  # values only, never printed
    for line in open(envf):
        if "=" in line and re.search(r"(SECRET|SALT|KEY|TOKEN|PASSWORD)", line.split("=", 1)[0]):
            v = line.split("=", 1)[1].strip().strip('"')
            for part in v.split(","):
                if len(part) >= 12 and part not in ("tobemodified",): vals.append(part)
files = subprocess.run(["git", "ls-files", "-c", "-o", "--exclude-standard"], cwd=root, capture_output=True, text=True).stdout.split()
pats = {"hex64+": re.compile(r"\b[0-9a-f]{64,}\b"), "bearer": re.compile(r"Bearer [A-Za-z0-9._-]{20,}"),
        "anthropic": re.compile(r"sk-ant-[A-Za-z0-9_-]{10,}"), "gh": re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}")}
allow_hex = re.compile(r"(sha|integrity|commit|nonce|installId|lockfile)", re.I)
bad = 0
for f in files:
    p = os.path.join(root, f)
    if not os.path.isfile(p) or os.path.getsize(p) > 20_000_000: continue
    try: t = open(p, encoding="utf-8", errors="ignore").read()
    except Exception: continue
    for v in vals:
        if v in t:
            print("SECRET VALUE in", f); bad += 1; break
    for n, rx in pats.items():
        if f.endswith("package-lock.json") and n == "hex64+": continue
        for m in rx.finditer(t):
            ctx = t[max(0, m.start()-80):m.start()]
            if n == "hex64+" and allow_hex.search(ctx): continue
            print("pattern", n, "in", f); bad += 1; break
print("scanned", len(files), "files;", "FAIL" if bad else "clean")
sys.exit(1 if bad else 0)
