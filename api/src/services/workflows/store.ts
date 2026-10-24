import {nativeClaimAttachment} from '../../control-plane/state/resource-claims.js';
import {legacyDrainFor} from '../../control-plane/legacy-drain.js';
import {workflowState,workflowOwnerContext,workflowOwnerRuntime,publishWorkflowRow,patchWorkflowRow} from './owner.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  workflowRuns,
  workflowRunTasks,
  workflowRunMembers,
  workflowRunEvents,
  workflowVersions,
  workflowTaskAttempts,
  workflows,
} from '../../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import {
  WORKFLOW_LEASE_MS,
  canonical,
  digest,
  type WorkflowActor,
  type WorkflowDocument,
  type WorkflowEvidence,
  type WorkflowTx,
} from './contract.js';
export type Run = typeof workflowRuns.$inferSelect;
export type Task = typeof workflowRunTasks.$inferSelect;
export type Member = typeof workflowRunMembers.$inferSelect;
export type Definition = typeof workflows.$inferSelect;
export type Version = typeof workflowVersions.$inferSelect;
export type Session = { tx: WorkflowTx; actor: WorkflowActor; now: string };
export const leaseUntil = (now: string) => new Date(Date.parse(now) + WORKFLOW_LEASE_MS).toISOString();
export const expired = (until: string | null, now: string) => !until || until <= now;
export const agentRecord = (actor: WorkflowActor) => ({ ...actor });
export const isSameBinding = (member: Member, actor: WorkflowActor) =>
  member.agentAddressId === actor.address_id &&
  member.sessionId === actor.session_id &&
  member.bindingGeneration === actor.binding_generation;
