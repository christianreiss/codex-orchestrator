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

`workflow://<slug>@<version>` is a read address, not an accepted knowledge-note
`source.uri`. For informational inline notes on historical servers, use the run's
HTTPS `report_url` and name the pinned workflow version/digest and knowledge IDs
in the text. Required knowledge receipts instead use
`workflow://<run.workflow_sha256>/knowledge/<knowledge_id>` with the matching
inline digest and applicability contract; a report URL is not a receipt substitute.
For external knowledge use the actual accepted source URI, not the report URL.

## Clarification and confirmation

Every new run, including one from an existing template or a template without inputs,
follows request → clarification → confirmed summary → execution → final report.
The existing typed `inputs` are its freely defined questions: label/question,
description, string/number/boolean/enum, required and optional default. No resource
or VM-specific fields are imposed. Answers may be saved incomplete in the web form
or by the agent in conversation. Existing answers and defaults are reused and
shown for review; `false` and `0` are values, not missing answers.

`preparation` tracks `clarifying`, `awaiting_confirmation` and `ready` while the
run stays `pending`. `coordinator_acquire` establishes preparation ownership;
`start` is separate. Additional `{id, question, answer?}` questions are stored on
the run. They do not change the reusable definition. All required inputs and
all follow-ups must be answered before `present_summary` stores a snapshot of
the goal, answers, agreements and planned task instructions/acceptance criteria.

The operator confirms the current summary in the web report or explicitly in
conversation. `confirm_summary` records its revision, actor, timestamp, channel
and approval text. An agent records the user's explicit approval, never inferred
consent. This is an agent attestation of the conversation, not an independently
authenticated user signature. Correcting answers or presenting a new summary
invalidates confirmation; existing agreements remain available for re-review.
Preparation mutations append snapshots to the event history. Final reports
retain the confirmed request as well as execution results.

Start and task mutations are fenced server-side until the current summary is
confirmed. Recovery does not start an unconfirmed run. A ready run still needs
an agent to start it; web confirmation launches no process. New run participation
requires cxx 0.9.114's `workflow_protocol_version: 2`. Older agents may drain
historical runs (`preparation: null`) under protocol 1 without acquiring rights
to new runs. Migration 0085 leaves historical runs unchanged.

Always inspect the returned status and preparation before a control action. On an
older protocol-1 deployment, agent run creation already returns `running`; do not
start or configure that run again. A rejected redundant start does not justify
creating a replacement run. Pending protocol-2 runs still require the complete
clarification, explicit confirmation and start sequence above.

## Execution and collaboration

Every run has an authenticated report URL from creation:
`/admin/workflows/runs/<run-id>`. Preparing a run does not launch a session.
Both admin- and agent-created runs stay pending until clarification and explicit
summary confirmation are complete. Agent-created runs assign preparation
coordination without starting execution. The coordinator may invite existing agents across hosts
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
version history, run preparation and run lists. A report shows the result,
unresolved work and unmet acceptance checks before the handover. Nested handover
objects use labeled fields, arrays use lists, and safe web references are links.
Passed checks, completed task evidence, participants, evaluation findings,
workflow changes and history can be expanded; raw JSON remains available for
exact values. Active task problems stay visible. Section links navigate long
reports, and **Copy report** copies a readable handoff including outcome, open
work, acceptance checks, handover, evaluation and the full report link.
The live page becomes the final report at the same URL; completed reports no
longer present the coordinator's historical lease as an active deadline.

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
protocol version 2 for new runs. Old wrappers must upgrade before new-run participation;
protocol 1 remains available for historical runs.
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
