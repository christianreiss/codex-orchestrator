import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { ManagedSkillManifest } from './managed-context-skill.js';
import { SettingsService } from './settings.js';

export const WORKFLOWS_MIN_CXX_VERSION = '0.9.111';
const DESCRIPTION = 'Use workflows to create or execute reusable instructions, join an invited run, resume workflow work, or evaluate and improve a completed work pass.';
const INVITE_DESCRIPTION = 'Use invite when an active workflow run needs another existing agent, or when handling a WORKFLOW-INVITE/1 message. An unambiguous run context is required.';
const MANIFEST = `---
name: workflows
description: "${DESCRIPTION}"
---

# Workflows and shared runs

A workflow is a reusable instruction with one stable goal. A run is one pinned execution,
with tasks, participants, evidence, evaluation and a permanent authenticated report link.
The server records and fences work; the agents execute it within their existing authority.

## Start or resume

1. Read with workflow_list and workflow_get (or workflow://<slug>@<version>). Load
   referenced knowledge through its existing tools and access rules. Record used source
   URIs, read time and available digest/revision with agent_workflow_run_note kind knowledge.
2. Create with agent_workflow_run_create, or use the run_id of a prepared run. Read the
   run snapshot before taking coordination with agent_workflow_run_control action start.
3. After resume/compaction call agent_self, then agent_workflow_run_current. Reconcile
   open invitations, membership bindings, coordinator lease and task claims before writes.
   Several open runs are possible: every write explicitly names run_id.
4. Keep a stable client_request_id for retries of the same mutation. If its response was
   lost, retry the identical body and UUID before deciding whether the action occurred.
   A different body needs a new UUID. A stale binding is resolved explicitly, never by
   pretending to be a new native session.

## Invite collaborators

Any active participant can invite; the coordinator need not relay every request.

1. Identify missing access or expertise from the pinned tasks. Discover an existing
   suitable agent with agent_list and resolve its canonical UUID with agent_translate.
   Choose an unambiguous target; preserve its address rather than a mutable display name.
2. Call agent_workflow_invite with run_id, target_address_id, reason, optional task_ids
   and client_request_id. This atomically stores the invitation and WORKFLOW-INVITE/1
   coordination message. It starts no process and reactivates no ended session.
3. On WORKFLOW-INVITE/1 read the run and pinned instruction, check your access and current
   commitments, then agent_workflow_membership accept or decline with invitation_id,
   run_id, reason and client_request_id. Acceptance is membership, not completion or a
   task claim. Respect a decline/expiry; the system does not automatically reinvite.
4. The second acceptance creates exactly one managed run chat. Further participants join
   automatically. Use the returned room_id with agent_chat_read/send and attachment tools.
   Membership changes go through agent_workflow_membership, including leave/removal.

In an open managed run chat an active participant may ask at most ten other active
participants a targeted question using agent_chat_send recipients. WORKFLOW-QUESTION/1
requests one answer in that room. Answer with reply_to set to its event UUID and omit
recipients. Finish with agent_listen once. Contributions and answers without recipients
are passive; acknowledgement chains and automatic follow-up rounds are not started.
Ordinary groups, conferences and host/project rooms retain their existing rules.

## Execute tasks

Acquire one executable task with agent_workflow_task_claim action acquire and its
expected_task_version. The result supplies your claim token/generation and lease. Keep
those private; record only sanitized evidence in notes/chat. Independent tasks may run
in parallel, while a task has one accountable claim owner.

Renew a 30-minute claim within ten minutes and before further external changes. Each
write carries the current task revision and claim credentials. Claims do not replace
external-system idempotency, resource claims or the task's authorization. Validate the
actual execution host; a path on another host is not a shared artifact.

Store the result with agent_workflow_task_update action result, status, summary, outputs,
evidence and execution_host. Dependencies consume tasks.<task_id>.outputs.<key> as data.
A chat discussion alone changes no task state. A not-applicable task uses action skip
with its reason. Failed work can retry only through an explicit justified retry.

When a claim expires or external effects are unclear, the task is uncertain. Use claim
reconcile stage begin, inspect the old process, target state and existing outputs, then
stage resolve with the recovery claim and evidence. verified_success adopts proven work;
safe_to_retry requires proof the old execution stopped; still_uncertain preserves doubt.
Never start a second attempt solely because an agent disappeared or an ACK was lost.

## Finish and improve

The coordinator keeps its separate 30-minute lease current. Pause/cancel requests stop
new claims; they do not terminate an already running external process. Settle attempts
or document uncertainty before finishing. Transfer coordination to an active member
explicitly; an expired coordinator may be replaced without restarting its tasks.

1. agent_workflow_run_finish records outcome, summary, all goal-criterion assessments,
   structured results and open_items. Success needs all criteria met and supported;
   uncertain external effects remain unknown. The run now evaluates, not completes.
2. Read pinned and current workflow versions, task attempts, notes and evidence. Assess
   goal achievement, task clarity, dependencies, source quality and collaboration.
3. agent_workflow_run_evaluate saves a draft evaluation with findings, lessons, decision
   no_change or revise, and reason. A revision includes the full improved document and
   expected_workflow_version. Improve the path automatically within the original goal;
   changing the goal or its success criteria requires a new workflow.
4. Finalize the evaluation with its revision. On a workflow-head conflict retain/read the
   draft, read the current version, reconcile justified improvements and use a new UUID.
   Finalization publishes at most one version, freezes the report and closes run chat.
   A reasoned no_change is a complete evaluation. A crash leaves evaluation visibly open.
5. End your user-facing answer with the returned report_url. Distinguish completed work,
   remaining uncertainty and checks actually run. If the original assignment came from
   agent_request, Conference or Wake, additionally report its bus work outcome with
   agent_task_result: finishing a workflow task never acknowledges that delivery.

Keep secrets in the Secrets Store; results carry references and sanitized evidence.
Workflow improvement does not itself authorize editing referenced memory or Skills.
`;
const INVITE = `---
name: invite
description: "${INVITE_DESCRIPTION}"
---

# Invite a workflow collaborator

Read skill://workflows and follow its "Invite collaborators" section. Identify the explicit
run_id first; outside an unambiguous active run create no invitation. Any active run
participant may discover and invite an existing suitable agent without an operator dialog.
Acceptance adds membership and the managed chat; the invited agent explicitly claims work.
`;

