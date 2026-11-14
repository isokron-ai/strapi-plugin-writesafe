"""Shared fixtures for the spike tests: page creation, reads, SQLite inspection (read-only)."""
import json, os, sqlite3, sys
sys.path.insert(0, os.path.dirname(__file__))
import spike

DB = os.environ.get("SPIKE_SQLITE_DB") or os.path.join(spike.ROOT, "app", ".tmp", "data.db")
CMP_TABLE = {"shared.item": "components_shared_items", "shared.seo": "components_shared_seos",
             "blocks.text": "components_blocks_texts", "blocks.hero": "components_blocks_heroes",
             "blocks.cta": "components_blocks_ctas"}


PG = os.environ.get("SPIKE_PG")  # "host:port:db:user" ; password from .secrets/pg.json


class _PgConn:
    """Minimal read-only adapter so the sqlite-style helpers also work against Postgres (via psql in the container)."""
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, sql, params=()):
        import subprocess
        q = sql.replace('"order"', '"order"')
        for p in params:
            q = q.replace("?", ("'%s'" % str(p).replace("'", "''")) if isinstance(p, str) else str(p), 1)
        out = subprocess.run(["docker", "exec", os.environ.get("SPIKE_PG_CONTAINER", "isokron-strapi-spike-2026-11-pg"), "psql", "-U",
                              os.environ.get("SPIKE_PG_USER", "postgres"), "-d", os.environ.get("SPIKE_DB_NAME", "strapi"), "-At", "-F", "\t", "-c", q],
                             capture_output=True, text=True, check=True).stdout
        rows = [tuple(int(x) if x.lstrip("-").isdigit() else x for x in l.split("\t")) for l in out.splitlines() if l]
        class R:
            def fetchall(self_): return rows
            def fetchone(self_): return rows[0] if rows else None
        return R()


MYSQL = os.environ.get("SPIKE_MYSQL")  # set to 1 for the MySQL instance; password from .secrets/mysql.json


class _MyConn(_PgConn):
    """Same read-only adapter for MySQL 8 (mysql client in the container, ANSI quotes so "order" works)."""
    def execute(self, sql, params=()):
        import subprocess
        q = sql
        for p in params:
            q = q.replace("?", ("'%s'" % str(p).replace("'", "''")) if isinstance(p, str) else str(p), 1)
        pw = json.load(open(os.environ.get("SPIKE_MYSQL_SECRET") or os.path.join(spike.ROOT, ".secrets", "mysql.json")))["password"]
        # The password goes through the environment (`-e MYSQL_PWD` copies it from this process), never the command
        # line: a CalledProcessError prints its argv in a traceback.
        out = subprocess.run(["docker", "exec", "-i", "-e", "MYSQL_PWD", os.environ.get("SPIKE_MYSQL_CONTAINER", "isokron-strapi-spike-2026-11-mysql"),
                              "mysql", "-u" + os.environ.get("SPIKE_MYSQL_USER", "root"), "-N", "-B", os.environ.get("SPIKE_DB_NAME", "strapi"),
                              "-e", "SET SESSION sql_mode='ANSI_QUOTES'; " + q], env=dict(os.environ, MYSQL_PWD=pw), capture_output=True, text=True, check=True).stdout
        rows = [tuple(int(x) if x.lstrip("-").isdigit() else x for x in l.split("\t")) for l in out.splitlines() if l]
        class R:
            def fetchall(self_): return rows
            def fetchone(self_): return rows[0] if rows else None
        return R()


def db():
    if MYSQL:
        return _MyConn()
    if PG:
        return _PgConn()
    return sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=30)


def para(text):
    return {"type": "paragraph", "children": [{"type": "text", "text": text}]}


def page_data(title, n_items=3, n_sections=3, n_paras=2):
    kinds = ["blocks.text", "blocks.hero", "blocks.cta"]
    secs = []
    for i in range(n_sections):
        k = kinds[i % 3]
        secs.append({"__component": k, **({"body": "text %d" % i} if k == "blocks.text" else
                                          {"heading": "hero %d" % i} if k == "blocks.hero" else
                                          {"label": "cta %d" % i, "url": "https://example.test/%d" % i})})
    return {"title": title, "summary": "s", "note": "n0",
            "seo": {"metaTitle": "meta"},
            "items": [{"label": "item %d" % i, "qty": i + 1} for i in range(n_items)],
            "sections": secs,
            "body": [para("para %d" % i) for i in range(n_paras)]}


