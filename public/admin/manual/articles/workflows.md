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
dependencies, freely defined questions, and optional knowledge references.

**New run** prepares an execution with a title and inputs. Give its continuation
instruction to a managed agent. Preparation does not launch a process.
You may also ask an agent to find a workflow and create its run directly.

The run's report link exists immediately. Use it to follow progress, open
evidence and see which tasks need attention.

## Clarify and confirm before execution

Define questions such as CPUs, RAM, disk size or location using text, numbers,
yes/no or choices. These are examples: every workflow defines its own questions,
required answers, hints and optional defaults.

Save a request even if some answers are missing. Answer in the web report or ask
an agent to clarify them with you. Additional questions and answers stay with
that run. Once the required answers are complete, choose **Review execution
summary**. Check the goal, answers, agreements and planned tasks, then choose
**Confirm execution summary**, or explicitly approve it in conversation.

Execution waits for that confirmation. Correcting an answer requires a new review
and confirmation. Confirmation does not launch an agent; give the continuation
assignment to an existing agent. This also applies to new runs from older templates
and templates without questions. Already existing runs retain their original flow.
The final report preserves the confirmed request and its history alongside results.
New runs require cxx 0.9.114 or newer; older agents can finish historical runs.

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

The report starts with the outcome, unresolved work and unmet acceptance checks,
followed by the handover as readable fields and lists. Use the section links to
jump through a long report, or **Copy report** to copy a readable handoff with
the outcome, open work and report link.

Expand passed checks, task evidence, participants, workflow changes or history
when you need their details. **Raw JSON** preserves the exact recorded values.

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
