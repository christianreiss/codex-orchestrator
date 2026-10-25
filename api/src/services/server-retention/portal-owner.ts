import { ownerHistoryCandidates, readOwnerRetentionClock } from './ram.js';
import { serverRetentionPolicy, historyRetentionHours } from './policy.js';
import { legacyDrainFor } from '../../control-plane/legacy-drain.js';
import { eq, sql } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '../../db/client.js';
import { agentSessions, agentBusAddresses, agentNameLeases } from '../../db/schema.js';
import type { Env } from '../../env.js';
import type { OwnerMutationContext, OwnerRuntime } from '../../control-plane/state/runtime.js';
import { mutateOwnerState } from '../../control-plane/state/runtime.js';
import { stageDelete, stageUpdate } from '../../control-plane/state/rows.js';
import { ownerPresence } from '../../control-plane/presence.js';
import { receiverState, RECEIVER_FRESH_MS } from '../agent-receiver-state.js';
import { RetentionProjection } from './projection.js';
import {
  ownerRetention,
  retentionFamily,
  runOwnerHistoryRetention,
  recordRetentionSweep,
  stageRetentionSweep,
  finishRetentionRun,
} from './owner.js';
import { type RetentionClockSnapshot } from './deadlines.js';
import { pruneHosts } from '../host-lifecycle.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { OwnerWorkObligation, OwnerWorkResult } from '../../ops/owner-worker.js';

const rebooting = (context: OwnerMutationContext, id: string) =>
  context.draft
    .table('agentRebootHandoffs')
    .all()
    .some((row) => row.oldSessionId === id && row.status === 'armed');

export function turnClock(
  state: import('../../control-plane/state/store.js').OwnerStateSnapshot,
  now: number,
  delay: number,
): RetentionClockSnapshot {
  let past = false,
    next: number | null = null;
  for (const session of state.sessions.all())
    if (!session.endedAt && session.activeTurnId) {
      const due = session.portalAcceptedAt ? Date.parse(session.portalAcceptedAt) + delay : 0;
      if (due <= now) past = true;
      else next = next === null ? due : Math.min(next, due);
    }
  return { past, next };
}

