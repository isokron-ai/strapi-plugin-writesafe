'use strict';

// The rebase of a stale admin form (bench X4; server/rebase.js): unit tests and a property test.
// Property (2,000 random trials, seeded): from one base, an agent and an editor each make random edits (top-level
// scalars, fields of repeatable component rows and dynamic-zone rows, rows added and removed). Then:
//   - disjoint edits both apply: every leaf ends as the editor's value if she changed it, else the agent's;
//   - overlapping edits (the same leaf to different values, both changing one list's rows, edit against delete) are
//     conflicts, and nothing else is;
//   - nothing is dropped silently: with no conflict, every change of either side is in the result.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../server/rebase');

const MODEL = {
  'api::page.page': { attributes: {
    title: { type: 'string' }, note: { type: 'string' }, qty: { type: 'integer' },
    items: { type: 'component', repeatable: true, component: 'c.item' },
    sections: { type: 'dynamiczone', components: ['c.a', 'c.b'] },
    seo: { type: 'component', repeatable: false, component: 'c.seo' },
    cover: { type: 'media', multiple: false },
    reviewer: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
  } },
  'c.item': { attributes: { label: { type: 'string' }, qty: { type: 'integer' } } },
  'c.a': { attributes: { h: { type: 'string' } } },
  'c.b': { attributes: { t: { type: 'string' } } },
  'c.seo': { attributes: { metaTitle: { type: 'string' } } },
};
const attrsOf = (u) => (MODEL[u] || {}).attributes;
const UID = 'api::page.page';
const clone = (x) => JSON.parse(JSON.stringify(x));
const apply = (current, data) => ({ ...current, ...data }); // what the Document Service ends with (missing keys unchanged)

function base() {
  return {
    title: 'Team lunch', note: 'n', qty: 1, cover: { id: 7 }, reviewer: { documentId: 'r1' },
    items: [{ id: 1, label: 'Coffee', qty: 4 }, { id: 2, label: 'Tea', qty: 2 }, { id: 3, label: 'Cake', qty: 1 }],
    sections: [{ id: 1, __component: 'c.a', h: 'hero' }, { id: 1, __component: 'c.b', t: 'text' }],
    seo: { id: 5, metaTitle: 'meta' },
  };
}
/** The form the Content Manager sends for a draft (relations as connect/disconnect, nothing changed). */
const asForm = (d) => ({ ...clone(d), reviewer: { connect: [], disconnect: [] } });

test('X4: the editor changed the title, the agent changed Coffee: both kept, Coffee reported', () => {
  const b = base();
  const cur = clone(b); cur.items[0].qty = 12;
  const mine = asForm(b); mine.title = 'Team lunch (Friday)';
  const entries = R.journalOf(attrsOf, UID, b, cur, ['items']);
  assert.deepStrictEqual(entries.map((e) => e.path), ['items[1].qty']);
  const r = R.rebase(attrsOf, UID, { mine, current: cur, entries });
  assert.deepStrictEqual(r.conflicts, []);
  const out = apply(cur, r.data);
  assert.strictEqual(out.title, 'Team lunch (Friday)');
  assert.strictEqual(out.items[0].qty, 12);
  assert.deepStrictEqual(r.kept.map((k) => [k.label, k.from, k.to]), [['items row 1 qty', 4, 12]], 'rows are named by position, never by a value (R2-S1)');
});

test('same leaf, different values: a conflict naming both values; same value: none', () => {
  const b = base();
  const cur = clone(b); cur.items[0].qty = 12;
  const entries = R.journalOf(attrsOf, UID, b, cur, ['items']);
  const mine = asForm(b); mine.items[0].qty = 6;
  const r = R.rebase(attrsOf, UID, { mine, current: cur, entries });
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.conflicts[0].mine, 6);
  assert.strictEqual(r.conflicts[0].agent, 12);
  mine.items[0].qty = 12;
  assert.deepStrictEqual(R.rebase(attrsOf, UID, { mine, current: cur, entries }).conflicts, []);
});

