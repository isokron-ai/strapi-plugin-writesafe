'use strict';

/**
 * Approval tiers for bulk jobs (1.0 hardening, Phase 4 stream G; ChatGPT's design in
 * from an outside design review, trimmed to the owner's ceilings).
 *
 *   count <= automaticMax                        automatic: the job starts when the agent asks (as before)
 *   automaticMax < count <= twoApproverAbove     one approval by an admin, in the Strapi admin panel
 *   twoApproverAbove < count <= maxDocuments     two approvals by two DIFFERENT admins
 *   count > maxDocuments                         too_many_documents (no approval can raise it)
 *
 * Operation escalations (config approvals.escalate) ask for one approval at any size: `publish` (bulk publish) and
 * `relations` (a bulk edit of a to-many relation). Both are off by default (see DEFAULTS below for why).
 *
 * Every number is configurable inside the HARD limits below. The hard limits are code constants: no config, argument
 * or approval can move them.
 */

const HARD = Object.freeze({
  // The most documents one approved job may cover (the plan's hard ceiling, owner decision 13 Nov).
  maxDocuments: 100000,
  // Above this many documents two distinct approvers are always required, whatever twoApproverAbove says.
  twoApproverAboveMax: 50000,
  // A pending request must be decided within this time; an approval must be used within this time.
  requestTtlSecondsMax: 7 * 24 * 3600,
  approvalTtlSecondsMax: 24 * 3600,
  // Pending requests per token (an injected agent cannot flood the approval page).
  pendingPerTokenMax: 20,
  samplesMax: 10,
  approverQuietHoursMax: 720,
});

const DEFAULTS = Object.freeze({
  enabled: true,
  // automaticMax: null = the bulk module's own ceiling (writesafe.bulk.maxDocuments), so there is one number to set.
  automaticMax: null,
  twoApproverAbove: 25000,
  // 20,000: measured on stream E's job tables (one approved 20,000-document job end to end on Postgres, run by the
  // runner: flat memory, every document written). 100,000 stays the hard limit; the default goes up only once a
  // 100,000-document run has been measured too.
  maxDocuments: 20000,
  requestTtlSeconds: 24 * 3600,
  approvalTtlSeconds: 3600,
  pendingPerToken: 5,
  samples: 5,
  // Off by default: a one-person site would need an admin click for every 3-document publish, and bulk publish
  // already binds what it publishes (Phase 3 item 19). Teams should turn both on (docs/tools-bulk-create.md).
  escalate: { publish: false, relations: false },
  // The admin who owns the requesting token may approve it (a one-person company has no one else). In the
  // two-approver tier at most ONE of the two approvers may be that admin, whatever this says.
  requesterMayApprove: true,
  // re-review A1.3: an approver's admin account must be unchanged (created/updated) for this long before the request
  approverQuietHours: 24,
});

const isInt = (v) => Number.isSafeInteger(v);

/** Effective approval settings: defaults, the config, and the bulk ceiling. Throws on a value outside the hard limits. */
function settings(approvalsCfg, bulkMax) {
  const c = { ...DEFAULTS, ...(approvalsCfg || {}), escalate: { ...DEFAULTS.escalate, ...((approvalsCfg && approvalsCfg.escalate) || {}) } };
  validate(c, bulkMax);
  const automaticMax = c.automaticMax == null ? bulkMax : Math.min(c.automaticMax, bulkMax);
  const maxDocuments = Math.min(c.maxDocuments, HARD.maxDocuments);
  const twoApproverAbove = Math.max(automaticMax, Math.min(c.twoApproverAbove, HARD.twoApproverAboveMax, maxDocuments));
  return { ...c, automaticMax, maxDocuments, twoApproverAbove };
}