async function purgePortalFamily(runtime: OwnerRuntime, env: Env, family: 'portal' | 'turns'): Promise<void> {
  let changed = 0,
    clock: RetentionClockSnapshot | undefined;
  await mutateOwnerState(runtime, {
    kind: `retention.${family}`,
    payload: {},
    prepare(context) {
      const now = new Date().toISOString();
      const projection = new RetentionProjection(context.draft);
      const hours = serverRetentionPolicy(context.snapshot).history_hours;
      const cutoff = new Date(Date.parse(now) - hours * 3600000).toISOString();
      const turnCutoff = new Date(
        Date.parse(now) - env.AGENT_PORTAL_RELAY_FRESH_SECONDS * 10000,
      ).toISOString();
      const turns = context.snapshot.sessions
        .all()
        .filter(
          (s) =>
            !s.endedAt &&
            s.activeTurnId &&
            !rebooting(context, s.id) &&
            (!s.portalAcceptedAt || s.portalAcceptedAt <= turnCutoff),
        )
        .slice(0, 100);
      const portal =
        family === 'portal'
          ? ownerHistoryCandidates(context.snapshot, cutoff, now, ownerPresence(runtime)).portal()
          : [];
      const readClock = () =>
        family === 'portal'
          ? readOwnerRetentionClock(context.draft.view(), 'portal', Date.parse(now), hours)
          : turnClock(context.draft.view(), Date.parse(now), env.AGENT_PORTAL_RELAY_FRESH_SECONDS * 10000);
      if (!(family === 'portal' ? portal : turns).length) {
        clock = readClock();
        stageRetentionSweep(context, family, 0);
        return { changed: 0 };
      }
      context.write(async (tx) => {
        if (family === 'turns') {
          for (const session of turns) {
            await tx
              .update(agentSessions)
              .set({ activeTurnId: null, updatedAt: now })
              .where(eq(agentSessions.id, session.id));
            projection.patchWhere('agentSessions', (row) => row.id === session.id, {
              activeTurnId: null,
              updatedAt: now,
            });
            changed++;
          }
        } else {
          const ids = portal.map((row) => row.id);
          if (ids.length) {
            const list = sql.join(
                ids.map((id) => sql`${id}`),
                sql`,`,
              ),
              removed = new Set(ids);
            const [portalTotals] = await tx.execute(
              sql`SELECT s.engine,m.status,COUNT(*) AS n FROM agent_messages m JOIN agent_sessions s ON s.id=m.session_id WHERE m.session_id IN (${list}) GROUP BY s.engine,m.status`,
            );
            const [responseTotals] = await tx.execute(
              sql`SELECT s.engine,COUNT(*) AS n FROM agent_events e JOIN agent_sessions s ON s.id=e.session_id WHERE e.session_id IN (${list}) AND e.event_type='assistant_message' AND e.source IN ('bridge','engine') GROUP BY s.engine`,
            );
            context.draft.adjustMessagingTotals({
              portal: (portalTotals as unknown as Array<{ engine: string; status: string; n: number }>).map(
                (row) => ({ engine: row.engine, status: row.status, count: -Number(row.n) }),
              ),
              responses: (responseTotals as unknown as Array<{ engine: string; n: number }>).map((row) => ({
                engine: row.engine,
                count: -Number(row.n),
              })),
            });
            await tx.execute(
              sql`UPDATE agent_chat_attachments SET status = 'retired' WHERE session_id IN (${list})`,
            );
            for (const table of [
              'companion_follows',
              'agent_native_controls',
              'agent_scope_members',
              'agent_resource_claims',
              'agent_messages',
              'agent_prompts',
              'agent_events',
              'agent_chat_notices',
            ])
              await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE session_id IN (${list})`);
            await tx.execute(
              sql`DELETE FROM host_daemon_portal_bindings WHERE portal_session_id IN (${list})`,
            );
            // An explicitly ended lifecycle may still own a stale address binding.
            for (const address of context.draft.table('agentBusAddresses').all()) {
              if (!address.currentSessionId || !removed.has(address.currentSessionId)) continue;
              const session = context.draft.table('agentSessions').get(address.currentSessionId);
              const upstream = session?.upstreamSessionId ?? address.lastUpstreamSessionId;
              const patch = {
                currentSessionId: null,
                bindingGeneration: address.bindingGeneration + 1,
                lastUpstreamSessionId: upstream,
                adapterProtocol: null,
                adapterCapabilities: null,
                readiness: upstream ? 'resumable' : 'offline',
                receiveHeartbeatAt: null,
                updatedAt: now,
              };
              await tx.update(agentBusAddresses).set(patch).where(eq(agentBusAddresses.id, address.id));
              context.draft.upsert('agentBusAddresses', { ...address, ...patch });
            }
            for (const name of context.draft.table('agentNameLeases').all()) {
              if (!removed.has(name.sessionId) || name.endedAt) continue;
              const patch = {
                endedAt: now,
                cooldownUntil: new Date(Date.parse(now) + 86_400_000).toISOString(),
              };
              await tx.update(agentNameLeases).set(patch).where(eq(agentNameLeases.id, name.id));
              context.draft.upsert('agentNameLeases', { ...name, ...patch });
            }
            await tx.execute(sql`DELETE FROM agent_sessions WHERE id IN (${list})`);
            projection.patchWhere('agentChatAttachments', (row) => removed.has(row.sessionId), {
              status: 'retired',
            });
            projection.removeWhere('companionFollows', (row) => removed.has(row.sessionId));
            projection.removeWhere('hostDaemonPortalBindings', (row) => removed.has(row.portalSessionId));
            projection.removeWhere('agentNativeControls', (row) => removed.has(row.sessionId));
            projection.removeWhere('agentScopeMembers', (row) => removed.has(row.sessionId));
            projection.removeWhere('agentResourceClaims', (row) => removed.has(row.sessionId));
            projection.removeWhere('agentMessages', (row) => removed.has(row.sessionId));
            projection.removeWhere('agentPrompts', (row) => removed.has(row.sessionId));
            projection.removeWhere('agentChatNotices', (row) => removed.has(row.sessionId));
            projection.removeWhere('agentSessions', (row) => removed.has(row.id));
            changed = ids.length;
          }
        }
        clock = readClock();
        await recordRetentionSweep(context, tx, family, changed);
      });
      return () => ({ changed });
    },
  });
  if (!clock) throw new Error('Portal retention command did not publish its clock');
  ownerRetention(runtime).publishSweep(family, clock, changed);
  if (changed) wsPublisher.publish('agent_portal.sessions.changed', { retention: family, changed });
}

async function expireReceiver(runtime: OwnerRuntime, id: string): Promise<OwnerWorkResult> {
  const session = runtime.state.snapshot().sessions.get(id);
  if (!session || session.endedAt) return { observed: true };
  const receiver = receiverState(session.receiver);
  const presence = ownerPresence(runtime);
  if (
    !receiver ||
    (!receiver.failure &&
      !receiver.portal_closed &&
      (presence.hasReceiver(id, session.bindingGeneration, receiver.generation) ||
        legacyDrainFor(runtime)?.receiver(id, session.bindingGeneration, receiver.generation) ||
        Date.parse(receiver.heartbeat_at) > Date.now() - RECEIVER_FRESH_MS))
  )
    return { observed: true };
  await mutateOwnerState(runtime, {
    kind: 'retention.receiver-prompts',
    payload: { id },
    prepare(context) {
      const current = context.snapshot.sessions.get(id),
        latest = current ? receiverState(current.receiver) : null;
      if (
        !current ||
        current.endedAt ||
        !latest ||
        latest.generation !== receiver.generation ||
        (!latest.failure &&
          !latest.portal_closed &&
          (presence.hasReceiver(id, current.bindingGeneration, latest.generation) ||
            legacyDrainFor(runtime)?.receiver(id, current.bindingGeneration, latest.generation) ||
            Date.parse(latest.heartbeat_at) > Date.now() - RECEIVER_FRESH_MS))
      )
        return null;
      if (
        rebooting(context, id) ||
        context.snapshot
          .table('hostDaemonPortalBindings')
          .all()
          .some((row) => row.portalSessionId === id)
      )
        return null;
      for (const prompt of context.draft.table('agentPrompts').all())
        if (prompt.sessionId === id && prompt.status === 'open') {
          stageUpdate(context, 'agentPrompts', prompt.id, {
            status: 'expired',
            expiresAt: new Date().toISOString(),
            version: prompt.version + 1,
          });
          if (session.status === 'waiting')
            stageUpdate(context, 'agentSessions', id, {
              status: 'active',
              updatedAt: new Date().toISOString(),
            });
        }
      return null;
    },
  });
  wsPublisher.publish('agent_portal.sessions.changed', { session_id: id });
  return { observed: true };
}

export async function runOwnerPortalRetention(
  db: Database,
  runtime: OwnerRuntime,
  env: Env,
  work: OwnerWorkObligation,
): Promise<OwnerWorkResult> {
  if (work.key.startsWith('host:')) {
    await pruneHosts(db);
    return { observed: true };
  }
  if (work.key.startsWith('receiver:')) return expireReceiver(runtime, work.key.slice('receiver:'.length));
  if (work.key.startsWith('session:')) {
    await purgePortalFamily(runtime, env, 'portal');
    return { observed: true };
  }
  if (work.key.startsWith('attachment:')) {
    await purgeAttachments(runtime, env);
    return { observed: true };
  }
  const family = retentionFamily(work.key);
  if (family === 'portal' || family === 'turns') await purgePortalFamily(runtime, env, family);
  else if (family === 'attachments') await purgeAttachments(runtime, env);
  else await runOwnerHistoryRetention(db, runtime, family, env);
  if (JSON.parse(runtime.state.snapshot().setting('server_retention_run_v1') ?? '{}').status === 'running')
    wsPublisher.publish('settings.changed', { key: 'server_retention_run_v1' });
  await finishRetentionRun(runtime);
}

export async function purgeAttachments(runtime: OwnerRuntime, env: Env): Promise<void> {
  const snapshot = runtime.state.snapshot();
  const eligible = (
    view: import('../../control-plane/state/store.js').OwnerStateSnapshot,
    file: import('../../control-plane/state/catalog.js').StateRow<'agentChatAttachments'>,
  ) => {
    if (file.status === 'retired') return true;
    const native = view.sessions.get(file.sessionId);
    if (native && !native.endedAt) return false;
    const daemon = view.table('hostDaemonSessions').get(file.sessionId);
    if (daemon && !['completed', 'failed', 'canceled'].includes(daemon.status)) return false;
    const scopeExists =
      view.sessions.has(file.sessionId) ||
      view.table('hostDaemonSessions').has(file.sessionId) ||
      view.table('agentBusGroups').has(file.sessionId) ||
      view.table('agentBusConferences').has(file.sessionId) ||
      view.table('agentScopes').has(file.sessionId) ||
      view
        .table('hostDaemonPortalBindings')
        .all()
        .some((row) => row.daemonSessionId === file.sessionId && view.sessions.has(row.portalSessionId));
    if (!scopeExists) return true;
    return (
      ['uploading', 'ready'].includes(file.status) &&
      Date.parse(file.updatedAt) < Date.now() - historyRetentionHours(view) * 3600000 &&
      !view
        .table('workflowRuns')
        .all()
        .some((row) => row.communicationGroupId === file.sessionId)
    );
  };
  const candidates = snapshot
    .table('agentChatAttachments')
    .all()
    .filter((file) => eligible(snapshot, file))
    .slice(0, 100);
  let retired = candidates.filter((row) => row.status === 'retired');
  if (candidates.some((row) => row.status !== 'retired'))
    await mutateOwnerState(runtime, {
      kind: 'retention.attachments.retire',
      payload: { ids: candidates.map((row) => row.id) },
      prepare(context) {
        retired = [];
        for (const candidate of candidates) {
          const current = context.draft.table('agentChatAttachments').get(candidate.id);
          if (!current || !eligible(context.draft.view(), current)) continue;
          if (current.status !== 'retired')
            stageUpdate(context, 'agentChatAttachments', current.id, { status: 'retired' });
          retired.push(current);
        }
        return null;
      },
    });
  // Durable retirement precedes unlink. A crash or filesystem failure leaves a
  // visible retry obligation; owner replacement can safely repeat rm(force).
  for (const file of retired) {
    runtime.assertOwner();
    if (!/^[0-9a-f-]{36}$/i.test(file.id)) throw new Error('Invalid retained attachment ID');
    await rm(join(env.DATA_ROOT ?? 'storage', 'agent-chat', file.id), { recursive: true, force: true });
  }
  let clock: RetentionClockSnapshot | undefined;
  await mutateOwnerState(runtime, {
    kind: 'retention.attachments.delete',
    payload: { ids: retired.map((row) => row.id) },
    prepare(context) {
      for (const file of retired) {
        const current = context.draft.table('agentChatAttachments').get(file.id);
        if (current && current.status !== 'retired')
          throw new Error('Retired attachment was revived during unlink');
        stageDelete(context, 'agentChatAttachments', file.id);
      }
      clock = readOwnerRetentionClock(
        context.draft.view(),
        'attachments',
        Date.now(),
        serverRetentionPolicy(context.snapshot).history_hours,
      );
      if (retired.length)
        context.write(async (tx) => recordRetentionSweep(context, tx, 'attachments', retired.length));
      else stageRetentionSweep(context, 'attachments', 0);
      return null;
    },
  });
  if (!clock) throw new Error('Attachment retention did not commit its clock');
  ownerRetention(runtime).publishSweep('attachments', clock, retired.length);
  if (retired.length) wsPublisher.publish('agent_chat.attachment.changed', { purged: retired.length });
}