test('media and relations: an untouched relation (empty connect/disconnect) never conflicts', () => {
  const b = base();
  const cur = clone(b); cur.reviewer = { documentId: 'r2' }; cur.cover = { id: 9 };
  const entries = R.journalOf(attrsOf, UID, b, cur, ['reviewer', 'cover']);
  const mine = asForm(b); mine.cover = { id: 7, url: '/x.png' };
  const r = R.rebase(attrsOf, UID, { mine, current: cur, entries });
  assert.deepStrictEqual(r.conflicts, []);
  assert.ok(!('cover' in r.data), 'the agent\'s cover stays (key dropped)');
  mine.reviewer = { connect: [{ documentId: 'r3' }], disconnect: [] };
  assert.strictEqual(R.rebase(attrsOf, UID, { mine, current: cur, entries }).conflicts.length, 1);
});

test('single component: field edits on both sides merge by id', () => {
  const b = base();
  const cur = clone(b); cur.seo.metaTitle = 'agent meta';
  const entries = R.journalOf(attrsOf, UID, b, cur, ['seo']);
  const mine = asForm(b); mine.title = 'x';
  const r = R.rebase(attrsOf, UID, { mine, current: cur, entries });
  assert.deepStrictEqual(r.conflicts, []);
  assert.strictEqual(apply(cur, r.data).seo.metaTitle, 'agent meta');
});

// ---------------------------------------------------------------- property test
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const LISTS = { items: { comp: () => 'c.item', field: (r) => (r() < 0.5 ? 'label' : 'qty'), rid: (row) => String(row.id) },
  sections: { comp: (row) => row.__component, field: (r, row) => (row.__component === 'c.a' ? 'h' : 't'), rid: (row) => `${row.__component}#${row.id}` } };
const SCALARS = ['title', 'note', 'qty'];

/** Random edits of one side. Returns { doc, leaves: Map(leaf -> value), struct: Set(list), removed: Set(list|rid) }. */
function edit(r, b, side, nextId) {
  const d = clone(b);
  const leaves = new Map();
  const struct = new Set();
  const removed = new Set();
  for (const f of SCALARS) {
    if (r() < 0.3) { const v = f === 'qty' ? Math.floor(r() * 3) : `${side}-${f}-${Math.floor(r() * 2)}`; if (v !== d[f]) { d[f] = v; leaves.set(f, v); } }
  }
  for (const [lf, L] of Object.entries(LISTS)) {
    for (const row of d[lf]) {
      if (r() < 0.3) { const k = L.field(r, row); const v = k === 'qty' ? Math.floor(r() * 3) : `${side}-${Math.floor(r() * 2)}`; if (v !== row[k]) { row[k] = v; leaves.set(`${lf}[${L.rid(row)}].${k}`, v); } }
    }
    if (r() < 0.15) {
      const i = Math.floor(r() * d[lf].length);
      const [gone] = d[lf].splice(i, 1);
      struct.add(lf); removed.add(`${lf}|${L.rid(gone)}`);
      for (const k of [...leaves.keys()]) if (k.startsWith(`${lf}[${L.rid(gone)}]`)) leaves.delete(k);
    }
    if (r() < 0.15) {
      const row = lf === 'items' ? { label: `${side}-new`, qty: 0 } : { __component: 'c.a', h: `${side}-new` };
      if (side === 'agent') row.id = nextId(); // the agent's rows exist (ids); the editor's new rows have none yet
      d[lf].push(row);
      struct.add(lf);
    }
  }
  return { doc: d, leaves, struct, removed };
}

