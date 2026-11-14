'use strict';

/**
 * Approval requests and decisions for bulk jobs above the automatic tier (1.0 hardening, Phase 4 stream G).
 *
 * The proof rule (a decision of the 1.0 hardening: human approval is never a flag the agent sets):
 *  - nothing an agent sends approves anything. ws_bulk has no approval argument, its schema is strict, and the agent's
 *    reply only names the request;
 *  - a decision is recorded only by decide(), which the admin API calls for an authenticated Strapi admin SESSION
 *    (an admin API token, which is what MCP agents hold, is refused: approver.viaSession must be true);
 *  - a decision names the plan hash the admin saw; a request is bound to one plan (planId + planHash), and an approval
 *    is used once, for that plan, before it expires (consume()).
 *
 * The store is injected (store.js: Strapi tables; the unit tests use a memory store), as is the clock.
 */
const crypto = require('crypto');

class ApprovalError extends Error {
  constructor(code, message, status = 409, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const newId = (p) => `${p}${crypto.randomBytes(12).toString('hex')}`;
const num = (v) => (v == null ? null : Number(v));
const TERMINAL = ['rejected', 'expired', 'consumed', 'cancelled'];

/**
 * isStillApprover(approverId, request) -> bool: at the final decision, earlier approvals count only while their admin is still
 * active and still holds "Approve writesafe jobs" (review finding 7). Default: every recorded approval counts.
 */
function create({ store, now = () => Date.now(), settings, isStillApprover = async () => true }) {
  const S = typeof settings === 'function' ? settings : () => settings;

  /** Marks a request expired when its time is up (pending: not decided in time; approved: not used in time). */
  async function refresh(req) {
    if (!req) return req;
    const t = now();
    if ((req.status === 'pending' && num(req.expiresAt) < t) || (req.status === 'approved' && num(req.approvalExpiresAt) < t)) {
      const was = req.status;
      if (await store.updateRequest(req.requestId, { status: 'expired', expiredFrom: was }, { status: was })) return { ...req, status: 'expired', expiredFrom: was };
      return store.getRequest(req.requestId);
    }
    return req;
  }

  /**
   * A new request for a plan, or the pending one this token already has for the same plan hash.
   * plan: { planId, planHash, manifestRoot, uid, locale, action, count, filterSummary, spec, samples, tool }
   * requester: { tokenId, tokenName, ownerUserId, agent, permFingerprint }
   * tier: tiers.tierFor() result with approvals >= 1.
   */
  async function request({ plan, requester, tier }) {
    const s = S();
    if (!tier || !(tier.approvals >= 1)) throw new ApprovalError('invalid', 'This job needs no approval.', 400);
    if (!requester || requester.tokenId == null) throw new ApprovalError('unsupported', 'Approval requests need the identity of the requesting admin token, and it could not be found.', 400);
    const pending = await store.findRequests({ tokenId: String(requester.tokenId), status: 'pending' });
    const live = [];
    for (const r of pending) {
      const x = await refresh(r);
      if (x.status === 'pending') live.push(x);
    }
    const same = live.find((r) => r.planHash === plan.planHash);
    if (same) return { request: same, existing: true };
    if (live.length >= s.pendingPerToken) {
      throw new ApprovalError('too_many_pending', `This token already has ${live.length} approval requests waiting (the limit is ${s.pendingPerToken}). Wait for an admin to decide them, or for them to expire.`, 429, { pending: live.map((r) => r.requestId) });
    }
    const t = now();
    const row = {
      requestId: newId('ar_'), planId: plan.planId, planHash: plan.planHash, manifestRoot: plan.manifestRoot || null,
      status: 'pending', tier: tier.tier, requiredApprovals: tier.approvals, reason: tier.reason,
      tool: plan.tool || 'ws_bulk', uid: plan.uid, locale: plan.locale || null, action: plan.action, count: plan.count,
      filter: plan.filter || null, filterSummary: plan.filterSummary || null, spec: plan.spec || null, samples: plan.samples || null,
      tokenId: String(requester.tokenId), tokenName: requester.tokenName || null, ownerUserId: requester.ownerUserId == null ? null : String(requester.ownerUserId),
      agent: requester.agent || null, permFingerprint: requester.permFingerprint || null,
      // the token owner's account changed within the quiet period before the request: they may not approve it (A1.3)
      ownerMayApprove: !(requester.ownerChangedAt != null && s.approverQuietHours && Number(requester.ownerChangedAt) > t - s.approverQuietHours * 3600000),
      requestedAt: t, expiresAt: t + s.requestTtlSeconds * 1000, approvedAt: null, approvalExpiresAt: null, consumedAt: null,
    };
    await store.createRequest(row);
    return { request: row, existing: false };
  }

  /**
   * Records one admin's decision. approver: { id, name, viaSession } from the admin session (never from the agent).
   * decision: 'approve' | 'reject'. planHash: the plan hash the admin was shown (must equal the request's).
   */
  async function decide({ requestId, approver, decision, planHash, note }) {
    if (!approver || approver.id == null) throw new ApprovalError('unauthorized', 'No authenticated admin.', 401);
    if (approver.viaSession !== true) {
      throw new ApprovalError('session_required', 'Approvals are recorded only for an admin signed in to the Strapi admin panel. API tokens (what agents hold) cannot approve or reject.', 403);
    }
    if (!['approve', 'reject'].includes(decision)) throw new ApprovalError('invalid', 'decision must be approve or reject.', 400);
    if (typeof planHash !== 'string' || !planHash) throw new ApprovalError('invalid', 'plan_hash is required: the decision is bound to the plan you reviewed.', 400);
    const s = S();
    return store.withRequestLock(requestId, async (locked) => {
      const req = await refresh(locked);
      if (!req) throw new ApprovalError('not_found', `No approval request ${requestId}.`, 404);
      if (req.status !== 'pending') throw new ApprovalError(req.status === 'expired' ? 'expired' : 'not_pending', `This request is ${req.status}; it can no longer be decided.`, 409, { status: req.status });
      if (req.planHash !== planHash) {
        throw new ApprovalError('plan_mismatch', 'The plan hash does not match this request: the decision must name the plan it was shown. Reload the page.', 409, { expected_plan_hash: req.planHash });
      }
      // An admin account created or changed (email, password, roles) after the request, or within approverQuietHours
      // before it, cannot approve it (review 1b, re-review A1.3): an approval should come from settled credentials, so
      // an approver whose credentials changed recently can't approve. A rejection only stops a job, so it is allowed.
      if (decision === 'approve') {
        // credentialsSince: the last credential change (email, password, active, roles; credentials.js, third review
        // B4); without it (tests, other callers) the account row's createdAt/updatedAt
        const changed = approver.credentialsSince != null ? Number(approver.credentialsSince)
          : Math.max(...[approver.createdAt, approver.updatedAt].map((x) => (x == null ? NaN : new Date(x).getTime())));
        const at = num(req.requestedAt);
        if (!(changed <= at)) {
          throw new ApprovalError('approver_changed', 'Your admin account was created or changed (email, password or roles) after this request was made, so you cannot approve it. Another admin must, or the agent asks again.', 403);
        }
        const quiet = (s.approverQuietHours || 0) * 3600000;
        if (quiet && changed > at - quiet) {
          const h = Math.round((at - changed) / 3600000);
          throw new ApprovalError('approver_changed', `Your admin account changed ${h} h before this request; an approver's account must be unchanged for ${s.approverQuietHours} h before it (approvals.approverQuietHours). Another admin must approve.`, 403, { account_changed_hours_before: h });
        }
      }
      // The approver must be allowed what the job does on its type (update, or publish for a publish job), or their
      // approval would let a job do what nobody approving it may do (review finding 7). mayAct: bool or fn(request).
      const may = typeof approver.mayAct === 'function' ? approver.mayAct(req) : approver.mayAct;
      if (may !== true) {
        throw new ApprovalError('approver_lacks_permission', `You may not ${req.action === 'publish' ? 'publish' : (req.spec && req.spec.publish === 'if_clean' ? 'update and publish' : 'update')} ${req.uid} yourself, so you cannot decide a job that does it.`, 403);
      }
      const approverId = String(approver.id);
      const decisions = await store.listDecisions(requestId);
      if (decisions.some((d) => d.approverId === approverId)) {
        throw new ApprovalError('already_decided', 'You already decided this request. A second approval must come from a different admin.', 409);
      }
      if (decision === 'approve' && req.ownerUserId != null && req.ownerUserId === approverId && (!s.requesterMayApprove || req.ownerMayApprove === false)) {
        throw new ApprovalError('requester_cannot_approve', req.ownerMayApprove === false
          ? 'You own the token that asked for this job, and your account changed within the quiet period before the request; another admin must approve it.'
          : 'You own the token that asked for this job; another admin must approve it (config approvals.requesterMayApprove is false).', 403);
      }
      const t = now();
      const d = {
        key: `${requestId}:${approverId}`, requestId, planHash, approverId, approverName: approver.name || null,
        decision, decidedAt: t, note: note ? String(note).slice(0, 500) : null,
      };
      try {
        await store.createDecision(d);
      } catch (e) {
        if (e && e.duplicate) throw new ApprovalError('already_decided', 'You already decided this request. A second approval must come from a different admin.', 409);
        throw e;
      }
      const all = [...decisions, d];
      const dropped = [];
      const approvals = new Set(decision === 'approve' ? [approverId] : []);
      for (const x of decisions.filter((y) => y.decision === 'approve')) {
        if (await isStillApprover(x.approverId, req)) approvals.add(x.approverId);
        else dropped.push(x.approverId);
      }
      let patch = null;
      if (decision === 'reject') patch = { status: 'rejected' };
      else if (approvals.size >= req.requiredApprovals) patch = { status: 'approved', approvedAt: t, approvalExpiresAt: t + s.approvalTtlSeconds * 1000 };
      if (patch) await store.updateRequest(requestId, patch, { status: 'pending' });
      return { request: { ...req, ...(patch || {}) }, decisions: all, approvals: approvals.size, required: req.requiredApprovals, dropped };
    });
  }

  /**
   * Uses an approval to start its job, once. Refused unless the request is approved, unexpired, unused and bound to
   * exactly this plan (planId and planHash, the hash recomputed by the caller from the stored plan).
   */
  async function consume({ requestId, planId, planHash }) {
    return store.withRequestLock(requestId, async (locked) => {
      const req = await refresh(locked);
      if (!req) throw new ApprovalError('not_found', `No approval request ${requestId}.`, 404);
      if (req.status === 'consumed') throw new ApprovalError('approval_used', 'This approval was already used: an approval starts one job once.', 409, { status: req.status });
      if (req.status === 'expired') throw new ApprovalError('approval_expired', req.expiredFrom === 'approved' ? 'The approval expired before the job started. Ask for a new one.' : 'No admin decided this request in time. Ask for a new one.', 409, { status: req.status });
      if (req.status !== 'approved') throw new ApprovalError(req.status === 'rejected' ? 'approval_rejected' : 'approval_pending', `This request is ${req.status}.`, 409, { status: req.status });
      if (req.planId !== planId || req.planHash !== planHash) {
        throw new ApprovalError('plan_mismatch', 'This approval is bound to a different plan. Nothing was started.', 409);
      }
      const ok = await store.updateRequest(requestId, { status: 'consumed', consumedAt: now() }, { status: 'approved' });
      if (!ok) throw new ApprovalError('approval_used', 'This approval was already used.', 409);
      return { ...req, status: 'consumed' };
    });
  }

  async function get(requestId) {
    const r = await refresh(await store.getRequest(requestId));
    if (!r) return null;
    return { ...r, decisions: await store.listDecisions(requestId) };
  }

  async function list(where = {}) {
    const rows = await store.findRequests(where);
    const out = [];
    for (const r of rows) {
      const x = await refresh(r);
      if (where.status && x.status !== where.status) continue;
      out.push({ ...x, decisions: await store.listDecisions(x.requestId) });
    }
    return out;
  }

  /** Cancels a request that can no longer run (its job was cancelled). */
  async function cancel(requestId) {
    const r = await store.getRequest(requestId);
    if (!r || TERMINAL.includes(r.status)) return false;
    return store.updateRequest(requestId, { status: 'cancelled' }, { status: r.status });
  }

  return { request, decide, consume, get, list, refresh, cancel };
}

/** Memory store with the same contract as store.js (unit tests; also documents the contract). */
function memoryStore() {
  const reqs = new Map();
  const decs = new Map();
  let chain = Promise.resolve();
  const match = (r, where) => Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    reqs, decs,
    async createRequest(row) { reqs.set(row.requestId, { ...row }); },
    async getRequest(id) { const r = reqs.get(id); return r ? { ...r } : null; },
    async findRequests(where) { return [...reqs.values()].filter((r) => match(r, where)).map((r) => ({ ...r })); },
    async updateRequest(id, patch, expect) {
      const r = reqs.get(id);
      if (!r || (expect && !match(r, expect))) return false;
      Object.assign(r, patch);
      return true;
    },
    async createDecision(d) {
      if (decs.has(d.key)) { const e = new Error('duplicate'); e.duplicate = true; throw e; }
      decs.set(d.key, { ...d });
    },
    async listDecisions(id) { return [...decs.values()].filter((d) => d.requestId === id).map((d) => ({ ...d })); },
    // one at a time, like a row lock
    withRequestLock(id, fn) {
      const run = chain.then(async () => fn(await this.getRequest(id)));
      chain = run.catch(() => {});
      return run;
    },
  };
}

module.exports = { create, memoryStore, ApprovalError, TERMINAL };
