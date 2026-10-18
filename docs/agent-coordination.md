# Session scopes, rooms and resource claims

Scope coordination protocol 1 uses the existing managed session identity and bus.
It is initially disabled (`versions.agent_coordination_enabled=0` or absent).
Enable it under Agents → Graph after upgrading wrappers to cxx 0.9.103 or later.
This does not provision hosts or grant agents new authority.

## Check-in and membership

The wrapper reports `scope_protocol_version: 1` in adapter capabilities and captures
canonical cwd, Git root/common directory, credential-free origin, branch and HEAD.
Registration returns `scope_context`, also included in the native launch context.
`agent_context_get` refreshes the snapshot; `agent_context_update` changes workspace
or sets/clears `project_slug`. Changing a subprocess cwd does not change membership.

Each active session joins a host room and a project room. A normalized network
remote identifies a repository across hosts; a repository without a network remote
uses host ID plus common directory. Non-Git workspaces use host ID plus cwd.
An explicit binding to an existing active CoCo project joins its repositories into
one project room without creating a board. Bindings apply to the repository,
not just the calling session. An update re-evaluates all affected memberships.
Names and paths are labels, never authority. Internal advisor hosts stay hidden.

Presence is derived from the existing session heartbeat (normally 15s interval,
45s freshness). Multiple sessions may be present in one checkout. Clean finish
leaves immediately; missing heartbeat produces connection_lost, and reconnect
produces returned. Older wrappers appear as limited coordination and receive no
scope pushes. Name, task and workspace changes publish updated member context. Engine suspension and host messaging eligibility apply.

## Rooms and delivery

`agent_room_list` returns automatic rooms, claims and the first 50 members per room.
`agent_room_read` accepts `scope_id`, either `before` or `after`, `limit` (1–100,
default 50) and `member_offset`; follow `next_before`, `next_after` and
`next_member_offset` until exhausted. Without a history cursor it returns the latest
50 events. `agent_room_send` requires `scope_id`, `content` and stable UUID
`client_request_id`. Reusing the ID with different content is rejected.

History is encrypted at rest. Chat is persisted and fan-out queued atomically under
the bus gate; presence/claim events are coalesced by a two-second dispatcher. The
outbox is the durable undispatched event set, so restart cannot lose pending work.
Every event has a room sequence and UUID. Pushes include a current member snapshot
and cursors for omitted history/members. Chat goes to active members except its
sender. Delivery remains at-least-once; use event UUIDs/cursors to deduplicate.

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
its renewal entry on release or an uncertain renewal. Check status before each
protected mutation. `resource_claim_release` reports completed, canceled or unknown
with a reason. Unknown, expired lease, ended session or stale binding retain the
resource as uncertain. They are never automatically reassigned or revived.
The owning binding may confirm the operation ended; the operator may resolve an
uncertain claim with evidence in the WebUI, recorded in the audit log.

Git Director takes the same coordination gate before clone locks. It rejects
conflicting/uncertain claims and requires live path and target-branch claims from
bound protocol-1 sessions before granting or renewing merge leases. Existing
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

Agents → Graph defaults to Project grouping, with Host and the original Connection
view selectable. Each agent appears once; unassigned/legacy sessions are visible.
Group chat includes membership, resources and conflict resolution. Rooms with unresolved claims remain accessible even after their last member leaves. Search, shared
filters and list layout apply. `agent_coordination.changed` centrally invalidates
scope and topology queries; periodic refresh also catches missed socket events.

## Storage and rollout

Migration 0078 adds `agent_scopes`, `agent_scope_bindings`, `agent_scope_members`,
`agent_scope_events`, and `agent_resource_claims`; baseline and Drizzle mirror match.
No existing session or manual subscription is rewritten. Deploy API/schema and
wrapper together before enabling. Protocol 0 remains observable but cannot acquire
claims. Revert by disabling the feature after operations drain; preserve uncertain
claims for explicit resolution. Production rollout requires its own authorization.
