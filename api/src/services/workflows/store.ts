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
  const [run] = await ctx.tx.select().from(workflowRuns).where(eq(workflowRuns.id, id)).for('update');
  if (!run) throw new NotFoundError('Workflow run not found', 'workflow_run_not_found');
  return run;
}
export async function members(ctx: Session, run: Run) {
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
    expired(run.coordinatorLeaseUntil, ctx.now)
  )
    throw new ConflictError('Coordinator lease or generation was lost', 'workflow_coordinator_lost');
}
export async function pinned(ctx: Session, run: Run) {
  const [v] = await ctx.tx
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, run.workflowVersionId));
  if (!v) throw new NotFoundError('Pinned workflow version missing');
  return v.document as WorkflowDocument;
}
export async function tasks(ctx: Session, run: Run) {
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
  await ctx.tx
    .update(workflowRuns)
    .set({ eventSequence: run.eventSequence, updatedAt: ctx.now })
    .where(eq(workflowRuns.id, run.id));
  await ctx.tx.insert(workflowRunEvents).values({
    id: randomUUID(),
    runId: run.id,
    sequence: run.eventSequence,
    type,
    detail,
    actor: agentRecord(ctx.actor),
    createdAt: ctx.now,
  });
}
export async function patchRun(ctx: Session, run: Run, patch: Partial<Run>) {
  Object.assign(run, patch, { version: run.version + 1, updatedAt: ctx.now });
  await ctx.tx
    .update(workflowRuns)
    .set({ ...patch, version: run.version, updatedAt: ctx.now })
    .where(eq(workflowRuns.id, run.id));
}
export async function patchTask(ctx: Session, t: Task, patch: Partial<Task>) {
  Object.assign(t, patch, { version: t.version + 1, updatedAt: ctx.now });
  await ctx.tx
    .update(workflowRunTasks)
    .set({ ...patch, version: t.version, updatedAt: ctx.now })
    .where(eq(workflowRunTasks.id, t.id));
}
/** Expiry is evidence of uncertainty, never evidence that external work stopped. */
export async function materializeExpiry(ctx: Session, run: Run) {
  for (const t of await tasks(ctx, run)) {
    if (t.claimOwnerAddressId && expired(t.claimLeaseUntil, ctx.now)) {
      const execution = t.status === 'running';
      await patchTask(ctx, t, {
        ...clearClaim,
        ...(execution
          ? { status: 'uncertain', reason: 'Claim lease expired; external effects require reconciliation' }
          : {}),
      });
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
    expired(t.claimLeaseUntil, ctx.now) ||
    Boolean(t.claimRecovery) !== recovery
  )
    throw new ConflictError('Task claim was lost or belongs to another binding', 'workflow_claim_lost');
}
export function newClaim(ctx: Session, t: Task, recovery = false) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    patch: {
      claimOwnerAddressId: ctx.actor.address_id!,
      claimSessionId: ctx.actor.session_id!,
      claimBindingGeneration: ctx.actor.binding_generation!,
      claimGeneration: t.claimGeneration + 1,
      claimTokenHash: digest(token),
      claimLeaseUntil: leaseUntil(ctx.now),
      claimRecovery: recovery ? 1 : 0,
    },
  };
}
export function taskView(t: Task, now: string) {
  const expiredClaim = t.claimOwnerAddressId && expired(t.claimLeaseUntil, now);
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
          lease_until: t.claimLeaseUntil,
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
          lease_until: run.coordinatorLeaseUntil,
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
export async function dbNow(tx: WorkflowTx) {
  const rows = await tx.execute(
    sql`SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS workflow_now`,
  );
  return new Date((rows[0] as unknown as Array<{ workflow_now: string }>)[0]!.workflow_now).toISOString();
}
export async function definition(tx: WorkflowTx, id: string, lock = false) {
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
  const [old] = await ctx.tx
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, w.currentVersionId));
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
  await ctx.tx.insert(workflowVersions).values(row);
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
