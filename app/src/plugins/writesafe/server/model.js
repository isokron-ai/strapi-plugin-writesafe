'use strict';

/**
 * Schema helpers: deep populate, row keys, the semantic content hash and the version token.
 *
 * Version token (1.0 hardening item 15): "v2.<mac>", where mac is a full-length HMAC-SHA256 (base64url, 43 characters)
 * over the token version, the content type uid, the documentId, the locale and the SEMANTIC content hash of the draft.
 *   - The semantic hash covers what an editor would call the content: scalars, single components, the type, order and
 *     nesting of every component row and dynamic-zone block, blocks (rich text) trees, relation documentIds and media
 *     references, at every depth. It leaves out component row ids at every depth, timestamps and authors.
 *   - So a write that only makes Strapi recreate component rows (the i18n sync of non-localized fields, a new locale,
 *     an import) keeps the version; a real change of a value, a row's type, the order or the nesting changes it.
 *   - updatedAt is not part of the token and not a matching condition (rc.2 compared it first).
 *   - The uid, documentId and locale are bound, so a version read from one locale (or document, or type) never matches
 *     another one with the same content.
 * Tokens of 1.0.0-rc.2 and the Phase 1 builds ("<updatedAt>~<hash12>") are refused with error.code version_format
 * (requires_reread): see engine.assertVersion and the plugin CHANGELOG for why they are not accepted any more.
 *
 * Why an HMAC and not a plain hash (0.2): the version covers fields the token may not be allowed to read. With a plain
 * sha256, a token could rebuild the draft from what it can read, add a guess for a hidden field and compare hashes
 * (measured: a hidden `note` of "approved" was recovered from the version alone). The key is derived from the app's
 * own secret keys at register time (setVersionKey), so versions stay stable across restarts.
 */
const crypto = require('crypto');

let VERSION_KEY = crypto.randomBytes(32);
/** Key for content hashes and blocks row keys. Call once at register with a secret the app already has. */
function setVersionKey(secret) {
  VERSION_KEY = crypto.createHash('sha256').update(`writesafe-version:${secret}`).digest();
}
const mac = (s) => crypto.createHmac('sha256', VERSION_KEY).update(s).digest('hex');
const mac64 = (s) => crypto.createHmac('sha256', VERSION_KEY).update(s).digest('base64url');

/**
 * Database epoch of component row keys (1.0 hardening item 16b): a random value created once per database in its own
 * table (server/epoch.js), which Strapi's data transfer does not carry: a key read before an import into another
 * database (a migration, a copy to staging) never matches after it. A whole-database dump and restore DOES carry the
 * table, along with the ids and sequences, so keys stay valid there (the content MAC still refuses a changed row).
 * Until the database's epoch is loaded, and whenever it cannot be read, a random per-process epoch is used: keys then
 * fail closed (stale_row_key) instead of matching.
 */
let ROW_EPOCH = crypto.randomBytes(16).toString('base64url');
let EPOCH_FROM_DB = false;
function setRowEpoch(epoch, fromDb = true) {
  if (typeof epoch !== 'string' || !epoch) throw new Error('row key epoch must be a non-empty string');
  ROW_EPOCH = epoch;
  EPOCH_FROM_DB = Boolean(fromDb);
}
const rowEpoch = () => ({ epoch: ROW_EPOCH, fromDb: EPOCH_FROM_DB });

const SKIP_KEYS = new Set(['updatedAt', 'updatedBy', 'createdAt', 'createdBy', 'publishedAt', 'localizations', 'locale', 'documentId', 'id']);

const isLocalizedUid = (strapi, uid) => Boolean(uid && strapi && strapi.contentTypes && strapi.contentTypes[uid]
  && strapi.contentTypes[uid].pluginOptions && strapi.contentTypes[uid].pluginOptions.i18n && strapi.contentTypes[uid].pluginOptions.i18n.localized === true);