export function requireAgent(actor: WorkflowActor) {
  if (actor.kind !== 'agent' || !actor.address_id || !actor.session_id || !actor.binding_generation)
    throw new ForbiddenError('An authenticated agent binding is required', 'workflow_agent_required');
}
export function expect(actual: number, wanted: number, code: string) {
  if (actual !== wanted)
    throw new ConflictError('State changed; read the current version before retrying', code, {
      current_version: actual,
    });
}
export async function lockRun(ctx: Session, id: string) {
  const state=workflowState();
  const run = state ? structuredClone(state.table('workflowRuns').get(id)) : (await ctx.tx.select().from(workflowRuns).where(eq(workflowRuns.id, id)).for('update'))[0];
  if (!run) throw new NotFoundError('Workflow run not found', 'workflow_run_not_found');
  return run;
}
export async function members(ctx: Session, run: Run) {
  const state=workflowState();if(state)return structuredClone([...state.table('workflowRunMembers').by('runId',run.id)]);
  return ctx.tx.select().from(workflowRunMembers).where(eq(workflowRunMembers.runId, run.id));
}
export async function member(ctx: Session, run: Run) {
  requireAgent(ctx.actor);
  const list = await members(ctx, run);
  const found = list.find((m) => m.status === 'active' && isSameBinding(m, ctx.actor));
  if (!found)
    throw new ForbiddenError(
      'Active membership with the same session binding is required',
      'workflow_member_required',
    );
  return found;
}
export function assertPreparationReady(run: Run) {
  const p = run.preparation;
  if (p && (p.phase !== 'ready' || !p.summary || p.confirmation?.summary_revision !== p.summary.revision))
    throw new ConflictError('Confirm the current workflow summary before execution', 'workflow_confirmation_required');
}
export function mutable(run: Run) {
  if (run.status === 'completed')
    throw new ConflictError('Completed runs are immutable', 'workflow_run_completed');
}
export async function coordinator(
  ctx: Session,
  run: Run,
  generation: number | undefined,
  adminAllowed = false,
) {
  mutable(run);
  if (adminAllowed && ctx.actor.kind === 'admin') return;
  await member(ctx, run);
  if (
    run.coordinatorAddressId !== ctx.actor.address_id ||
    generation !== run.coordinatorGeneration ||
    (run.coordinatorOwnershipMode==='connection' ? !sameCoordinatorConnection(ctx,run) : expired(run.coordinatorLeaseUntil,ctx.now))
  )
    throw new ConflictError('Coordinator lease or generation was lost', 'workflow_coordinator_lost');
}
export async function pinned(ctx: Session, run: Run) {
  const state=workflowState();if(state){const row=state.table('workflowVersions').get(run.workflowVersionId);if(!row)throw new NotFoundError('Pinned workflow version missing');return structuredClone(row.document) as WorkflowDocument;}
  const [v] = await ctx.tx
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, run.workflowVersionId));
  if (!v) throw new NotFoundError('Pinned workflow version missing');
  return v.document as WorkflowDocument;
}
export async function tasks(ctx: Session, run: Run) {
  const state=workflowState();if(state)return structuredClone([...state.table('workflowRunTasks').by('runId',run.id)].sort((a,b)=>a.position-b.position));
  return ctx.tx
    .select()
    .from(workflowRunTasks)
    .where(eq(workflowRunTasks.runId, run.id))
    .orderBy(asc(workflowRunTasks.position))
    .for('update');
}
export const clearClaim = {
  claimOwnerAddressId: null,
  claimSessionId: null,
  claimBindingGeneration: null,
  claimTokenHash: null,
  claimLeaseUntil: null,
  claimRecovery: 0,
};
export async function event(ctx: Session, run: Run, type: string, detail: Record<string, unknown>) {
  run.eventSequence++;
  patchWorkflowRow('workflowRuns',run.id,{eventSequence:run.eventSequence,updatedAt:ctx.now});
  await ctx.tx
    .update(workflowRuns)
    .set({ eventSequence: run.eventSequence, updatedAt: ctx.now })
    .where(eq(workflowRuns.id, run.id));
  const row={
    id: randomUUID(),
    runId: run.id,
    sequence: run.eventSequence,
    type,
    detail,
    actor: agentRecord(ctx.actor),
    createdAt: ctx.now,
  };
  await ctx.tx.insert(workflowRunEvents).values(row);
  const active=workflowOwnerContext();
  const source=detail.source as {knowledge_id?:string}|undefined;
  if(active&&type==='note.knowledge'&&source?.knowledge_id){
    for(const old of active.command.draft.table('workflowRunEvents').by('runId',run.id)){const oldSource=old.detail.source as {knowledge_id?:string}|undefined;if(oldSource?.knowledge_id===source.knowledge_id&&(old.detail.task_id??null)===(detail.task_id??null)&&old.actor.address_id===row.actor.address_id&&old.actor.session_id===row.actor.session_id&&old.actor.binding_generation===row.actor.binding_generation)active.command.draft.remove('workflowRunEvents',old.id);}
    publishWorkflowRow('workflowRunEvents',row);
  }
}
export async function patchRun(ctx: Session, run: Run, patch: Partial<Run>) {
  if(patch.status==='completed'){const active=workflowOwnerContext();for(const row of active?.command.draft.table('workflowRunEvents').by('runId',run.id)??[])active!.command.draft.remove('workflowRunEvents',row.id);}
  Object.assign(run, patch, { version: run.version + 1, updatedAt: ctx.now });
  patchWorkflowRow('workflowRuns',run.id,{...patch,version:run.version,updatedAt:ctx.now});
  await ctx.tx
    .update(workflowRuns)
    .set({ ...patch, version: run.version, updatedAt: ctx.now })
    .where(eq(workflowRuns.id, run.id));
}
export async function patchTask(ctx: Session, t: Task, patch: Partial<Task>) {
  Object.assign(t, patch, { version: t.version + 1, updatedAt: ctx.now });
  patchWorkflowRow('workflowRunTasks',t.id,{...patch,version:t.version,updatedAt:ctx.now});
  await ctx.tx
    .update(workflowRunTasks)
    .set({ ...patch, version: t.version, updatedAt: ctx.now })
    .where(eq(workflowRunTasks.id, t.id));
}
/** Expiry is evidence of uncertainty, never evidence that external work stopped. */
export async function materializeExpiry(ctx: Session, run: Run) {
  for (const t of await tasks(ctx, run)) {
    if (t.claimOwnerAddressId && t.claimOwnershipMode!=='connection' && expired(t.claimLeaseUntil, ctx.now)) {
      const execution = t.status === 'running';
      await patchTask(ctx, t, {
        ...clearClaim,
        ...(execution
          ? { status: 'uncertain', reason: 'Claim lease expired; external effects require reconciliation' }
          : {}),
      });
      if(execution)for(const attempt of workflowState()?.table('workflowTaskAttempts').by('runId',run.id)??[])if(attempt.taskId===t.taskId&&attempt.attemptNo===t.attemptNo)patchWorkflowRow('workflowTaskAttempts',attempt.id,{status:'uncertain'});
      if (execution)
        await ctx.tx
          .update(workflowTaskAttempts)
          .set({ status: 'uncertain' })
          .where(
            and(
              eq(workflowTaskAttempts.runId, run.id),
              eq(workflowTaskAttempts.taskId, t.taskId),
              eq(workflowTaskAttempts.attemptNo, t.attemptNo),
            ),
          );
      await event(ctx, run, 'task.claim_expired', { task_id: t.taskId, claim_generation: t.claimGeneration });
    }
  }
}
export function checkClaim(
  ctx: Session,
  t: Task,
  token: string | undefined,
  generation: number | undefined,
  recovery = false,
) {
  if (
    !token ||
    t.claimTokenHash !== digest(token) ||
    t.claimOwnerAddressId !== ctx.actor.address_id ||
    t.claimSessionId !== ctx.actor.session_id ||
    t.claimBindingGeneration !== ctx.actor.binding_generation ||
    t.claimGeneration !== generation ||
    (t.claimOwnershipMode==='connection' ? !sameTaskConnection(ctx,t) : expired(t.claimLeaseUntil,ctx.now)) ||
    Boolean(t.claimRecovery) !== recovery
  )
    throw new ConflictError('Task claim was lost or belongs to another binding', 'workflow_claim_lost');
}
export function newClaim(ctx: Session, t: Task, recovery = false) {
  const proof=connectionActor(ctx);
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    patch: {
      claimOwnerAddressId: ctx.actor.address_id!,
      claimSessionId: ctx.actor.session_id!,
      claimBindingGeneration: ctx.actor.binding_generation!,
      claimGeneration: t.claimGeneration + 1,
      claimTokenHash: digest(token),
      claimLeaseUntil: proof?null:leaseUntil(ctx.now),
      claimOwnershipMode:proof?'connection':'timed',claimNativeInstanceId:proof?.instanceId??null,
      claimRecovery: recovery ? 1 : 0,
    },
  };
}
export function taskView(t: Task, now: string) {
  const expiredClaim = t.claimOwnerAddressId && t.claimOwnershipMode!=='connection' && expired(t.claimLeaseUntil, now);
  return {
    task_id: t.taskId,
    title: t.title,
    status: expiredClaim && t.status === 'running' ? 'uncertain' : t.status,
    version: t.version + (expiredClaim ? 1 : 0),
    attempt_no: t.attemptNo,
    skip_reason: t.skipReason,
    reason: t.reason,
    claim: t.claimOwnerAddressId
      ? {
          owner_address_id: t.claimOwnerAddressId,
          generation: t.claimGeneration,
          lease_until: t.claimOwnershipMode==='connection'?null:t.claimLeaseUntil,
          ownership_mode:t.claimOwnershipMode??'timed',
          recovery: !!t.claimRecovery,
          expired: !!expiredClaim,
        }
      : null,
  };
}
export function runView(run: Run, baseUrl: string) {
  return {
    run_id: run.id,
    workflow_id: run.workflowId,
    workflow_version: run.workflowVersion,
    workflow_sha256: run.workflowSha256,
    version: run.version,
    status: run.status,
    outcome: run.outcome,
    title: run.title,
    inputs: run.inputs,
    preparation: run.preparation ?? null,
    coordinator: run.coordinatorAddressId
      ? {
          address_id: run.coordinatorAddressId,
          generation: run.coordinatorGeneration,
          lease_until: run.coordinatorOwnershipMode==='connection'?null:run.coordinatorLeaseUntil,
          ownership_mode:run.coordinatorOwnershipMode??'timed',
          native_instance_id:run.coordinatorNativeInstanceId??null,
        }
      : null,
    cancel_requested: !!run.cancelRequested,
    report_url: `${baseUrl}/admin/workflows/runs/${run.id}`,
    communication: run.communication,
    summary: run.summary,
    criteria: run.criteria,
    results: run.results,
    open_items: run.openItems,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    completed_at: run.completedAt,
    event_sequence: run.eventSequence,
  };
}
/** Execution acknowledgements carry fences and outcomes, not the pinned instructions. */
export function compactRunMutation(result: Record<string, unknown>) {
  const fields = ['run_id', 'workflow_id', 'workflow_version', 'workflow_sha256', 'version', 'status',
    'outcome', 'coordinator', 'cancel_requested', 'report_url', 'event_sequence', 'task',
    'claim_token', 'claim_generation', 'sequence'];
  const preparation = result.preparation as Run['preparation'];
  return {
    ...Object.fromEntries(fields.filter((field) => field in result).map((field) => [field, result[field]])),
    compact: true,
    preparation: preparation ? {
      phase: preparation.phase,
      revision: preparation.revision,
      summary_revision: preparation.summary?.revision ?? null,
      confirmed_summary_revision: preparation.confirmation?.summary_revision ?? null,
    } : null,
  };
}
export async function dbNow(tx: WorkflowTx) {
  if(workflowState())return new Date().toISOString();
  const rows = await tx.execute(
    sql`SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS workflow_now`,
  );
  return new Date((rows[0] as unknown as Array<{ workflow_now: string }>)[0]!.workflow_now).toISOString();
}
export async function definition(tx: WorkflowTx, id: string, lock = false) {
  const state=workflowState();if(state){const row=/^[0-9a-f-]{36}$/i.test(id)?state.table('workflows').get(id):state.table('workflows').all().find(r=>r.slug===id);if(!row)throw new NotFoundError('Workflow not found','workflow_not_found');return structuredClone(row);}
  const query = tx
    .select()
    .from(workflows)
    .where(/^[0-9a-f-]{36}$/i.test(id) ? eq(workflows.id, id) : eq(workflows.slug, id));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new NotFoundError('Workflow not found', 'workflow_not_found');
  return row;
}
export async function publish(
  ctx: Session,
  w: Definition,
  document: WorkflowDocument,
  reason: string,
  expected: number,
  sourceRunId: string | null = null,
) {
  expect(w.currentVersion, expected, 'workflow_version_conflict');
  const state=workflowState();
  const old = state ? state.table('workflowVersions').get(w.currentVersionId) : (await ctx.tx.select().from(workflowVersions).where(eq(workflowVersions.id,w.currentVersionId)))[0];
  if (!old) throw new NotFoundError('Workflow head missing');
  const before = old.document as WorkflowDocument;
  if (canonical(before.goal) !== canonical(document.goal))
    throw new ConflictError(
      'The goal and success criteria are immutable; create another workflow',
      'workflow_goal_changed',
    );
  if (old.sha256 === digest(document)) return { version: old, changed: false };
  const row = {
    id: randomUUID(),
    workflowId: w.id,
    version: w.currentVersion + 1,
    previousVersionId: old.id,
    document: { ...document },
    sha256: digest(document),
    reason,
    diff: (Object.keys(document) as (keyof WorkflowDocument)[])
      .filter((k) => canonical(before[k]) !== canonical(document[k]))
      .map((field) => ({ field, before: before[field], after: document[field] })),
    sourceRunId,
    actor: agentRecord(ctx.actor),
    createdAt: ctx.now,
  };
  publishWorkflowRow('workflowVersions',row);
  await ctx.tx.insert(workflowVersions).values(row);
  patchWorkflowRow('workflows',w.id,{currentVersion:row.version,currentVersionId:row.id,title:document.title,summary:document.summary,controlVersion:w.controlVersion+1,updatedAt:ctx.now});
  await ctx.tx
    .update(workflows)
    .set({
      currentVersion: row.version,
      currentVersionId: row.id,
      title: document.title,
      summary: document.summary,
      controlVersion: w.controlVersion + 1,
      updatedAt: ctx.now,
    })
    .where(eq(workflows.id, w.id));
  return { version: row, changed: true };
}

