import { z } from 'zod';
import type { Database } from '../db/client.js';
import { agentWorkStates, versions } from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { ConflictError, ForbiddenError } from '../http/errors.js';
import {
  requireOwnerRuntime,
  mutateOwnerState,
  type OwnerMutationContext,
} from '../control-plane/state/runtime.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { stageStopWatchdog } from '../control-plane/state/session-lifecycle.js';
import { stageCoordinationNotice } from '../control-plane/state/coordination-notices.js';
import { adminAudit } from '../control-plane/state/admin.js';
import { ownerPresence } from '../control-plane/presence.js';
import { activityView } from './agent-activity.js';
import { WatchdogsService, WATCHDOG_LIVE } from './watchdogs.js';
import { stageSupervisorDependencies } from './agent-supervisor/dependencies.js';
import { stageSupervisorAttention } from './agent-supervisor/notices.js';
import { stageSupervisorArm } from './agent-supervisor/arm.js';
import { isEngine } from '../util/engine.js';
import { activeHostEngines } from './host-engine-policy.js';
import { readFleetEngineState } from './engine-switch.js';
import { messagingHostEligible } from './agent-messaging/eligibility.js';
import { wsPublisher } from '../ws/publisher.js';
import {
  SUPERVISOR,
  WORK_LIVE,
  recoveryBudget,
  supervisorEnabled,
  supervisorCanMonitor,
  waitCycle,
  type Work,
} from './agent-supervisor/policy.js';

const address = z
  .string()
  .regex(/^agent:[0-9a-f-]{36}$/i)
  .transform((v) => v.slice(6).toLowerCase());
