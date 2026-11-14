'use strict';

/**
 * Approvals, the runner and admin job control, wired to Strapi (1.0 hardening, Phase 4 stream G).
 * init() is called from the plugin's bootstrap; the admin API (admin-api.js), the ws_bulk gate (gate.js) and the
 * runner use the functions below.
 */
const T = require('./tiers');
const SVC = require('./service');
const STORE = require('./store');
const AT = require('../compat/admin-token');
const AD = require('../runner/adapter');
const RUN = require('../runner/runner');
const CFG = require('../config');

// runnerActive: true only once the workers are started. `runner.enabled` with a failed probe leaves it false, and
// approved jobs then run when the agent resumes them (review finding 2).
const ST = { strapi: null, service: null, leases: null, workers: [], approvalsCfg: undefined, runner: RUN.settings({}), runnerActive: false };

const bulkMax = (strapi) => require('../modules/_bulk/util').settings(strapi).bulk.maxDocuments;
/** Effective approval settings (the automatic tier follows writesafe.bulk.maxDocuments). */
const approvalSettings = (strapi = ST.strapi) => T.settings(ST.approvalsCfg, bulkMax(strapi));
const runnerSettings = () => ST.runner;
/**
 * Approvals work only with adminTokens 'mcp-only' (third review B2): with 'any', admin tokens authenticate on every
 * admin route, so an agent's token is not kept inside writesafe's guarantees; the approval tier is then off and jobs
 * above the automatic tier are refused (approval_needs_mcp_only), as in rc.2.
 */
const approvalsActive = (strapi = ST.strapi) => Boolean(approvalSettings(strapi).enabled && require('../compat/admin-tokens').mode() === 'mcp-only');
const approvalsState = (strapi = ST.strapi) => {
  if (!approvalSettings(strapi).enabled) return { active: false, reason: 'disabled' };
  if (require('../compat/admin-tokens').mode() !== 'mcp-only') return { active: false, reason: 'needs_mcp_only' };
  return { active: true, reason: null };
};
const runnerActive = () => Boolean(ST.runner.enabled && ST.runnerActive);

const KILL = { type: 'plugin', name: 'writesafe', key: 'jobs-kill-switch' };
async function killSwitch(strapi = ST.strapi) {
  // the runner's config switch, E's config switch (bulk.paused), or the admin's switch on the page: any stops jobs
  if (ST.runner.killSwitch || (strapi && AD.configPaused(strapi))) return true;
  try {
    const v = await strapi.store.get(KILL);
    return Boolean(v && v.on);
  } catch {
    return true; // fail closed: a switch that cannot be read counts as on (review finding 9)
  }
}
async function setKillSwitch(strapi, on, by) {
  await strapi.store.set({ ...KILL, value: { on: Boolean(on), by: by || null, at: Date.now() } });
  return killSwitch(strapi);
}
async function killSwitchState(strapi) {
  let v = null;
  try { v = await strapi.store.get(KILL); } catch { v = null; }
  return { on: await killSwitch(strapi), config: Boolean(ST.runner.killSwitch || AD.configPaused(strapi)), set_by: v && v.by ? v.by : null, set_at: v && v.at ? new Date(Number(v.at)).toISOString() : null };
}

/** Throws a plain error with code and status for the admin API and the gate. */
const fail = (code, message, status = 409, extra = {}) => { throw new SVC.ApprovalError(code, message, status, extra); };

/**
 * Starts an approved job: uses the approval once (bound to the plan hash recomputed from the stored job), marks the
 * job running and, with the runner on, hands it to the runner. One transaction: all or nothing.
 */
async function activate(strapi, job, requestId) {
  return strapi.db.transaction(async () => {
    const req = await ST.service.consume({ requestId, planId: job.job_id, planHash: AD.planHash(job) });
    const runner = runnerActive();
    const decisions = (await ST.service.get(requestId)).decisions || [];
    const j = await AD.setJobStatus(strapi, job.job_id, 'running', {
      from: ['awaiting_approval'],
      patch: { runner, approval: { ...(job.approval || {}), request_id: requestId, status: 'used', approved_by: decisions.filter((d) => d.decision === 'approve').length } },
    });
    if (!j) fail('job_not_waiting', 'The job is no longer waiting for approval.');
    if (runner) {
      await ST.leases.insert({ jobId: job.job_id, requestId, uid: job.uid, state: 'queued', owner: job.owner, tokenId: req.tokenId, permFingerprint: req.permFingerprint, updatedAtMs: Date.now() });
    }
    return { job: j, runner };
  });
}