def create_page_mcp(title, who=spike.A, **kw):
    err, r, _, _ = spike.tool(who, "create_page", {"data": page_data(title, **kw)})
    if err:
        raise RuntimeError(r)
    return r["data"]["documentId"]


def mcp_get(who, doc):
    err, r, _, _ = spike.tool(who, "get_page", {"documentId": doc})
    if err:
        raise RuntimeError(r)
    return r["data"]


def rest_get(who, doc):
    s, b, _ = spike.rest(who, "GET", "/api/pages/%s?populate=*&status=draft" % doc)
    if s != 200:
        raise RuntimeError((s, b))
    return b["data"]


def rest_put(who, doc, data):
    s, b, raw = spike.rest(who, "PUT", "/api/pages/%s?status=draft" % doc, {"data": data})
    return s, b, len(raw)


def strip_ids(lst):
    # 1.0: also drops null values; the built-in update_<type> refuses its own get_<type> output's `meta: null`
    # (an empty nested component) with "expected object, received null".
    return [{k: v for k, v in x.items() if k != "id" and v is not None} for x in lst]


def draft_row(doc):
    with db() as c:
        return c.execute("select id, updated_at from pages where document_id=? and published_at is null", (doc,)).fetchone()


def cmp_rows(doc, field):
    """(component_type, cmp_id, order) rows linked to the draft row of doc for field."""
    row = draft_row(doc)
    with db() as c:
        return c.execute('select component_type, cmp_id, "order" from pages_cmps where entity_id=? and field=? order by "order"',
                         (row[0], field)).fetchall()


def table_count(table):
    with db() as c:
        return c.execute("select count(*) from %s" % table).fetchone()[0]


def orphan_count():
    """Component rows not linked from any pages_cmps row (left behind by deletes)."""
    out = {}
    with db() as c:
        for uid, t in CMP_TABLE.items():
            out[t] = c.execute("select count(*) from %s where id not in (select cmp_id from pages_cmps where component_type=?)" % t,
                               (uid,)).fetchone()[0]
    return out


def vv(a):
    """1.0 hardening item 16c: `set` and `unset` need expected_version. Calls whose test is about something else get the
    current version filled in (read with agent A: a version is the same for every token), unless they name a version
    or force. A document that cannot be read is left alone (the call then reports its own error)."""
    if not isinstance(a, dict) or not ("set" in a or "unset" in a) or "expected_version" in a or a.get("force") or not a.get("uid"):
        return a
    q = {k: a[k] for k in ("uid", "documentId", "locale") if k in a and a[k] is not None}
    e, r, _, _ = spike.tool(spike.A, "ws_get", q)
    return {**a, "expected_version": r["version"]} if not e and isinstance(r, dict) and r.get("version") else a


def vb(a):
    """vv for the patch items of a ws_batch (items as a list or as a JSON string): the first item per document gets its
    version; later items of the same document need none (the engine chains the version the earlier item left)."""
    items = a.get("items")
    raw = isinstance(items, str)
    lst = json.loads(items) if raw else items
    if not isinstance(lst, list):
        return a
    seen, out = set(), []
    for x in lst:
        if isinstance(x, dict) and x.get("action", "patch") == "patch":
            t = (x.get("uid"), x.get("documentId"), x.get("locale"))
            x = x if t in seen else vv(x)
            seen.add(t)
        out.append(x)
    return {**a, "items": json.dumps(out) if raw else out}


def ident(keys):
    """Row identities ("<component>:<id>") of row keys: keys carry a content MAC since 1.0 hardening item 16b, so a
    test that checks "same rows (ids)" compares identities; blocks keys are returned as they are."""
    one = lambda k: k if not isinstance(k, str) or k.startswith("#") else ":".join(k.split(":")[:2])
    return one(keys) if isinstance(keys, str) else [one(k) for k in keys]
