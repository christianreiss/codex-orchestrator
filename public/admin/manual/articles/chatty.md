---
title: Chatty administration assistant
section: Admin workspace
verified: 2026-10-27
sources: api/src/services/chatty/tools.ts, api/src/services/chatty/contracts.ts, api/src/services/chatty/coordinator.ts, api/src/services/chatty/owner-actions.ts, api/src/services/chatty/workflow-tools.ts, api/src/services/chatty/role-retention-tools.ts, api/src/services/chatty/quota-tools.ts, api/src/services/chatty/supervisor-tools.ts, api/src/services/chatty/handoff-tools.ts, api/src/services/chatty/surface-inventory.json, api/src/services/chatty/knowledge.ts
---

# Chatty administration assistant

Chatty is the Orchestrator application administrator available to signed-in
Owner and Admin users. Open the speech-bubble assistant to ask about the product,
inspect current state, or request a specific administrative change. Availability
requires usable provider access and a ready runner; a gateway API key alone is
not provider access.

## What she can administer

Chatty's typed tools cover hosts, provider accounts, engine settings, skills,
fleet instructions, Claude collections, projects and boards, shared memory,
console users, gateway-key state, and existing schedule/watchdog suspension.
The newer administration tools also cover:

- Workflow definitions: create, revise, archive, restore and revert; inspect run
  status, events, reports and task details.
- Agent roles: metadata and policy, drafts, publishing, reverting, withdrawal,
  and proposal decisions.
- Quotas: fleet and account policy, admission limits, advice and usage scaling.
- Retention: inspect policy, preview eligible history, save policy and request
  a guarded cleanup pass.
- Supervisor: inspect diagnostics, configure the fleet switch and pause an
  existing task's supervision.

These newer mutations show a confirmation card tied to the target state. Review
its operation, arguments and target before approving. If the target changes or
your access is revoked, the old approval cannot execute. Unknown outcomes must be
inspected before retrying. Clearing the chat does not undo completed changes.

A successful action receipt proves the recorded product operation. It does not
prove that a host has synchronized. A retention-run receipt confirms the cleanup
request was admitted; ask for its run status before treating deletion as complete.

## Application administration boundary

Chatty does not run shell commands, launch agents or workflow runs, dispatch host
work, create/reactivate schedules, or activate individual task recovery. Fleet
configuration changes use existing Orchestrator services and their policy checks.
Credentials, identity verification and uploads remain in their existing interfaces;
Chatty can hand you a link without claiming she performed the operation.

Her documentation knowledge is bundled with the API build. Editing a guide does
not refresh an already running API; the rebuilt image must be rolled out. Live
product state comes from tools, rather than documentation excerpts.

## Source references

- api/src/services/chatty/tools.ts — typed tool registry and capabilities.
- api/src/services/chatty/owner-actions.ts — confirmed target checks and receipts.
- api/src/services/chatty/surface-inventory.json — callable, interactive and excluded routes.
- api/src/services/chatty/knowledge.ts — maintained source corpus.
- api/src/services/chatty/contracts.ts — application administration boundary.
