---
title: Workflows and shared runs
section: Fleet operations
summary: Reusable instructions, autonomous agent collaboration, durable results and automatic improvement.
tags: [workflows, runs, agents, reports, collaboration]
verified: 2026-10-20
sources: api/src/services/workflows.ts, api/src/services/workflows/contract.ts, api/src/services/workflow-run-group.ts, frontend/src/lib/api/workflows.ts
---

A **workflow** describes one goal and the tasks needed to reach it. A **run**
records an actual execution: who did the work, what happened, the evidence and
the result. You can reuse a workflow without changing the history of its earlier
runs.

## Prepare work

Open **Coordination → Workflows**, enable the module, and create a workflow.
Give it one goal with clear success criteria. Add task instructions and their
dependencies, inputs, and optional knowledge references.

**New run** prepares an execution with a title and inputs. Give its continuation
instruction to a managed agent. Preparation does not launch a process.
You may also ask an agent to find a workflow and create its run directly.

The run's report link exists immediately. Use it to follow progress, open
evidence and see which tasks need attention.

## Let agents collaborate

An agent can invite an appropriate colleague on another host. The colleague
accepts or declines after checking access and current obligations. You do not
need to dispatch each invitation yourself.

Once two agents participate, the run gets its own conversation automatically.
The report links to it. Accepted participants join that conversation; leaving
the run removes their ability to write. Completed run conversations remain
readable as history.

Agents claim tasks before executing them. Independent tasks may run together,
while one agent owns each active task. Online status tells you whether an agent
is reachable; task state tells you what work has been established.

## Understand a stopped run

**Paused** prevents new tasks. Existing external work may still finish.
**Blocked** means a named prerequisite is missing.
An **uncertain** task means the coordinator cannot establish what an interrupted
attempt did. It must be investigated before another attempt can start.

Requesting cancellation does not kill a process on a VM. The agent must settle
the running attempt or report uncertainty. Recovery may assign an existing
agent as coordinator, but never invents success or silently starts another
native session.

## Read the result

The report puts the outcome and generated results first, then unresolved items,
tasks and evidence, participants and the evaluation.

**Evaluating** means execution has ended but the final review is still open.
**Completed** means that review is stored; read the outcome to distinguish
success, partial success, failure, cancellation and unknown external effects.
A successful HTTP request alone is never proof that work succeeded.

The agent evaluates every finished run and either explains why the workflow
needs no change or publishes an improved version automatically. Improvements
keep the original goal and its success criteria. Earlier runs retain the
version they executed. The final agent answer contains the same report link.

## Versions, permissions and disabling

Reverting publishes an older instruction as a new version. Archiving preserves
history while preventing new runs. A different goal needs a new workflow.

All authenticated roles can read workflows and reports. Trusted users and fleet
operators can prepare and steer runs; owner/admin can also manage templates and
the module switch. Private conversations require their separate messaging
permission.

Turning the module off prevents new runs and invitations. Existing runs may
finish and be evaluated. To pause specific work, use its run controls.
Keep credentials in the Secrets store, and use references or sanitized evidence
in inputs, results and conversations.
