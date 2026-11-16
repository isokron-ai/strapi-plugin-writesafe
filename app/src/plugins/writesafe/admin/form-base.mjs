// The stale form guard's admin half (bench task X4; server/compat/stale-form.js).
//
// The Content Manager's Save sends the whole form and nothing that says which version of the entry the form was loaded
// from. The server answers every draft load of the edit view with `X-Writesafe-Version` (the entry's revision, read
// before the entry). This wrapper of window.fetch keeps that version per browser tab (this module's memory) and per
// entry and locale, and sends it back as `X-Writesafe-Base` on Save, publish and discard, so the server can merge the
// form with what agents changed since it was loaded, or refuse with 409 when both changed the same thing.
//
// Which response sets the base (review S4): the version of the entry's draft load whose REQUEST started last, and the
// version a Save answers. A late answer of an earlier request never moves it, so overlapping refetches cannot leave the
// base ahead of the form the edit view shows. (Strapi 5.62's edit view feeds the form from these loads only.)
//
// After a stale-form 409 Strapi refetches the entry and resets the form, so the editor's unsaved values would be gone:
// the wrapper keeps the form she sent and shows a panel with every field she changed (against the form as loaded),
// with copy buttons, until she closes it. It never writes into the admin's form state.
//
// Unsupported Strapi internal: it relies on the admin calling window.fetch with these Content Manager URLs (Strapi
// 5.47 to 5.62). test/form-base.test.js pins the URL shapes and the global fetch to the installed Strapi.
//
// After a merge the server sends `X-Writesafe-Merged` (the agent's changes kept); the editor gets a short note.

const VERSION = 'x-writesafe-version';
const MERGED = 'x-writesafe-merged';
const BASE = 'X-Writesafe-Base';
const CM = /\/content-manager\/(collection-types\/([^/?#]+)\/([^/?#]+)|single-types\/([^/?#]+))(\/actions\/([^/?#]+))?\/?$/;
// "<uid>|<documentId or ''>|<locale>" -> { v, seq } (this tab only): the version and the start order of its request
const versions = new Map();
const loaded = new Map(); // same key -> the form data the last accepted load answered (for the panel)
let seq = 0;

/** { key, action, method } of a Content Manager entry request, or null. Exported for the test. */
export function entryOf(url, method) {
  let u;
  try { u = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost/'); } catch { return null; }
  const m = CM.exec(u.pathname);
  if (!m) return null;
  const uid = decodeURIComponent(m[2] || m[4]);
  const doc = m[3] ? decodeURIComponent(m[3]) : '';
  if (doc === 'actions') return null;
  return { key: `${uid}|${doc}|${u.searchParams.get('locale') || ''}`, action: m[6] || null, method: String(method || 'GET').toUpperCase(), status: u.searchParams.get('status') };
}

const SENDS = (e) => (e.method === 'PUT' && !e.action) || (e.method === 'POST' && ['publish', 'discard', 'unpublish'].includes(e.action));
const LOAD = (e) => e.method === 'GET' && !e.action && e.status !== 'published';

function note(kept) {
  if (typeof document === 'undefined' || !kept || !kept.length) return;
  const text = kept.length === 1
    ? `Kept 1 change made by an agent: ${kept[0].label} ${kept[0].from} → ${kept[0].to}`
    : `Kept ${kept.length} changes made by an agent: ${kept.slice(0, 3).map((k) => `${k.label} ${k.from} → ${k.to}`).join('; ')}${kept.length > 3 ? '; …' : ''}`;
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.setAttribute('data-writesafe-note', '');
  el.textContent = text;
  Object.assign(el.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: 10000, maxWidth: '480px', padding: '12px 16px', borderRadius: '4px',
    background: '#eafbe7', color: '#2f6846', border: '1px solid #c6f0c2', boxShadow: '0 2px 8px rgba(0,0,0,.15)', font: '14px/1.4 sans-serif' });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

const SKIP = new Set(['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy', 'localizations', 'locale', 'status']);
function canonical(v) {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined && k !== '__temp_key__').sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
const isUntouchedRelation = (v) => v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.connect) && !v.connect.length && Array.isArray(v.disconnect) && !v.disconnect.length;
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/** The top-level fields of the sent form that differ from the form as loaded (all of them when it is unknown). */
export function changedFields(sent, before) {
  const out = [];
  for (const [k, v] of Object.entries(sent || {})) {
    if (SKIP.has(k) || isUntouchedRelation(v)) continue;
    if (before && canonical(v) === canonical(before[k])) continue;
    out.push({ field: k, value: v });
  }
  return out;
}

/** The panel after a stale-form 409: the editor's changed values, each with a copy button, until she closes it. */
function panel(message, fields) {
  if (typeof document === 'undefined') return;
  const old = document.querySelector('[data-writesafe-unsaved]');
  if (old) old.remove();
  const box = document.createElement('section');
  box.setAttribute('data-writesafe-unsaved', '');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'Your unsaved edits');
  Object.assign(box.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: 10001, width: '440px', maxHeight: '70vh', overflow: 'auto',
    background: '#fff', color: '#32324d', border: '1px solid #d02b20', borderRadius: '4px', boxShadow: '0 4px 16px rgba(0,0,0,.2)', font: '14px/1.4 sans-serif', padding: '16px' });
  const h = document.createElement('h2');
  h.textContent = 'Your unsaved edits';
  Object.assign(h.style, { margin: '0 0 4px', fontSize: '16px' });
  const p = document.createElement('p');
  p.textContent = `${message ? `${message} ` : ''}The page shows the current version now. Your values are below: copy what you need, then make your edit again.`;
  Object.assign(p.style, { margin: '0 0 12px', fontSize: '13px' });
  box.append(h, p);
  const copy = (label, value) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, { marginLeft: '8px', padding: '2px 8px', fontSize: '12px', cursor: 'pointer' });
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(value); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy below'; }
    });
    return b;
  };
  if (!fields.length) {
    const n = document.createElement('p');
    n.textContent = 'No changed field was found in the form you sent.';
    box.append(n);
  }
  for (const f of fields) {
    const row = document.createElement('div');
    row.setAttribute('data-writesafe-field', f.field);
    Object.assign(row.style, { borderTop: '1px solid #eaeaef', padding: '8px 0' });
    const name = document.createElement('strong');
    name.textContent = f.field;
    const pre = document.createElement('pre');
    pre.textContent = text(f.value);
    Object.assign(pre.style, { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '4px 0 0', fontSize: '12px', background: '#f6f6f9', padding: '6px' });
    row.append(name, copy('Copy', text(f.value)), pre);
    box.append(row);
  }
  const bar = document.createElement('div');
  Object.assign(bar.style, { borderTop: '1px solid #eaeaef', paddingTop: '8px', display: 'flex', justifyContent: 'space-between' });
  bar.append(copy('Copy all', JSON.stringify(Object.fromEntries(fields.map((f) => [f.field, f.value])), null, 2)));
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.setAttribute('data-writesafe-close', '');
  close.addEventListener('click', () => box.remove());
  bar.append(close);
  box.append(bar);
  document.body.appendChild(box);
}

