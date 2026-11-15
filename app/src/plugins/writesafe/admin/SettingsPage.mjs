// Settings > Write-safe MCP: the effective configuration, where each value comes from, and the few safety settings an
// admin may tighten at runtime (never loosen). config/plugins stays the source of truth; see server/settings.
import * as React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Page, Layouts, useFetchClient, useNotification, useRBAC } from '@strapi/strapi/admin';
import { Box, Flex, Grid, Typography, Button, Badge, Toggle, NumberInput, Checkbox, Field, Link, Loader } from '@strapi/design-system';

const h = React.createElement;
export const PERMISSIONS = { read: [{ action: 'plugin::writesafe.settings.read', subject: null }], update: [{ action: 'plugin::writesafe.settings.update', subject: null }] };
const errText = (e) => (e && e.response && e.response.data && e.response.data.error && e.response.data.error.message) || (e && e.message) || 'Request failed';
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '–');

export function fmt(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (v == null) return '–';
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(empty)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
const SOURCE = { config: ['secondary', 'config file'], default: ['neutral', 'default'], derived: ['neutral', 'derived'], runtime: ['warning', 'tightened here'], 'config or default': ['neutral', 'config or default'] };
const Source = ({ s }) => { const [variant, label] = SOURCE[s] || ['neutral', s]; return h(Badge, { variant, size: 'S' }, label); };
const NOTE = {
  builtinUpdates: 'Strapi\'s own update_/write_/publish_<type> tools: keep, guide, guard or hide', allowForce: 'agents may skip the version check with force: true',
  adminTokens: 'mcp-only: admin API tokens work only on the MCP endpoint (needed for approvals)', 'approvals.automaticMax': 'jobs up to this size start without approval',
  'approvals.twoApproverAbove': 'two different admins above this', 'approvals.maxDocuments': 'refused above this, whatever the approvals', 'bulk.paused': 'config kill switch',
  'media.allow': 'hosts agents may import from; empty = none', 'runner.killSwitch': 'config kill switch',
};

// the runtime-tightenable settings: [key, label, kind, hint]
export const EDITABLE = [
  ['approvals.escalate.publish', 'Every bulk publish needs an approval', 'on'],
  ['approvals.escalate.relations', 'Every bulk relation edit needs an approval', 'on'],
  ['approvals.requesterMayApprove', 'The token\'s owner may approve its own job', 'off'],
  ['approvals.automaticMax', 'Jobs start without approval up to (documents)', 'lower'],
  ['approvals.twoApproverAbove', 'Two different admins must approve above (documents)', 'lower'],
  ['approvals.maxDocuments', 'Largest job an approval can allow (documents)', 'lower'],
  ['approvals.approverQuietHours', 'Approver account unchanged for at least (hours)', 'raise'],
];

/** The draft (effective values) from the server's view: { key: value, 'media.disabled': [...] }. */
export function draftOf(d) {
  const rows = Object.fromEntries(d.sections.flatMap((s) => s.rows).map((r) => [r.key, r]));
  const out = {};
  for (const [k] of EDITABLE) out[k] = rows[k].value;
  // only entries still in the config file's media.allow: a host removed from the file has no checkbox to clear
  const off = d.overrides.values['media.disabled'];
  out['media.disabled'] = Array.isArray(off) ? off.filter((e) => d.media_file_allow.includes(e)) : [];
  return { draft: out, rows };
}
/** What the page sends: every editable value that differs from the config file's (the server drops no-ops too). */
export function valuesOf(draft, rows) {
  const v = {};
  for (const [k] of EDITABLE) {
    const fileV = rows[k].source === 'runtime' ? rows[k].file : rows[k].value;
    if (draft[k] !== fileV && draft[k] !== undefined && draft[k] !== null) v[k] = draft[k];
  }
  if (draft['media.disabled'].length) v['media.disabled'] = draft['media.disabled'];
  return v;
}

function Card({ title, subtitle, children, testid }) {
  return h(Box, { background: 'neutral0', shadow: 'tableShadow', hasRadius: true, padding: 6, 'data-testid': testid },
    h(Typography, { variant: 'delta', tag: 'h2' }, title),
    subtitle ? h(Box, { paddingTop: 1 }, h(Typography, { variant: 'pi', textColor: 'neutral600', tag: 'p' }, subtitle)) : null,
    h(Box, { paddingTop: 4 }, children));
}

export function origin(r) {
  if (!r.adjusted) return `config file: ${fmt(r.file)}`;
  const from = `${r.adjusted.source === 'config' ? 'config file' : 'default'}: ${fmt(r.adjusted.from)}`;
  return r.source === 'runtime' ? `${from} (runs as ${fmt(r.file)} to fit the other limits)` : `${from}, adjusted to fit the other limits`;
}

// one line per setting: name and note, value (with the config file value and hard limit), source; wraps on a phone
export function Rows({ rows }) {
  return h(Box, { tag: 'ul', style: { listStyle: 'none', margin: 0, padding: 0 } }, ...rows.map((r, i) => h(Flex, {
    key: r.key, tag: 'li', 'data-testid': `row-${r.key}`, gap: 4, wrap: 'wrap', alignItems: 'flex-start', paddingTop: 3, paddingBottom: 3,
    ...(i ? { borderColor: 'neutral150', borderStyle: 'solid', borderWidth: '1px 0 0 0' } : {}),
  },
  h(Box, { style: { flex: '2 1 16rem', minWidth: 0 } },
    h(Typography, { variant: 'pi', fontWeight: 'semiBold', tag: 'p', style: { fontFamily: 'monospace', overflowWrap: 'anywhere' } }, r.key),
    NOTE[r.key] || r.default_on !== undefined ? h(Typography, { variant: 'pi', textColor: 'neutral600', tag: 'p' }, NOTE[r.key] || (r.default_on ? 'on by default' : 'off by default')) : null),
  h(Box, { style: { flex: '1 1 10rem', minWidth: 0 } },
    h(Typography, { variant: 'omega', tag: 'p', style: { overflowWrap: 'anywhere' } }, fmt(r.value)),
    // one line under the value: the config file's (or default) value, and what it runs as when the limits adjusted it
    r.source === 'runtime' || r.adjusted ? h(Typography, { variant: 'pi', textColor: 'neutral600', tag: 'p' }, origin(r)) : null,
    r.hard !== undefined ? h(Typography, { variant: 'pi', textColor: 'neutral500', tag: 'p' }, `hard limit ${fmt(r.hard)}`) : null),
  h(Box, { style: { flex: '0 0 9rem' } }, h(Source, { s: r.source })))));
}

export function Tighten({ data, rows, draft, setDraft, canUpdate, busy, onSave, onReset }) {
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const fileOf = (k) => (rows[k].source === 'runtime' ? rows[k].file : rows[k].value);
  const fields = EDITABLE.map(([k, label, kind]) => {
    const f = fileOf(k);
    const hint = kind === 'on' || kind === 'off'
      ? (f === (kind === 'on') ? `Already ${kind} in the config file.` : `Config file: ${fmt(f)}. Can only be turned ${kind} here.`)
      : `Config file: ${fmt(f)}. Can only be ${kind === 'lower' ? 'lowered' : 'raised'} here.`;
    // approvals off in the config file: only the automatic limit is enforced, so only it can be tightened
    const off = rows['approvals.enabled'] && rows['approvals.enabled'].value === false && k !== 'approvals.automaticMax';
    const locked = !canUpdate || off || ((kind === 'on' || kind === 'off') && f === (kind === 'on'));
    const input = kind === 'on' || kind === 'off'
      ? h(Toggle, { checked: Boolean(draft[k]), onLabel: 'On', offLabel: 'Off', disabled: locked || busy, onChange: (e) => set(k, e.target.checked) })
      : h(NumberInput, { value: draft[k], disabled: locked || busy, step: 1, onValueChange: (v) => set(k, v === undefined ? f : v) });
    return h(Grid.Item, { key: k, col: 6, s: 12, xs: 12, direction: 'column', alignItems: 'stretch' },
      h(Field.Root, { name: k, hint, id: `ws-${k}` }, h(Field.Label, null, label), input, h(Field.Hint, null)));
  });
  const allow = data.media_file_allow;
  return h(Card, { title: 'Tighten at runtime', testid: 'tighten',
    subtitle: `These can only be made stricter than config/plugins, never looser, and apply on every replica within ${data.refresh_seconds} s without a restart, to jobs requested after the change (a request already waiting keeps the approvals it was created with). The automatic limit always applies. While approvals are off (approvals.enabled false), it is the only one that applies and can be tightened; while they are inactive, a job that would need an approval is refused.` },
  h(Grid.Root, { gap: 5 }, ...fields),
  h(Box, { paddingTop: 6 },
    h(Typography, { variant: 'sigma', textColor: 'neutral600', tag: 'p' }, 'Media import allowlist (from the config file)'),
    allow.length ? h(Flex, { direction: 'column', alignItems: 'flex-start', gap: 2, paddingTop: 2 }, ...allow.map((e) => h(Checkbox, {
      key: e, disabled: !canUpdate || busy, checked: !draft['media.disabled'].includes(e),
      onCheckedChange: (on) => set('media.disabled', on ? draft['media.disabled'].filter((x) => x !== e) : [...draft['media.disabled'], e]),
    }, e))) : h(Typography, { variant: 'pi', textColor: 'neutral600', tag: 'p' }, 'Empty: no host can be imported from. Hosts can be added only in the config file.')),
  h(Flex, { paddingTop: 6, gap: 2, wrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' },
    h(Typography, { variant: 'pi', textColor: 'neutral600', 'data-testid': 'last-change' }, data.overrides.at ? `Last changed by ${data.overrides.by} on ${when(data.overrides.at)}.` : 'Never changed here: the config file applies as it is.'),
    canUpdate ? h(Flex, { gap: 2 },
      h(Button, { variant: 'tertiary', disabled: busy || !Object.keys(data.overrides.values).length, onClick: onReset }, 'Back to the config file'),
      h(Button, { disabled: busy, onClick: onSave }, 'Save')) : h(Typography, { variant: 'pi', textColor: 'neutral600' }, 'Read only: changing these needs the "Tighten settings at runtime" permission.')));
}

function Status({ data }) {
  const a = data.approvals_state;
  const k = data.kill_switch;
  // neutral100 is the page background: the neutral box is drawn as a card instead
  const item = (tone, text, testid) => h(Box, { background: tone === 'neutral' ? 'neutral0' : `${tone}100`, shadow: tone === 'neutral' ? 'tableShadow' : undefined, padding: 4, hasRadius: true, 'data-testid': testid, style: { flex: '1 1 16rem' } }, h(Typography, { textColor: `${tone}700` }, text));
  return h(Flex, { gap: 4, wrap: 'wrap', alignItems: 'stretch' },
    item(a.active ? 'success' : 'warning', a.active ? 'Approvals active: bulk jobs above the automatic limit wait for an admin.' : (a.reason === 'needs_mcp_only' ? 'Approvals inactive: they need adminTokens "mcp-only". Jobs above the automatic limit are refused.' : 'Approvals off (approvals.enabled false): jobs above the automatic limit are refused.'), 'approvals-state'),
    item(k.on ? 'danger' : 'neutral', k.on ? `All bulk jobs are stopped${k.config ? ' by the config file' : (k.set_by ? ` by ${k.set_by}` : '')}.` : 'Bulk jobs may run. The kill switch is on the Write-safe jobs page.', 'kill-switch'));
}

export function SettingsPage() {
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();
  const { allowedActions: { canUpdate } } = useRBAC(PERMISSIONS);
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const apply = (d) => { setData(d); setDraft(draftOf(d).draft); };
  const load = React.useCallback(async () => {
    try { apply((await get('/writesafe/settings')).data.data); setError(null); } catch (e) { setError(errText(e)); }
  }, [get]);
  React.useEffect(() => { load(); }, [load]);
  const send = async (values, ok) => {
    setBusy(true);
    try {
      apply((await put('/writesafe/settings/overrides', { values, based_on: data.overrides.at })).data.data);
      toggleNotification({ type: 'success', message: ok });
    } catch (e) {
      toggleNotification({ type: 'danger', message: errText(e) });
    }
    setBusy(false);
  };
  const rows = data ? draftOf(data).rows : null;
  return h(Page.Main, null,
    h(Page.Title, null, 'Write-safe MCP settings'),
    h(Layouts.Header, { title: 'Write-safe MCP', subtitle: 'How writesafe runs on this server. config/plugins is the source of truth; change it there and restart. A few safety settings can be tightened here.' }),
    h(Layouts.Content, null, !data ? (error ? h(Box, { background: 'danger100', padding: 4, hasRadius: true }, h(Typography, { textColor: 'danger700' }, error)) : h(Flex, { justifyContent: 'center', padding: 8 }, h(Loader, null, 'Loading')))
      : h(Flex, { direction: 'column', alignItems: 'stretch', gap: 6 },
        h(Status, { data }),
        h(Tighten, { data, rows, draft, setDraft, canUpdate, busy, onSave: () => send(valuesOf(draft, rows), 'Settings saved'), onReset: () => send({}, 'Back to the config file') }),
        data.provenance === 'unknown' ? h(Typography, { variant: 'pi', textColor: 'neutral600' }, 'The config files could not be read, so "config or default" is shown where the source is not known.') : null,
        ...data.sections.map((s) => h(Card, { key: s.id, title: s.title, testid: `section-${s.id}` }, h(Rows, { rows: s.rows }))),
        h(Typography, { variant: 'pi', textColor: 'neutral600' }, 'Everything else is set in config/plugins (writesafe.config) and needs a restart. Bulk jobs and the kill switch: ',
          h(Link, { tag: RouterLink, to: '/plugins/writesafe' }, 'Write-safe jobs'), '.'))));
}

export const ProtectedSettingsPage = () => h(Page.Protect, { permissions: PERMISSIONS.read }, h(SettingsPage, null));
