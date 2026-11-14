'use strict';

/**
 * The filter grammar of ws_bulk, ws_replace and ws_find (one check, so the tools cannot drift apart): Strapi filters,
 * checked against the token's READ permission through the Content Manager permission checker.
 *
 *  - validateQuery refuses unknown fields and operators (the checker's own error, as `invalid`).
 *  - The filters must come through the read sanitizer unchanged: a filter on a field the token cannot read is refused,
 *    never silently dropped (a dropped key widens the match). The update/publish sanitizer is NOT used for this: it
 *    deletes keys on fields the token may read but not write, which widened a bulk job to every document (review).
 *  - withConditions adds the permission conditions of one action (e.g. "own entries only") as an $and.
 *
 * This folder has no index.js, so the module registry skips it.
 */
const { WsError } = require('../../engine');
const M = require('../../model');

/**
 * Validates `filters` for this permission checker. Returns the filters (an object, {} when none were given).
 * opts.after: text appended to the refusal (ws_bulk: "Nothing was written.").
 */
async function checkFilters(pc, filters, { after = '' } = {}) {
  const query = { filters: filters || {} };
  try {
    await pc.validateQuery(query);
  } catch (e) {
    throw new WsError({ code: 'invalid', message: `filters: ${e.message}`, details: e.details?.errors?.map?.((x) => ({ path: x.path, message: x.message })) });
  }
  const readSafe = await pc.sanitizeQuery(query);
  if (M.canonical(readSafe.filters || {}) !== M.canonical(query.filters)) {
    throw new WsError({ code: 'invalid', message: `filters: uses fields or operators this token may not filter on.${after ? ` ${after}` : ''}` });
  }
  return query.filters;
}

/** `filters` narrowed by the permission conditions of `action` (read, update, publish, ...). */
async function withConditions(pc, action, filters) {
  const cond = (await pc.sanitizedQuery[action]({})).filters || {};
  if (!Object.keys(cond).length) return filters;
  return Object.keys(filters || {}).length ? { $and: [filters, cond] } : cond;
}

module.exports = { checkFilters, withConditions };