/**
 * Why the version cannot cover a content type, or null (phase 2 A review, finding 4). Such types are not offered by the
 * ws_* tools (engine.writableUids) and are named in ws_schema and the instructions (engine.uncoveredUids), rather than
 * hashed with a blind spot:
 *   - a polymorphic (morph) relation INSIDE a component or zone (a top-level one is read and hashed as its target's
 *     type and documentId since re-review N6; inside components it is not read);
 *   - components nested deeper than the read populates (POPULATE_DEPTH): rows below it would not be read either.
 */
const POPULATE_DEPTH = 8;
function unhashable(strapi, uid) {
  const m = strapi.contentTypes[uid];
  if (!m) return 'unknown type';
  const walk = (attrs, depth, seen) => {
    for (const [k, a] of Object.entries(attrs || {})) {
      if (a.type === 'relation' && !a.target && depth > 0) return `it has a polymorphic relation inside a component (${k})`;
      const comps = a.type === 'component' ? [a.component] : a.type === 'dynamiczone' ? a.components || [] : [];
      for (const c of comps) {
        if (depth + 1 > POPULATE_DEPTH) return `its components are nested deeper than ${POPULATE_DEPTH} levels (${c})`;
        if (seen.includes(c)) continue;
        const r = walk((strapi.components[c] || {}).attributes, depth + 1, [...seen, c]);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(m.attributes, 0, []);
}

const attrsOf = (strapi, uid) => {
  const m = strapi.contentTypes[uid] || strapi.components[uid];
  if (!m) throw new Error(`Unknown model ${uid}`);
  return m.attributes;
};

/**
 * The creator fields that permission conditions read (admin::is-creator: createdBy.id; has-same-role-as-creator:
 * createdBy.roles.id), as a Document Service populate (CREATOR_POPULATE) and a Query Engine populate (CREATOR_QUERY).
 * 1.0 hardening item 10a (Phase 0 N-A, N-B): drafts were read without them (createdBy is in SKIP_KEYS), so
 * permissionChecker.cannot.*(entity) and sanitizeOutput(entity) evaluated an is-creator condition against an entity with
 * no creator: an Author-role token got `forbidden` on its own entries, and ws_history showed it none of its receipts on
 * localized types. They are loaded on every read that feeds a permission check; they are never hashed or shown
 * (SKIP_KEYS).
 */
const CREATOR_FIELDS = ['createdBy', 'updatedBy'];
// Only ids (and role codes): a populated admin row must never carry its password hash, tokens or email (re-review B).
const CREATOR_POPULATE = { fields: ['documentId'], populate: { roles: { fields: ['documentId', 'code'] } } };
const CREATOR_QUERY = { select: ['id'], populate: { roles: { select: ['id', 'code'] } } };
const creatorPopulate = (strapi, uid, form = CREATOR_POPULATE) => {
  const attrs = (strapi.contentTypes[uid] || {}).attributes || {};
  return Object.fromEntries(CREATOR_FIELDS.filter((f) => attrs[f] && attrs[f].type === 'relation').map((f) => [f, form]));
};

/**
 * Relations the caller's permission conditions read (phase 1 review, 10a: "whatever the conditions reference", e.g. a
 * custom condition on reviewer.name). The engine installs the hook: it reads the conditions of the token's rules for this
 * type from its CASL ability and returns a populate for the relation paths they name ('document' form for the Document
 * Service, 'query' form for the Query Engine). Without a caller (no tool call running) it returns {}.
 */
let conditionHook = null;
const setConditionPopulate = (fn) => { conditionHook = fn; };
const conditionPopulate = (strapi, uid, form) => {
  try { return conditionHook ? conditionHook(strapi, uid, form) || {} : {}; } catch { return {}; }
};
/**
 * Deep merge of two populate entries of one form: field lists are united, nested populates merged (re-review B: the
 * condition populate for has-same-role-as-creator used to REPLACE the narrow creator populate with one that loaded the
 * creator's whole admin row, password hash included).
 */
function mergePop(a, b) {
  if (!a || typeof a !== 'object') return b;
  if (!b || typeof b !== 'object') return a;
  const out = { ...a };
  for (const k of ['fields', 'select']) if (a[k] || b[k]) out[k] = [...new Set([...(a[k] || []), ...(b[k] || [])])];
  if (a.populate || b.populate) {
    out.populate = { ...(a.populate || {}) };
    for (const [k, v] of Object.entries(b.populate || {})) out.populate[k] = mergePop(out.populate[k], v);
  }
  return out;
}
/** Merge condition populates into a base populate (deep, see mergePop). */
const mergeConditions = (out, cond) => {
  for (const [k, v] of Object.entries(cond)) out[k] = mergePop(out[k], v);
  return out;
};
/** Query Engine populate for reads that feed a permission check: creator fields plus what the conditions name. */
const permQueryPopulate = (strapi, uid) => mergeConditions(creatorPopulate(strapi, uid, CREATOR_QUERY), conditionPopulate(strapi, uid, 'query'));

/**
 * The relation paths a condition object names: {'createdBy.id': 1} -> [['createdBy','id']]; operators ($and, $or, $eq,
 * $elemMatch...) are walked through; nested objects extend the path.
 */
function conditionPaths(cond, prefix = [], out = []) {
  if (Array.isArray(cond)) { for (const c of cond) conditionPaths(c, prefix, out); return out; }
  if (!cond || typeof cond !== 'object' || cond instanceof Date) return out;
  for (const [k, v] of Object.entries(cond)) {
    if (k.startsWith('$')) conditionPaths(v, prefix, out);
    else { const p = [...prefix, ...k.split('.')]; out.push(p); conditionPaths(v, p, out); }
  }
  return out;
}
/**
 * Populate for those paths, in the Document Service form ('document': `fields`) or the Query Engine form ('query':
 * `select`). Every populated relation selects only its id (documentId) plus the scalar fields the conditions name
 * (re-review B): never a whole related row. Paths start at the type's own relations; a scalar of the type itself is
 * always read with the draft.
 */
function populateForPaths(strapi, uid, paths, form = 'document') {
  const key = form === 'query' ? 'select' : 'fields';
  const base = form === 'query' ? ['id'] : ['documentId'];
  const root = { fields: new Set(), children: {} };
  for (const p of paths) {
    let model = strapi.contentTypes[uid];
    let node = root;
    for (const seg of p) {
      const a = model && model.attributes && model.attributes[seg];
      if (a && a.type === 'relation' && a.target) {
        node = node.children[seg] = node.children[seg] || { fields: new Set(), children: {} };
        model = strapi.contentTypes[a.target];
        continue;
      }
      if (node !== root && a && !['relation', 'component', 'dynamiczone', 'media'].includes(a.type)) node.fields.add(seg);
      break; // `id` (always returned) or an unknown name ends the path
    }
  }
  const toPop = (n) => Object.fromEntries(Object.entries(n.children).map(([k, c]) => {
    const nested = toPop(c);
    return [k, { [key]: [...new Set([...base, ...c.fields])], ...(Object.keys(nested).length ? { populate: nested } : {}) }];
  }));
  return toPop(root);
}

/** Deep populate object for Document Service reads: components, dynamic zones, media, relation ids, creator fields. */
function populateFor(strapi, uid, depth = 0) {
  if (depth > 8) return {};
  const out = depth === 0 ? creatorPopulate(strapi, uid) : {};
  for (const [name, a] of Object.entries(attrsOf(strapi, uid))) {
    if (SKIP_KEYS.has(name)) continue;
    if (a.type === 'component') {
      const p = populateFor(strapi, a.component, depth + 1);
      out[name] = Object.keys(p).length ? { populate: p } : true;
    } else if (a.type === 'dynamiczone') {
      const on = {};
      for (const c of a.components) {
        const p = populateFor(strapi, c, depth + 1);
        on[c] = Object.keys(p).length ? { populate: p } : true;
      }
      out[name] = { on };
    } else if (a.type === 'media') {
      out[name] = { fields: ['id'] };
    } else if (a.type === 'relation' && a.target) {
      // the linked locale too when the target is localized: which locale a relation points at is content (phase 2 A
      // review, finding 4), and the version reads it from the raw draft
      out[name] = { fields: isLocalizedUid(strapi, a.target) ? ['documentId', 'locale'] : ['documentId'] };
    } else if (a.type === 'relation' && !a.target && depth === 0) {
      // a top-level polymorphic relation: read whole (its entries carry __type), hashed as (__type, documentId)
      out[name] = true;
    }
  }
  if (depth === 0) mergeConditions(out, conditionPopulate(strapi, uid, 'document'));
  return out;
}

const fieldKind = (attr) => {
  if (!attr) return 'unknown';
  if (attr.type === 'dynamiczone') return 'dynamiczone';
  if (attr.type === 'component') return attr.repeatable ? 'repeatable' : 'component';
  if (attr.type === 'blocks') return 'blocks';
  if (attr.type === 'relation' || attr.type === 'media') return attr.type;
  return 'scalar';
};

const isListKind = (k) => k === 'dynamiczone' || k === 'repeatable' || k === 'blocks';
/**
 * A field whose value is a list that `set` replaces whole: the list kinds above, plus to-many relations and multiple
 * media (1.0 hardening item 3; fourth review N3: replacing them from a stale read dropped a colleague's tag or image).
 */
const isListAttr = (attr) => Boolean(attr) && (isListKind(fieldKind(attr))
  || (attr.type === 'relation' && /ToMany$/.test(attr.relation || '')) || (attr.type === 'media' && attr.multiple === true));

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The semantic form of one attribute value (1.0 hardening item 15): component rows lose their database `id` at every
 * depth; everything else is kept as it is, in order: component and dynamic-zone rows (with `__component`), nested
 * components, blocks trees (a blocks image node's `id` is a file reference and stays), json values, relation
 * documentIds and media references. Works on raw and normalized values alike (relations and media reduced to refs).
 */
function semanticValue(strapi, attr, v, depth = 0) {
  if (v == null || !attr || depth > 10) return v === undefined ? null : v;
  if (attr.type === 'relation') {
    // a relation to a localized type is the target document AND the locale it links (raw drafts carry it; phase 2 A
    // review, finding 4); a polymorphic one is the target's type AND document (re-review N6); a normalized value (a
    // documentId string) has neither and stays as it is
    const loc = isLocalizedUid(strapi, attr.target);
    const ref = (x) => {
      if (x && typeof x === 'object' && !attr.target && x.__type) return `${x.__type}:${x.documentId ?? x.id}`;
      return x && typeof x === 'object' && loc && x.locale ? `${x.documentId}@${x.locale}` : refOf(x);
    };
    return Array.isArray(v) ? v.map(ref) : ref(v);
  }
  if (attr.type === 'media') return Array.isArray(v) ? v.map(refOf) : refOf(v);
  if (attr.type === 'component') return attr.repeatable ? (Array.isArray(v) ? v : []).map((r) => semanticRow(strapi, attr.component, r, depth + 1)) : semanticRow(strapi, attr.component, v, depth + 1);
  if (attr.type === 'dynamiczone') return (Array.isArray(v) ? v : []).map((r) => semanticRow(strapi, r && r.__component, r, depth + 1));
  return v;
}
/** One component row without its id (and without a `_key`), its fields in semantic form. */
function semanticRow(strapi, cuid, row, depth = 0) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row === undefined ? null : row;
  const m = strapi && strapi.components ? strapi.components[cuid] : null;
  const out = {};
  for (const [k, x] of Object.entries(row)) {
    if (k === 'id' || k === '_key') continue;
    const a = m && m.attributes ? m.attributes[k] : null;
    out[k] = a ? semanticValue(strapi, a, x, depth) : x;
  }
  return out;
}
/** A whole draft in semantic form: SKIP_KEYS left out, every attribute through semanticValue. */
function semanticDoc(strapi, uid, doc) {
  const m = strapi && (strapi.contentTypes[uid] || strapi.components[uid]);
  const attrs = (m && m.attributes) || {};
  const out = {};
  for (const [k, v] of Object.entries(doc || {})) {
    if (SKIP_KEYS.has(k)) continue;
    out[k] = attrs[k] ? semanticValue(strapi, attrs[k], v) : v;
  }
  return out;
}
/** sha256 of the semantic form (never shown: it only enters the version HMAC). */
const semanticHash = (strapi, uid, doc) => sha(canonical(semanticDoc(strapi, uid, doc)));

/**
 * rc.2 content hash: an HMAC over the draft WITH component row ids (12 hex). Kept for the history module's comparison
 * of receipts written before 1.0 hardening; versions no longer use it.
 */
function contentHash(doc) {
  const c = {};
  for (const [k, v] of Object.entries(doc || {})) if (!SKIP_KEYS.has(k)) c[k] = v;
  return mac(canonical(c)).slice(0, 12);
}

const isoOf = (d) => (d == null ? null : new Date(d).toISOString());

const VERSION_PREFIX = 'v2';
/**
 * The version token of a draft (normalized or raw): "v2.<HMAC-SHA256 over v2, uid, documentId, locale and the semantic
 * hash, base64url>". documentId and locale are read from the draft itself.
 */
function versionOf(strapi, uid, doc) {
  if (!strapi || typeof uid !== 'string') throw new Error('versionOf(strapi, uid, doc): the uid binds the version (1.0 hardening item 15)');
  const d = doc || {};
  const msg = [VERSION_PREFIX, uid, d.documentId || '', d.locale || '', semanticHash(strapi, uid, d)].join('\n');
  return `${VERSION_PREFIX}.${mac64(msg)}`;
}

/** A version token as ws_get returns it since 1.0 hardening item 15: "v2." and 43 base64url characters. */
const isVersionToken = (v) => typeof v === 'string' && /^v2\.[A-Za-z0-9_-]{43}$/.test(v);
/** The token format of 1.0.0-rc.2 and the Phase 1 builds ("<updatedAt ISO>~<12 hex>"), refused as version_format. */
const isLegacyVersionToken = (v) => typeof v === 'string' && /^[^~\s]+~[0-9a-f]{12}$/.test(v);

/** true when `expected` is the current version of `doc` (constant-time compare of the full token). */
function versionMatches(strapi, uid, expected, doc) {
  if (!isVersionToken(expected)) return false;
  const cur = Buffer.from(versionOf(strapi, uid, doc));
  const exp = Buffer.from(expected);
  return cur.length === exp.length && crypto.timingSafeEqual(cur, exp);
}

/**
 * Row IDENTITY of one entry of a list field, for matching rows inside the plugin (history images, undo, diffs):
 * components "<componentUid>:<id>", blocks nodes "#<index>:<hash8>". Agents never send identities since 1.0 hardening
 * item 16b: they send the row KEYS below (rowHandle), which for components add a content-bound MAC.
 * Blocks nodes: "#<index>:<hash8>", hash8 = HMAC(scope, index, node). Since 1.0 the HMAC covers the scope
 *   "<uid>|<documentId>|<locale>|<field>", so the same paragraph at the same index of two documents (or locales, or
 *   fields) has two different keys, and a key read from one cannot edit the other. The key changes when the node or
 *   its index changes, so a stale key is refused. A blocks key is both identity and key.
 */
function rowKey(kind, attr, row, index, scope) {
  if (kind === 'blocks') return `#${index}:${mac(`${scope || ''}#${index}#${canonical(row)}`).slice(0, 8)}`;
  const cuid = kind === 'dynamiczone' ? row.__component : attr.component;
  return `${cuid}:${row.id}`;
}

function rowKeys(kind, attr, rows, scope) {
  return (rows || []).map((r, i) => rowKey(kind, attr, r, i, scope));
}

/**
 * Row KEY of one entry of a list field, as ws_get shows it and as row ops take it (1.0 hardening item 16b).
 * Components: "<componentUid>:<id>:<mac>", mac = 132 bits (22 base64url characters) of an HMAC-SHA256 over
 *   the database epoch, the scope "<uid>|<documentId>|<locale>|<field>", the component uid, the row id and the row's
 *   canonical content (its fields in semantic form, nested components and nested repeatable rows included, nested row
 *   ids left out). Why: component ids are reused after an import into a fresh database or a sequence reset (Phase 0,
 *   test 6: an old "<component>:<id>" key edited a different row and the reply said ok). The content binds the key to
 *   the row the agent read, the epoch to the database it was read from. A key also goes stale when anyone edits that
 *   row: the edit is then refused with stale_row_key (requires_reread) instead of landing on content the agent has not
 *   seen. Edits of OTHER rows never touch this row's key. Every write reply returns the new keys.
 *   The full row is hashed (hidden fields included): an HMAC, so the key is no oracle for fields the token cannot read.
 * Blocks nodes: the blocks key of rowKey (already content- and index-bound).
 */
const KEY_MAC_CHARS = 22; // 22 x 6 = 132 bits
function rowHandle(strapi, kind, attr, row, index, scope) {
  if (kind === 'blocks') return rowKey(kind, attr, row, index, scope);
  const cuid = kind === 'dynamiczone' ? row.__component : attr.component;
  const content = canonical(semanticRow(strapi, cuid, row));
  const m = mac64(['rk1', ROW_EPOCH, scope || '', cuid, String(row.id), content].join('\n')).slice(0, KEY_MAC_CHARS);
  return `${cuid}:${row.id}:${m}`;
}
function rowHandles(strapi, kind, attr, rows, scope) {
  return (rows || []).map((r, i) => rowHandle(strapi, kind, attr, r, i, scope));
}
/**
 * The identity part of a key an agent sent: "<component>:<id>" of "<component>:<id>:<mac>" (and of an rc.2 key without
 * a mac), a blocks key unchanged. Used to tell stale_row_key (the row is there, the key no longer matches it) from
 * row_not_found (no such row any more).
 */
function keyIdentity(key) {
  if (typeof key !== 'string' || !key) return null;
  if (key.startsWith('#') || key.startsWith('new:')) return key;
  const parts = key.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : null;
}

/** Scope of a field's row keys: "<uid>|<documentId>|<locale>|<field>". */
const keyScope = (uid, documentId, locale, field) => `${uid}|${documentId || ''}|${locale || ''}|${field}`;

const isToMany = (attr) => /ToMany$/.test(attr.relation || '');
const refOf = (x) => (x && typeof x === 'object' ? (x.documentId ?? x.id) : x);

/** One attribute value with relations (also inside components and zones) reduced to documentIds and media to ids. */
function normValue(strapi, attr, v, depth = 0) {
  if (v == null || depth > 8) return v;
  if (attr.type === 'relation' || attr.type === 'media') return Array.isArray(v) ? v.map(refOf) : refOf(v);
  if (attr.type === 'component') return attr.repeatable ? (v || []).map((r) => normRow(strapi, attr.component, r, depth + 1)) : normRow(strapi, attr.component, v, depth + 1);
  if (attr.type === 'dynamiczone') return (v || []).map((r) => normRow(strapi, r.__component, r, depth + 1));
  return v;
}
function normRow(strapi, uid, row, depth = 0) {
  if (!row || typeof row !== 'object') return row;
  const m = strapi.contentTypes[uid] || strapi.components[uid];
  if (!m) return row;
  const out = {};
  for (const [k, x] of Object.entries(row)) out[k] = m.attributes[k] ? normValue(strapi, m.attributes[k], x, depth) : x;
  return out;
}
/**
 * The draft as the plugin hashes, shows and writes it: relations are documentIds (a string, or a list for *ToMany),
 * at any depth. Writing a row back with these values keeps its relations (Document Service shorthand = set).
 */
const normalize = (strapi, uid, doc) => normRow(strapi, uid, doc);

/**
 * Output view of a document: component rows carry `_key` instead of `id`; list fields' keys also in `rows`.
 * `raw` is the view to show (usually the token's sanitized read). Row keys bind the FULL row content (rowHandle), so
 * pass the full draft as `at.full` whenever `raw` may lack fields: keys are then computed from the full rows (matched
 * by row identity), and they match what a write computes. Without `at.full` the keys come from `raw` itself.
 */
function presentDoc(strapi, uid, raw, fields, at = {}) {
  const documentId = at.documentId ?? raw?.documentId;
  const locale = at.locale !== undefined ? at.locale : raw?.locale;
  const sc = (name) => keyScope(uid, documentId, locale, name);
  const attrs = attrsOf(strapi, uid);
  const doc = normalize(strapi, uid, raw);
  // the RAW full draft: a relation inside a row keeps its linked locale there, and the key binds it (re-review N5)
  const full = at.full || null;
  const data = {};
  const rows = {};
  // the row to hash for a key: the full row with the same identity, else the shown row itself
  const fullRow = (name, kind, a, r) => {
    if (!full || r == null || kind === 'blocks') return r;
    const list = kind === 'component' ? [full[name]] : full[name];
    const id = rowKey(kind === 'component' ? 'repeatable' : kind, a, r, 0);
    return (Array.isArray(list) ? list : []).find((x) => x && rowKey(kind === 'component' ? 'repeatable' : kind, a, x, 0) === id) || r;
  };
  const keyOf = (name, kind, a, r, i) => rowHandle(strapi, kind === 'component' ? 'repeatable' : kind, a, fullRow(name, kind, a, r), i, sc(name));
  // Nested component rows are shown without ids (1.0): ids are never accepted inside a component row, so showing them
  // would only invite an echo that is refused.
  const dropIds = (cuid, v, depth = 0) => {
    if (v == null || typeof v !== 'object' || depth > 8) return v;
    const m = strapi.components[cuid];
    if (!m) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'id' && depth > 0) continue;
      const a = m.attributes[k];
      if (a && a.type === 'component' && x != null) out[k] = a.repeatable ? (x || []).map((r) => dropIds(a.component, r, depth + 1)) : dropIds(a.component, x, depth + 1);
      else out[k] = x;
    }
    return out;
  };
  const strip = (cuid, v, key) => {
    if (v == null) return v;
    const out = { _key: key };
    for (const [k, x] of Object.entries(dropIds(cuid, v))) if (k !== 'id') out[k] = x;
    return out;
  };
  for (const [name, a] of Object.entries(attrs)) {
    if (SKIP_KEYS.has(name)) continue;
    if (fields && !fields.includes(name)) continue;
    // A field missing from the (sanitized) document is one the token cannot read: leave it out. Before 0.2 a hidden
    // list field was shown as [] here, which reads as "this list is empty".
    if (!(name in doc)) continue;
    const v = doc[name];
    const kind = fieldKind(a);
    if (kind === 'repeatable' || kind === 'dynamiczone') {
      const keys = (v || []).map((r, i) => keyOf(name, kind, a, r, i));
      data[name] = (v || []).map((r, i) => strip(kind === 'dynamiczone' ? r.__component : a.component, r, keys[i]));
      rows[name] = keys;
    } else if (kind === 'component') data[name] = v == null ? v : strip(a.component, v, keyOf(name, kind, a, v, 0));
    else if (kind === 'blocks') { data[name] = v; rows[name] = rowKeys(kind, a, v, sc(name)); }
    else data[name] = v;
  }
  return { data, rows };
}

/**
 * Component attributes that the plugin cannot round-trip safely yet: polymorphic (morph) relations inside a component.
 * Relations with a target are supported since 0.2, media (references to existing files) since 1.0.
 */
function unsupportedNested(strapi, cuid, depth = 0) {
  if (depth > 8) return [];
  const bad = [];
  for (const [k, a] of Object.entries(attrsOf(strapi, cuid))) {
    if (a.type === 'relation' && !a.target) bad.push(`${cuid}.${k}`);
    if (a.type === 'component') bad.push(...unsupportedNested(strapi, a.component, depth + 1));
  }
  return bad;
}

module.exports = {
  populateFor, fieldKind, isListKind, isListAttr, isVersionToken, isLegacyVersionToken, canonical, sha, contentHash, versionOf, versionMatches, rowKey, rowKeys,
  rowHandle, rowHandles, keyIdentity, unhashable, isLocalizedUid, POPULATE_DEPTH, setRowEpoch, rowEpoch, semanticDoc, semanticRow, semanticHash, KEY_MAC_CHARS,
  keyScope, presentDoc, attrsOf, unsupportedNested, isoOf, SKIP_KEYS, setVersionKey, mac, normalize, isToMany,
  creatorPopulate, CREATOR_QUERY, permQueryPopulate, setConditionPopulate, conditionPaths, populateForPaths,
};