/** Records an admin's decision; a final approval starts the job at once when the runner is on. */
async function decide(strapi, { requestId, admin, decision, planHash, note }) {
  const r = await ST.service.decide({ requestId, approver: admin, decision, planHash, note });
  let started = null;
  if (r.request.status === 'rejected') await AD.setJobStatus(strapi, r.request.planId, 'rejected', { from: ['awaiting_approval'] });
  if (r.request.status === 'approved') {
    const job = await AD.getJob(strapi, r.request.planId);
    // the job was pruned or deleted meanwhile: the approval stands but nothing will run (review finding 3)
    if (!job) return { ...r, started: false, start_error: { code: 'job_missing', message: 'The job of this request no longer exists (pruned or deleted); nothing will run. The agent has to start it again.' } };
    if (runnerActive() && job.status === 'awaiting_approval') {
      try {
        started = await activate(strapi, job, requestId);
      } catch (e) {
        // the decision stands; the job did not start (its plan changed, it was cancelled): say so, do not fail the decision
        if (!(e instanceof SVC.ApprovalError)) throw e;
        return { ...r, started: false, start_error: { code: e.code, message: e.message } };
      }
    }
  }
  return { ...r, started: Boolean(started) };
}

/** Undo jobs (stream F) are listed on the jobs page; their control stays with the agent (ws_undo). */
async function notUndo(strapi, jobId, job) {
  const j = job === undefined ? await AD.getJob(strapi, jobId) : job;
  if (AD.isUndo(j)) fail('not_supported', 'This is an undo job (ws_undo): the agent that started it continues or cancels it with ws_undo. The jobs page only lists it, and the kill switch does not stop it.');
  return j;
}

async function pause(strapi, jobId, by) {
  await notUndo(strapi, jobId);
  const j = await AD.setJobStatus(strapi, jobId, 'paused', { from: ['running', 'stopped'], reason: 'admin_job', detail: by });
  if (!j) fail('not_pausable', 'Only a running or stopped job can be paused.');
  await ST.leases.update(jobId, { state: 'paused', reason: 'admin_job', detail: by }, { state: ['queued', 'running', 'stopped'] });
  return j;
}

/**
 * Resumes a paused or stopped job. A runner job takes the token's CURRENT permissions as its new baseline (the admin
 * has looked at the change); a token that is revoked, expired or whose owner is inactive cannot be resumed.
 */
async function resume(strapi, jobId) {
  const job = await notUndo(strapi, jobId);
  if (!job || !['paused', 'stopped'].includes(job.status)) fail('not_resumable', 'Only a paused or stopped job can be resumed.');
  let lease = await ST.leases.get(jobId);
  // a runner job whose lease row is gone (pruned, deleted by hand) gets it back from its approval request (finding 14)
  const rid = job.approval && job.approval.request_id;
  const req = !lease && runnerActive() && job.runner && rid ? await ST.service.get(rid) : null;
  const tokenId = lease ? lease.tokenId : (req ? req.tokenId : null);
  const viaRunner = runnerActive() && Boolean(lease || req);
  let fp = null;
  if (viaRunner) {
    const chk = await AT.check(strapi, tokenId, job.uid);
    if (!chk.ok) fail('token_unusable', `The token that asked for this job cannot be used any more (${chk.reason}). Cancel the job.`);
    fp = chk.fingerprint;
  }
  const j = await AD.setJobStatus(strapi, jobId, 'running', { from: ['paused', 'stopped'], patch: viaRunner ? { runner: true } : {} });
  if (!j) fail('not_resumable', 'The job changed meanwhile; reload.');
  if (viaRunner && lease) await ST.leases.update(jobId, { state: 'queued', reason: null, detail: null, errors: 0, nextAttemptAt: null, permFingerprint: fp }, {});
  else if (viaRunner) {
    lease = { jobId, requestId: rid, uid: job.uid, state: 'queued', owner: job.owner, tokenId, permFingerprint: fp, updatedAtMs: Date.now() };
    await ST.leases.insert(lease);
  }
  return j;
}

async function cancel(strapi, jobId, by) {
  await notUndo(strapi, jobId);
  const j = await AD.setJobStatus(strapi, jobId, 'cancelled', { from: ['running', 'paused', 'stopped', 'awaiting_approval'], patch: { cancelled_by: by || null } });
  if (!j) fail('not_cancellable', 'Only a running, paused, stopped or waiting job can be cancelled.');
  await ST.leases.update(jobId, { state: 'cancelled' }, {});
  if (j.approval && j.approval.request_id) await ST.service.cancel(j.approval.request_id);
  return j;
}