function validate(c, bulkMax) {
  const bad = (m) => { throw new Error(`writesafe.approvals.${m}`); };
  if (typeof c.enabled !== 'boolean') bad('enabled must be a boolean');
  if (c.automaticMax != null && (!isInt(c.automaticMax) || c.automaticMax < 0)) bad('automaticMax must be an integer >= 0 (or null: the bulk ceiling)');
  if (!isInt(c.maxDocuments) || c.maxDocuments < 1 || c.maxDocuments > HARD.maxDocuments) bad(`maxDocuments must be an integer from 1 to ${HARD.maxDocuments} (hard limit)`);
  if (!isInt(c.twoApproverAbove) || c.twoApproverAbove < 0 || c.twoApproverAbove > HARD.twoApproverAboveMax) bad(`twoApproverAbove must be an integer from 0 to ${HARD.twoApproverAboveMax} (hard limit)`);
  if (bulkMax != null && c.automaticMax != null && c.automaticMax > bulkMax) bad(`automaticMax (${c.automaticMax}) cannot be above writesafe.bulk.maxDocuments (${bulkMax})`);
  if (!isInt(c.requestTtlSeconds) || c.requestTtlSeconds < 1 || c.requestTtlSeconds > HARD.requestTtlSecondsMax) bad(`requestTtlSeconds must be from 1 to ${HARD.requestTtlSecondsMax}`);
  if (!isInt(c.approvalTtlSeconds) || c.approvalTtlSeconds < 1 || c.approvalTtlSeconds > HARD.approvalTtlSecondsMax) bad(`approvalTtlSeconds must be from 1 to ${HARD.approvalTtlSecondsMax}`);
  if (!isInt(c.pendingPerToken) || c.pendingPerToken < 1 || c.pendingPerToken > HARD.pendingPerTokenMax) bad(`pendingPerToken must be from 1 to ${HARD.pendingPerTokenMax}`);
  if (!isInt(c.samples) || c.samples < 0 || c.samples > HARD.samplesMax) bad(`samples must be from 0 to ${HARD.samplesMax}`);
  for (const k of Object.keys(c.escalate)) {
    if (!['publish', 'relations'].includes(k)) bad(`escalate.${k} is unknown (publish, relations)`);
    if (typeof c.escalate[k] !== 'boolean') bad(`escalate.${k} must be a boolean`);
  }
  if (typeof c.requesterMayApprove !== 'boolean') bad('requesterMayApprove must be a boolean');
  if (!isInt(c.approverQuietHours) || c.approverQuietHours < 0 || c.approverQuietHours > HARD.approverQuietHoursMax) bad(`approverQuietHours must be an integer from 0 to ${HARD.approverQuietHoursMax}`);
}

/**
 * The tier of a job: { tier: 'automatic' | 'one' | 'two' | 'refused', approvals: 0 | 1 | 2, reason }.
 * `op` = { action: 'patch' | 'publish', relations: true when the spec edits a to-many relation }.
 */
function tierFor(count, op, s) {
  if (!s.enabled) return count > s.automaticMax ? { tier: 'refused', approvals: null, reason: 'over_ceiling' } : { tier: 'automatic', approvals: 0, reason: null };
  if (count > s.maxDocuments) return { tier: 'refused', approvals: null, reason: 'over_admin_ceiling' };
  if (count > s.twoApproverAbove || count > HARD.twoApproverAboveMax) return { tier: 'two', approvals: 2, reason: 'count' };
  if (count > s.automaticMax) return { tier: 'one', approvals: 1, reason: 'count' };
  if (op && op.action === 'publish' && s.escalate.publish) return { tier: 'one', approvals: 1, reason: 'publish' };
  if (op && op.relations && s.escalate.relations) return { tier: 'one', approvals: 1, reason: 'relations' };
  return { tier: 'automatic', approvals: 0, reason: null };
}

/** The most documents a job may match before it is refused outright (the agent's max_documents can only lower it). */
const ceiling = (s) => (s.enabled ? s.maxDocuments : s.automaticMax);

module.exports = { HARD, DEFAULTS, settings, validate, tierFor, ceiling };