test('property: disjoint edits both apply, overlapping edits conflict, nothing dropped silently', () => {
  const r = rng(20261115);
  let merged = 0; let conflicted = 0;
  for (let trial = 0; trial < 2000; trial += 1) {
    const b = base();
    let id = 100;
    const agent = edit(r, b, 'agent', () => (id += 1));
    const editor = edit(r, b, 'editor', () => null);
    const cur = agent.doc;
    const entries = R.journalOf(attrsOf, UID, b, cur, Object.keys(MODEL[UID].attributes));
    const res = R.rebase(attrsOf, UID, { mine: asForm(editor.doc), current: cur, entries });
    // expected conflicts
    const want = new Set();
    for (const [leaf, v] of editor.leaves) if (agent.leaves.has(leaf) && agent.leaves.get(leaf) !== v) want.add(leaf);
    for (const lf of Object.keys(LISTS)) {
      if (agent.struct.has(lf) && editor.struct.has(lf)) want.add(lf);
      for (const side of [agent, editor]) {
        const other = side === agent ? editor : agent;
        for (const g of side.removed) {
          const [l, rid] = g.split('|');
          if ([...other.leaves.keys()].some((k) => k.startsWith(`${l}[${rid}]`))) want.add(`${l}[${rid}]`);
        }
      }
    }
    const listsBoth = new Set(Object.keys(LISTS).filter((lf) => agent.struct.has(lf) && editor.struct.has(lf)));
    const got = new Set(res.conflicts.map((c) => c.path));
    // a conflict is reported for every overlap (inside a list both changed, the list itself is the conflict)
    for (const w of want) {
      const lf = w.split('[')[0];
      assert.ok(got.has(w) || (listsBoth.has(lf) && got.has(lf)), `trial ${trial}: missing conflict ${w}; got ${[...got]}`);
    }
    // and no conflict without an overlap
    for (const g of got) assert.ok(want.has(g), `trial ${trial}: unexpected conflict ${g}; want ${[...want]}`);
    if (got.size) { conflicted += 1; continue; }
    merged += 1;
    const out = apply(cur, res.data);
    for (const f of SCALARS) {
      const exp = editor.leaves.has(f) ? editor.leaves.get(f) : agent.leaves.has(f) ? agent.leaves.get(f) : b[f];
      assert.deepStrictEqual(out[f], exp, `trial ${trial}: ${f}`);
    }
    for (const [lf, L] of Object.entries(LISTS)) {
      const byRid = new Map(out[lf].filter((x) => x.id != null).map((x) => [L.rid(x), x]));
      for (const [leaf, v] of [...agent.leaves, ...editor.leaves]) {
        if (!leaf.startsWith(`${lf}[`)) continue;
        const m = /^[a-z]+\[([^\]]+)\]\.(\w+)$/.exec(leaf);
        const rowGone = agent.removed.has(`${lf}|${m[1]}`) || editor.removed.has(`${lf}|${m[1]}`);
        if (rowGone) continue;
        const exp = editor.leaves.has(leaf) ? editor.leaves.get(leaf) : v;
        assert.ok(byRid.has(m[1]), `trial ${trial}: row ${lf}[${m[1]}] dropped`);
        assert.deepStrictEqual(byRid.get(m[1])[m[2]], exp, `trial ${trial}: ${leaf}`);
      }
      for (const g of [...agent.removed, ...editor.removed]) if (g.startsWith(`${lf}|`)) assert.ok(!byRid.has(g.split('|')[1]), `trial ${trial}: removed row ${g} came back`);
      const adds = (s) => s.doc[lf].filter((x) => String(x[lf === 'items' ? 'label' : 'h']).endsWith('-new')).length;
      assert.strictEqual(out[lf].filter((x) => String(x[lf === 'items' ? 'label' : 'h']).endsWith('-new')).length, adds(agent) + adds(editor), `trial ${trial}: added rows of ${lf}`);
    }
  }
  assert.ok(merged > 500 && conflicted > 200, `coverage: ${merged} merged, ${conflicted} conflicted`);
});

