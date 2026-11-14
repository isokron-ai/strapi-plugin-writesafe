'use strict';

/**
 * The plugin's admin API (1.0 hardening, Phase 4 stream G), used by the Write-safe jobs page in the admin panel.
 * Mounted by Strapi at /writesafe/... with admin authentication. Every route needs:
 *   - an admin SESSION (someone signed in to the admin panel). Strapi also accepts admin API tokens on admin routes,
 *     and MCP agents hold admin API tokens, so the `session-only` policy refuses them: an agent cannot approve, list
 *     the samples, pause or resume, even with a token that holds every permission;
 *   - the RBAC action plugin::writesafe.approve-jobs ("Approve writesafe jobs"; Super Admins have it, other roles
 *     only when given it in Settings > Roles).
 */
const C = require('./control');
const AD = require('../runner/adapter');
const { ApprovalError } = require('./service');

const ACTION = 'plugin::writesafe.approve-jobs';
const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

/** Is this request an admin panel session (not an admin API token)? */
const isSession = (ctx) => Boolean(ctx.state && ctx.state.auth && ctx.state.auth.strategy && ctx.state.auth.strategy.name === 'admin' && ctx.state.user);

const policies = {
  // false = Strapi's own 403 (a thrown PolicyError from the plugin's copy of @strapi/utils became a 500 on 5.47.1)
  'session-only': (policyContext) => isSession(policyContext),
};

const admin = async (ctx) => {
  const u = ctx.state.user;
  const name = [u.firstname, u.lastname].filter(Boolean).join(' ') || u.username || u.email || `admin ${u.id}`;
  // createdAt/updatedAt: decide() refuses an account created or changed after the request (review finding 1b);
  // mayAct: the admin's own ability must allow the job's action on its type (finding 7)
  // re-review A4: every touched field and the locale, through the admin's own permission checker
  const ability = ctx.state.userAbility;
  const mayAct = (req) => require('./approver').mayActWith(strapi, ability, req);
  // the last change of the admin's credentials, not of any profile field (third review B4)
  let credentialsSince = null;
  try { credentialsSince = await require('./credentials').credentialsSince(strapi, u.id); } catch { credentialsSince = Date.now(); }
  return { id: u.id, name, viaSession: isSession(ctx), createdAt: u.createdAt, updatedAt: u.updatedAt, credentialsSince, mayAct };
};

function requestView(r) {
  return {
    request_id: r.requestId, plan_id: r.planId, plan_hash: r.planHash, manifest_root: r.manifestRoot, status: r.status,
    tier: r.tier, approvals_needed: r.requiredApprovals, reason: r.reason, tool: r.tool, uid: r.uid, locale: r.locale, action: r.action,
    count: r.count, filter: r.filter || null, filter_summary: r.filter ? JSON.stringify(r.filter) : r.filterSummary, spec: r.spec, samples: r.samples || [],
    requested_by: { token_id: r.tokenId, token_name: r.tokenName, owner_user_id: r.ownerUserId, agent: r.agent, owner_may_approve: r.ownerMayApprove !== false },
    requested_at: iso(r.requestedAt), expires_at: iso(r.expiresAt), approved_at: iso(r.approvedAt), approval_expires_at: iso(r.approvalExpiresAt), consumed_at: iso(r.consumedAt),
    decisions: (r.decisions || []).map((d) => ({ approver_id: d.approverId, approver_name: d.approverName, decision: d.decision, plan_hash: d.planHash, decided_at: iso(d.decidedAt), note: d.note })),
  };
}

/** The viewing admin: id, when their credentials last changed, the quiet period (re-review A1.3, third review B4). */
async function meOf(ctx) {
  const u = ctx.state.user;
  let changed = null;
  try { changed = await require('./credentials').credentialsSince(strapi, u.id); } catch { changed = null; }
  return { id: u.id, account_changed_at: changed ? new Date(changed).toISOString() : null, quiet_hours: C.approvalSettings().approverQuietHours };
}

/** The request as THIS admin may see it: samples, change and filter through their own read permission (finding 4). */
const viewFor = (ctx, r) => require('./view').approverView(ctx.state.userAbility, requestView(r), (uid) => strapi.contentTypes[uid] || strapi.components[uid] || null);

