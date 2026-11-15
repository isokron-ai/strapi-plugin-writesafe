'use strict';

/**
 * ws_bulk's approval gate (1.0 hardening, Phase 4 stream G), installed into the bulk engine with jobs.setHooks().
 *
 * Above the automatic tier a job is planned as usual (its exact document list is stored), but stored as
 * `awaiting_approval` and NOT run; an approval request bound to that plan's hash goes to the admin panel. The agent
 * gets `approval_required` with the request id and nothing it can do to approve: ws_bulk has no approval argument (its
 * schema is strict, so `approved: true` is refused as an unknown key). When an admin approves:
 *  - with the runner on, the job starts in the background at once;
 *  - with it off, the agent's next `ws_bulk {job_id}` starts it (and drives it, chunk by chunk, as before).
 * Starting uses the approval once and only for the plan it was given for (control.activate).
 */
const T = require('./tiers');
const C = require('./control');
const AT = require('../compat/admin-token');
const AD = require('../runner/adapter');
const E = require('../engine');
const M = require('../model');
const { ApprovalError } = require('./service');

const { WsError } = E;
const TO_MANY = new Set(['oneToMany', 'manyToMany', 'morphToMany', 'morphMany', 'manyWay']);
const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
const wsErr = (e) => (e instanceof ApprovalError ? new WsError({ code: e.code, message: e.message, ...(e.extra || {}) }) : e);

/** Does a bulk spec edit a to-many relation (set/unset of one, or a relation op on one)? */
function editsRelations(strapi, job) {
  const attrs = M.attrsOf(strapi, job.uid) || {};
  const spec = job.spec || {};
  const fields = [...Object.keys(spec.set || {}), ...(spec.unset || []), ...(spec.ops || []).map((o) => o && o.field),
    ...(spec.relation_ops || spec.relations || []).map((o) => o && o.field)].filter(Boolean);
  return fields.some((f) => attrs[f] && attrs[f].type === 'relation' && TO_MANY.has(attrs[f].relation));
}

/**
 * Admin actions that manage admin accounts or credentials: create or update users, give a role new rights, mint or
 * regenerate tokens, use transfer tokens, or change the SSO provider settings. Approval is a human check that the agent
 * must not be able to influence, and least privilege says an agent's token needs none of these, so a token holding
 * one cannot ask for approval (review finding 1a). Give agents a token with content-manager (and upload) permissions
 * only.
 */
const UNSAFE_ACTIONS = [
  'admin::users.create', 'admin::users.update', 'admin::roles.create', 'admin::roles.update',
  // re-review A1.2: tokens that mint tokens, transfer tokens, and SSO provider settings
  'admin::admin-tokens.create', 'admin::admin-tokens.update', 'admin::admin-tokens.regenerate',
  'admin::api-tokens.create', 'admin::api-tokens.update', 'admin::api-tokens.regenerate',
  'admin::transfer.tokens.access', 'admin::transfer.tokens.create', 'admin::transfer.tokens.read', 'admin::transfer.tokens.update',
  'admin::transfer.tokens.regenerate', 'admin::transfer.tokens.delete',
  'admin::provider-login.update',
];
function unsafeToken(ability) {
  if (!ability || typeof ability.can !== 'function') return null;
  for (const a of UNSAFE_ACTIONS) {
    try { if (ability.can(a)) return a; } catch { /* not this one */ }
  }
  return null;
}

/**
 * The filter an approval request stores and shows: all of it (re-review A2), or a refusal when it is longer than
 * MAX_FILTER_CHARS, so an agent cannot pad a filter to push its real condition out of what the admin sees.
 */
const MAX_FILTER_CHARS = 20000;
function filterRecord(qfilters) {
  const filter = JSON.parse(JSON.stringify(qfilters || {}));
  return { filter, tooLong: JSON.stringify(filter).length > MAX_FILTER_CHARS };
}

/** When the token owner's credentials last changed (ms; credentials.js, third review B4), or null. */
async function ownerChangedAt(strapi, ownerUserId) {
  if (ownerUserId == null) return null;
  try {
    return await require('./credentials').credentialsSince(strapi, ownerUserId);
  } catch {
    return Date.now(); // unknown: treat as just changed (the owner then cannot approve)
  }
}

// job: { uid, action, spec } (a dry run's description or a G job); a patch with publish "if_clean" counts as a publish
function opOf(strapi, job) {
  const publishes = Boolean(job.spec && job.spec.publish === 'if_clean');
  return { action: publishes ? 'publish' : job.action, relations: editsRelations(strapi, job) };
}
const tierOf = (strapi, job, count) => T.tierFor(count, opOf(strapi, job), C.approvalSettings(strapi));