// ---------------------------------------------------------------- property test 2 (review S7)
// Nested components (items[].tags[]), media and a relation inside rows, a wide decimal, and one to three agent writes
// journaled one after the other. The oracle mirrors the promised rule per leaf: the editor's change wins unless the
// agent touched the same leaf in any of its writes and both end on different values (a conflict); a row one side
// removed and the other edited in any way (nested rows, media, relation included) is a conflict; never a silent drop.
const MODEL2 = {
  'api::p.p': { attributes: {
    title: { type: 'string' }, price: { type: 'decimal' }, qty: { type: 'integer' }, cover: { type: 'media', multiple: false },
    items: { type: 'component', repeatable: true, component: 'c.it' },
  } },
  'c.it': { attributes: {
    label: { type: 'string' }, qty: { type: 'integer' }, photo: { type: 'media', multiple: false },
    supplier: { type: 'relation', relation: 'manyToOne', target: 'api::s.s' },
    tags: { type: 'component', repeatable: true, component: 'c.tag' },
  } },
  'c.tag': { attributes: { name: { type: 'string' } } },
};
const attrs2 = (u) => (MODEL2[u] || {}).attributes;
const U2 = 'api::p.p';
const BIG = ['12345678901234567.10', '12345678901234567.12', '12345678901234567.14', '99.5'];
function base2() {
  return {
    title: 't0', price: BIG[0], qty: 1, cover: { id: 1 },
    items: [1, 2, 3].map((i) => ({ id: i, label: `L${i}`, qty: i, photo: { id: 10 + i }, supplier: { documentId: `s${i}` }, tags: [{ id: 10 * i + 1, name: `n${i}a` }, { id: 10 * i + 2, name: `n${i}b` }] })),
  };
}
const leafKeys = (d) => {
  const out = new Map();
  out.set('title', d.title); out.set('price', d.price); out.set('qty', d.qty); out.set('cover', d.cover ? d.cover.id : null);
  for (const it of d.items) {
    out.set(`items[${it.id}].label`, it.label); out.set(`items[${it.id}].qty`, it.qty); out.set(`items[${it.id}].photo`, it.photo ? it.photo.id : null);
    for (const t of it.tags) out.set(`items[${it.id}].tags[${t.id}].name`, t.name);
  }
  return out;
};
function agentWrite(r, prev, nextId) {
  const d = clone(prev);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  if (r() < 0.3) d.title = pick(['ta', 'tb', 't0']);
  if (r() < 0.3) d.price = pick(BIG);
  if (r() < 0.2) d.qty = pick([1, 2, 3]);
  if (r() < 0.2) d.cover = { id: pick([1, 2, 3]) };
  for (const it of d.items) {
    if (r() < 0.2) it.label = pick(['La', 'Lb', it.label]);
    if (r() < 0.2) it.qty = pick([1, 2, 3, 7]);
    if (r() < 0.15) it.photo = { id: pick([11, 12, 19]) };
    for (const t of it.tags) if (r() < 0.15) t.name = pick(['x', 'y', t.name]);
    if (r() < 0.08 && it.tags.length) it.tags.splice(Math.floor(r() * it.tags.length), 1);
  }
  if (r() < 0.1 && d.items.length) d.items.splice(Math.floor(r() * d.items.length), 1);
  if (r() < 0.1) d.items.push({ id: nextId(), label: 'agent-new', qty: 0, photo: null, supplier: null, tags: [] });
  return d;
}
function editorForm(r, b) {
  const d = clone(b);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const rel = new Set();
  if (r() < 0.3) d.title = pick(['ea', 'eb', 't0']);
  if (r() < 0.3) d.price = pick(BIG);
  if (r() < 0.2) d.qty = pick([1, 2, 5]);
  if (r() < 0.2) d.cover = { id: pick([1, 4]), url: '/x' };
  for (const it of d.items) {
    if (r() < 0.2) it.label = pick(['Le', 'Lb', it.label]);
    if (r() < 0.2) it.qty = pick([1, 2, 9]);
    if (r() < 0.1) it.photo = { id: pick([11, 18]) };
    for (const t of it.tags) if (r() < 0.15) t.name = pick(['x', 'z', t.name]);
    if (r() < 0.1) { it.supplier = { connect: [{ documentId: 's9' }], disconnect: [] }; rel.add(it.id); } else it.supplier = { connect: [], disconnect: [] };
  }
  let struct = false;
  if (r() < 0.1 && d.items.length) { d.items.splice(Math.floor(r() * d.items.length), 1); struct = true; }
  if (r() < 0.1) { d.items.push({ label: 'editor-new', qty: 0, photo: null, supplier: { connect: [], disconnect: [] }, tags: [] }); struct = true; }
  return { d, rel, struct };
}

