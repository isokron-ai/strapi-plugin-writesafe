// The "Write-safe jobs" admin page (1.0 hardening, Phase 4 stream G).
// - Waiting for approval: each bulk job an agent asked for above the automatic tier, with what it will do (count,
//   target, action, filter, manifest root, a before/after sample) and who asked (token, agent label). Approve or reject;
//   the decision is sent with the plan hash shown here and is refused if the plan changed.
// - Jobs: progress of recent jobs, with pause, resume and cancel, and a kill switch that stops every bulk job.
// Every call goes to the plugin's admin API (/writesafe/...), which accepts only a signed-in admin session with the
// "Approve writesafe jobs" permission.
import * as React from 'react';
import { Page, Layouts, useFetchClient, useNotification } from '@strapi/strapi/admin';
import { Box, Flex, Typography, Button, Badge, Table, Thead, Tbody, Tr, Th, Td, Divider, Loader } from '@strapi/design-system';

const h = React.createElement;
const short = (s, n = 12) => (s ? `${String(s).slice(0, n)}…` : '–');
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '–');
const show = (v) => {
  if (v === undefined) return '–';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};
const errText = (e) => (e && e.response && e.response.data && e.response.data.error && e.response.data.error.message) || (e && e.message) || 'Request failed';

const STATUS = {
  pending: ['warning', 'Waiting'], approved: ['success', 'Approved'], rejected: ['danger', 'Rejected'], expired: ['neutral', 'Expired'],
  consumed: ['success', 'Started'], cancelled: ['neutral', 'Cancelled'],
  running: ['primary', 'Running'], paused: ['warning', 'Paused'], stopped: ['danger', 'Stopped'], done: ['success', 'Done'],
  awaiting_approval: ['warning', 'Waiting for approval'],
};
const StatusBadge = ({ status }) => {
  const [variant, label] = STATUS[status] || ['neutral', status];
  return h(Badge, { variant, size: 'S' }, label);
};

const Fact = ({ label, children, title }) => h(Box, { minWidth: '12rem', style: { flex: '1 1 12rem', minWidth: 0 } },
  h(Typography, { variant: 'sigma', textColor: 'neutral600', tag: 'p' }, label),
  h(Typography, { variant: 'omega', tag: 'p', title, style: { overflowWrap: 'anywhere' } }, children));

function Samples({ samples }) {
  const rows = [];
  for (const s of samples || []) {
    const fields = s.changed && s.changed.length ? s.changed : [null];
    for (const f of fields) {
      rows.push({ key: `${s.documentId}:${f}`, documentId: s.documentId, field: f || (s.status === 'failed' ? 'error' : '–'),
        before: f ? show(s.before && s.before[f]) : (s.error ? s.error.code : show(s.status)), after: f ? show(s.after && s.after[f]) : (s.error ? s.error.message : '–') });
    }
  }
  if (!rows.length) return h(Typography, { variant: 'pi', textColor: 'neutral600' }, 'No sample (the server is set to take none).');
  return h(Box, { style: { overflowX: 'auto' } }, h(Table, { colCount: 4, rowCount: rows.length + 1 },
    h(Thead, null, h(Tr, null, ...['Document', 'Field', 'Before', 'After'].map((t) => h(Th, { key: t }, h(Typography, { variant: 'sigma' }, t))))),
    h(Tbody, null, ...rows.map((r) => h(Tr, { key: r.key },
      h(Td, null, h(Typography, { variant: 'pi' }, short(r.documentId, 10))),
      h(Td, null, h(Typography, { variant: 'pi' }, r.field)),
      h(Td, null, h(Typography, { variant: 'pi', textColor: 'danger700', style: { overflowWrap: 'anywhere' } }, r.before)),
      h(Td, null, h(Typography, { variant: 'pi', textColor: 'success700', style: { overflowWrap: 'anywhere' } }, r.after)))))));
}

// the whole value, never cut: scrolls inside its own box
const Code = ({ testid, children }) => h(Box, { background: 'neutral100', hasRadius: true, padding: 3, marginTop: 1, style: { maxHeight: '14rem', overflow: 'auto' } },
  h(Typography, { variant: 'pi', tag: 'pre', 'data-testid': testid, style: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'monospace' } }, children));
