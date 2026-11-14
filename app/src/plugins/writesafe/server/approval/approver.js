'use strict';

/**
 * May this admin decide this job? (review 7, re-review A4)
 * The admin's own Content Manager permission checker must allow the job's action (update, or publish for a publish
 * job) on the job's locale (i18n turns locale rights into a condition, so the check uses a subject with `locale`),
 * and, for an update, on EVERY field the change touches (for a component, every leaf field under it, the way Strapi's
 * permissions name them). Conditions other than the locale (e.g. "is creator") are
 * evaluated against that bare subject and therefore fail: such an admin cannot approve bulk jobs (fail closed).
 */
const { fieldsOf } = require('./view');

/** A patch or replace job with publish "if_clean" also publishes: its approver needs the publish permission too. */
const publishesToo = (req) => Boolean(req && req.action !== 'publish' && req.spec && req.spec.publish === 'if_clean');

function mayAct(pc, req, leavesOf = (f) => [f]) {
  const act = req.action === 'publish' ? 'publish' : 'update';
  const ent = req.locale ? { locale: req.locale } : {};
  try {
    if (pc.cannot[act](ent)) return false;
    if (publishesToo(req) && pc.cannot.publish(ent)) return false;
    if (act === 'update') {
      for (const f of fieldsOf(req.spec)) for (const p of leavesOf(f)) if (pc.cannot[act](ent, p)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The permission paths of a field as Strapi's admin permissions name them: a (repeatable) component's leaf fields
 * ("items.label", "items.qty", nested components included); any other field, itself (dynamic zones, relations,
 * media and scalars are permitted as a whole).
 */
function leavesFor(strapi, uid) {
  const walk = (cuid, prefix, depth, out) => {
    const c = strapi.components && strapi.components[cuid];
    if (!c || depth > 6) { out.push(prefix); return out; }
    for (const [k, a] of Object.entries(c.attributes || {})) {
      if (k === 'id') continue;
      if (a.type === 'component') walk(a.component, `${prefix}.${k}`, depth + 1, out);
      else out.push(`${prefix}.${k}`);
    }
    return out;
  };
  return (f) => {
    const a = strapi.contentTypes && strapi.contentTypes[uid] && strapi.contentTypes[uid].attributes[f];
    return a && a.type === 'component' ? walk(a.component, f, 0, []) : [f];
  };
}

/**
 * A ws_replace job names text PATHS ("sections.body", "items.label", "body"): map them to the permission fields the
 * way ws_replace itself checks its token (zone and blocks paths -> the field; component paths -> the leaf), and only
 * the text leaves the job touches (third review B1: "sections.body" as a field name refused every approver).
 */
function permPathsFor(strapi, req) {
  const R = require('../modules/replace');
  return [...new Set(R.resolveTargets(strapi, req.uid, (req.spec && req.spec.fields) || null).map(R.permPath))];
}

/** The action (update) on the job's locale and on each of these permission paths. */
function mayActPaths(pc, req, paths) {
  const ent = req.locale ? { locale: req.locale } : {};
  try {
    if (pc.cannot.update(ent)) return false;
    if (publishesToo(req) && pc.cannot.publish(ent)) return false;
    for (const p of paths) if (pc.cannot.update(ent, p)) return false;
    return true;
  } catch {
    return false;
  }
}

const isReplace = (req) => req.tool === 'ws_replace' || req.action === 'replace';

/** The same check with an ability (builds the Content Manager permission checker for the job's type). */
function mayActWith(strapi, ability, req) {
  try {
    const pc = require('../compat/content-manager').permissionChecker(strapi, { userAbility: ability }, req.uid);
    if (isReplace(req)) return mayActPaths(pc, req, permPathsFor(strapi, req));
    return mayAct(pc, req, leavesFor(strapi, req.uid));
  } catch {
    return false;
  }
}

module.exports = { publishesToo, mayAct, mayActWith, leavesFor, permPathsFor, mayActPaths };