async function handle(ctx, fn) {
  try {
    ctx.body = await fn();
  } catch (e) {
    if (e instanceof ApprovalError) {
      ctx.status = e.status;
      ctx.body = { error: { code: e.code, message: e.message, ...(e.extra || {}) } };
      return;
    }
    throw e;
  }
}

const controllers = {
  jobs: {
    async approvals(ctx) {
      await handle(ctx, async () => {
        const status = typeof ctx.query.status === 'string' && ctx.query.status ? ctx.query.status : undefined;
        const list = await C.ST.service.list(status ? { status } : {});
        return { data: list.slice(0, 100).map((r) => viewFor(ctx, r)), me: await meOf(ctx), admin_tokens: require('../compat/admin-tokens').mode() };
      });
    },
    async approval(ctx) {
      await handle(ctx, async () => {
        const r = await C.ST.service.get(ctx.params.id);
        if (!r) throw new ApprovalError('not_found', 'No such approval request.', 404);
        return { data: viewFor(ctx, r) };
      });
    },
    async decide(ctx) {
      await handle(ctx, async () => {
        const body = ctx.request.body || {};
        const decision = ctx.params.decision === 'approve' ? 'approve' : (ctx.params.decision === 'reject' ? 'reject' : null);
        const r = await C.decide(strapi, { requestId: ctx.params.id, admin: await admin(ctx), decision, planHash: body.plan_hash, note: body.note });
        return { data: viewFor(ctx, { ...r.request, decisions: r.decisions }), approvals: r.approvals, required: r.required, started: r.started, ...(r.dropped && r.dropped.length ? { dropped_approvals: r.dropped } : {}), ...(r.start_error ? { start_error: r.start_error } : {}) };
      });
    },
    async list(ctx) {
      await handle(ctx, async () => ({ data: await C.jobs(strapi), admin_tokens: require('../compat/admin-tokens').mode(), approvals: C.approvalsState(strapi), kill_switch: await C.killSwitchState(strapi), runner: { enabled: C.runnerSettings().enabled, active: C.runnerActive(), workers: C.runnerSettings().workers } }));
    },
    async control(ctx) {
      await handle(ctx, async () => {
        const by = await admin(ctx);
        const id = ctx.params.id;
        const op = ctx.params.op;
        let j;
        if (op === 'pause') j = await C.pause(strapi, id, `${by.name} (${by.id})`);
        else if (op === 'resume') j = await C.resume(strapi, id);
        else if (op === 'cancel') j = await C.cancel(strapi, id, `${by.name} (${by.id})`);
        else throw new ApprovalError('invalid', 'op must be pause, resume or cancel', 400);
        return { data: AD.summary(j) };
      });
    },
    async killSwitch(ctx) {
      await handle(ctx, async () => {
        if (ctx.method === 'PUT') {
          const by = await admin(ctx);
          await C.setKillSwitch(strapi, Boolean((ctx.request.body || {}).on), `${by.name} (${by.id})`);
        }
        return { data: await C.killSwitchState(strapi) };
      });
    },
  },
};

const pol = ['admin::isAuthenticatedAdmin', 'plugin::writesafe.session-only', { name: 'admin::hasPermissions', config: { actions: [ACTION] } }];
const route = (method, path, handler) => ({ method, path, handler: `jobs.${handler}`, config: { policies: pol } });
const routes = {
  admin: {
    type: 'admin',
    routes: [
      route('GET', '/approvals', 'approvals'),
      route('GET', '/approvals/:id', 'approval'),
      route('POST', '/approvals/:id/:decision', 'decide'),
      route('GET', '/jobs', 'list'),
      route('POST', '/jobs/:id/:op', 'control'),
      route('GET', '/kill-switch', 'killSwitch'),
      route('PUT', '/kill-switch', 'killSwitch'),
    ],
  },
};

async function registerActions(strapi) {
  const p = strapi.admin && strapi.admin.services && strapi.admin.services.permission;
  if (!p || !p.actionProvider || typeof p.actionProvider.registerMany !== 'function') {
    strapi.log.error('[writesafe] could not register the "Approve writesafe jobs" permission: the approval page is unreachable');
    return false;
  }
  await p.actionProvider.registerMany([{ section: 'plugins', displayName: 'Approve writesafe jobs', uid: 'approve-jobs', pluginName: 'writesafe' }]);
  return true;
}

module.exports = { routes, controllers, policies, registerActions, ACTION, isSession, requestView };
