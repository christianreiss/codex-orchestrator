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
A background tick first observes all membership, host/engine eligibility, title,
binding and active-claim inputs in one fresh database snapshot. Active-member session IDs
are selected as a set, avoiding a dependent membership scan per historical session. While those inputs
are unchanged and no event is due, it skips the locked reconciliation transaction.
Fresh heartbeats and unexpired claim renewals do not themselves require a sweep;
presence/claim expiry still changes the observed input. A certificate is remembered
only after a successful transaction, from the same repeatable-read snapshot and
evaluation time used by reconciliation. Overlapping ticks share one execution.
Due events bypass the unchanged-input guard, including backlogs over 500 entries.
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
because nobody answered.

Waiting claims queue in arrival order (`created_at`, then `id`; the server keeps
`created_at` strictly increasing across waiting claims). Each claim is blocked by
overlapping active/uncertain claims and by overlapping waiting claims ahead of it,
which appear in `blockers` with `state: "waiting"`. A new acquisition queues behind
every existing overlapping waiter, so an owner that releases and immediately
re-acquires cannot overtake a waiter. One exception keeps a holder from
deadlocking against its own grant: a claim whose contested resources are all
covered by the same session's live active claims does not queue behind waiters,
because those waiters are queued behind that holder anyway. Earlier waiters are not
sent a `CLAIM/1` conflict notice and cannot answer `wait`/`isolate`. A waiter whose
owner is not continuously connected neither blocks nor is granted; it keeps its
arrival position for when its original attachment returns. The queue is strict
FIFO among overlapping claims: a waiter also waits behind an earlier waiter that
is itself blocked by a claim it does not share.

The server grants the queue: release, operator resolution and reconciliation
(including the session-ended release of an uncertain claim) promote every eligible
waiter in arrival order inside the same commit, so the freed resource is never
open to a later acquisition first. Polling `resource_claim_status` applies the same
rule. Each waiting→active transition sends the claimant one non-waking `CLAIM/1`
presence notice naming the claim; an operator releasing a waiting claim sends its
claimant one `CLAIM/1` notice with the reason. The waiter's own cancellation sends
nothing.

New owned claims use a proven native connection (`ownership_mode: connection`),
not a renewable 60-second lease. Their public `expires_at` is null while the exact
native session/generation/instance attachment holds ownership. Legacy timed claims
retain their bounded compatibility drain; their timestamps never establish a new
connection grant. Check status before each protected mutation.

Native engine children can share the parent's session and broker. A separate
transcript or worktree is not a separate fleet identity. Children read `agent_self`
and report a shared binding to the parent; the parent serializes global naming,
workspace/context changes, identity binding and shared-claim release. Use distinct
task resource paths and coordinate claim IDs with the parent. The shared address
alone does not identify a filesystem writer or explain a historical generation rebind.

`resource_claim_release` reports completed, canceled or unknown with a reason.
Unknown outcomes, ended owners and lost attachments retain resources as uncertain;
there is no general self-takeover based on a matching session or agent name.
An exact original native attachment may recover a disconnected/owner-restart claim.
A different lifecycle can continue it only after the old lifecycle reported completed,
detached and the server proves the same native transcript, address, host, username,
engine and host-credential fingerprint. Use the existing claim ID with
`resource_claim_status({claim_id, renew:true})`; read-only status never transfers it.
`reported_unknown`, running/failed/foreign lifecycles and ambiguous external operations
remain blocked. The proven original owner may confirm the operation ended, or an
operator may resolve it with evidence and an audit record.

`claim_connection_required` retains HTTP 409 and includes `extra.claim_connection`
with the caller's session ID, binding generation, authenticated host ID/FQDN, engine,
a native-transcript-bound flag, proof state and safe recovery instructions. Proof
states distinguish missing session attachment, missing native instance, a missing
original instance and a currently present native connection; the last state alone
does not authorize adopting an older claim. No credential, native-instance UUID or
foreign owner's proof is exposed. Run `cxx communicator status` and the engine's
`cdx doctor`/`clx doctor`/`cgx doctor` read-only on that host. A stale owner is a
possible diagnosis, not proof: coordinate any shared-owner restart with its users.
Session naming/context updates do not create attachment proof. After reconnect,
retry acquire with its original request UUID, or renew the existing claim ID.

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

## Claim and workspace refinements (2026-10-24)

Legacy timed waiting claims begin with a 180-second expiry and may renew without authorizing a write; new connection-owned claims retain their native attachment fence. Negotiation remains 120 seconds; uncertain claims cannot be taken over; only the proven reconnect/completed-transcript recovery described above may renew them. Blockers include overlapping waiting claims ahead in arrival order (`state: "waiting"`; a legacy timed waiter only until its expiry) and carry purpose, resources, owner address/name and, for uncertain outcomes, the supported audited operator endpoint `/admin/agent-messaging/scopes/resolve`. Owner metadata is loaded only for overlapping claims. A live same-session Git lease does not block its own claims.

Unmanaged SSH targets use `{kind:"remote",fqdn:"mx1.example.org",service:"mail"}`. FQDN case and one trailing dot normalize. The operator's literal canonical FQDN is the shared key across caller hosts; DNS aliases/IPs are not inferred. `service:"*"` reserves all services of that FQDN. These claims do not create fleet membership or access credentials, and do not permit worktree isolation on a system target.

An origin-omitting workspace refresh preserves repository identity only when its canonical common directory is unchanged. Explicit null/empty origin clears it. Project discovery without Git includes local descendant directories with path-segment boundaries; missing peer metadata still marks coverage limited.

Use `agent_git_remote` for a fleet SSH target whose own path and target-branch claims belong to the calling managed session. Supply actual absolute checkout/common-directory facts. The authenticated bridge carries origin provenance to the remote registration without a helper identity or remote host-key impersonation. It never executes Git, SSH or deployment commands.


Local `path`, `git` and `service` resources may omit `host_id`; only the
authenticated caller's host is used as the default. An explicit positive fleet
host is preserved. `remote` resources still require their explicit canonical
FQDN/service and never inherit a fleet host. Null, zero and malformed explicit
host IDs remain invalid. Defaulted and explicit-current-host retries normalize
to the same resources under the same request UUID.

Git registration without proven native broker scope now names
`cxx communicator status` and the original managed native connection as recovery.
A checkout/workspace mismatch instead names `agent_context_update`, including
the actual absolute root/common directory for a nested repository. None of
these diagnostics bypasses a registration, claim or merge exclusion.