/** Evidence remains addressable across retries, including failed historical attempts. */
export async function knownEvidence(ctx: Session, run: Run) {
  const rows = await ctx.tx
    .select({ evidence: workflowTaskAttempts.evidence })
    .from(workflowTaskAttempts)
    .where(eq(workflowTaskAttempts.runId, run.id));
  return new Set(rows.flatMap((row) => (row.evidence ?? []).map((e) => (e as { id: string }).id)));
}

/** An evidence ID keeps the same meaning across the entire run. Recovery appends
 * evidence to its open attempt; it never erases the observations that made the
 * external outcome uncertain in the first place. */
export async function mergeAttemptEvidence(ctx: Session, run: Run, task: Task, incoming: WorkflowEvidence[]) {
  if (new Set(incoming.map((e) => e.id)).size !== incoming.length)
    throw new ValidationError('Evidence IDs must be unique', { param: 'evidence' });
  const attempts = await ctx.tx
    .select({
      taskId: workflowTaskAttempts.taskId,
      attemptNo: workflowTaskAttempts.attemptNo,
      evidence: workflowTaskAttempts.evidence,
    })
    .from(workflowTaskAttempts)
    .where(eq(workflowTaskAttempts.runId, run.id));
  const registry = new Map<string, WorkflowEvidence>();
  for (const attempt of attempts)
    for (const entry of (attempt.evidence ?? []) as WorkflowEvidence[]) registry.set(entry.id, entry);
  const current = attempts.find((a) => a.taskId === task.taskId && a.attemptNo === task.attemptNo);
  if (!current) throw new NotFoundError('Task attempt not found', 'workflow_attempt_not_found');
  const merged = [...(current.evidence ?? [])] as WorkflowEvidence[];
  for (const entry of incoming) {
    const existing = registry.get(entry.id);
    if (existing && canonical(existing) !== canonical(entry))
      throw new ValidationError(`Evidence ${entry.id} already names another observation; use a new ID`, {
        param: 'evidence',
      });
    if (!merged.some((e) => e.id === entry.id)) merged.push(entry);
  }
  if (merged.length > 200)
    throw new ValidationError('An attempt may retain at most 200 evidence entries', { param: 'evidence' });
  return merged;
}