/** Wrap window.fetch once. */
export function install() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || window.fetch.__writesafe) return false;
  const orig = window.fetch.bind(window);
  const wrapped = async (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url;
    const method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
    const e = url ? entryOf(url, method) : null;
    let args = [input, init];
    const mySeq = (seq += 1);
    if (e && SENDS(e) && versions.has(e.key)) {
      const headers = new Headers((init && init.headers) || (input && typeof input === 'object' && input.headers) || undefined);
      headers.set(BASE, versions.get(e.key).v);
      args = [input, { ...(init || {}), headers }];
    }
    const res = await orig(...args);
    if (e) {
      try {
        const v = res.headers.get(VERSION);
        const prev = versions.get(e.key);
        // the request that started last sets the base, a load or a Save's answer alike: a late answer of an earlier
        // request never moves it (review S4). A merged Save's answer never moves it: Strapi resets the form to the values
        // it sent (the agent's fields still old) and shows the merged entry only when its refetch lands, which moves
        // the base then; a second Save or a Publish before that is merged again instead of writing them back (R2-S2)
        const merged = SENDS(e) && Boolean(res.headers.get(MERGED));
        if (v && res.ok && !merged && (SENDS(e) || LOAD(e)) && (!prev || mySeq > prev.seq)) {
          versions.set(e.key, { v, seq: mySeq });
          if (LOAD(e)) res.clone().json().then((b) => { if (versions.get(e.key)?.seq === mySeq) loaded.set(e.key, b && b.data); }).catch(() => {});
          else res.clone().json().then((b) => { if (versions.get(e.key)?.seq === mySeq && b && b.data) loaded.set(e.key, b.data); }).catch(() => {});
        }
        const m = res.headers.get(MERGED);
        if (m && res.ok) note(JSON.parse(decodeURIComponent(m)));
        if (res.status === 409 && SENDS(e)) {
          const sent = init && typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null;
          const before = loaded.get(e.key) || null;
          res.clone().json().then((b) => {
            const err = b && b.error;
            if (!err || !err.details || err.details.code !== 'stale_form') return;
            panel(err.message, changedFields(sent || {}, before));
          }).catch(() => {});
        }
      } catch { /* the wrapper never breaks a request */ }
    }
    return res;
  };
  wrapped.__writesafe = true;
  window.fetch = wrapped;
  return true;
}

export const _versions = versions;
