# Workflows and shared runs

A workflow is a versioned instruction with one goal, at least one task, and
optional knowledge. A run records one execution against a pinned version.
Agents execute the instructions; the coordinator stores state and checks
ownership, dependencies and completion. It does not execute instruction text.

## Versions and knowledge

Each published version stores the complete document and its digest. Tasks have
stable IDs, explicit dependencies and acceptance criteria. Independent tasks may
run concurrently. Editing a workflow requires its expected current version;
restoring an old version publishes another version rather than rewriting history.
The goal and its success criteria remain fixed. A different goal needs another
workflow.

Knowledge may be inline or reference `shared://`, project memory/files,
`skill://`, or HTTP(S). The API validates references without fetching arbitrary
URLs. Agents read sources through their existing authorized tools and record
source revisions and useful findings. Fleetwide templates cannot reference
host-local `memory://` records. Credentials belong in the secrets store, never
in workflow inputs, task outputs, chat or reports.

## Execution and collaboration

Every run has an authenticated report URL from creation:
`/admin/workflows/runs/<run-id>`. Preparing a run does not launch a session.
An admin preparation stays pending until an agent starts it. An agent-created
run starts atomically with that agent as coordinator. The coordinator may invite existing agents across hosts
and engines. Any active participant may invite another suitable agent.

Invitations bind the target's canonical address and session generation.
Accepting creates membership, not a task claim or a successful work result.
The second accepted participant creates exactly one managed communication
group; later members join it automatically. Normal opt-in groups retain their
existing rules. The run group is linked to the report and remains readable
after completion.

One valid claim owns each task. Claims last 30 minutes and must be renewed
before further external changes, normally after 10 minutes. Claim generation,
session binding and task revision fence stale writes. Different tasks have
independent revisions, so parallel progress does not overwrite another result.
Every mutation carries a stable `client_request_id`; retry an uncertain HTTP
response with the same request and body, not a new task execution.

Pause or cancellation prevents new work but does not kill a remote process.
An expired claim makes an unfinished task uncertain. Reconcile the old process
and its target before marking success or authorizing a retry. Recovery does not
automatically start a fresh native transcript.

## Completion and improvement

Runs progress through `pending`, `running`, `paused`/`blocked`, `evaluating`,
and `completed`. Their outcome is separate: `succeeded`, `partial`, `failed`,
`canceled`, or `unknown`. Transport success and online presence are not work
outcomes.

Finishing work requires a result and assessment of every goal criterion.
Evaluation is mandatory before a run becomes completed, including failed and
canceled runs. The coordinator records either a justified decision to leave the
workflow unchanged or an improved document with a reason. Improvements publish
automatically using version compare-and-swap. A conflicting head leaves the
evaluation open for reconciliation; it never silently overwrites another change.
Goal criteria cannot be weakened by improvement.

Finalization stores the evaluation and report, publishes any new version, closes
pending invitations and makes the group read-only atomically. A crash before
finalization remains visible as unfinished evaluation. The old run always
retains its original pinned instruction.

The final agent answer includes the report link. If the original request arrived
as accepted fleet work, its `agent_task_result` remains separately required.
Workflow results do not acknowledge unrelated bus deliveries.

## Console and authorization

Workflows live in the existing Coordination hub. The catalog leads to an editor,
version history, run preparation and run lists. A report shows the result first,
then unresolved work, tasks and evidence, participants, evaluation and history.
The live page becomes the final report at the same URL.

`workflows.read` allows authenticated workflow/report reads.
`workflows.manage` controls definitions and the module switch.
`workflows.run` controls prepared runs and recovery. Owner/admin hold all three;
trusted users and fleet operators may run, and viewer/user may read. These
rights are enforced in both strict and compatible authorization modes. Reading
a report does not grant `agent_messaging.reveal_content`.

The `workflows_enabled` module starts disabled. Disabling it prevents new runs,
invitations and free-standing agent definition changes while allowing existing
runs to drain, including evaluation and its associated version. Existing
host, messaging and engine restrictions still apply.

## Delivery and recovery

Ship schema, API, managed instructions, cxx and the built SPA together.
The shared cxx implementation supports Codex, Claude and Grok through workflow
protocol version 1. Old wrappers must upgrade before accepting work.
Check the running host daemon as well as the interactive CLI: legacy installations
can pin `/usr/local/lib/cxx-daemon/cxx` independently of `/usr/local/bin/cxx`.
After draining active daemon operations, run `cxx daemon install` from the updated
binary as the existing service administrator if that copy is stale. Verify its
version and restarted service before resuming the original native sessions.
An updated CLI alone does not prove the daemon's broker supports workflow routes.

After a session binding changes, `agent_workflow_run_current` separates current
work from `stale_memberships` and `stale_claims` belonging to that same address.
These entries explain recovery without transferring ownership or exposing claim
tokens. Settle outstanding earlier claims, then use the report's “Assign recovery
coordinator” control to bind the existing agent explicitly. Check current
membership and coordinator generation again before continuing.

Before enabling the feature, verify migrations, API health, served UI and the
published wrapper. Exercise a harmless shared run with two hosts, task evidence,
an invitation/group, evaluation and a report. Keep unknown external results
visible instead of retrying them.

Rollback begins by stopping new runs and pausing or draining active work.
Restore a known API/UI/wrapper release and retain the additive workflow tables.
Do not drop historical reports or restore a database backup over newer work
unless a demonstrated database problem requires it.