test('property 2: nested rows, media, relations in rows, wide decimals, several agent writes', () => {
  const r = rng(51115);
  let merged = 0; let conflicted = 0;
  for (let trial = 0; trial < 3000; trial += 1) {
    const b = base2();
    let id = 100;
    const writes = 1 + Math.floor(r() * 3);
    const states = [b];
    for (let w = 0; w < writes; w += 1) states.push(agentWrite(r, states[states.length - 1], () => (id += 1)));
    const cur = states[states.length - 1];
    const entries = [];
    for (let w = 1; w < states.length; w += 1) entries.push(...R.journalOf(attrs2, U2, states[w - 1], states[w], Object.keys(MODEL2[U2].attributes)));
    const ed = editorForm(r, b);
    const res = R.rebase(attrs2, U2, { mine: ed.d, current: cur, entries });
    const touched = new Set(entries.filter((e) => e.kind === 'field').map((e) => e.path));
    const bL = leafKeys(b); const cL = leafKeys(cur); const mL = leafKeys({ ...ed.d, items: ed.d.items.filter((x) => x.id != null) });
    const curIds = cur.items.map((x) => x.id);
    const agentStruct = JSON.stringify(curIds) !== JSON.stringify(b.items.map((x) => x.id));
    const want = new Set();
    if (agentStruct && ed.struct) want.add('items');
    const rowEdited = (rid) => [...mL.keys()].some((k) => k.startsWith(`items[${rid}].`) && mL.get(k) !== bL.get(k)) || ed.rel.has(rid);
    for (const it of b.items) {
      const inCur = curIds.includes(it.id);
      const inMine = ed.d.items.some((x) => x.id === it.id);
      if (want.has('items')) break;
      if (!inCur && inMine && rowEdited(it.id)) want.add(`items[${it.id}]`);
      if (inCur && !inMine && entries.some((e) => e.path.startsWith(`items[${it.id}].`))) want.add(`items[${it.id}]`);
      if (!inCur || !inMine) continue;
      const bt = it.tags.map((t) => t.id); const ct = cur.items.find((x) => x.id === it.id).tags.map((t) => t.id);
      for (const t of bt) if (!ct.includes(t) && mL.get(`items[${it.id}].tags[${t}].name`) !== bL.get(`items[${it.id}].tags[${t}].name`)) want.add(`items[${it.id}].tags[${t}]`);
    }
    for (const [k, mv] of mL) {
      if (!touched.has(k) || !cL.has(k)) continue;
      if (want.has('items') && k.startsWith('items')) continue;
      const pv = k === 'price' ? R.decimalString(mv) : mv;
      const bv = k === 'price' ? R.decimalString(bL.get(k)) : bL.get(k);
      const cv = k === 'price' ? R.decimalString(cL.get(k)) : cL.get(k);
      if (pv !== bv && pv !== cv) want.add(k);
    }
    const got = new Set(res.conflicts.map((c) => c.path));
    assert.deepStrictEqual([...got].sort(), [...want].sort(), `trial ${trial}: conflicts`);
    if (got.size) { conflicted += 1; continue; }
    merged += 1;
    const out = apply(cur, res.data);
    const oL = leafKeys({ ...out, items: out.items.map((x) => ({ tags: [], ...x, photo: x.photo == null ? null : typeof x.photo === 'object' ? x.photo : { id: x.photo }, tags: x.tags || [] })) });
    for (const [k, cv] of cL) {
      if (!oL.has(k)) { assert.ok(!mL.has(k) || mL.get(k) === bL.get(k), `trial ${trial}: ${k} dropped`); continue; }
      const edited = mL.has(k) && bL.has(k) && mL.get(k) !== bL.get(k);
      const exp = edited ? mL.get(k) : cv;
      const norm = (v) => (k === 'price' ? R.decimalString(v) : v);
      assert.deepStrictEqual(norm(oL.get(k)), norm(exp), `trial ${trial}: ${k}`);
    }
    for (const rid of ed.rel) {
      const row = out.items.find((x) => x.id === rid);
      if (row) assert.deepStrictEqual(row.supplier, { connect: [{ documentId: 's9' }], disconnect: [] }, `trial ${trial}: relation edit of row ${rid}`);
    }
  }
  assert.ok(merged > 800 && conflicted > 300, `coverage: ${merged} merged, ${conflicted} conflicted`);
});

