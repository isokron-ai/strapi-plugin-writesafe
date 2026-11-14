# Approvals and the job runner (bulk jobs)

Reference for the plugin's approval tier, the admin panel's **Write-safe jobs** page and the in-Strapi job runner
(1.0 hardening). The plugin README has the summary; configuration keys are in its Config section.

A bulk job (ws_bulk, ws_replace) above `bulk.maxDocuments` can run with an admin's approval, **only when
`adminTokens` is `'mcp-only'`** (see below). With `'any'` (the default) approvals are off: such a job is refused as
before, with `approval_needs_mcp_only`, no request is stored, the dry run says so and the jobs page explains why.
Jobs within the automatic tier run either way.

| Documents | What happens |
|---|---|
| up to `bulk.maxDocuments` (5,000; the automatic tier) | runs when the agent asks, as before |
| above it, up to `approvals.maxDocuments` (20,000 by default) | one admin approves |
| above `approvals.twoApproverAbove` (25,000), up to `approvals.maxDocuments` | two **different** admins approve: only when `approvals.maxDocuments` is raised above 25,000 (at most 100,000) |
| above `approvals.maxDocuments` | `too_many_documents` |

Tiers apply per job: an agent that splits a change into jobs under the automatic limit needs no approval. Approval
guards the size of one reviewed change, not a daily total (the plan decided against quotas). After the rebase onto
stream E, its one active job per token and content type makes splitting sequential and visible; watch the jobs page.

