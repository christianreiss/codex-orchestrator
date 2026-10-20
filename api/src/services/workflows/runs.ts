import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  workflowRuns,
  workflowRunTasks,
  workflowRunEvaluations,
  workflowVersions,
  workflowRunMembers,
} from '../../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import {
  validateInputs,
  requireWorkflowProtocol,
  type MutationInput,
  type WorkflowCollaboration,
  type WorkflowDocument,
  type WorkflowActor,
} from './contract.js';
import { addMember, syncGroup } from './members.js';
import { validateKnowledgeReceipt } from './knowledge.js';
import {
  assertPreparationReady,
  agentRecord,
  coordinator,
  knownEvidence,
  definition,
  event,
  expect,
  expired,
  leaseUntil,
  member,
  members,
  mutable,
  patchRun,
  patchTask,
  pinned,
  requireAgent,
  tasks,
  type Run,
  type Session,
} from './store.js';
export async function createRun(ctx: Session, input: MutationInput<'run_create'>) {
  requireWorkflowProtocol(ctx.actor);
  const workflow = await definition(ctx.tx, input.workflow_id, true);
  if (workflow.status !== 'active')
    throw new ConflictError('Archived workflows cannot start runs', 'workflow_archived');
  const number = input.version === 'latest' ? workflow.currentVersion : input.version;
  const [v] = await ctx.tx
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, workflow.id), eq(workflowVersions.version, number)));
  if (!v) throw new NotFoundError('Workflow version not found', 'workflow_version_not_found');
  const doc = v.document as WorkflowDocument;
  const agent = ctx.actor.kind === 'agent';
  if (agent) requireAgent(ctx.actor);
  const row: Run = {
    id: randomUUID(),
    workflowId: workflow.id,
    workflowVersionId: v.id,
    workflowVersion: number,
    workflowSha256: v.sha256,
    title: input.title,
    inputs: validateInputs(doc, input.inputs, true),
    preparation: { phase: 'clarifying', revision: 1, notes: '', questions: [], summary: null, confirmation: null },
    status: 'pending',
    outcome: null,
    version: 1,
    eventSequence: 0,
    coordinatorAddressId: agent ? ctx.actor.address_id! : null,
    coordinatorGeneration: agent ? 1 : 0,
    coordinatorLeaseUntil: agent ? leaseUntil(ctx.now) : null,
    cancelRequested: 0,
    communicationGroupId: null,
    communication: null,
    summary: null,
    criteria: null,
    results: null,
    openItems: null,
    report: null,
    actor: agentRecord(ctx.actor),
    startedAt: null,
    finishedAt: null,
    completedAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await ctx.tx.insert(workflowRuns).values(row);
  await ctx.tx.insert(workflowRunTasks).values(
    doc.tasks.map((t, i) => ({
      id: randomUUID(),
      runId: row.id,
      taskId: t.id,
      position: i,
      title: t.title,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })),
  );
  if (agent) await addMember(ctx, row, ctx.actor, 'Run creator');
  await event(ctx, row, 'run.created', { workflow_version: number });
  return row;
}
export async function runControl(
  ctx: Session,
  run: Run,
  input: MutationInput<'run_control'>,
  collaboration: WorkflowCollaboration | undefined,
) {
  mutable(run);
  expect(run.version, input.expected_run_version, 'workflow_run_version_conflict');
  let cancelDeliveries: Record<string, unknown> | undefined;
  if (input.action === 'configure') {
    if (run.status !== 'pending')
      throw new ConflictError('Only pending runs may be configured', 'workflow_run_not_pending');
    if (ctx.actor.kind === 'agent') await member(ctx, run);
    const doc = await pinned(ctx, run);
    if (input.questions && new Set(input.questions.map(q => q.id)).size !== input.questions.length)
      throw new ValidationError('Question IDs must be unique', { param: 'questions' });
    if (input.questions && !run.preparation)
      throw new ConflictError('Historical run has no clarification phase', 'workflow_legacy_run');
    await patchRun(ctx, run, {
      title: input.title ?? run.title,
      inputs: input.inputs ? validateInputs(doc, input.inputs, !!run.preparation) : run.inputs,
      ...(run.preparation ? { preparation: { phase: 'clarifying' as const, revision: run.preparation.revision + 1,
        notes: run.preparation.notes, questions: input.questions ?? run.preparation.questions, summary: null, confirmation: null } } : {}),
    });
  } else if (input.action === 'present_summary' || input.action === 'confirm_summary') {
    if (run.status !== 'pending' || !run.preparation)
      throw new ConflictError('Only unstarted clarification runs can be reviewed', 'workflow_run_not_pending');
    if (ctx.actor.kind === 'agent') await coordinator(ctx, run, input.coordinator_generation);
    const preparation = run.preparation;
    if (input.action === 'present_summary') {
      const doc = await pinned(ctx, run);
      const inputs = validateInputs(doc, run.inputs);
      if (preparation.questions.some(q => !q.answer?.trim()))
        throw new ValidationError('Answer every open follow-up question first', { param: 'questions' });
      const revision = preparation.revision + 1;
      await patchRun(ctx, run, { preparation: { ...preparation, phase: 'awaiting_confirmation', revision, notes: input.notes,
        summary: { revision, title: run.title, goal: doc.goal.statement, inputs,
          questions: preparation.questions, tasks: doc.tasks.map(({ id, title, instructions, acceptance_criteria }) => ({ id, title, instructions, acceptance_criteria })), notes: input.notes }, confirmation: null } });
    } else {
      if (preparation.phase !== 'awaiting_confirmation' || !preparation.summary || preparation.summary.revision !== input.summary_revision)
        throw new ConflictError('Read and confirm the current summary revision', 'workflow_summary_revision_conflict');
      if (ctx.actor.kind === 'agent' && !input.user_confirmation?.trim())
        throw new ValidationError('Record the explicit user approval of this summary', { param: 'user_confirmation' });
      await patchRun(ctx, run, { preparation: { ...preparation, phase: 'ready', confirmation: {
        summary_revision: input.summary_revision, actor: agentRecord(ctx.actor), time: ctx.now,
        channel: ctx.actor.kind === 'admin' ? 'web' : 'conversation',
        user_confirmation: input.user_confirmation ?? 'Confirmed in the workflow review',
      } } });
    }
  } else if (input.action === 'start' || input.action === 'coordinator_acquire') {
    requireAgent(ctx.actor);
    if (input.action === 'start') {
      if (run.status !== 'pending')
        throw new ConflictError('Run already started', 'workflow_run_not_pending');
      assertPreparationReady(run);
    }
    if (run.status === 'pending' && !run.coordinatorAddressId) {
      await addMember(ctx, run, ctx.actor, 'First coordinator');
      await patchRun(ctx, run, {
        ...(input.action === 'start' || !run.preparation ? { status: 'running', startedAt: ctx.now } : {}),
        coordinatorAddressId: ctx.actor.address_id!,
        coordinatorGeneration: run.coordinatorGeneration + 1,
        coordinatorLeaseUntil: leaseUntil(ctx.now),
      });
    } else {
      await member(ctx, run);
      if (input.action === 'start') {
        await coordinator(ctx, run, input.coordinator_generation);
        await patchRun(ctx, run, { status: 'running', startedAt: ctx.now });
      } else {
        if (!expired(run.coordinatorLeaseUntil, ctx.now))
          throw new ConflictError('Coordinator lease remains valid', 'workflow_coordinator_claimed');
        await patchRun(ctx, run, {
          coordinatorAddressId: ctx.actor.address_id!,
          coordinatorGeneration: run.coordinatorGeneration + 1,
          coordinatorLeaseUntil: leaseUntil(ctx.now),
        });
      }
    }
  } else if (input.action === 'coordinator_recover') {
    if (ctx.actor.kind !== 'admin')
      throw new ForbiddenError('Operator recovery requires admin authorization', 'workflow_admin_required');
    if (!collaboration)
      throw new ConflictError('Messaging is unavailable', 'workflow_collaboration_unavailable');
    const target = await collaboration.resolveTarget(ctx.tx, input.target_address_id);
    const old = (await members(ctx, run)).find((m) => m.agentAddressId === target.address_id);
    if (
      old?.status === 'active' &&
      (old.sessionId !== target.session_id || old.bindingGeneration !== target.binding_generation)
    ) {
      if ((await tasks(ctx, run)).some((t) => t.claimOwnerAddressId === target.address_id))
        throw new ConflictError(
          'Resolve earlier binding claims before recovery',
          'workflow_member_has_claims',
        );
      await ctx.tx
        .update(workflowRunMembers)
        .set({ status: 'removed', reason: input.reason, updatedAt: ctx.now })
        .where(eq(workflowRunMembers.id, old.id));
    }
    await addMember(ctx, run, target, input.reason);
    await patchRun(ctx, run, {
      coordinatorAddressId: target.address_id!,
      coordinatorGeneration: run.coordinatorGeneration + 1,
      coordinatorLeaseUntil: leaseUntil(ctx.now),
      ...(run.status === 'pending' && !run.preparation ? { status: 'running', startedAt: ctx.now } : {}),
    });
    await syncGroup(ctx, run, collaboration);
  } else {
    await coordinator(
      ctx,
      run,
      input.coordinator_generation,
      ['pause', 'resume', 'block', 'request_cancel'].includes(input.action),
    );
    if (input.action === 'coordinator_renew')
      await patchRun(ctx, run, { coordinatorLeaseUntil: leaseUntil(ctx.now) });
    else if (input.action === 'coordinator_transfer') {
      const target = (await members(ctx, run)).find(
        (m) => m.agentAddressId === input.target_address_id && m.status === 'active',
      );
      if (!target)
        throw new ConflictError('Target must be an active participant', 'workflow_member_required');
      if (collaboration) {
        const current = await collaboration.resolveTarget(ctx.tx, target.agentAddressId);
        if (
          current.session_id !== target.sessionId ||
          current.binding_generation !== target.bindingGeneration
        )
          throw new ConflictError('Coordinator target binding changed', 'workflow_binding_changed');
      }
      await patchRun(ctx, run, {
        coordinatorAddressId: target.agentAddressId,
        coordinatorGeneration: run.coordinatorGeneration + 1,
        coordinatorLeaseUntil: leaseUntil(ctx.now),
      });
    } else {
      if (!['running', 'paused', 'blocked'].includes(run.status))
        throw new ConflictError('Run control is only available during execution', 'workflow_execution_ended');
      if (input.action === 'resume' && !['paused', 'blocked'].includes(run.status))
        throw new ConflictError('Only paused or blocked runs may resume', 'workflow_run_transition');
      if (input.action === 'request_cancel') {
        await patchRun(ctx, run, { cancelRequested: 1 });
        if (collaboration?.notifyCancel)
          cancelDeliveries = await collaboration.notifyCancel(ctx.tx, {
            actor: ctx.actor,
            run_id: run.id,
            members: (await members(ctx, run))
              .filter((m) => m.status === 'active')
              .map((m) => m.actor as unknown as WorkflowActor),
            reason: input.reason,
            client_request_id: input.client_request_id,
          });
        else if ((await tasks(ctx, run)).some((t) => t.claimOwnerAddressId))
          throw new ConflictError(
            'Cancellation notification adapter is unavailable',
            'workflow_collaboration_unavailable',
          );
      } else
        await patchRun(ctx, run, {
          status: input.action === 'pause' ? 'paused' : input.action === 'block' ? 'blocked' : 'running',
        });
    }
  }
  await event(ctx, run, `run.${input.action}`, {
    ...('reason' in input ? { reason: input.reason } : {}),
    coordinator_generation: run.coordinatorGeneration,
    ...(['configure', 'present_summary', 'confirm_summary'].includes(input.action) ? { title: run.title, inputs: run.inputs, preparation: run.preparation } : {}),
    ...(cancelDeliveries ? { notifications: cancelDeliveries } : {}),
  });
  return run;
}
export async function runNote(ctx: Session, run: Run, input: MutationInput<'run_note'>) {
  mutable(run);
  await member(ctx, run);
  const doc = await pinned(ctx, run);
  const evidenceSet = await knownEvidence(ctx, run);
  if (input.task_id && !doc.tasks.some((t) => t.id === input.task_id))
    throw new NotFoundError('Task not found', 'workflow_task_not_found');
  if (input.evidence_ids?.some((id) => !evidenceSet.has(id)))
    throw new ValidationError('Unknown evidence reference', { param: 'evidence_ids' });
  if (input.kind === 'knowledge' && !input.source)
    throw new ValidationError('Knowledge notes need source metadata', { param: 'source' });
  validateKnowledgeReceipt(doc, run, input, ctx.now);
  await event(ctx, run, `note.${input.kind}`, {
    text: input.text,
    task_id: input.task_id ?? null,
    evidence_ids: input.evidence_ids ?? [],
    source: input.source ?? null,
  });
  return { sequence: run.eventSequence };
}
export async function finishRun(ctx: Session, run: Run, input: MutationInput<'run_finish'>) {
  await coordinator(ctx, run, input.coordinator_generation);
  expect(run.version, input.expected_run_version, 'workflow_run_version_conflict');
  if (!['pending', 'running', 'paused', 'blocked'].includes(run.status))
    throw new ConflictError('Work already finished', 'workflow_execution_ended');
  const doc = await pinned(ctx, run);
  const list = await tasks(ctx, run);
  if (list.some((t) => t.status === 'running' || t.claimOwnerAddressId))
    throw new ConflictError(
      'Known running attempts or recovery claims must finish first',
      'workflow_tasks_running',
    );
  const uncertain = list
    .filter((t) => t.status === 'uncertain')
    .map((t) => t.taskId)
    .sort();
  if (
    uncertain.length &&
    (input.outcome !== 'unknown' ||
      JSON.stringify([...input.uncertain_task_ids].sort()) !== JSON.stringify(uncertain))
  )
    throw new ConflictError(
      'Uncertain external effects require outcome unknown and exact task IDs',
      'workflow_task_uncertain',
    );
  if (uncertain.length && !input.open_items.length)
    throw new ValidationError('Uncertain tasks require an explicit statement of remaining external risks', {
      param: 'open_items',
    });
  if (input.uncertain_task_ids.some((id) => !uncertain.includes(id)))
    throw new ValidationError('Unknown uncertain task', { param: 'uncertain_task_ids' });
  const ids = doc.goal.success_criteria.map((c) => c.id).sort();
  if (JSON.stringify(input.criteria.map((c) => c.id).sort()) !== JSON.stringify(ids))
    throw new ValidationError('Rate every goal criterion exactly once', { param: 'criteria' });
  const evidenceSet = await knownEvidence(ctx, run);
  for (const c of input.criteria) {
    for (const id of c.evidence_ids)
      if (!evidenceSet.has(id)) throw new ValidationError(`Unknown evidence ${id}`, { param: 'criteria' });
    if (c.status === 'met' && !c.evidence_ids.length)
      throw new ValidationError('Met criteria need evidence references', { param: 'criteria' });
  }
  const met = input.criteria.filter((c) => c.status === 'met').length;
  if (
    input.outcome === 'succeeded' &&
    (met !== ids.length ||
      list.some(
        (t) => t.status !== 'succeeded' && !(t.status === 'skipped' && t.skipReason === 'not_applicable'),
      ))
  )
    throw new ConflictError(
      'Success needs every criterion met and every task successful or not applicable',
      'workflow_outcome_inconsistent',
    );
  if (input.outcome === 'partial' && (met === 0 || met === ids.length))
    throw new ConflictError(
      'Partial requires some but not all criteria met',
      'workflow_outcome_inconsistent',
    );
  for (const t of list)
    if (t.status === 'pending')
      await patchTask(ctx, t, { status: 'skipped', skipReason: 'run_ended', reason: input.summary });
  await patchRun(ctx, run, {
    status: 'evaluating',
    outcome: input.outcome,
    summary: input.summary,
    criteria: input.criteria,
    results: input.results,
    openItems: input.open_items,
    finishedAt: ctx.now,
  });
  await ctx.tx
    .insert(workflowRunEvaluations)
    .values({ runId: run.id, status: 'pending', createdAt: ctx.now, updatedAt: ctx.now });
  await event(ctx, run, 'run.finished', { outcome: input.outcome, uncertain_task_ids: uncertain });
  return run;
}
export async function prepareCancel(ctx: Session, run: Run, input: MutationInput<'prepare_cancel'>) {
  if (ctx.actor.kind !== 'admin')
    throw new ForbiddenError('Only an operator can cancel a prepared run', 'workflow_admin_required');
  expect(run.version, input.expected_run_version, 'workflow_run_version_conflict');
  if (run.status !== 'pending' || (run.coordinatorAddressId && !run.preparation))
    throw new ConflictError(
      'Only an unstarted run can be canceled here',
      'workflow_run_not_pending',
    );
  const doc = await pinned(ctx, run);
  for (const t of await tasks(ctx, run))
    await patchTask(ctx, t, { status: 'skipped', skipReason: 'run_ended', reason: input.reason });
  await patchRun(ctx, run, {
    status: 'evaluating',
    outcome: 'canceled',
    summary: input.reason,
    criteria: doc.goal.success_criteria.map((c) => ({
      id: c.id,
      status: 'unverified',
      reason: input.reason,
      evidence_ids: [],
    })),
    results: {},
    openItems: ['Evaluation by an agent is required'],
    finishedAt: ctx.now,
  });
  await ctx.tx
    .insert(workflowRunEvaluations)
    .values({ runId: run.id, status: 'pending', createdAt: ctx.now, updatedAt: ctx.now });
  await event(ctx, run, 'run.prepared_cancel', { reason: input.reason });
  return run;
}
