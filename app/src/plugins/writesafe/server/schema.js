'use strict';

/**
 * ws_schema (1.0 stretch b): a compact, read-only description of a content type's fields and of every component
 * and dynamic-zone shape it uses, so agents do not have to guess structure from a sample document.
 * Fields the token cannot read are left out; fields it cannot update are marked `write: false`.
 */
const M = require('./model');
const E = require('./engine');

const HOW = {
  scalar: 'set',
  component: 'set (merged into the current row; replacing a list inside it needs expected_version), or ref ops with path for a relation or media list inside it',
  repeatable: 'ops by row key (ref ops with key and path for a relation or media list inside a row), or set of the whole list with expected_version',
  dynamiczone: 'ops by row key (add needs component), or set of the whole list with expected_version',
  blocks: 'ops by node key, or set of the whole list with expected_version',
  relation: 'set (documentIds)',
  media: 'set (existing file documentIds or ids)',
};

function fieldOf(strapi, a, localizedType) {
  const kind = M.fieldKind(a);
  const f = { type: kind === 'scalar' ? a.type : kind };
  if (a.required) f.required = true;
  if (a.enum) f.enum = a.enum;
  if (a.type === 'string' || a.type === 'text') { if (a.maxLength) f.maxLength = a.maxLength; }
  if (kind === 'component' || kind === 'repeatable') f.component = a.component;
  if (kind === 'dynamiczone') f.components = a.components;
  if (kind === 'relation') {
    if (!a.target) return { type: 'relation', polymorphic: true, edit: 'not supported' };
    f.relation = a.relation;
    f.target = a.target;
    f.value = M.isToMany(a) ? 'list of documentIds' : 'documentId or null';
    // 1.0 hardening item 20: single links of a to-many relation by ref ops; the whole list only with a version
    if (M.isToMany(a)) f.edit = 'ops {op: "add"|"remove", field, ref: documentId} (other links kept, no version), or set of the whole list with expected_version';
  }
  if (kind === 'media') {
    f.multiple = Boolean(a.multiple);
    if (a.allowedTypes) f.allowedTypes = a.allowedTypes;
    f.value = a.multiple ? 'list of file documentIds' : 'file documentId or null';
    if (a.multiple) f.edit = 'ops {op: "add"|"remove", field, ref: file documentId or id} (other files kept, no version), or set of the whole list with expected_version';
  }
  if (localizedType && a.pluginOptions?.i18n?.localized === false) f.localized = false;
  return f;
}

/**
 * Shapes of the components used, keeping only sub-fields readable under at least one of the paths they are used at
 * (`readable(path)`; dynamic-zone permissions are per zone field, so everything under a readable zone is readable).
 * Fields hidden in the admin (visible: false) are left out.
 */
function componentShapes(strapi, uses, readable) {
  const out = {};
  const visit = (cuid, prefix, depth) => {
    if (depth > 8 || !strapi.components[cuid]) return;
    const shape = out[cuid] || (out[cuid] = { fields: {} });
    for (const [name, a] of Object.entries(strapi.components[cuid].attributes)) {
      if (name === 'id' || a.visible === false) continue;
      const path = prefix ? `${prefix}.${name}` : null;
      if (path && !(a.type === 'component' ? leafPaths(strapi, path, a).some(readable) : readable(path))) continue;
      shape.fields[name] = fieldOf(strapi, a, false);
      if (a.type === 'component') visit(a.component, path, depth + 1);
    }
  };
  for (const { cuid, prefix } of uses) visit(cuid, prefix, 0);
  return out;
}

/** Leaf permission paths under a field (components expand to their sub-fields). */
function leafPaths(strapi, prefix, a, depth = 0) {
  if (a.type !== 'component' || depth > 8 || !strapi.components[a.component]) return [prefix];
  return Object.entries(strapi.components[a.component].attributes).flatMap(([k, x]) => leafPaths(strapi, `${prefix}.${k}`, x, depth + 1));
}

function describeType(strapi, ctx, uid) {
  E.checkUid(strapi, uid);
  const ct = strapi.contentTypes[uid];
  const pc = E.permissionChecker(strapi, ctx, uid);
  if (pc.cannot.read()) throw new E.WsError({ code: 'forbidden', message: `This token cannot read ${uid}.` });
  const localized = ct.pluginOptions?.i18n?.localized === true;
  const fields = {};
  const used = [];
  for (const [name, a] of Object.entries(ct.attributes)) {
    if (M.SKIP_KEYS.has(name) || a.visible === false) continue;
    const paths = leafPaths(strapi, name, a);
    const can = (act) => pc.can[act](undefined, name) || paths.some((p) => pc.can[act](undefined, p));
    if (!can('read')) continue;
    const f = fieldOf(strapi, a, localized);
    f.edit = f.edit || HOW[M.fieldKind(a)] || 'set';
    if (!can('update')) f.write = false;
    fields[name] = f;
    if (a.type === 'component') used.push({ cuid: a.component, prefix: name });
    if (a.type === 'dynamiczone') a.components.forEach((c) => used.push({ cuid: c, prefix: null }));
  }
  return {
    uid, kind: ct.kind, displayName: ct.info?.displayName, draftAndPublish: Boolean(ct.options?.draftAndPublish), localized,
    documentId: ct.kind === 'singleType' ? 'optional (one document)' : 'required',
    fields, components: componentShapes(strapi, used, (p) => pc.can.read(undefined, p)),
    row_keys: 'components: "<component uid>:<id>:<mac>" from ws_get rows (bound to the row\'s content; replies return new keys); blocks nodes: "#<index>:<hash>"',
  };
}

function listTypes(strapi, ctx) {
  return {
    types: E.writableUids(strapi).filter((uid) => !E.permissionChecker(strapi, ctx, uid).cannot.read()).map((uid) => {
      const ct = strapi.contentTypes[uid];
      return { uid, kind: ct.kind, displayName: ct.info?.displayName, draftAndPublish: Boolean(ct.options?.draftAndPublish), localized: ct.pluginOptions?.i18n?.localized === true };
    }),
    // [stream G] admin API tokens limited to MCP (writesafe.adminTokens); not mentioned when they are not (B5)
    ...(require('./compat/admin-tokens').mode() === 'mcp-only' ? { admin_tokens: 'mcp-only' } : {}),
    hint: 'Call ws_schema with uid for the fields and component shapes of one type.',
    // types the version cannot fully cover, with the reason (re-review N6); only those this token can read
    ...(() => {
      const nc = E.uncoveredUids(strapi).filter((x) => { try { return !E.permissionChecker(strapi, ctx, x.uid).cannot.read(); } catch { return false; } });
      return nc.length ? { not_covered: nc } : {};
    })(),
  };
}

module.exports = { describeType, listTypes };