`approvals.maxDocuments` is 20,000 by default: the size measured end to end (one approved 20,000-document ws_bulk job
on Postgres, run by the in-Strapi runner in about 8 minutes, with Strapi's memory flat while it ran). An admin may raise
it up to 100,000; larger jobs have not been measured yet. With the default, the two-approver tier needs `maxDocuments`
raised above `twoApproverAbove`. ws_replace is also capped by its own `replace.maxScanDocuments` (5,000): it scans
before it plans, so an approved ws_replace job never exceeds that.
Hard limits in code: `approvals.maxDocuments` cannot exceed 100,000, and above 50,000 documents two approvers are always
required. `approvals.escalate.publish` / `.relations` (both off by default) ask for one approval at any size for a bulk
publish or a bulk edit of a to-many relation; teams should turn them on.

**What the agent sees.** The dry run says up front when a job will need approval. The start (the same call with the
dry run's `plan_token`) returns `approval_required` with a `job_id` and `approval` (request id, tier, plan hash). The
job and its exact document list (the id snapshot of its plan) are stored as `awaiting_approval`, but nothing runs.
A waiting job holds the token's job slot: one active job per token and content type, so the agent cannot start a
second one meanwhile (`job_running`); it may cancel its own waiting job (`control: "cancel"`), which withdraws the
request. The agent then calls `ws_bulk {job_id}`: it reports the approval status until an admin decides, and starts
the job once approved (`approval_rejected`, `approval_expired` otherwise; both free the slot). The approval is bound to
the plan: the job id comes from the plan token's MAC, and the plan hash also covers the stored id-list hash. A job an
admin paused, or that the runner paused because its token's permissions changed (`permission_changed`) or after
repeated errors (`runner_errors`), answers `job_paused`, and `control: "resume"` is refused for it: only an admin
resumes it. The canary pause of the first chunk stays the agent's to resume, as for any job.

**The agent can never approve.** ws_bulk has no approval argument (its schema is strict: `approved: true` is refused).
Approvals are recorded only through the admin panel's **Write-safe jobs** page, by an admin signed in to the panel with
the **Approve writesafe jobs** permission (Settings > Roles > Plugins; Super Admins have it). Strapi also accepts admin
API tokens on admin routes, and MCP agents hold admin API tokens, so the plugin's admin routes refuse every token: a
session is required. Each decision names the plan hash the admin was shown and is refused if it differs; a request
expires if not decided within `requestTtlSeconds`; an approval is used once, for that plan only, within
`approvalTtlSeconds`. In the two-approver tier the second approval must come from a different admin user. The admin who
owns the requesting token may approve it (`requesterMayApprove`, a one-person company has nobody else); in the
two-approver tier at least one approver is then someone else.

**What makes an agent's token safe: two things, both needed.** Strapi accepts admin API tokens on every admin route,
not only on MCP. With HTTP access, an agent holding one can:
- edit and bulk-publish through `/content-manager`, skipping writesafe altogether;
- use the rest of the admin API (users, roles, tokens) as far as the token's permissions reach: with
  `admin::users.create` or `admin::users.update`, create or change admin accounts; with token permissions, mint new
  tokens.

Restricting agent tokens to the MCP endpoint keeps them inside writesafe's guarantees, and least privilege keeps them
away from admin management. A content-manager-only token is therefore **not** safe on its own. Safety needs:
1. `adminTokens: 'mcp-only'` in the plugin config (admin tokens then work only on the MCP endpoint; every other admin
   route answers 403), or an agent with no HTTP access to Strapi besides MCP; **and**
2. a token without user, role or token permissions: in Settings > API Tokens > Admin tokens, tick only the content
   types (and Media Library) it needs, nothing under "Settings" or "Users & roles".

`adminTokens` defaults to `'any'`, Strapi's own behaviour, because admin tokens are also meant for scripts that call
the admin API ("to programmatically access the admin features", the Admin tokens page says). The approval tier needs
`'mcp-only'`: with `'any'` an agent holding an admin token could reach the admin HTTP API outside writesafe's
guarantees, so approvals are off. The jobs page shows the mode; ws_schema and the server instructions mention it only
when it is `'mcp-only'` (an agent is never told the admin API is open). Set `'mcp-only'` whenever agents hold the
tokens.

The plugin backs this up. A token that can `admin::users.create/update`, `admin::roles.create/update`,
`admin::admin-tokens.create/update/regenerate`, `admin::api-tokens.create/update/regenerate`, any
`admin::transfer.tokens.*` or `admin::provider-login.update` cannot ask for approval (`approval_unsafe_token`,
nothing stored; the dry run says so). An admin whose **credentials** (email, password, active flag, roles) changed
after the request, or within `approvals.approverQuietHours` (24) before it, cannot approve it (`approver_changed`;
rejecting stays possible). Name, language and other profile edits do not count. The plugin keeps a hash of those
credentials per admin in its store and dates a change from the moment it sees a different hash (at startup for every
admin, and whenever an admin decides); the first time it sees an admin, the date is the admin's creation. The card
shows how long ago your credentials changed. When the token owner's credentials are in that quiet period, the owner
may not approve that request (`requesterMayApprove` is off for it).

**Keep approver accounts apart from agents.** Agents should have no access to approvers' credentials or sessions. An
approver whose credentials changed recently can't approve: the account waits `approverQuietHours` before it can
approve again, however the change was made.

MCP elicitation (asking the user in the chat client) is not used: Strapi's MCP handler context does not expose it, and
it would only be acceptable for the one-approver tier, bound to the session. It is a possible later option.

**The page** lists the pending requests (count, target, action, filter, manifest root, plan hash, a before/after sample
from the token's view, the requesting token and agent label, the decisions so far) with Approve and Reject, and the
recent jobs with progress, Pause, Resume and Cancel, and a **Stop all bulk jobs** switch (the kill switch: a chunk
already running commits; no new chunk starts, agent-driven or not, until it is switched off; a switch that cannot be
read counts as on; `runner.killSwitch: true` or the bulk engine's `bulk.paused` holds it on from config: any of the
three stops every job). Each request is shown through the viewing
admin's own read permission: values of fields they cannot read are hidden. The admin who decides must be allowed the
job's action (update, or publish) on its content type, and an earlier approval stops counting if its admin is
deactivated or loses the permission.

**The runner** (`runner.enabled`, off by default) runs approved jobs in the background inside Strapi, so the agent does
not have to keep calling. It is safe with several replicas: a job is run only by the worker holding its database lease
(`leaseMs`, renewed every `heartbeatMs`), and every chunk's transaction checks the lease (owner and fence) after locking
the job row, so a worker whose lease was taken over while it was frozen writes nothing. An expired lease that nobody
took is still its worker's. The check holds the lease row until the chunk commits, so the runner does not start when
`leaseMs` is below 3 x the chunk time cap. After a crash the lease expires and another worker resumes from the last
committed chunk; after a chunk error the job waits 2, 4, 8, 16 s before the next try, and five errors in a row pause it
(`runner_errors`). If `runner.enabled` is set but the runner could not start (a failed probe, see the log), the jobs
page says so and approved jobs run when the agent resumes them. Before every chunk the permissions of the token that asked for the job are rebuilt from the token
itself (never a superuser, never the approver's); if the token was revoked or expired, its owner deactivated, or its
rules on the content type changed, the job pauses with `permission_changed` and only an admin can resume it (or cancel
it). `chunkPauseMs` paces chunks. With the runner off, an approved job runs when the agent calls `ws_bulk {job_id}`, as
any job does; agent-driven resume works either way. Replicas need synchronised clocks (the lease is in epoch ms).

**Undo jobs** (stream F's ws_undo jobs, in the same job tables) are not approval-tier jobs: they need no approval at
any size, the runner never runs them, the kill switch does not stop them (it stops forward bulk changes, so an undo can
repair them while it is on), and the jobs page lists them without Pause, Resume or Cancel (`not_supported` on the admin
API): the agent that started one continues or cancels it with ws_undo.

## From the package README

The package README's approval rules, moved here unchanged (the README keeps the tier table and the summary).

- **The agent never approves.** The start returns `approval_required` and stores the job as `awaiting_approval` (it
  holds the token's job slot). Only an admin signed in to the admin panel, with the **Approve writesafe jobs**
  permission, decides on the **Write-safe jobs** page; the plugin's admin routes refuse every token, and a decision is
  bound to the plan hash it was shown. An admin pause, `permission_changed` or `runner_errors` answers `job_paused`, and
  only an admin resumes it.
- **Safe tokens need both** `adminTokens: 'mcp-only'` (admin tokens work only on the MCP endpoint) **and** a token
  without user, role or token permissions. Tokens that can manage admins, roles or tokens cannot ask for approval
  (`approval_unsafe_token`); an admin whose credentials changed within `approverQuietHours` (24) cannot approve.
- **The page** shows pending requests through the viewing admin's own read permission, the recent jobs with Pause,
  Resume and Cancel, and a **Stop all bulk jobs** kill switch (`runner.killSwitch` or `bulk.paused` in config hold it
  on too).
- **The runner** (`runner.enabled`, off by default) runs approved jobs in the background under a database lease with a
  heartbeat; it resumes after a crash and re-checks the requesting token's permissions before every chunk.
- **Undo jobs** (ws_undo) need no approval, are not run by the runner nor stopped by the kill switch, and are listed on
  the page without controls: the agent continues or cancels them.

Full reference (what the agent sees, what makes a token safe, the quiet period, the page, the runner's lease and
back-off): `docs/tools-approvals.md`.