const REASON = {
  count: (n, s) => `more than the ${s.automaticMax} documents a job may change without approval`,
  publish: () => 'a bulk publish (or a bulk patch with publish "if_clean"), which this server has an admin approve first (approvals.escalate.publish)',
  relations: () => 'a bulk edit of a to-many relation, which this server has an admin approve first (approvals.escalate.relations)',
};

function approvalView(req) {
  return {
    request_id: req.requestId, status: req.status, tier: req.tier, approvals_needed: req.requiredApprovals,
    approvals_given: (req.decisions || []).filter((d) => d.decision === 'approve').length, reason: req.reason,
    plan_hash: req.planHash, manifest_root: req.manifestRoot, expires_at: iso(req.expiresAt),
    ...(req.approvalExpiresAt ? { approval_expires_at: iso(req.approvalExpiresAt) } : {}),
  };
}

function approvalReply(strapi, req, job) {
  const g = AD.asG(job); // an E row or a G job
  const s = C.approvalSettings(strapi);
  const n = req.requiredApprovals;
  const runner = C.runnerActive();
  const tool = g.tool || 'ws_bulk';
  return {
    ok: false, job_id: g.job_id, status: 'awaiting_approval', tool, uid: g.uid, locale: g.locale || null, action: g.action,
    total: g.total, processed: 0, remaining: g.total,
    approval: approvalView(req),
    error: {
      code: 'approval_required',
      message: `This job covers ${g.total} documents: ${(REASON[req.reason] || REASON.count)(g.total, s)}. `
        + `It needs ${n === 2 ? 'two approvals by two different' : 'one approval by a'} Strapi admin${n === 2 ? 's' : ''} in the admin panel (Write-safe jobs page). `
        + 'Nothing you send can approve it. Tell the user the job is waiting for approval. Nothing was written.',
    },
    next: {
      hint: runner ? 'It starts on the server by itself once approved. Call ws_job {action: "status", job_id} to follow it.'
        : `Once approved, call ${tool} with only {job_id} to start it. Until then that call reports the approval status.`,
      job_id: g.job_id,
    },
  };
}

// E's reply view of a job row (async), with our error
async function errorReply(strapi, row, code, message) {
  return { ...(await require('../modules/_bulk/jobs').view(strapi, row, [])), ok: false, error: { code, message } };
}
const findRow = (strapi, jobId) => require('../modules/_bulk/store').findJob(strapi, jobId);
// pauses only an admin lifts: the agent's control "resume" is refused for them
const ADMIN_PAUSES = ['admin_job', 'permission_changed', 'runner_errors'];