export const workStateInput = z
  .object({
    task_key: z.string().trim().min(1).max(255),
    state: z.enum(['working', 'waiting_agent', 'waiting_user', 'completed', 'canceled']),
    reason: z.string().trim().max(1000).nullable().optional(),
    waiting_for: address.nullable().optional(),
    message_id: z.string().uuid().nullable().optional(),
    coordinator: address.nullable().optional(),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (v) => v.state !== 'waiting_agent' || !!v.waiting_for || !!v.message_id,
    'A wait needs an agent or work message',
  );

function put(ctx: OwnerMutationContext, work: Work) {
  const old = ctx.draft.table('agentWorkStates').get(work.addressId);
  if (old) stageUpdate(ctx, 'agentWorkStates', work.addressId, work);
  else {
    ctx.draft.upsert('agentWorkStates', work);
    ctx.write(async (tx) => tx.insert(agentWorkStates).values(work));
  }
}
export class AgentSupervisor {
  constructor(
    private readonly db: Database,
    private readonly keyring: Keyring,
  ) {}
  list(target?: string) {
    const owner = requireOwnerRuntime(this.db);
    owner.assertOwner();
    const s = owner.state.snapshot();
    const states = s
      .table('agentWorkStates')
      .all()
      .filter((w) => !target || `agent:${w.addressId}` === target);
    return {
      enabled: s.setting('agent_supervisor_enabled') === '1',
      effective: supervisorEnabled(s),
      limits: SUPERVISOR,
      dependencies: s
        .table('agentWorkDependencies')
        .all()
        .filter((d) => d.status === 'waiting' && (!target || `agent:${d.waiterAddressId}` === target)),
      states: states.map((w) => {
        const dog = w.watchdogId ? s.table('agentWatchdogs').get(w.watchdogId) : undefined;
        const runs = dog ? s.table('agentScheduleRuns').by('scheduleId', dog.scheduleId) : [];
        const run = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return {
          ...w,
          target: `agent:${w.addressId}`,
          attempts: run ? run.recoveryCount + 1 : 0,
          nextAttemptAt:
            run?.nextAttemptAt ??
            (dog ? s.table('agentSchedules').get(dog.scheduleId)?.nextDueAt : null) ??
            null,
        };
      }),
    };
  }
  async setEnabled(enabled: boolean, actor: number) {
    const owner = requireOwnerRuntime(this.db);
    await mutateOwnerState(owner, {
      kind: 'supervisor.setting',
      payload: { enabled, actor },
      prepare: (ctx) => {
        const row = {
          name: 'agent_supervisor_enabled',
          version: enabled ? '1' : '0',
          updatedAt: new Date().toISOString(),
        };
        ctx.draft.upsert('versions', row);
        ctx.write(async (tx) =>
          tx
            .insert(versions)
            .values(row)
            .onDuplicateKeyUpdate({ set: { version: row.version, updatedAt: row.updatedAt } }),
        );
        if (enabled)
          for (const w of ctx.draft.table('agentWorkStates').all()) {
            const dog = w.watchdogId ? ctx.draft.table('agentWatchdogs').get(w.watchdogId) : undefined;
            if (!w.paused && !w.escalation && dog?.lastError === 'supervisor_disabled')
              stageUpdate(ctx, 'agentWorkStates', w.addressId, {
                watchdogId: null,
                state: 'working',
                version: w.version + 1,
              });
          }
        if (!enabled)
          for (const w of ctx.draft.table('agentWorkStates').all()) {
            const dog = w.watchdogId ? ctx.draft.table('agentWatchdogs').get(w.watchdogId) : undefined;
            if (dog?.createdBy === 'supervisor' && WATCHDOG_LIVE.includes(dog.status))
              stageStopWatchdog(ctx, dog, 'disabled', 'supervisor_disabled', new Date().toISOString());
          }
        adminAudit(ctx, 'supervisor.setting', { enabled, actor }, new Date().toISOString());
        return null;
      },
    });
    wsPublisher.publish('supervisor.changed', {});
    return this.list();
  }
  async pause(target: string, version: number) {
    const id = address.parse(target),
      owner = requireOwnerRuntime(this.db);
    await mutateOwnerState(owner, {
      kind: 'supervisor.pause',
      payload: { id, version },
      prepare: (ctx) => {
        const w = ctx.draft.table('agentWorkStates').get(id);
        if (!w || w.version !== version)
          throw new ConflictError('Supervisor state changed; refresh before pausing');
        const dog = w.watchdogId ? ctx.draft.table('agentWatchdogs').get(w.watchdogId) : undefined;
        if (dog && WATCHDOG_LIVE.includes(dog.status))
          stageStopWatchdog(ctx, dog, 'disabled', 'supervisor_paused', new Date().toISOString());
        stageUpdate(ctx, 'agentWorkStates', id, { paused: 1, version: w.version + 1 });
        adminAudit(ctx, 'supervisor.paused', { target }, new Date().toISOString());
        return null;
      },
    });
    wsPublisher.publish('supervisor.changed', {});
    return this.list(target);
  }
  async report(sessionId: string, token: string, raw: unknown) {
    const input = workStateInput.parse(raw),
      dogs = new WatchdogsService(this.db, this.keyring);
    const session = await dogs.bridge(sessionId, token),
      owner = requireOwnerRuntime(this.db);
    await mutateOwnerState(owner, {
      kind: 'supervisor.work-state',
      payload: { sessionId, ...input },
      prepare: async (ctx) => {
        // Recheck the authenticated binding inside the serialized owner mutation.
        const current = ctx.draft.table('agentSessions').get(sessionId),
          target = current?.agentBusAddressId
            ? ctx.draft.table('agentBusAddresses').get(current.agentBusAddressId)
            : undefined;
        if (
          !current ||
          current.endedAt ||
          !target ||
          target.currentSessionId !== sessionId ||
          target.bindingGeneration !== session.bindingGeneration
        )
          throw new ForbiddenError('Session binding changed');
        const old = ctx.draft.table('agentWorkStates').get(target.id);
        const message = input.message_id
          ? ctx.draft.table('agentBusMessages').get(input.message_id)
          : undefined;
        if (
          input.message_id &&
          (!message || ![message.senderAddressId, message.targetAddressId].includes(target.id))
        )
          throw new ForbiddenError('Work message is not owned by this agent');
        const waiting =
          input.waiting_for ??
          (message
            ? message.senderAddressId === target.id
              ? message.targetAddressId
              : message.senderAddressId
            : null);
        if (waiting === target.id) throw new ConflictError('An agent cannot wait for itself');
        for (const peer of [waiting, input.coordinator])
          if (peer && !ctx.draft.table('agentBusAddresses').get(peer))
            throw new ConflictError('Unknown agent');
        const now = new Date().toISOString(),
          sameTask =
            !!old && old.nativeSessionId === current.upstreamSessionId && old.taskKey === input.task_key;
        const patch = {
          state: input.state,
          taskKey: input.task_key,
          reason: input.reason ?? null,
          waitingForAddressId: input.state === 'waiting_agent' ? waiting : null,
          waitingForMessageId: input.state === 'waiting_agent' ? (input.message_id ?? null) : null,
          coordinatorAddressId: input.coordinator ?? null,
        };
        if (
          sameTask &&
          old.sessionId === sessionId &&
          Object.entries(patch).every(([k, v]) => old[k as keyof Work] === v)
        )
          return null;
        if (input.version !== undefined && old?.version !== input.version)
          throw new ConflictError('Work state changed');
        if (!sameTask && old?.watchdogId) {
          const previous = ctx.draft.table('agentWatchdogs').get(old.watchdogId);
          if (previous && WATCHDOG_LIVE.includes(previous.status))
            stageStopWatchdog(ctx, previous, 'completed', 'task_changed', now);
        }
        put(ctx, {
          addressId: target.id,
          sessionId,
          bindingGeneration: current.bindingGeneration,
          nativeSessionId: current.upstreamSessionId!,
          turnId: current.activeTurnId,
          model: sameTask
            ? old.model
            : typeof (current.adapterCapabilities as Record<string, unknown> | null)?.supervisor_model ===
                'string'
              ? String((current.adapterCapabilities as Record<string, unknown>).supervisor_model)
              : null,
          ...patch,
          lastProgressAt: now,
          reminderAt: null,
          incidentAt: sameTask ? old.incidentAt : null,
          deadlineAt: sameTask ? old.deadlineAt : null,
          paused: sameTask ? old.paused : 0,
          escalation: sameTask ? old.escalation : null,
          watchdogId: sameTask ? old.watchdogId : null,
          version: (old?.version ?? 0) + 1,
          updatedAt: now,
        });
        if (!WORK_LIVE.includes(input.state) && old?.watchdogId) {
          const dog = ctx.draft.table('agentWatchdogs').get(old.watchdogId);
          if (dog && WATCHDOG_LIVE.includes(dog.status))
            stageStopWatchdog(ctx, dog, 'completed', input.state, now);
        }
        return null;
      },
    });
    wsPublisher.publish('supervisor.changed', {});
    return this.list(`agent:${session.agentBusAddressId}`);
  }
  async tick(now = new Date()) {
    const owner = requireOwnerRuntime(this.db);
    owner.assertOwner();
    if (!supervisorEnabled(owner.state.snapshot())) return;
    const before = owner.state.snapshot().table('agentWorkStates');
    const timestamp = now.toISOString(),
      fleet = await readFleetEngineState(this.db);
    // Discover actual native work, never infer work from presence or repository membership.
    for (const session of owner.state.snapshot().sessions.all()) {
      const s = owner.state.snapshot(),
        target = session.agentBusAddressId ? s.addresses.get(session.agentBusAddressId) : undefined;
      const host = target ? s.hosts.get(target.hostId) : undefined;
      if (
        !target ||
        !host ||
        host.internalRole ||
        session.endedAt ||
        session.closeRequestedAt ||
        target.currentSessionId !== session.id ||
        !target.enabled ||
        target.archivedAt ||
        !isEngine(target.engine) ||
        !messagingHostEligible(host) ||
        !activeHostEngines(host.engines, fleet).includes(target.engine) ||
        !session.upstreamSessionId
      )
        continue;
      const connected = ownerPresence(owner).hasSession(session.id, session.bindingGeneration);
      const activity = activityView(session, now.getTime(), false, connected);
      const requests = s.messages
        .by('targetAddressId', target.id)
        .filter((m) => m.workKind && m.status === 'accepted' && !m.taskResultStatus && !m.cancelRequestedAt);
      const old = s.table('agentWorkStates').get(target.id);
      if (
        (!old ||
          old.nativeSessionId !== session.upstreamSessionId ||
          (!WORK_LIVE.includes(old.state) &&
            !!session.activeTurnId &&
            old.turnId !== session.activeTurnId)) &&
        (session.activeTurnId || activity.state === 'working' || requests.length)
      ) {
        await mutateOwnerState(owner, {
          kind: 'supervisor.discover',
          payload: { id: session.id },
          prepare: (ctx) => {
            const current = ctx.draft.table('agentSessions').get(session.id);
            if (
              !current ||
              current.endedAt ||
              ctx.draft.table('agentBusAddresses').get(target.id)?.currentSessionId !== session.id
            )
              return null;
            put(ctx, {
              addressId: target.id,
              sessionId: session.id,
              bindingGeneration: session.bindingGeneration,
              nativeSessionId: session.upstreamSessionId!,
              turnId: session.activeTurnId,
              model:
                typeof (session.adapterCapabilities as Record<string, unknown> | null)?.supervisor_model ===
                'string'
                  ? String((session.adapterCapabilities as Record<string, unknown>).supervisor_model)
                  : null,
              taskKey:
                requests[0]?.id ??
                (session.activeTurnId
                  ? `turn:${session.activeTurnId}`
                  : `native:${session.upstreamSessionId}`),
              state: 'working',
              reason: null,
              waitingForAddressId: null,
              waitingForMessageId: null,
              coordinatorAddressId: requests[0]?.senderAddressId ?? null,
              lastProgressAt: timestamp,
              reminderAt: null,
              incidentAt: null,
              deadlineAt: null,
              paused: 0,
              escalation: null,
              watchdogId: null,
              version: (old?.version ?? 0) + 1,
              updatedAt: timestamp,
            });
            return null;
          },
        });
      }
      if (
        old &&
        old.nativeSessionId === session.upstreamSessionId &&
        old.sessionId !== session.id &&
        s.sessions.get(old.sessionId)?.endedAt
      ) {
        await mutateOwnerState(owner, {
          kind: 'supervisor.rebind',
          payload: { id: target.id },
          prepare: (ctx) => {
            const w = ctx.draft.table('agentWorkStates').get(target.id);
            if (w && w.nativeSessionId === session.upstreamSessionId)
              stageUpdate(ctx, 'agentWorkStates', target.id, {
                sessionId: session.id,
                bindingGeneration: session.bindingGeneration,
                version: w.version + 1,
              });
            return null;
          },
        });
      }
      const work = owner.state.snapshot().table('agentWorkStates').get(target.id);
      if (!work || !WORK_LIVE.includes(work.state) || work.paused || work.escalation) continue;
      if (connected && WORK_LIVE.includes(work.state))
        await mutateOwnerState(owner, {
          kind: 'supervisor.arm',
          payload: { sessionId: session.id },
          prepare: (ctx) => {
            const current = ctx.draft.table('agentSessions').get(session.id);
            if (current) stageSupervisorArm(ctx, current, this.keyring, timestamp);
            return null;
          },
        });
    }
    await mutateOwnerState(owner, {
      kind: 'supervisor.reconcile',
      payload: { at: timestamp },
      prepare: (ctx) => {
        if (!supervisorEnabled(ctx.draft.view())) return null;
        stageSupervisorDependencies(ctx, this.keyring, now);
        for (const work of ctx.draft.table('agentWorkStates').all()) {
          if (!WORK_LIVE.includes(work.state) || work.paused || work.escalation) continue;
          const target = ctx.draft.table('agentBusAddresses').get(work.addressId),
            session = target?.currentSessionId
              ? ctx.draft.table('agentSessions').get(target.currentSessionId)
              : undefined;
          const dog = work.watchdogId ? ctx.draft.table('agentWatchdogs').get(work.watchdogId) : undefined;
          const stop = (reason: string) => {
            if (dog && WATCHDOG_LIVE.includes(dog.status))
              stageStopWatchdog(ctx, dog, 'blocked', reason, timestamp);
            stageUpdate(ctx, 'agentWorkStates', work.addressId, {
              escalation: reason,
              version: work.version + 1,
              updatedAt: timestamp,
            });
            stageSupervisorAttention(
              ctx,
              this.keyring,
              { sessionId: work.sessionId, target: `agent:${work.addressId}`, taskKey: work.taskKey, reason },
              timestamp,
            );
            if (
              reason === 'dependency_cycle' &&
              work.coordinatorAddressId &&
              work.coordinatorAddressId !== work.addressId
            ) {
              const c = ctx.draft.table('agentBusAddresses').get(work.coordinatorAddressId),
                coordinator = c?.currentSessionId
                  ? ctx.draft.table('agentSessions').get(c.currentSessionId)
                  : undefined;
              if (coordinator)
                stageCoordinationNotice(
                  ctx,
                  this.keyring,
                  coordinator,
                  `SUPERVISOR/1: A dependency cycle includes agent:${work.addressId}. Resolve the wait order within the existing task; recovery is paused.`,
                  { deliveryClass: 'coordination' },
                );
            }
          };
          if (!target || target.lastUpstreamSessionId !== work.nativeSessionId || target.archivedAt) {
            stop('native_session_changed');
            continue;
          }
          if (session?.closeRequestedAt || (dog && ['disabled', 'completed'].includes(dog.status))) {
            stageUpdate(ctx, 'agentWorkStates', work.addressId, {
              state: 'completed',
              version: work.version + 1,
              updatedAt: timestamp,
            });
            continue;
          }
          const runs = dog ? ctx.draft.table('agentScheduleRuns').by('scheduleId', dog.scheduleId) : [];
          const run = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          const failure =
            dog &&
            (['recovering', 'capacity_wait'].includes(dog.status) ||
              ['capacity', 'hang', 'crash'].includes(dog.lastError ?? '') ||
              (run && ['recovering', 'capacity_wait'].includes(run.status)));
          if (failure && !work.incidentAt) {
            const deadline = new Date(now.getTime() + SUPERVISOR.durationSeconds * 1000).toISOString();
            stageUpdate(ctx, 'agentWorkStates', work.addressId, {
              incidentAt: timestamp,
              deadlineAt: deadline,
              version: work.version + 1,
            });
            if (dog) stageUpdate(ctx, 'agentWatchdogs', dog.id, { deadlineAt: deadline });
          }
          const budget = recoveryBudget(
            work,
            run ? run.recoveryCount + (run.status === 'completed' ? 0 : 1) : 0,
            now.getTime(),
          );
          // An admitted fifth attempt may finish; prevent its next retry instead of canceling it.
          if (
            budget &&
            (budget !== 'recovery_limit' || !run || !['queued', 'leased', 'accepted'].includes(run.status))
          ) {
            stop(budget);
            continue;
          }
          if (dog && ['blocked', 'expired'].includes(dog.status)) {
            stop(dog.lastError ?? dog.status);
            continue;
          }
          if (work.state === 'waiting_user') continue;
          if (work.state === 'working' && (!session || !supervisorCanMonitor(ctx.draft.view(), session)))
            continue;
          if (work.state === 'waiting_agent') {
            const dependency = work.waitingForMessageId
              ? ctx.draft.table('agentBusMessages').get(work.waitingForMessageId)
              : undefined;
            const done = dependency?.taskResultStatus && dependency.taskResultStatus !== 'unknown';
            if (
              done &&
              !work.reminderAt &&
              ctx.draft.table('agentWorkDependencies').get(work.waitingForMessageId!)?.status === 'notified'
            ) {
              stageUpdate(ctx, 'agentWorkStates', work.addressId, {
                reminderAt: timestamp,
                version: work.version + 1,
              });
              continue;
            }
            if (done && !work.reminderAt && session && !session.endedAt) {
              stageCoordinationNotice(
                ctx,
                this.keyring,
                session,
                `SUPERVISOR/1: Work ${work.waitingForMessageId} has a durable result (${dependency.taskResultStatus}). Read the original result, notify your dependents and update agent_work_state. Do not repeat completed work.`,
                { deliveryClass: 'coordination' },
              );
              stageUpdate(ctx, 'agentWorkStates', work.addressId, {
                reminderAt: timestamp,
                version: work.version + 1,
              });
              continue;
            }
            if (work.reminderAt && now.getTime() - Date.parse(work.reminderAt) >= 300000) {
              const peer = work.waitingForAddressId
                ? ctx.draft.table('agentWorkStates').get(work.waitingForAddressId)
                : undefined;
              const peerDog = peer?.watchdogId
                ? ctx.draft.table('agentWatchdogs').get(peer.watchdogId)
                : undefined;
              if (peer?.state === 'waiting_user') continue;
              const peerProgress = [peer?.lastProgressAt, peerDog?.lastProgressAt]
                .filter((v): v is string => !!v)
                .sort()
                .at(-1);
              if (peerProgress && peerProgress > work.reminderAt)
                stageUpdate(ctx, 'agentWorkStates', work.addressId, {
                  reminderAt: null,
                  lastProgressAt: peerProgress,
                });
              else {
                stop('handoff_unanswered');
                continue;
              }
            }
            if (waitCycle(ctx.draft.view(), work.addressId)) {
              stop('dependency_cycle');
              continue;
            }
          }
          const progress =
            dog && dog.lastProgressAt > work.lastProgressAt ? dog.lastProgressAt : work.lastProgressAt;
          if (progress !== work.lastProgressAt)
            stageUpdate(ctx, 'agentWorkStates', work.addressId, {
              lastProgressAt: progress,
              ...(work.reminderAt && progress > work.reminderAt ? { reminderAt: null } : {}),
            });
          if (work.reminderAt || now.getTime() - Date.parse(progress) < SUPERVISOR.reminderSeconds * 1000)
            continue;
          const recipientId = work.state === 'waiting_agent' ? work.waitingForAddressId : work.addressId;
          const recipient = recipientId ? ctx.draft.table('agentBusAddresses').get(recipientId) : undefined;
          const recipientSession = recipient?.currentSessionId
            ? ctx.draft.table('agentSessions').get(recipient.currentSessionId)
            : undefined;
          if (
            !recipientSession ||
            recipientSession.endedAt ||
            !ownerPresence(owner).hasSession(recipientSession.id, recipientSession.bindingGeneration)
          ) {
            stop('receiver_unavailable');
            continue;
          }
          if (
            ctx.draft
              .table('agentPrompts')
              .by('sessionId', recipientSession.id)
              .some((p) => p.status === 'open')
          )
            continue;
          stageCoordinationNotice(
            ctx,
            this.keyring,
            recipientSession,
            `SUPERVISOR/1: ${work.state === 'waiting_agent' ? `Agent ${work.addressId} is waiting for your handoff` : 'No task progress has been observed for ten minutes'}. Report current status with agent_work_state; deliver any outstanding result using its original work ID. Continue only existing authorized work.`,
            { deliveryClass: 'coordination' },
          );
          stageUpdate(ctx, 'agentWorkStates', work.addressId, {
            reminderAt: timestamp,
            version: work.version + 1,
          });
          adminAudit(
            ctx,
            'supervisor.reminder',
            { target: `agent:${recipientId}`, task_key: work.taskKey },
            timestamp,
          );
        }
        return null;
      },
    });
    if (owner.state.snapshot().table('agentWorkStates') !== before)
      wsPublisher.publish('supervisor.changed', {});
  }
}
