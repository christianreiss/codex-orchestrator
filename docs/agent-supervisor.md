# Fleet task supervisor

The supervisor is an external control-plane service for missing handoffs and failed
native sessions. It is disabled by default. Settings → Agent supervisor is its
single editable home (`/admin/settings#agent-supervisor`). Enabling it covers all
managed Codex, Claude and Grok agents; it does not authorize additional work.

## What it observes

Accepted work messages establish persistent sender/worker dependencies. Claimed
workflow tasks establish worker/coordinator dependencies. One coordinator can have
several outstanding dependencies. An agent can explicitly report its current task
with `agent_work_state`; empty arguments read its state. Required write fields:
`state` (`working`, `waiting_agent`, `waiting_user`, `completed`, `canceled`) and
`task_key` or `message_id`. Optional fields: `reason`, `waiting_for` (canonical
`agent:UUID`), `coordinator`, and optimistic `version`. A report without `task_key`
derives it from `message_id` as `message:<id>`; a `waiting_agent` report without
`task_key` continues the current task of the same native session. A wait needs an
agent or a work message. Only participants can reference a work message. Task keys
identify actual tasks; keep them stable during recovery and use a new key for new work.

Native children sharing a fleet binding leave task-state reports to their parent.
Reporting state is idempotent for an unchanged body. It is not a work-result receipt.
Use the existing explicit result tools and original work IDs for completion. Avoid
secrets in task names and wait reasons. Membership, heartbeats and a shared checkout
never establish task dependencies or progress.

After ten minutes without observed progress, the supervisor asks once for status
or a handoff. Durable results notify their dependents without repeating the task.
A handoff unanswered for another five minutes creates operator attention. Explicit
wait cycles create attention and notify the named coordinator. User-input waits,
open questions and observed idle sessions do not authorize process termination.

## Recovery

cxx 0.9.139 advertises `supervisor_protocol_version:1` and captures the native launch
model selection. Automatic restart additionally requires an existing persistent
host, an exact native transcript and local process ownership. Older wrappers and
nonpersistent hosts retain handoff monitoring; their processes are not restarted.
An unknown original model prevents automatic termination/recovery.

The existing watchdog and scheduler provide the execution lane. The local watcher
checks the actual owned child and child tools, protects active tools, rereads fresh
policy immediately before TERM, and suspends termination if policy becomes stale.
A suspected hang gets ten minutes plus five minutes' grace. A supervisor TERM has
60 seconds to complete; it does not force KILL afterward. An unconfirmed exit blocks
recovery and creates attention. Native writer locks prevent concurrent transcript
execution; a connection disappearing is not an exit receipt.

Capacity/crash recovery starts no earlier than five minutes, with exponential
backoff, positive jitter and later provider reset hints. The first observed failure
starts a durable two-hour incident deadline. Initial admission plus four retries
is the maximum of five attempts. A deadline stops future recovery, preserving
already accepted work. The continuation resumes the same engine, native transcript,
model and cwd, preserving original work IDs and native subagents. No model fallback,
replacement transcript, task reassignment, host provisioning or communicator restart
is performed.

An explicit task outcome or user STOP ends recovery. Pause recovery on a task
retains its diagnostic state; a new task key is required to start a different task.
Turning off fleet supervision disables supervisor-owned watchdogs immediately.
Re-enabling allows previously switch-disabled work to be observed again. Other
explicitly configured watchdogs and schedules keep their own lifecycle.

## Interfaces and storage

- `GET /admin/agent-supervisor?target=agent:UUID`: configured/effective state, limits,
  work states, outstanding dependencies, attempts and next recovery deadline.
- `POST /admin/agent-supervisor/state` with `{enabled:boolean}`: fleet switch.
- `POST /admin/agent-supervisor/pause` with `{target,version}`: pause one task.
- `POST /host/agent-sessions/:id/agent-messaging/work-state`: authenticated bridge
  route underlying the native MCP tool. No AI tool can change another agent's state.

Admin reads require `agent_messaging.read`; writes require `agent_messaging.manage`.
Bridge access revalidates the current session binding. Existing engine, host and API
switches remain effective. Work states and dependency edges are owner-managed MySQL
rows introduced by migration 0111. Referenced result metadata survives owner restarts.
The worker reacts to state changes and reconciles every 60 seconds while enabled;
quiet supervision needs no model calls. UI updates use the shared event/query path.
Escalations are durable Portal attention notices plus Activity audit entries.

## Local validation and rollout

Run API typecheck/build, supervisor and lifecycle regressions, real-MySQL integration
and migration reapply tests. Run wrapper tests/build/vet and frontend check/build plus
settings and agent-detail browser scenarios. A production rollout is separate: apply
migration 0111 through the migration runner, publish the new wrapper using the normal
rollout path, verify capabilities, then explicitly enable supervision. Rolling back
behavior means disabling supervision; retain the diagnostic tables for inspection.

The [local verification record](verification/agent-supervisor-2026-10-27.md) distinguishes
source, build, isolated integration and browser evidence from production rollout.