/** Jobs for the admin page, with their runner lease (if any). */
async function jobs(strapi) {
  const list = await AD.listJobs(strapi, { limit: 50 });
  const ls = new Map((await ST.leases.list({})).map((l) => [l.jobId, l]));
  const ropts = require('../retention').opts();
  const AR = require('./retention');
  return list.map((j) => {
    const l = ls.get(j.job_id);
    const at = AR.pruneOn(j, new Date(j.updated_at || j.created_at || Date.now()).getTime(), ropts);
    return { ...j, prune_on: at ? new Date(at).toISOString() : null, lease: l ? { state: l.state, reason: l.reason || null, detail: l.detail || null, worker: l.leaseOwner || null, lease_until: l.leaseUntil ? new Date(l.leaseUntil).toISOString() : null, fence: l.fence, errors: l.errors || 0, events: (l.events || []).slice(-10) } : null };
  });
}

function startRunner(strapi) {
  ST.runnerActive = false;
  if (!ST.runner.enabled) return;
  if (!AT.probe(strapi)) { strapi.log.error('[writesafe] runner NOT started: the token ability internals are missing (compat report)'); return; }
  if (STORE.READY.ok === false) { strapi.log.error('[writesafe] runner NOT started: the job lease table has no unique index'); return; }
  // A chunk holds the lease row's lock while it runs (lease.js): it must stay well under the lease (finding 11).
  // through the adapter (re-review A5): B's bulk.chunkTimeMs; with the cap turned off (0), 1 s is assumed
  let chunkCap;
  try { chunkCap = AD.chunkTimeMs(strapi) || 1000; } catch (e) { strapi.log.error(`[writesafe] runner NOT started: ${e.message}`); return; }
  if (ST.runner.leaseMs < 3 * chunkCap) { strapi.log.error(`[writesafe] runner NOT started: runner.leaseMs (${ST.runner.leaseMs}) must be at least 3 x bulk.chunkTimeMs (${chunkCap})`); return; }
  const adapter = {
    runOneChunk: (args) => AD.runOneChunk(strapi, args),
    setJobStatus: (jobId, to, opts) => AD.setJobStatus(strapi, jobId, to, opts),
  };
  const tokens = { check: (tokenId, uid) => AT.check(strapi, tokenId, uid) };
  for (let i = 0; i < ST.runner.workers; i += 1) {
    const w = RUN.createWorker({ store: ST.leases, adapter, tokens, settings: ST.runner, killSwitch: () => killSwitch(strapi), log: strapi.log });
    ST.workers.push(w);
    w.start();
  }
  ST.runnerActive = true;
  strapi.log.info(`[writesafe] job runner on: ${ST.runner.workers} worker(s), lease ${ST.runner.leaseMs} ms, pacing ${ST.runner.chunkPauseMs} ms`);
}

async function stopRunner() {
  ST.runnerActive = false;
  const ws = ST.workers;
  ST.workers = [];
  await Promise.all(ws.map((w) => w.stop()));
}

/** Is this admin still active and still allowed to approve writesafe jobs? (earlier approvals at the final decision) */
async function isStillApprover(strapi, approverId, req) {
  try {
    const user = await strapi.db.query('admin::user').findOne({ where: { id: Number.isNaN(Number(approverId)) ? approverId : Number(approverId) }, populate: ['roles'] });
    if (!user || user.isActive !== true || user.blocked === true) return false;
    const ability = await strapi.admin.services.permission.engine.generateUserAbility(user);
    // still holds the permission AND may still do what the job does (re-review A4)
    return Boolean(ability.can('plugin::writesafe.approve-jobs')) && (!req || require('./approver').mayActWith(strapi, ability, req));
  } catch {
    return false; // fail closed: an approval that cannot be confirmed does not count
  }
}

async function init(strapi) {
  const cfg = CFG.get(strapi);
  ST.strapi = strapi;
  ST.approvalsCfg = cfg.approvals;
  ST.runner = RUN.settings(cfg.runner);
  ST.service = SVC.create({ store: STORE.approvals(strapi), settings: () => approvalSettings(strapi), isStillApprover: (id, req) => isStillApprover(strapi, id, req) });
  ST.leases = STORE.leases(strapi);
  await STORE.ensureIndexes(strapi);
  AT.probe(strapi);
  // date every admin's credentials from now on (first observation: their createdAt; third review B4)
  require('./credentials').subscribe(strapi);
  try { await require('./credentials').observeAll(strapi); } catch (e) { strapi.log.warn(`[writesafe] could not record admin credentials: ${e.message}`); }
}

module.exports = { ST, init, approvalSettings, approvalsActive, approvalsState, runnerSettings, runnerActive, killSwitch, setKillSwitch, killSwitchState, activate, decide, pause, resume, cancel, jobs, startRunner, stopRunner, fail };
