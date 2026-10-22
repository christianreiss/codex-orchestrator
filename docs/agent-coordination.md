# Session scopes, rooms and resource claims

Scope coordination protocol 1 uses the existing managed session identity and bus.
It is initially disabled (`versions.agent_coordination_enabled=0` or absent).
Enable it under Settings → Agent coordination after upgrading wrappers to cxx 0.9.103 or later.
This does not provision hosts or grant agents new authority.

`agent_context_get` returning `enabled: false` and acquisitions returning
`agent_coordination_disabled` reflect that switch, not a failed lock service.
An operator with the existing manage capability can use Settings → Agent coordination or
`POST /admin/agent-messaging/scopes/state` to enable it after the rollout checks
below. Agents must not enable a fleet feature just to bypass a task's missing
ownership prerequisite. Keep tasks requiring that ownership blocked until enabled.
The setting covers both automatic project/host rooms and new resource claims.
Agents → Graph shows the independently loaded effective state and links to Settings;
it does not offer a second editable control. Settings confirms accepted changes and
reads the current state before retrying an uncertain save.
For cluster maintenance, all participants must agree on the same canonical
`host_id` and service key: separate node-local keys do not serialize a cluster.
Claims are leased ownership, not durable locks across a reboot; use the
`reboot-safe` Skill to reconcile ownership before continuing after boot.

## Check-in and membership

The wrapper reports `scope_protocol_version: 1` in adapter capabilities and captures
canonical cwd, Git root/common directory, credential-free origin, branch and HEAD.
Registration returns `scope_context`, also included in the native launch context.
Room enrichment is optional after authenticated naming/binding succeeds. A database
or snapshot read failure returns `scope_context` with `available:false` and
`reason:"snapshot_unavailable"`, retaining `enabled:true` when the setting was read
successfully; a sanitized warning records the failure. It does not discard the
confirmed launch identity. Authentication, authorization and stale binding errors
still fail registration. Refresh unavailable context with `agent_context_get`;
an unavailable snapshot grants no resources and never bypasses the identity gate.
`agent_context_get` refreshes the snapshot; `agent_context_update` changes workspace
or sets/clears `project_slug`. Changing a subprocess cwd does not change membership.

Each active session joins a host room and a project room. A normalized network
remote identifies a repository across hosts; a repository without a network remote
uses host ID plus common directory. Non-Git workspaces use host ID plus cwd.
An explicit binding to an existing active CoCo project joins its repositories into
one project room without creating a board. Bindings apply to the repository,
not just the calling session. An update re-evaluates all affected memberships.
Names and paths are labels, never authority. Internal advisor hosts stay hidden.

Sessions on a server-owned host (`hosts.internal_role`, the Fleet Advisor) are
outside scope coordination: they join no room and their host is never a claim
target. Registration therefore returns no `scope_context` for them (so the wrapper
adds no claim-before-write instruction), `agent_context_get` returns
`enabled:false` with `reason:"internal_host"` even while the fleet switch is on, and
new claims, room reads/sends and context updates return 403
`agent_coordination_not_applicable` rather than `agent_coordination_disabled` or a
`Target host not found` for their own host. Claim status and release stay available.
The advisor role prompt states the matching rule: a unique file name in the shared
working directory is the only ownership rule for fetched transfers.

Presence is derived from the existing session heartbeat (normally 15s interval,
45s freshness). Multiple sessions may be present in one checkout. Clean finish
leaves immediately; missing heartbeat produces connection_lost, and reconnect
produces returned. Older wrappers appear as limited coordination and receive no
scope pushes. Name, task and workspace changes update durable member context.
Routine presence and claim changes, including a session's own join or task-title update,
do not queue model wakeups. Context/room reads and the operator UI expose current
membership and its ordered history. Engine suspension and host messaging eligibility apply.

## Rooms and delivery

`agent_room_list` returns automatic rooms, claims and the first 50 members per room.
`agent_room_read` accepts `scope_id`, either `before` or `after`, `limit` (1–100,
default 50) and `member_offset`; follow `next_before`, `next_after` and
`next_member_offset` until exhausted. Without a history cursor it returns the latest
50 events. `agent_room_send` requires `scope_id`, `content` and stable UUID
`client_request_id`. Reusing the ID with different content is rejected.

History is encrypted at rest. Chat is persisted and fan-out queued atomically under
the bus gate; routine events are collected by a two-second dispatcher. The
outbox is the durable undispatched event set, so restart cannot lose pending work.
Every event has a room sequence and UUID. Presence and claim batches are marked dispatched
without model mail; mixed batches fan out only chat entries. Durable room
history/cursors and WebSocket invalidation remain
available. Pushes for substantive events include a current member snapshot
and cursors for omitted history/members. Chat goes to active members except its
sender. Delivery remains at-least-once; use event UUIDs/cursors to deduplicate.
Direct `CLAIM/1` requests to conflicting resource owners retain their existing
delivery and response contract.

Before presenting queued mail, bounded scans retire only provably routine,
never-attempted server notices. This includes complete presence/claim-only scope
updates and safe historical role/Director bookkeeping. Direct work, chat,
conflicts, faulty-role warnings, current or ambiguously bound lease waiters,
peer-origin messages, malformed/truncated payloads and accepted/uncertain
deliveries are preserved. Routine-only queued digests require every retained
original and digest metadata to agree before retirement. History remains auditable.

The bus uses session-bound `presence_notice` envelopes for `SCOPE/1` and `CLAIM/1`.
They cannot wake or follow a replacement session. Do not reply using agent_reply:
use agent_room_send for useful chat replies and resource_claim_status for a claim
response. A room post is not a work request or automatic authorization. Existing
manual groups, conferences, direct requests and task results are unchanged.