const gate = {
  ceiling(bulkCfg) {
    // with the Settings page's tightenings, as beforeCreate checks it (a dry run reports the limit a start applies)
    return T.ceiling(require('../settings/overrides').approvals(T.settings(C.ST.approvalsCfg, bulkCfg.maxDocuments)));
  },

  /** desc: { uid, action, spec } of the dry run. */
  dryRunNote(strapi, desc, count, ctx) {
    const t = tierOf(strapi, desc, count);
    if (!t.approvals) return {};
    if (!C.approvalsActive(strapi)) {
      return { approval: { required: true, tier: t.tier, approvals_needed: t.approvals, reason: t.reason, needs_mcp_only: true,
        note: 'This job would need an admin\'s approval, and approvals are off on this server (they need writesafe.adminTokens set to "mcp-only"). Starting it will be refused: narrow the filter to the automatic limit, or ask the user.' } };
    }
    const unsafe = unsafeToken(ctx && ctx.userAbility);
    return { approval: { required: true, tier: t.tier, approvals_needed: t.approvals, reason: t.reason,
      ...(unsafe ? { token_unsafe: true, note: `This token holds ${unsafe}, so it cannot ask for an approval (it can manage admin users, roles or tokens, which an agent's token should not). Starting this job will be refused; use a token with content permissions only.` }
        : { note: `Starting this job stores it and asks ${t.approvals === 2 ? 'two different Strapi admins' : 'a Strapi admin'} to approve it in the admin panel; it does not run before that.` }) } };
  },

  /**
   * job: E's job object about to be created (jobId, owner, contentType, action, spec, qfilters, total, idHash, ...).
   * Refuses (throws) or marks it awaiting_approval (it then holds the slot, and the snapshot is still written).
   */
  async beforeCreate(strapi, ctx, extra, job, count) {
    const g = AD.toG(job);
    const t = tierOf(strapi, g, count);
    // over the admin ceiling: refused here too, whatever the caller checked before (review finding 10)
    if (t.tier === 'refused') {
      const max = T.ceiling(C.approvalSettings(strapi));
      throw new WsError({ code: 'too_many_documents', match_count: count, max_documents: max, message: `${count} documents match; the most an admin can approve for one job is ${max} (writesafe.approvals.maxDocuments in the config, or lower on the plugin's Settings page). Narrow the filter or split the job. Nothing was written.` });
    }
    if (!t.approvals) return null;
    if (!C.approvalsActive(strapi)) {
      const s = C.approvalSettings(strapi);
      throw new WsError({ code: 'approval_needs_mcp_only', match_count: count, max_documents: s.automaticMax, message: `${count} documents match; without approval the limit is ${s.automaticMax}${t.reason === 'count' ? '' : ' (and this kind of job always needs approval here)'}. Approvals are off on this server: they need writesafe.adminTokens set to "mcp-only" (an admin decides that). Nothing was stored or written. Narrow the filter or split the job, or ask the user.` });
    }
    if (filterRecord(job.qfilters).tooLong) {
      throw new WsError({ code: 'filter_too_long', max_chars: MAX_FILTER_CHARS, message: `This job needs an admin's approval, and its filter (with your token's permission conditions) is longer than ${MAX_FILTER_CHARS} characters, more than an approval request shows in full. Nothing was stored or written. Use a shorter filter.` });
    }
    const unsafe = unsafeToken(ctx && ctx.userAbility);
    if (unsafe) {
      throw new WsError({ code: 'approval_unsafe_token', message: `This job needs an admin's approval, and this token holds ${unsafe}, an admin management permission. Approvals are refused for tokens that can manage admin users, roles or tokens. Nothing was stored or written. Ask the user for a token with content permissions only (no admin user or role management).` });
    }
    const who = await AT.identify(strapi, extra);
    if (!who) throw new WsError({ code: 'unsupported', message: 'This job needs an admin\'s approval, and approvals need the admin API token that asks for them; it could not be identified. Nothing was written.' });
    const ph = AD.planHash(job);
    job.state = 'awaiting_approval';
    job.approval = { tier: t.tier, approvals_needed: t.approvals, reason: t.reason, plan_hash: ph, manifest_root: AD.manifestRoot(job) };
    return { awaiting: true, tier: t, who, planHash: ph };
  },

  async afterCreate(strapi, ctx, extra, job, gated) {
    const g = AD.toG(job);
    const s = C.approvalSettings(strapi);
    const samples = s.samples ? await AD.previewDocs(strapi, ctx, extra, g, await AD.sampleRows(strapi, g, s.samples)) : [];
    const chk = await AT.check(strapi, gated.who.tokenId, g.uid);
    const { filter } = filterRecord(g.qfilters);
    let res;
    try {
      res = await C.ST.service.request({
        plan: { planId: g.job_id, planHash: gated.planHash, manifestRoot: g.idHash, tool: g.tool, uid: g.uid, locale: g.locale, action: g.action, count: g.total, filter, spec: g.spec || {}, samples },
        requester: { ...gated.who, agent: g.agent || null, permFingerprint: chk.ok ? chk.fingerprint : null, ownerChangedAt: await ownerChangedAt(strapi, gated.who.ownerUserId) },
        tier: gated.tier,
      });
    } catch (e) {
      await AD.setJobStatus(strapi, g.job_id, 'cancelled', { from: ['awaiting_approval'] });
      throw wsErr(e);
    }
    if (res.existing) {
      // another job of this token with the same plan hash waits already (cannot happen while a waiting job holds the
      // slot, kept as a safety net): keep that one
      await AD.setJobStatus(strapi, g.job_id, 'cancelled', { from: ['awaiting_approval'] });
      return approvalReply(strapi, res.request, (await AD.getJob(strapi, res.request.planId)) || g);
    }
    const j = await AD.setJobStatus(strapi, g.job_id, 'awaiting_approval', { from: ['awaiting_approval'], patch: { approval: { ...job.approval, request_id: res.request.requestId } } });
    return approvalReply(strapi, res.request, j || g);
  },

  /** row: E's job row. Returns null (go on), { reply }, or { reload } (the job was started: read it again). */
  async onResume(strapi, ctx, extra, row, a = {}) {
    const job = AD.toG(row);
    if (job.status === 'awaiting_approval') {
      const rid = job.approval && job.approval.request_id;
      const req = rid ? await C.ST.service.get(rid) : null;
      if (!req) return { reply: await errorReply(strapi, row, 'approval_missing', 'This job has no approval request (it was not stored). Cancel it with ws_job {action: "cancel", job_id} and start a new one.') };
      if (req.status === 'approved') {
        try {
          const r = await C.activate(strapi, job, rid);
          if (r.runner) return { reply: await require('../modules/_bulk/jobs').view(strapi, await findRow(strapi, job.job_id), []) };
          return { reload: true };
        } catch (e) {
          if (!(e instanceof ApprovalError)) throw e;
          const again = await C.ST.service.get(rid);
          if (again && again.status === 'expired') await AD.setJobStatus(strapi, job.job_id, 'expired', { from: ['awaiting_approval'] });
          return { reply: await errorReply(strapi, await findRow(strapi, job.job_id), e.code, e.message) };
        }
      }
      if (req.status === 'pending') return { reply: approvalReply(strapi, req, job) };
      if (req.status === 'consumed') return { reload: true };
      const to = req.status === 'rejected' ? 'rejected' : (req.status === 'expired' ? 'expired' : 'cancelled');
      await AD.setJobStatus(strapi, job.job_id, to, { from: ['awaiting_approval'] });
      const msg = { rejected: 'An admin rejected this job. Nothing was written. Do not retry it unchanged; ask the user.', expired: 'No admin decided in time, or the approval was not used in time. Nothing was written. Dry-run and start the job again to ask anew.', cancelled: 'The approval request was cancelled. Nothing was written.' }[to];
      return { reply: await errorReply(strapi, await findRow(strapi, job.job_id), `approval_${to}`, msg) };
    }
    if (job.status === 'paused' && ADMIN_PAUSES.includes(job.pause_reason)) {
      const J = require('../modules/_bulk/jobs');
      return { reply: await errorReply(strapi, row, 'job_paused', J.PAUSE_TEXT[job.pause_reason]) };
    }
    if (job.status === 'rejected') return { reply: await errorReply(strapi, row, 'approval_rejected', 'An admin rejected this job. Nothing was written. Do not retry it unchanged; ask the user.') };
    if (job.status === 'expired') return { reply: await errorReply(strapi, row, 'approval_expired', 'No admin decided in time, or the approval was not used in time. Nothing was written. Dry-run and start the job again to ask anew.') };
    if (job.runner && C.runnerActive()) {
      if (job.status === 'stopped' || (job.status === 'paused' && a.control === 'resume')) {
        // a runner job resumed by its agent goes back to the runner (canary pause, a stopped document)
        await AD.setJobStatus(strapi, job.job_id, 'running', { from: ['stopped', 'paused'] });
        await C.ST.leases.update(job.job_id, { state: 'queued', reason: null, detail: null, errors: 0, nextAttemptAt: null }, {});
        return { reply: await require('../modules/_bulk/jobs').view(strapi, await findRow(strapi, job.job_id), []) };
      }
      if (job.status === 'running') return { reply: await require('../modules/_bulk/jobs').view(strapi, row, []) };
    }
    return null;
  },

  /** An agent cancelled its waiting job: the request goes too. */
  async onCancel(strapi, row) {
    const g = AD.toG(row);
    if (g && g.approval && g.approval.request_id) await C.ST.service.cancel(g.approval.request_id);
    if (g) await C.ST.leases.update(g.job_id, { state: 'cancelled' }, {}).catch(() => {});
  },

  /** Extra reply fields for a job (sync: from the job's own record). row: E's job row. */
  describe(row) {
    const job = AD.toG(row);
    const out = {};
    if (job.approval) out.approval = { request_id: job.approval.request_id || null, tier: job.approval.tier, approvals_needed: job.approval.approvals_needed, reason: job.approval.reason, plan_hash: job.approval.plan_hash, status: job.status === 'awaiting_approval' ? 'pending' : (job.approval.status || null) };
    if (job.status === 'paused') out.pause_reason = job.pause_reason || null;
    if (job.runner && job.status === 'running' && C.runnerActive()) {
      out.runner = true;
      out.next = { hint: 'Running on the server in the background. Call ws_job {action: "status", job_id} to follow it.', job_id: job.job_id };
    }
    return out;
  },
};

/** The kill switch, checked before every chunk (agent-driven and runner-driven alike). */
async function chunkGuard(strapi) {
  // the admin's switch (page or runner.killSwitch) or E's config switch (bulk.paused): either stops every job
  if (await C.killSwitch(strapi)) {
    throw new WsError({ code: 'jobs_stopped', message: 'An admin stopped all bulk jobs (kill switch). Nothing was written in this chunk; the job continues from here once the switch is off. Tell the user.' });
  }
}

function install(strapi) {
  require('../modules/_bulk/jobs').setHooks({ gate, chunkGuard });
}

module.exports = { install, gate, chunkGuard, editsRelations, opOf, approvalView, unsafeToken, UNSAFE_ACTIONS, filterRecord, MAX_FILTER_CHARS };
