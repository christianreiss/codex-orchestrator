import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { workflowRunTasks, workflowTaskAttempts } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import type { MutationInput } from './contract.js';
import {
  checkClaim,
  clearClaim,
  event,
  expect,
  leaseUntil,
  member,
  mutable,
  newClaim,
  patchTask,
  pinned,
  taskView,
  tasks,
  type Run,
  type Session,
  type Task,
} from './store.js';
async function target(ctx: Session, run: Run, id: string) {
  mutable(run);
  await member(ctx, run);
  if (run.status === 'evaluating')
    throw new ConflictError('Execution ended; tasks are immutable', 'workflow_execution_ended');
  const list = await tasks(ctx, run);
  const t = list.find((t) => t.taskId === id);
  if (!t) throw new NotFoundError('Task not found', 'workflow_task_not_found');
  return { t, list };
}
async function executable(ctx: Session, run: Run, t: Task, list: Task[]) {
  if (run.status !== 'running' || run.cancelRequested)
    throw new ConflictError('Run does not allow new work', 'workflow_run_not_running');
  const document = await pinned(ctx, run);
  for (const dependency of document.tasks.find((d) => d.id === t.taskId)!.depends_on) {
    const dep = list.find((t) => t.taskId === dependency)!;
    if (dep.status !== 'succeeded' && !(dep.status === 'skipped' && dep.skipReason === 'not_applicable'))
      throw new ConflictError(`Dependency ${dependency} is not satisfied`, 'workflow_dependency_unmet', {
        task_id: dependency,
      });
  }
}
async function finishAttempt(
  ctx: Session,
  run: Run,
  t: Task,
  patch: Partial<typeof workflowTaskAttempts.$inferSelect>,
) {
  await ctx.tx
    .update(workflowTaskAttempts)
    .set(patch)
    .where(
      and(
        eq(workflowTaskAttempts.runId, run.id),
        eq(workflowTaskAttempts.taskId, t.taskId),
        eq(workflowTaskAttempts.attemptNo, t.attemptNo),
      ),
    );
}
export async function taskClaim(ctx: Session, run: Run, input: MutationInput<'task_claim'>) {
  const { t, list } = await target(ctx, run, input.task_id);
  expect(t.version, input.expected_task_version, 'workflow_task_version_conflict');
  let token: string | undefined;
  if (input.action === 'acquire') {
    if (t.status === 'uncertain')
      throw new ConflictError(
        'Reconcile the uncertain attempt before another execution',
        'workflow_task_uncertain',
      );
    if (t.claimOwnerAddressId) throw new ConflictError('Task already has a claim', 'workflow_task_claimed');
    if (t.status !== 'pending')
      throw new ConflictError(
        'Only pending tasks may start; retry a failed task explicitly',
        'workflow_task_not_pending',
      );
    await executable(ctx, run, t, list);
    const claim = newClaim(ctx, t);
    token = claim.token;
    await patchTask(ctx, t, { ...claim.patch, status: 'running', attemptNo: t.attemptNo + 1 });
    await ctx.tx.insert(workflowTaskAttempts).values({
      id: randomUUID(),
      runId: run.id,
      taskId: t.taskId,
      attemptNo: t.attemptNo,
      status: 'running',
      actor: { ...ctx.actor },
      startedAt: ctx.now,
    });
  } else if (input.action === 'renew') {
    checkClaim(ctx, t, input.claim_token, input.claim_generation, !!t.claimRecovery);
    await patchTask(ctx, t, { claimLeaseUntil: leaseUntil(ctx.now) });
  } else if (input.action === 'release') {
    checkClaim(ctx, t, input.claim_token, input.claim_generation, !!t.claimRecovery);
    await patchTask(ctx, t, { ...clearClaim, status: 'uncertain', reason: input.reason });
    await finishAttempt(ctx, run, t, { status: 'uncertain', summary: input.reason });
  } else if (input.stage === 'begin') {
    if (t.status !== 'uncertain')
      throw new ConflictError('Only uncertain tasks can be reconciled', 'workflow_task_not_uncertain');
    if (t.claimOwnerAddressId)
      throw new ConflictError('Task already has a recovery claim', 'workflow_task_claimed');
    const claim = newClaim(ctx, t, true);
    token = claim.token;
    await patchTask(ctx, t, claim.patch);
  } else {
    checkClaim(ctx, t, input.claim_token, input.claim_generation, true);
    if (!input.resolution)
      throw new ValidationError('Reconcile resolve needs resolution', { param: 'resolution' });
    if (input.resolution === 'still_uncertain') {
      await patchTask(ctx, t, { ...clearClaim, reason: input.reason });
    } else {
      if (!input.old_execution_stopped || !input.evidence?.length || !input.execution_host)
        throw new ValidationError(
          'Confirmed stopped old execution, evidence and execution_host are required',
          { param: 'old_execution_stopped' },
        );
      const status = input.resolution === 'verified_success' ? 'succeeded' : 'failed';
      await patchTask(ctx, t, {
        ...clearClaim,
        status,
        reason: input.reason,
        outputs: input.outputs ?? {},
        evidence: input.evidence,
      });
      await finishAttempt(ctx, run, t, {
        status,
        endedAt: ctx.now,
        summary: input.reason,
        outputs: input.outputs ?? {},
        evidence: input.evidence,
        executionHost: input.execution_host,
      });
    }
  }
  await event(ctx, run, `task.${input.action}`, {
    task_id: t.taskId,
    task_version: t.version,
    ...(input.action === 'reconcile'
      ? { stage: input.stage, resolution: input.resolution ?? null, reason: input.reason }
      : {}),
    claim_generation: t.claimGeneration,
  });
  return {
    ...taskView(t, ctx.now),
    ...(token ? { claim_token: token, claim_generation: t.claimGeneration } : {}),
  };
}
export async function taskUpdate(ctx: Session, run: Run, input: MutationInput<'task_update'>) {
  const { t, list } = await target(ctx, run, input.task_id);
  expect(t.version, input.expected_task_version, 'workflow_task_version_conflict');
  if (input.action === 'retry') {
    if (t.status === 'uncertain')
      throw new ConflictError('Reconciliation is required before retry', 'workflow_task_uncertain');
    if (!['failed', 'blocked'].includes(t.status) || t.claimOwnerAddressId)
      throw new ConflictError(
        'Only a failed or resolved blocked task can retry',
        'workflow_task_not_retryable',
      );
    await executable(ctx, run, t, list);
    await patchTask(ctx, t, { status: 'pending', reason: input.reason });
  } else if (input.action === 'skip') {
    await executable(ctx, run, t, list);
    if (t.status !== 'pending' || t.claimOwnerAddressId)
      throw new ConflictError('Only a task without an attempt can be skipped', 'workflow_task_not_pending');
    await patchTask(ctx, t, { status: 'skipped', skipReason: 'not_applicable', reason: input.reason });
  } else {
    checkClaim(ctx, t, input.claim_token, input.claim_generation);
    if (t.status !== 'running') throw new ConflictError('Task is not running', 'workflow_claim_lost');
    if (input.status === 'succeeded' && !input.evidence.length)
      throw new ValidationError('A successful task needs evidence', { param: 'evidence' });
    if (new Set(input.evidence.map((e) => e.id)).size !== input.evidence.length)
      throw new ValidationError('Evidence IDs must be unique', { param: 'evidence' });
    await patchTask(ctx, t, {
      ...clearClaim,
      status: input.status,
      reason: input.summary,
      outputs: input.outputs,
      evidence: input.evidence,
    });
    await finishAttempt(ctx, run, t, {
      status: input.status,
      summary: input.summary,
      outputs: input.outputs,
      evidence: input.evidence,
      error: input.error ?? null,
      executionHost: input.execution_host,
      ...(input.status !== 'uncertain' ? { endedAt: ctx.now } : {}),
    });
  }
  await event(ctx, run, `task.${input.action}`, {
    task_id: t.taskId,
    task_version: t.version,
    status: t.status,
    reason: input.action === 'result' ? input.summary : input.reason,
  });
  return taskView(t, ctx.now);
}