const pretty = (f) => {
  if (!f) return '{} (every document)';
  try { return JSON.stringify(JSON.parse(f), null, 2); } catch { return f; }
};

function RequestCard({ r, me, meInfo, busy, onDecide }) {
  const ownsToken = r.requested_by.owner_user_id != null && String(r.requested_by.owner_user_id) === String(me);
  // re-review A1.3: the viewer's account age against the quiet period before this request
  const changedAt = meInfo && meInfo.account_changed_at ? new Date(meInfo.account_changed_at).getTime() : null;
  const hoursAgo = changedAt ? Math.round((Date.now() - changedAt) / 3600000) : null;
  const quiet = meInfo ? meInfo.quiet_hours || 0 : 0;
  const tooRecent = changedAt != null && r.requested_at && (changedAt > new Date(r.requested_at).getTime() || (quiet && changedAt > new Date(r.requested_at).getTime() - quiet * 3600000));
  const approvals = r.decisions.filter((d) => d.decision === 'approve');
  const mine = r.decisions.find((d) => String(d.approver_id) === String(me));
  const what = r.action === 'publish' ? 'Publish' : (r.tool === 'ws_replace' ? 'Find and replace' : 'Patch');
  const andPublish = r.action !== 'publish' && r.spec && r.spec.publish === 'if_clean' ? ' and publish (if clean)' : '';
  const reason = { count: 'Above the automatic limit', publish: 'Bulk publish needs approval', relations: 'Relation edit needs approval' }[r.reason] || r.reason;
  return h(Box, { background: 'neutral0', shadow: 'tableShadow', hasRadius: true, padding: 6, 'data-testid': 'approval-card' },
    h(Flex, { justifyContent: 'space-between', alignItems: 'flex-start', gap: 4, wrap: 'wrap' },
      h(Box, { style: { minWidth: 0 } },
        h(Typography, { variant: 'delta', tag: 'h3' }, `${what} ${r.count.toLocaleString()} documents${andPublish}`),
        h(Typography, { variant: 'pi', textColor: 'neutral600', tag: 'p', style: { overflowWrap: 'anywhere' } }, `${r.uid}${r.locale ? ` · ${r.locale}` : ''} · ${reason}`)),
      h(Flex, { gap: 2, wrap: 'wrap' },
        h(Badge, { variant: r.approvals_needed === 2 ? 'danger' : 'secondary', size: 'S' }, r.approvals_needed === 2 ? 'Two different admins' : 'One admin'),
        h(StatusBadge, { status: r.status }))),
    h(Box, { paddingTop: 4, paddingBottom: 4 }, h(Divider, null)),
    h(Flex, { gap: 4, wrap: 'wrap', alignItems: 'flex-start' },
      h(Fact, { label: 'Requested by' }, `${r.requested_by.token_name || 'token'} (#${r.requested_by.token_id})`,
        ownsToken ? h(Typography, { variant: 'pi', textColor: 'warning600', tag: 'span', fontWeight: 'bold', style: { display: 'block' } }, 'You own the requesting token') : null),
      h(Fact, { label: 'Agent label (supplied by the agent)' }, r.requested_by.agent || 'none'),
      h(Fact, { label: 'Fields it touches' }, h('span', { 'data-testid': 'touched-fields' }, (r.fields || []).join(', ') || '–')),
      h(Fact, { label: 'Manifest root', title: r.manifest_root }, short(r.manifest_root, 16)),
      h(Fact, { label: 'Plan hash', title: r.plan_hash }, short(r.plan_hash, 16)),
      h(Fact, { label: 'Decide by' }, when(r.expires_at)),
      h(Fact, { label: 'Approvals' }, `${approvals.length} of ${r.approvals_needed}${approvals.length ? ` (${approvals.map((d) => d.approver_name).join(', ')})` : ''}`)),
    h(Flex, { paddingTop: 4, gap: 4, wrap: 'wrap', alignItems: 'flex-start' },
      h(Box, { style: { flex: '1 1 18rem', minWidth: 0 } },
        h(Typography, { variant: 'sigma', textColor: 'neutral600', tag: 'p' }, 'The change, in full'),
        h(Code, { testid: 'change-full' }, JSON.stringify(r.spec, null, 2))),
      h(Box, { style: { flex: '1 1 18rem', minWidth: 0 } },
        h(Typography, { variant: 'sigma', textColor: 'neutral600', tag: 'p' }, 'The filter, in full'),
        h(Code, { testid: 'filter-full' }, pretty(r.filter_summary)))),
    h(Box, { paddingTop: 4 }, h(Typography, { variant: 'sigma', textColor: 'neutral600', tag: 'p' }, 'Sample: before and after')),
    h(Box, { paddingTop: 2 }, r.samples_hidden ? h(Typography, { variant: 'pi', textColor: 'neutral600' }, r.samples_hidden === 'conditional_read' ? 'Hidden: your read permission on this type has conditions, so samples are not shown.' : 'Hidden: you cannot read this content type.') : h(Samples, { samples: r.samples })),
    r.status === 'pending' ? h(Box, { paddingTop: 4 }, h(Typography, { variant: 'pi', textColor: tooRecent ? 'danger600' : 'neutral600', 'data-testid': 'account-age' },
      `Your account changed ${hoursAgo == null ? '?' : hoursAgo} h ago.${tooRecent ? ` Approvers need an account unchanged for ${quiet} h before the request, so you can only reject this one.` : ''}`
      + (ownsToken && r.requested_by.owner_may_approve === false ? ' You own the requesting token and your account changed in the quiet period before it: another admin must approve.' : ''))) : null,
    r.status === 'pending' ? h(Flex, { paddingTop: 4, gap: 2, wrap: 'wrap', justifyContent: 'flex-end' },
      mine ? h(Typography, { variant: 'pi', textColor: 'neutral600' }, `You ${mine.decision === 'approve' ? 'approved' : 'rejected'} this. ${r.approvals_needed === 2 ? 'A second, different admin must approve it too.' : ''}`) : null,
      h(Button, { variant: 'danger-light', disabled: busy || Boolean(mine), onClick: () => onDecide(r, 'reject') }, 'Reject'),
      h(Button, { variant: 'success', disabled: busy || Boolean(mine) || tooRecent || (ownsToken && r.requested_by.owner_may_approve === false), onClick: () => onDecide(r, 'approve') }, 'Approve')) : null);
}

