'use strict';

/**
 * Media library read permission per file (1.0). The admin permission `plugin::upload.read` can carry conditions
 * (Strapi's default Author role: admin::is-creator), so a coarse ability.can() is not enough. This mirrors
 * @strapi/upload's own MCP check (server/.../find-entity-and-check-permissions.js): the file with createdBy and the
 * creator's roles, through admin::permission's permissions manager. Batched: one query for all files.
 */
const C = require('./index');

const FILE_UID = 'plugin::upload.file';

/**
 * { all, readable }: maps of each requested ref (file documentId or numeric id) to {id, documentId, mime}; `all` has
 * every file found, `readable` only those the ability may read.
 */
async function readableFiles(strapi, ability, refs) {
  const ids = [...new Set(refs.filter((r) => typeof r === 'number'))];
  const docIds = [...new Set(refs.filter((r) => typeof r === 'string'))];
  const or = [...(ids.length ? [{ id: { $in: ids } }] : []), ...(docIds.length ? [{ documentId: { $in: docIds } }] : [])];
  if (!or.length) return { all: new Map(), readable: new Map() };
  const files = await strapi.db.query(FILE_UID).findMany({ where: { $or: or }, populate: { createdBy: { populate: { roles: true } }, folder: true } });
  let pm;
  try {
    pm = strapi.service('admin::permission').createPermissionsManager({ ability, action: 'plugin::upload.read', model: FILE_UID });
  } catch (e) {
    C.note('upload.file_permission', false, `admin::permission createPermissionsManager failed: ${e.message}`);
    pm = null; // fail closed: nothing is readable
  }
  const all = new Map();
  const readable = new Map();
  for (const f of files) {
    const v = { id: f.id, documentId: f.documentId, mime: f.mime };
    all.set(f.id, v);
    all.set(f.documentId, v);
    if (!pm || !ability || pm.ability.cannot(pm.action, pm.toSubject(f))) continue;
    readable.set(f.id, v);
    readable.set(f.documentId, v);
  }
  if (pm && !C.status['upload.file_permission']) C.note('upload.file_permission', true, 'permissions manager used');
  return { all, readable };
}

function probe(strapi) {
  let ok = false;
  try { ok = typeof strapi.service('admin::permission')?.createPermissionsManager === 'function'; } catch { ok = false; }
  C.note('upload.file_permission', ok, ok ? 'admin::permission.createPermissionsManager present' : 'missing: media references are refused (fail closed)');
}

/**
 * Media references in a write payload, rewritten to numeric file ids (1.0.0-rc.2). Strapi 5.62 accepts a file's
 * documentId in a media field; 5.47 to 5.5x only accept the numeric id ("N relation(s) of type plugin::upload.file
 * associated with this entity do not exist", found by the CI matrix). Numeric ids work on every 5.x, so every writer
 * (ws_patch, ws_batch, the module tools) sends ids. Walks top-level fields, components and dynamic-zone rows.
 * A documentId that matches no file calls onMissing(refs) (callers throw a WsError naming them); without onMissing it is
 * left as it is. Existence and read permission of new references were already checked by the engine (checkRefs). Returns a new object; `data` is not changed.
 */
async function toFileIds(strapi, uid, data, onMissing) {
  const refs = new Set();
  const attrsOf = (u) => (strapi.contentTypes[u] || strapi.components[u] || {}).attributes || {};
  const refOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.documentId === 'string' && v.id == null ? v.documentId : null);
  const walk = (attrs, obj, fn, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 10) return obj;
    const out = Array.isArray(obj) ? [...obj] : { ...obj };
    for (const [k, v] of Object.entries(out)) {
      const a = attrs[k];
      if (!a || v == null) continue;
      if (a.type === 'media') out[k] = Array.isArray(v) ? v.map(fn) : fn(v);
      else if (a.type === 'component') out[k] = Array.isArray(v) ? v.map((r) => walk(attrsOf(a.component), r, fn, depth + 1)) : walk(attrsOf(a.component), v, fn, depth + 1);
      else if (a.type === 'dynamiczone' && Array.isArray(v)) out[k] = v.map((r) => (r && r.__component ? walk(attrsOf(r.__component), r, fn, depth + 1) : r));
    }
    return out;
  };
  walk(attrsOf(uid), data, (v) => { const r = refOf(v); if (r) refs.add(r); return v; });
  if (!refs.size) return data;
  const rows = await strapi.db.query(FILE_UID).findMany({ where: { documentId: { $in: [...refs] } }, select: ['id', 'documentId'] });
  const byDoc = new Map(rows.map((r) => [r.documentId, r.id]));
  // A file deleted since it was referenced (e.g. in an undo's before-image): the caller names it instead of passing
  // Strapi's raw "relation(s) ... do not exist" through.
  const missing = [...refs].filter((r) => !byDoc.has(r));
  if (missing.length && onMissing) onMissing(missing);
  return walk(attrsOf(uid), data, (v) => { const r = refOf(v); return r && byDoc.has(r) ? byDoc.get(r) : v; });
}

module.exports = { readableFiles, probe, toFileIds };