export function isManagedWorkflowSlug(slug: string) { return ['workflows', 'invite'].includes(slug.trim().toLowerCase()); }
export function buildManagedWorkflowSkills(updatedAt: string): ManagedSkillManifest[] {
  return [['workflows', 'Workflows', DESCRIPTION, MANIFEST], ['invite', 'Invite Workflow Collaborators', INVITE_DESCRIPTION, INVITE]].map(([slug, display_name, description, manifest]) => ({
    slug: slug!, display_name: display_name!, description: description!, manifest: manifest!,
    sha256: createHash('sha256').update(manifest!).digest('hex'), updated_at: updatedAt,
    deleted_at: null, engine: null, uri: `skill://${slug}`, canonical_uri: `skill://${slug}`, managed: true,
  }));
}
/** Keep resume/evaluation instructions available while disabled: old runs may drain. */
export async function managedWorkflowSkills(db: Database, updatedAt: string): Promise<ManagedSkillManifest[]> {
  const enabled = await new SettingsService(db).getFlag('workflows_enabled', false);
  if (enabled) return buildManagedWorkflowSkills(updatedAt);
  const { workflowRuns } = await import('../db/schema.js');
  const { ne } = await import('drizzle-orm');
  const open = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(ne(workflowRuns.status, 'completed')).limit(1);
  return open.length ? buildManagedWorkflowSkills(updatedAt) : [];
}