test('S5: private and password fields are journaled as keyed hashes, never values; a conflict on one shows no value', () => {
  const M3 = { 'api::q.q': { attributes: { title: { type: 'string' }, secret: { type: 'string', private: true }, pw: { type: 'password' } } } };
  const a3 = (u) => (M3[u] || {}).attributes;
  const h = (s) => `H(${s.length})${require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 8)}`;
  const b = { title: 't', secret: 'old secret', pw: 'old pw' };
  const cur = { ...b, secret: 'agent secret' };
  const entries = R.journalOf(a3, 'api::q.q', b, cur, ['secret', 'pw'], h);
  assert.strictEqual(entries.length, 1);
  assert.ok(!JSON.stringify(entries).includes('secret"') || !JSON.stringify(entries).includes('agent secret'));
  assert.ok(!JSON.stringify(entries).includes('agent secret') && !JSON.stringify(entries).includes('old secret'));
  assert.deepStrictEqual(R.journalOf(a3, 'api::q.q', b, cur, ['secret'], undefined), [], 'no hash function: not journaled');
  let r = R.rebase(a3, 'api::q.q', { mine: { ...b, title: 'mine' }, current: cur, entries, hash: h });
  assert.deepStrictEqual(r.conflicts, []);
  assert.ok(!('secret' in r.data) || r.data.secret === 'agent secret');
  assert.strictEqual(r.kept[0].from, R.HIDDEN);
  r = R.rebase(a3, 'api::q.q', { mine: { ...b, secret: 'editor secret' }, current: cur, entries, hash: h });
  assert.strictEqual(r.conflicts.length, 1);
  assert.ok(!JSON.stringify(r.conflicts).includes('secret '), 'no value of a secret field in the conflict');
});

test('S6: decimals compare as exact strings', () => {
  assert.strictEqual(R.decimalString('12.10'), '12.1');
  assert.strictEqual(R.decimalString('-0.00'), '0');
  assert.strictEqual(R.decimalString('007.50'), '7.5');
  assert.strictEqual(R.decimalString(12.5), '12.5');
  assert.notStrictEqual(R.decimalString('12345678901234567.10'), R.decimalString('12345678901234567.12'));
  assert.ok(R.eq({ type: 'decimal' }, '1.50', 1.5));
});

test('S5 (review), R2-S1: row labels never carry a value (secret, unreadable or plain), in the journal, the merge note or a conflict', () => {
  const MODEL = {
    'api::p.p': { attributes: { items: { type: 'component', repeatable: true, component: 'c.i' } } },
    'c.i': { attributes: { code: { type: 'string', private: true }, pin: { type: 'password' }, hidden: { type: 'string' }, name: { type: 'string' }, qty: { type: 'integer' } } },
  };
  const attrsOf = (u) => (MODEL[u] || {}).attributes;
  const hash = (s) => `h${s.length}`;
  const base = { items: [{ id: 7, code: 'SECRET-0', pin: 'PIN-0', hidden: 'HIDDEN-0', name: 'Tea', qty: 1 }, { id: 1, code: 'SECRET-1', pin: 'PIN-1', hidden: 'HIDDEN-1', name: 'Coffee', qty: 4 }] };
  const cur = { items: [base.items[0], { ...base.items[1], qty: 12 }] };
  const entries = R.journalOf(attrsOf, 'api::p.p', base, cur, ['items'], hash).map((e) => ({ ...e, rev: 1, locale: '' }));
  const VALUES = /SECRET|PIN-|HIDDEN|Coffee|Tea/;
  assert.ok(!VALUES.test(JSON.stringify(entries)), JSON.stringify(entries));
  const merged = R.rebase(attrsOf, 'api::p.p', { mine: { items: [base.items[0], { ...base.items[1] }] }, current: cur, entries, hash });
  assert.deepStrictEqual(merged.kept.map((k) => k.label), ['items row 2 qty'], 'named by the row\'s position in the form');
  const conflict = R.rebase(attrsOf, 'api::p.p', { mine: { items: [base.items[0], { ...base.items[1], qty: 6 }] }, current: cur, entries, hash });
  assert.strictEqual(conflict.conflicts.length, 1);
  assert.ok(!VALUES.test(conflict.conflicts[0].label), conflict.conflicts[0].label);
  const removed = R.rebase(attrsOf, 'api::p.p', { mine: { items: [base.items[0]] }, current: cur, entries, hash });
  assert.ok(removed.conflicts.length === 1 && !VALUES.test(removed.conflicts[0].label), JSON.stringify(removed.conflicts));
});
