'use strict';

/**
 * Tables of the approvals and the runner (1.0 hardening, Phase 4 stream G). Declared always, like the modules' tables:
 * they stay empty while approvals are not used. Hidden from the Content Manager and the Content-Type Builder.
 * Times are epoch milliseconds (biginteger), set by the plugin, so no database or driver time zone is involved.
 */
const hidden = () => ({ 'content-manager': { visible: false }, 'content-type-builder': { visible: false } });
// a fresh object per attribute: Strapi annotates attribute objects in place (a shared one gave duplicate columns)
const ms = () => ({ type: 'biginteger' });

const approvalRequest = {
  schema: {
    kind: 'collectionType',
    collectionName: 'writesafe_approval_requests',
    info: { singularName: 'approval-request', pluralName: 'approval-requests', displayName: 'Write-safe approval request' },
    options: { draftAndPublish: false },
    pluginOptions: hidden(),
    attributes: {
      requestId: { type: 'string', required: true, unique: true }, // "ar_<24 hex>"
      planId: { type: 'string', required: true },                  // the job the request is for
      planHash: { type: 'string', required: true },                // sha256 the decision and the start are bound to
      manifestRoot: { type: 'string' },                             // sha256 of the ordered document list
      status: { type: 'string', required: true },                  // pending | approved | rejected | expired | consumed | cancelled
      expiredFrom: { type: 'string' },                              // pending or approved, when status is expired
      tier: { type: 'string' },                                     // one | two
      requiredApprovals: { type: 'integer' },
      reason: { type: 'string' },                                   // count | publish | relations
      tool: { type: 'string' },
      uid: { type: 'string' },
      locale: { type: 'string' },
      action: { type: 'string' },
      docCount: { type: 'integer' },
      filterSummary: { type: 'text' },                              // rc requests only (cut at 4,000 characters)
      filter: { type: 'json' },                                     // the whole filter (re-review A2)
      spec: { type: 'json' },
      samples: { type: 'json' },                                    // before/after of a few documents (the token's view)
      tokenId: { type: 'string' },                                  // the admin API token that asked
      tokenName: { type: 'string' },
      ownerUserId: { type: 'string' },                              // the admin user who owns that token
      agent: { type: 'string' },
      permFingerprint: { type: 'string' },                          // the token's rules on uid when it asked
      ownerMayApprove: { type: 'boolean' },                         // false: owner's account changed in the quiet period
      requestedAt: ms(), expiresAt: ms(), approvedAt: ms(), approvalExpiresAt: ms(), consumedAt: ms(),
    },
  },
};

const approvalDecision = {
  schema: {
    kind: 'collectionType',
    collectionName: 'writesafe_approval_decisions',
    info: { singularName: 'approval-decision', pluralName: 'approval-decisions', displayName: 'Write-safe approval decision' },
    options: { draftAndPublish: false },
    pluginOptions: hidden(),
    attributes: {
      key: { type: 'string', required: true, unique: true },       // "<requestId>:<approverId>": one decision per admin
      requestId: { type: 'string', required: true },
      planHash: { type: 'string', required: true },                // the plan hash the admin was shown
      approverId: { type: 'string', required: true },              // admin user id (from the admin session)
      approverName: { type: 'string' },
      decision: { type: 'string', required: true },                // approve | reject
      decidedAt: ms(),
      note: { type: 'text' },
    },
  },
};

const jobLease = {
  schema: {
    kind: 'collectionType',
    collectionName: 'writesafe_job_leases',
    info: { singularName: 'job-lease', pluralName: 'job-leases', displayName: 'Write-safe job lease' },
    options: { draftAndPublish: false },
    pluginOptions: hidden(),
    attributes: {
      jobId: { type: 'string', required: true, unique: true },
      requestId: { type: 'string' },
      uid: { type: 'string' },
      state: { type: 'string', required: true },                   // queued | running | paused | stopped | cancelled | done
      reason: { type: 'string' },                                   // permission_changed | admin | runner_errors
      detail: { type: 'string' },
      owner: { type: 'string' },                                    // the job's owner scope (token)
      tokenId: { type: 'string' },
      permFingerprint: { type: 'string' },
      leaseOwner: { type: 'string' },                               // worker id holding the lease, or null
      leaseUntil: ms(),
      fence: { type: 'integer' },                                   // +1 on every acquire
      heartbeatAt: ms(),
      processed: { type: 'integer' },
      errors: { type: 'integer' },
      nextAttemptAt: ms(),                                          // after a chunk error: not before (back-off)
      lastError: { type: 'text' },
      events: { type: 'json' },                                     // the last 50 runner events
      updatedAtMs: ms(),
    },
  },
};

module.exports = { 'approval-request': approvalRequest, 'approval-decision': approvalDecision, 'job-lease': jobLease };