export function connectionActor(ctx:Session,actor:WorkflowActor=ctx.actor){
 const owner=workflowOwnerRuntime(),state=workflowState();if(!owner||!state)return null;
 const session=state.sessions.get(actor.session_id??'');
 const attachment=session&&session.bindingGeneration===actor.binding_generation&&session.agentBusAddressId===actor.address_id&&!session.endedAt?nativeClaimAttachment(owner,session):undefined;
 if(!session||!attachment?.scope.native_instance_id)throw new ConflictError('A live exact native process attachment is required','workflow_native_attachment_required');
 return{sessionId:session.id,binding:session.bindingGeneration,instanceId:attachment.scope.native_instance_id};
}
export function coordinatorOwnership(ctx:Session,actor:WorkflowActor=ctx.actor){const proof=connectionActor(ctx,actor);return{coordinatorOwnershipMode:proof?'connection':'timed',coordinatorSessionId:proof?.sessionId??null,coordinatorBindingGeneration:proof?.binding??null,coordinatorNativeInstanceId:proof?.instanceId??null,coordinatorLeaseUntil:proof?null:leaseUntil(ctx.now)};}
function sameTaskConnection(ctx:Session,t:Task){const owner=workflowOwnerRuntime(),state=workflowState();if(!owner||!state)return false;const session=state.sessions.get(ctx.actor.session_id??'');return Boolean(session&&session.bindingGeneration===t.claimBindingGeneration&&t.claimNativeInstanceId&&(nativeClaimAttachment(owner,session,t.claimNativeInstanceId)||legacyDrainFor(owner)?.session(session.id,session.bindingGeneration,t.claimNativeInstanceId)));}
function sameCoordinatorConnection(ctx:Session,run:Run){if(run.coordinatorSessionId!==ctx.actor.session_id||run.coordinatorBindingGeneration!==ctx.actor.binding_generation)return false;const owner=workflowOwnerRuntime(),state=workflowState();if(!owner||!state)return false;const session=state.sessions.get(run.coordinatorSessionId??'');return Boolean(session&&run.coordinatorNativeInstanceId&&(nativeClaimAttachment(owner,session,run.coordinatorNativeInstanceId)||legacyDrainFor(owner)?.session(session.id,session.bindingGeneration,run.coordinatorNativeInstanceId)));}
