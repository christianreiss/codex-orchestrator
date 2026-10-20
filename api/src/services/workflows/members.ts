import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { workflowRunInvitations, workflowRunMembers, workflowTaskAttempts } from '../../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../../http/errors.js';
import {
  WORKFLOW_LIMITS,
  type MutationInput,
  type WorkflowActor,
  type WorkflowCollaboration,
} from './contract.js';
import {
  clearClaim,
  coordinator,
  event,
  expect,
  expired,
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
export async function addMember(ctx: Session, run: Run, actor: WorkflowActor, reason: string) {
  requireAgent(actor);
  const list = await members(ctx, run);
  const previous = list.find((m) => m.agentAddressId === actor.address_id);
  if (previous?.status === 'active') {
    if (previous.sessionId !== actor.session_id || previous.bindingGeneration !== actor.binding_generation)
      throw new ConflictError('Existing membership belongs to another binding', 'workflow_binding_changed');
    return;
  }
  if (list.filter((m) => m.status === 'active').length >= WORKFLOW_LIMITS.members)
    throw new ConflictError('The run has 32 active participants', 'workflow_member_limit');
  const row = {
    runId: run.id,
    agentAddressId: actor.address_id!,
    sessionId: actor.session_id!,
    bindingGeneration: actor.binding_generation!,
    actor: { ...actor },
    status: 'active',
    reason,
    updatedAt: ctx.now,
  };
  if (previous)
    await ctx.tx.update(workflowRunMembers).set(row).where(eq(workflowRunMembers.id, previous.id));
  else await ctx.tx.insert(workflowRunMembers).values({ id: randomUUID(), createdAt: ctx.now, ...row });
}
export async function syncGroup(
  ctx: Session,
  run: Run,
  collaboration: WorkflowCollaboration | undefined,
  closed = false,
) {
  const active = (await members(ctx, run))
    .filter((m) => m.status === 'active')
    .map((m) => m.actor as unknown as WorkflowActor);
  if (!run.communicationGroupId && active.length < 2) return;
  if (!collaboration)
    throw new ServiceUnavailableError(
      'Workflow communication adapter is unavailable',
      'workflow_collaboration_unavailable',
    );
  const group = await collaboration.syncGroup(ctx.tx, {
    run_id: run.id,
    group_id: run.communicationGroupId,
    members: active,
    closed,
  });
  if (group) {
    run.communicationGroupId = group.group_id;
    run.communication = { ...group };
    await ctx.tx
      .update((await import('../../db/schema.js')).workflowRuns)
      .set({ communicationGroupId: group.group_id, communication: { ...group } })
      .where(eq((await import('../../db/schema.js')).workflowRuns.id, run.id));
  }
}
export async function invite(
  ctx: Session,
  run: Run,
  input: MutationInput<'invite'>,
  collaboration: WorkflowCollaboration | undefined,
  reportUrl: string,
) {
  mutable(run);
  await member(ctx, run);
  if (run.status === 'evaluating')
    throw new ConflictError('Work already finished', 'workflow_execution_ended');
  if (input.target_address_id === ctx.actor.address_id)
    throw new ConflictError('Cannot invite yourself', 'workflow_invitation_self');
  if (!collaboration)
    throw new ServiceUnavailableError(
      'Workflow communication adapter is unavailable',
      'workflow_collaboration_unavailable',
    );
  const target = await collaboration.resolveTarget(ctx.tx, input.target_address_id);
  requireAgent(target);
  const existing = (await members(ctx, run)).find(
    (m) => m.agentAddressId === target.address_id && m.status === 'active',
  );
  if (existing) {
    if (existing.bindingGeneration !== target.binding_generation || existing.sessionId !== target.session_id)
      throw new ConflictError(
        'Membership belongs to an earlier binding; recover explicitly',
        'workflow_binding_changed',
      );
    return { already_member: true };
  }
  const all = await ctx.tx
    .select()
    .from(workflowRunInvitations)
    .where(
      and(
        eq(workflowRunInvitations.runId, run.id),
        eq(workflowRunInvitations.targetAddressId, target.address_id!),
        eq(workflowRunInvitations.status, 'pending'),
      ),
    );
  for (const old of all) {
    if (expired(old.expiresAt, ctx.now))
      await ctx.tx
        .update(workflowRunInvitations)
        .set({ status: 'expired', updatedAt: ctx.now })
        .where(eq(workflowRunInvitations.id, old.id));
    else if (
      old.targetBindingGeneration === target.binding_generation &&
      old.targetSessionId === target.session_id
    )
      return invitationView(old);
    else
      await ctx.tx
        .update(workflowRunInvitations)
        .set({ status: 'revoked', updatedAt: ctx.now })
        .where(eq(workflowRunInvitations.id, old.id));
  }
  const doc = await pinned(ctx, run);
  for (const id of input.task_ids)
    if (!doc.tasks.some((t) => t.id === id))
      throw new NotFoundError(`Unknown task ${id}`, 'workflow_task_not_found');
  const row = {
    id: randomUUID(),
    runId: run.id,
    inviterAddressId: ctx.actor.address_id!,
    targetAddressId: target.address_id!,
    targetSessionId: target.session_id!,
    targetBindingGeneration: target.binding_generation!,
    target: { ...target },
    reason: input.reason,
    taskIds: input.task_ids,
    status: 'pending',
    messageId: null as string | null,
    expiresAt: new Date(Date.parse(ctx.now) + 86400000).toISOString(),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await ctx.tx.insert(workflowRunInvitations).values(row);
  const message = await collaboration.invite(ctx.tx, {
    actor: ctx.actor,
    target,
    invitation_id: row.id,
    run_id: run.id,
    goal: doc.goal,
    reason: input.reason,
    task_ids: input.task_ids,
    report_url: reportUrl,
    client_request_id: input.client_request_id,
  });
  row.messageId = message.message_id;
  await ctx.tx
    .update(workflowRunInvitations)
    .set({ messageId: row.messageId })
    .where(eq(workflowRunInvitations.id, row.id));
  await event(ctx, run, 'member.invited', { invitation_id: row.id, target_address_id: target.address_id });
  return invitationView(row);
}
export function invitationView(
  row: typeof workflowRunInvitations.$inferSelect,
  now = new Date().toISOString(),
) {
  return {
    invitation_id: row.id,
    run_id: row.runId,
    inviter_address_id: row.inviterAddressId,
    target_address_id: row.targetAddressId,
    target_binding_generation: row.targetBindingGeneration,
    reason: row.reason,
    task_ids: row.taskIds,
    status: row.status === 'pending' && expired(row.expiresAt, now) ? 'expired' : row.status,
    message_id: row.messageId,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
  };
}
export async function membership(
  ctx: Session,
  run: Run,
  input: MutationInput<'membership'>,
  collaboration: WorkflowCollaboration | undefined,
) {
  mutable(run);
  requireAgent(ctx.actor);
  if ('invitation_id' in input) {
    const [inv] = await ctx.tx
      .select()
      .from(workflowRunInvitations)
      .where(
        and(eq(workflowRunInvitations.id, input.invitation_id), eq(workflowRunInvitations.runId, run.id)),
      )
      .for('update');
    if (!inv) throw new NotFoundError('Invitation not found', 'workflow_invitation_not_found');
    if (input.action === 'revoke_invitation') {
      await member(ctx, run);
      if (inv.inviterAddressId !== ctx.actor.address_id && run.coordinatorAddressId !== ctx.actor.address_id)
        throw new ForbiddenError('Only inviter or coordinator may revoke', 'workflow_member_required');
    } else if (
      inv.targetAddressId !== ctx.actor.address_id ||
      inv.targetSessionId !== ctx.actor.session_id ||
      inv.targetBindingGeneration !== ctx.actor.binding_generation
    )
      throw new ForbiddenError(
        'Invitation belongs to a different recipient binding',
        'workflow_invitation_recipient',
      );
    if (expired(inv.expiresAt, ctx.now))
      throw new ConflictError('Invitation expired', 'workflow_invitation_expired');
    if (inv.status !== 'pending') {
      if (input.action === 'accept' && inv.status === 'accepted')
        return { status: 'accepted', invitation_id: inv.id };
      throw new ConflictError('Invitation is no longer pending', 'workflow_invitation_closed');
    }
    if (run.status === 'evaluating' && input.action === 'accept')
      throw new ConflictError('Execution already ended', 'workflow_execution_ended');
    const status =
      input.action === 'accept' ? 'accepted' : input.action === 'decline' ? 'declined' : 'revoked';
    if (input.action === 'accept') await addMember(ctx, run, ctx.actor, input.reason);
    await ctx.tx
      .update(workflowRunInvitations)
      .set({ status, updatedAt: ctx.now })
      .where(eq(workflowRunInvitations.id, inv.id));
    await syncGroup(ctx, run, collaboration);
    await event(ctx, run, `member.${status}`, { invitation_id: inv.id, address_id: inv.targetAddressId });
    return { status, invitation_id: inv.id };
  }
  await member(ctx, run);
  const address = input.action === 'remove' ? input.target_address_id : ctx.actor.address_id!;
  if (address === run.coordinatorAddressId)
    throw new ConflictError(
      'Transfer coordination before leaving or removing its owner',
      'workflow_coordinator_required',
    );
  if (input.action === 'remove') {
    expect(run.version, input.expected_run_version, 'workflow_run_version_conflict');
    await coordinator(ctx, run, input.coordinator_generation);
  }
  const found = (await members(ctx, run)).find((m) => m.agentAddressId === address && m.status === 'active');
  if (!found) throw new NotFoundError('Active participant not found', 'workflow_member_not_found');
  for (const t of await tasks(ctx, run)) {
    if (t.claimOwnerAddressId !== address) continue;
    if (input.action === 'leave')
      throw new ConflictError('Resolve or release owned claims before leaving', 'workflow_member_has_claims');
    await patchTask(ctx, t, { ...clearClaim, status: 'uncertain', reason: input.reason });
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
  }
  const status = input.action === 'leave' ? 'left' : 'removed';
  await ctx.tx
    .update(workflowRunMembers)
    .set({ status, reason: input.reason, updatedAt: ctx.now })
    .where(eq(workflowRunMembers.id, found.id));
  if (input.action === 'remove') await patchRun(ctx, run, {});
  await syncGroup(ctx, run, collaboration);
  await event(ctx, run, `member.${status}`, { address_id: address, reason: input.reason });
  return { status, address_id: address };
}