## Claims

`resource_claim_acquire` requires a stable UUID `client_request_id`, `purpose` and
1–64 resources. All resources are acquired atomically:

- `{kind:"path", host_id, path}` reserves a canonical absolute path and descendants.
- `{kind:"git", host_id, common_dir, branch?}` reserves shared Git metadata or a target branch.
- `{kind:"service", host_id, service}` reserves a named host service; `*` covers all services.

The response is active or waiting and includes blocker IDs and owners. Conflicting
owners get one session-bound coordination notice. They answer with
`resource_claim_status({claim_id, response:"wait"|"isolate"})`; a response never
transfers ownership. After 120 seconds without an answer a waiting Git/path claim
reports `isolation_available`; create a new worktree from the recorded HEAD,
leave dirty changes in place, update context, cancel the waiting claim and acquire
resources for the new worktree. A system resource never becomes available merely
because nobody answered. If owners release, polling can grant the waiting claim.

Leases last 60 seconds. The broker tracks explicitly acquired active claims and
renews them on the wrapper heartbeat, independently of long model turns. It drops
its renewal entry on release or an uncertain renewal. Renewal is driven by the
15-second heartbeat, not by tool activity, and is the same for cdx, clx and cgx.
Native child agents (Codex subagents, Claude Task agents) share the parent's
session and broker, so a claim any of them acquires or reads as active is renewed
by that one broker; no per-child renewal is needed. Each claim renews concurrently
with its own 5-second budget; only a definitive answer (non-active state,
`claim_not_active`, stale binding, not found) drops it, while timeouts, transport
errors and 5xx retry on the next tick, which does not back off while claims are
held. An agent that renews explicitly keeps working the same way. Check status before each
protected mutation. `resource_claim_release` reports completed, canceled or unknown
with a reason. Unknown, expired lease, ended session or stale binding retain the
resource as uncertain. They are never automatically reassigned or revived.
The owning binding may confirm the operation ended; the operator may resolve an
uncertain claim with evidence in the WebUI, recorded in the audit log.

Git Director takes the same coordination gate before clone locks. It rejects
conflicting/uncertain claims and requires live path and target-branch claims from
bound protocol-1 sessions before granting or renewing merge leases. A worktree
registration without a live bound session cannot own claims, so its own live
claims still block; that refusal names the missing binding and the repair
(re-register with `username`/`engine`, after `agent_context_update` if needed)
instead of implying a foreign owner. Existing
legacy merge leases also block new resource claims. Shell/SSH file writes are not
OS-fenced; agents must follow the claim contract. This is not a sandbox and cannot
prove a remote process stopped. Claims grant no permission to execute an action.

Disabling coordination rejects new acquisitions and new rooms/chat operations.
Existing claims may be checked/renewed/released while messaging remains enabled;
waiting claims cannot promote while coordination is off. Uncertain claims still
block Git merges even with the feature disabled. Drain operations before disabling
Agent Messaging itself. No rollback drops claim/history tables.

## Operator API and UI

All endpoints use existing admin authentication/capabilities:

The state GET/POST responses are the lightweight `{enabled, protocol:1,
shell_enforcement:false}` setting, independent of room/member snapshots. Operator
setting changes and their audit event commit together; a failed audit leaves the
old setting intact. WebSocket invalidation happens after commit. A failed room
refresh does not undo a successful setting change; read the state endpoint to
reconcile an uncertain response before retrying.

- GET/POST `/admin/agent-messaging/scopes/state`: status/toggle (read/manage).
- GET `/admin/agent-messaging/scopes`: rooms, members and claims (read).
- GET `/admin/agent-messaging/scopes/:scopeId/members?offset=N`: paged metadata (read).
- POST `/admin/agent-messaging/scopes/read`: history, no-store, audited (reveal_content).
- POST `/admin/agent-messaging/scopes/send`: operator post (manage).
- POST `/admin/agent-messaging/scopes/resolve`: explicit claim outcome/reason (manage).

Session bridge routes under `/host/agent-sessions/:id/agent-messaging/` are
`context/get`, `context/update`, `rooms/list`, `rooms/read`, `rooms/send`,
`claims/acquire`, `claims/status`, `claims/release`. No host-wide credential can
impersonate a session through these routes. Broker tools remain session-scoped.

Agents → Graph defaults to the original Connection topology. Project/Host grouping
adds translucent cloud outlines and room buttons while preserving the radial graph,
connections, zoom and selection. Project + Host displays overlapping clouds for
shared membership, like a Venn diagram. Missing assignments remain ordinary graph nodes. Each agent appears once; legacy sessions remain visible.
Group chat includes membership, resources and conflict resolution. Rooms with unresolved claims remain accessible even after their last member leaves. Search, shared
filters and list layout apply. `agent_coordination.changed` centrally invalidates
scope and topology queries; periodic refresh also catches missed socket events.

## Storage and rollout

Migration 0078 adds `agent_scopes`, `agent_scope_bindings`, `agent_scope_members`,
`agent_scope_events`, and `agent_resource_claims`; baseline and Drizzle mirror match.
Migration 0089 aligns only `agent_scope_members.session_id` and
`agent_resource_claims.session_id` with the installed `agent_sessions.id` charset
and collation. This repairs membership and retention joins on upgraded databases
whose defaults changed, preserving rows, indexes and all other column collations.
No existing session or manual subscription is rewritten. Deploy API/schema and
wrapper together before enabling. Protocol 0 remains observable but cannot acquire
claims. Revert by disabling the feature after operations drain; preserve uncertain
claims for explicit resolution. Production rollout requires its own authorization.
