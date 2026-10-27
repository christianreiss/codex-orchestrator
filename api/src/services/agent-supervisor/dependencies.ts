import type { OwnerMutationContext } from '../../control-plane/state/runtime.js';
import type { Keyring } from '../../security/keyring.js';
import { agentWorkDependencies } from '../../db/schema.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { stageCoordinationNotice } from '../../control-plane/state/coordination-notices.js';
import { stageSupervisorAttention } from './notices.js';
import { SUPERVISOR } from './policy.js';
import { isEngine } from '../../util/engine.js';

export function stageSupervisorDependencies(ctx: OwnerMutationContext, keyring: Keyring, now: Date) {
  const timestamp = now.toISOString();
  // Accepted work creates a durable edge even when an agent forgets to register its wait.
  const addEdge = (
    id: string,
    waiter: string,
    dependency: string,
    messageId: string | null,
    workflowTaskId: string | null,
    createdAt: string,
  ) => {
    if (waiter === dependency || !isEngine(ctx.draft.table('agentBusAddresses').get(waiter)?.engine ?? ''))
      return;
    const existing = ctx.draft.table('agentWorkDependencies').get(id);
    if (existing) {
      if (
        existing.dependencyAddressId !== dependency ||
        (existing.status !== 'waiting' && createdAt > existing.updatedAt)
      )
        stageUpdate(ctx, 'agentWorkDependencies', id, {
          dependencyAddressId: dependency,
          status: 'waiting',
          reminderAt: null,
          createdAt,
          updatedAt: timestamp,
        });
      return;
    }
    const row = {
      id,
      waiterAddressId: waiter,
      dependencyAddressId: dependency,
      messageId,
      workflowTaskId,
      status: 'waiting',
      reminderAt: null,
      createdAt,
      updatedAt: timestamp,
    };
    ctx.draft.upsert('agentWorkDependencies', row);
    ctx.write(async (tx) => tx.insert(agentWorkDependencies).values(row));
  };
  for (const message of ctx.draft.table('agentBusMessages').all()) {
    if (
      message.workKind &&
      message.acceptedAt &&
      !message.taskResultStatus &&
      !message.cancelRequestedAt &&
      !['canceled', 'dead', 'expired'].includes(message.status)
    )
      addEdge(
        message.id,
        message.senderAddressId,
        message.targetAddressId,
        message.id,
        null,
        message.acceptedAt,
      );
  }
  for (const task of ctx.draft.table('workflowRunTasks').all()) {
    const run = ctx.draft.table('workflowRuns').get(task.runId);
    if (
      task.claimOwnerAddressId &&
      run?.coordinatorAddressId &&
      !['completed', 'canceled', 'paused'].includes(run.status) &&
      ['claimed', 'running'].includes(task.status)
    )
      addEdge(task.id, run.coordinatorAddressId, task.claimOwnerAddressId, null, task.id, task.updatedAt);
  }
  for (const edge of ctx.draft.table('agentWorkDependencies').all()) {
    if (!['waiting', 'attention'].includes(edge.status)) continue;
    const request = edge.messageId ? ctx.draft.table('agentBusMessages').get(edge.messageId) : undefined;
    const task = edge.workflowTaskId
      ? ctx.draft.table('workflowRunTasks').get(edge.workflowTaskId)
      : undefined;
    const workflow = task ? ctx.draft.table('workflowRuns').get(task.runId) : undefined;
    if (workflow?.status === 'paused') continue;
    if (workflow?.status === 'canceled') {
      stageUpdate(ctx, 'agentWorkDependencies', edge.id, { status: 'canceled', updatedAt: timestamp });
      continue;
    }
    const result =
      request?.taskResultStatus ??
      (task && ['succeeded', 'failed', 'blocked', 'skipped'].includes(task.status) ? task.status : null);
    const waiter = ctx.draft.table('agentBusAddresses').get(edge.waiterAddressId),
      worker = ctx.draft.table('agentBusAddresses').get(edge.dependencyAddressId);
    const waiterSession = waiter?.currentSessionId
      ? ctx.draft.table('agentSessions').get(waiter.currentSessionId)
      : undefined;
    const workerSession = worker?.currentSessionId
      ? ctx.draft.table('agentSessions').get(worker.currentSessionId)
      : undefined;
    if (request?.cancelRequestedAt || request?.status === 'canceled') {
      stageUpdate(ctx, 'agentWorkDependencies', edge.id, { status: 'canceled', updatedAt: timestamp });
      continue;
    }
    if (result && result !== 'unknown') {
      if (
        waiterSession &&
        stageCoordinationNotice(
          ctx,
          keyring,
          waiterSession,
          `SUPERVISOR/1: ${edge.messageId ? `Work ${edge.messageId}` : `Workflow task ${edge.workflowTaskId}`} has a durable result (${result}). Read the original result and continue dependent work. Notify your own dependents; keep original receipt IDs.`,
          { deliveryClass: 'coordination' },
        )
      )
        stageUpdate(ctx, 'agentWorkDependencies', edge.id, {
          status: 'notified',
          updatedAt: timestamp,
        });
      continue;
    }
    if (edge.status === 'attention') continue;
    const workerState = ctx.draft.table('agentWorkStates').get(edge.dependencyAddressId);
    const dog = workerState?.watchdogId
      ? ctx.draft.table('agentWatchdogs').get(workerState.watchdogId)
      : undefined;
    const progress = [edge.createdAt, workerState?.lastProgressAt, dog?.lastProgressAt]
      .filter((v): v is string => !!v)
      .sort()
      .at(-1)!;
    if (
      !edge.reminderAt &&
      now.getTime() - Date.parse(progress) >= SUPERVISOR.reminderSeconds * 1000 &&
      workerState?.state !== 'waiting_user' &&
      workerSession &&
      !ctx.draft
        .table('agentPrompts')
        .by('sessionId', workerSession.id)
        .some((p) => p.status === 'open')
    ) {
      if (
        stageCoordinationNotice(
          ctx,
          keyring,
          workerSession,
          `SUPERVISOR/1: agent:${edge.waiterAddressId} still needs the result for ${edge.messageId ?? edge.workflowTaskId}. Send the original durable result if ready, otherwise report your current wait with agent_work_state.`,
          { deliveryClass: 'coordination' },
        )
      )
        stageUpdate(ctx, 'agentWorkDependencies', edge.id, {
          reminderAt: timestamp,
          updatedAt: timestamp,
        });
    }
    if (
      edge.reminderAt &&
      now.getTime() - Date.parse(edge.reminderAt) >= 300000 &&
      progress <= edge.reminderAt
    ) {
      if (waiterSession)
        stageCoordinationNotice(
          ctx,
          keyring,
          waiterSession,
          `SUPERVISOR/1: The handoff from agent:${edge.dependencyAddressId} for ${edge.messageId ?? edge.workflowTaskId} remains unconfirmed after a reminder. Inspect the existing task; no replacement or model switch was started.`,
          { deliveryClass: 'coordination' },
        );
      stageUpdate(ctx, 'agentWorkDependencies', edge.id, { status: 'attention', updatedAt: timestamp });
      if (waiterSession)
        stageSupervisorAttention(
          ctx,
          keyring,
          {
            sessionId: waiterSession.id,
            target: `agent:${edge.waiterAddressId}`,
            taskKey: edge.id,
            reason: 'handoff_unanswered',
          },
          timestamp,
        );
    }
  }
}