// a plain bar on the theme's colors (the design system's ProgressBar is drawn for dark surfaces such as upload dialogs)
const Bar = ({ pct }) => h(Box, { background: 'neutral150', hasRadius: true, style: { height: 6, overflow: 'hidden' }, role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
  h(Box, { background: pct >= 100 ? 'success500' : 'primary600', style: { height: '100%', width: `${pct}%` } }));

function JobsTable({ jobs, busy, onControl }) {
  if (!jobs.length) return h(Box, { background: 'neutral0', hasRadius: true, shadow: 'tableShadow', padding: 6 }, h(Typography, { textColor: 'neutral600' }, 'No bulk jobs yet.'));
  return h(Box, { style: { overflowX: 'auto' } }, h(Table, { colCount: 5, rowCount: jobs.length + 1 },
    h(Thead, null, h(Tr, null, ...['Job', 'Target', 'Progress', 'Status', 'Actions'].map((t) => h(Th, { key: t }, h(Typography, { variant: 'sigma' }, t))))),
    h(Tbody, null, ...jobs.map((j) => {
      const pct = j.total ? Math.round((100 * (j.processed || 0)) / j.total) : 0;
      // an undo job (ws_undo) is listed only: the agent that started it continues or cancels it
      const undo = j.kind === 'undo';
      const canPause = !undo && ['running', 'stopped'].includes(j.status);
      const canResume = !undo && ['paused', 'stopped'].includes(j.status);
      const canCancel = !undo && ['running', 'paused', 'stopped', 'awaiting_approval'].includes(j.status);
      return h(Tr, { key: j.job_id },
        h(Td, null, h(Typography, { variant: 'pi', title: j.job_id }, short(j.job_id, 10)), h(Typography, { variant: 'pi', textColor: 'neutral600', tag: 'p' }, `${j.action}${j.agent ? ` · ${j.agent}` : ''}`)),
        h(Td, null, h(Typography, { variant: 'pi' }, undo ? `undo of ${short(j.undo_of || '', 10)}` : `${j.uid}${j.locale ? ` · ${j.locale}` : ''}`),
          j.prune_on ? h(Typography, { variant: 'pi', textColor: 'neutral500', tag: 'p' }, `pruned on ${when(j.prune_on)} if idle`) : null),
        h(Td, null, h(Flex, { direction: 'column', alignItems: 'stretch', gap: 1, style: { minWidth: '8rem' } },
          h(Bar, { pct }), h(Typography, { variant: 'pi', textColor: 'neutral600' }, `${(j.processed || 0).toLocaleString()} / ${j.total.toLocaleString()}`))),
        h(Td, null, h(Flex, { direction: 'column', alignItems: 'flex-start', gap: 1 },
          h(StatusBadge, { status: j.status }),
          j.pause_reason ? h(Typography, { variant: 'pi', textColor: 'warning600' }, j.pause_reason === 'permission_changed' ? `permissions changed${j.pause_detail ? ` (${j.pause_detail})` : ''}` : j.pause_reason) : null,
          j.lease ? h(Typography, { variant: 'pi', textColor: j.lease.state === 'failed' ? 'danger600' : 'neutral600' }, `runner: ${j.lease.state}${j.lease.reason ? ` (${j.lease.reason})` : ''}`) : null)),
        h(Td, null, h(Flex, { gap: 1, wrap: 'wrap' },
          undo ? h(Typography, { variant: 'pi', textColor: 'neutral600' }, 'run by the agent (ws_undo)') : null,
          canPause ? h(Button, { size: 'S', variant: 'secondary', disabled: busy, onClick: () => onControl(j, 'pause') }, 'Pause') : null,
          canResume ? h(Button, { size: 'S', variant: 'secondary', disabled: busy, onClick: () => onControl(j, 'resume') }, 'Resume') : null,
          canCancel ? h(Button, { size: 'S', variant: 'danger-light', disabled: busy, onClick: () => onControl(j, 'cancel') }, 'Cancel') : null)));
    }))));
}

export function JobsPage() {
  const { get, post, put } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [state, setState] = React.useState({ loading: true, approvals: [], jobs: [], kill: { on: false }, runner: { enabled: false }, me: null, error: null });
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [a, j] = await Promise.all([get('/writesafe/approvals'), get('/writesafe/jobs')]);
      setState({ loading: false, approvals: a.data.data, me: a.data.me.id, meInfo: a.data.me, adminTokens: j.data.admin_tokens, approvalsState: j.data.approvals, jobs: j.data.data, kill: j.data.kill_switch, runner: j.data.runner, error: null });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: errText(e) }));
    }
  }, [get]);
  React.useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const act = async (fn, ok) => {
    setBusy(true);
    try { await fn(); toggleNotification({ type: 'success', message: ok }); } catch (e) { toggleNotification({ type: 'danger', message: errText(e) }); }
    setBusy(false);
    load();
  };
  const onDecide = (r, decision) => act(async () => {
    const res = await post(`/writesafe/approvals/${r.request_id}/${decision}`, { plan_hash: r.plan_hash });
    if (res.data.start_error) toggleNotification({ type: 'warning', message: `Approved, but the job did not start: ${res.data.start_error.message}` });
    if (res.data.dropped_approvals) toggleNotification({ type: 'warning', message: 'An earlier approval no longer counts: its admin is inactive or lost the permission.' });
  }, decision === 'approve' ? 'Approval recorded' : 'Job rejected');
  const onControl = (j, op) => act(() => post(`/writesafe/jobs/${j.job_id}/${op}`, {}), { pause: 'Job paused', resume: 'Job resumed', cancel: 'Job cancelled' }[op]);
  const onKill = () => act(() => put('/writesafe/kill-switch', { on: !state.kill.on }), state.kill.on ? 'Bulk jobs allowed again' : 'All bulk jobs stopped');

  const pending = state.approvals.filter((r) => r.status === 'pending');
  const decided = state.approvals.filter((r) => r.status !== 'pending').slice(0, 20);

  return h(Page.Main, null,
    h(Page.Title, null, 'Write-safe jobs'),
    h(Layouts.Header, {
      title: 'Write-safe jobs',
      subtitle: 'Bulk changes agents asked for. Only an admin can approve them here; nothing an agent sends counts as approval.',
      primaryAction: h(Button, { variant: state.kill.on ? 'secondary' : 'danger', disabled: busy || state.kill.config, onClick: onKill }, state.kill.on ? 'Allow bulk jobs again' : 'Stop all bulk jobs'),
    }),
    h(Layouts.Content, null,
      state.loading ? h(Flex, { justifyContent: 'center', padding: 8 }, h(Loader, null, 'Loading')) : h(Flex, { direction: 'column', alignItems: 'stretch', gap: 8 },
        state.error ? h(Box, { background: 'danger100', padding: 4, hasRadius: true }, h(Typography, { textColor: 'danger700' }, state.error)) : null,
        h(Box, { background: state.adminTokens === 'mcp-only' ? 'success100' : 'warning100', padding: 4, hasRadius: true, 'data-testid': 'admin-tokens' },
          h(Typography, { textColor: state.adminTokens === 'mcp-only' ? 'success700' : 'warning700' }, state.adminTokens === 'mcp-only'
            ? 'Admin API tokens: MCP only. Agents holding admin tokens cannot call the admin HTTP API (content manager, users, tokens) directly.'
            : 'Approvals are off: they need writesafe.adminTokens set to "mcp-only". With "any", admin API tokens work on every admin route, so an agent with an admin token and HTTP access is not limited to writesafe; jobs above the automatic limit are refused (approval_needs_mcp_only).')),
        state.kill.on ? h(Box, { background: 'danger100', borderColor: 'danger200', padding: 4, hasRadius: true, 'data-testid': 'kill-switch-on' },
          h(Typography, { textColor: 'danger700', fontWeight: 'bold' }, `All bulk jobs are stopped${state.kill.config ? ' by the server config (writesafe.runner.killSwitch)' : (state.kill.set_by ? ` by ${state.kill.set_by}` : '')}. No chunk runs until they are allowed again.`)) : null,
        h(Flex, { direction: 'column', alignItems: 'stretch', gap: 4 },
          h(Typography, { variant: 'beta', tag: 'h2' }, `Waiting for approval (${pending.length})`),
          pending.length ? h(Flex, { direction: 'column', alignItems: 'stretch', gap: 4 }, ...pending.map((r) => h(RequestCard, { key: r.request_id, r, me: state.me, meInfo: state.meInfo, busy, onDecide })))
            : h(Box, { background: 'neutral0', hasRadius: true, shadow: 'tableShadow', padding: 6 }, h(Typography, { textColor: 'neutral600' }, 'Nothing is waiting for approval.'))),
        h(Flex, { direction: 'column', alignItems: 'stretch', gap: 4 },
          h(Flex, { justifyContent: 'space-between', alignItems: 'baseline', wrap: 'wrap', gap: 2 },
            h(Typography, { variant: 'beta', tag: 'h2' }, 'Jobs'),
            h(Typography, { variant: 'pi', textColor: 'neutral600' }, state.runner.active ? `Runner on (${state.runner.workers} worker${state.runner.workers === 1 ? '' : 's'}): approved jobs run on the server.` : (state.runner.enabled ? 'Runner enabled but NOT running (see the server log): approved jobs run when the agent resumes them.' : 'Runner off: approved jobs run when the agent resumes them.'))),
          h(JobsTable, { jobs: state.jobs, busy, onControl })),
        decided.length ? h(Flex, { direction: 'column', alignItems: 'stretch', gap: 4 },
          h(Typography, { variant: 'beta', tag: 'h2' }, 'Recent decisions'),
          h(Box, { style: { overflowX: 'auto' } }, h(Table, { colCount: 4, rowCount: decided.length + 1 },
            h(Thead, null, h(Tr, null, ...['Request', 'Documents', 'Status', 'Decided by'].map((t) => h(Th, { key: t }, h(Typography, { variant: 'sigma' }, t))))),
            h(Tbody, null, ...decided.map((r) => h(Tr, { key: r.request_id },
              h(Td, null, h(Typography, { variant: 'pi' }, `${r.action} ${r.uid}`)),
              h(Td, null, h(Typography, { variant: 'pi' }, r.count.toLocaleString())),
              h(Td, null, h(StatusBadge, { status: r.status })),
              h(Td, null, h(Typography, { variant: 'pi' }, r.decisions.map((d) => `${d.approver_name}: ${d.decision}`).join(', ') || '–')))))))) : null)));
}

