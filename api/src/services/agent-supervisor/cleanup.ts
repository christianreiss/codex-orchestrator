import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentChatNotices, agentEvents } from '../../db/schema.js';
import type { Keyring } from '../../security/keyring.js';
import { decrypt, encrypt } from '../../security/secret-box.js';
import { ABANDONED_SESSION_EVENT_ID } from '../agent-session-finished.js';
import { requireOwnerRuntime, mutateOwnerState } from '../../control-plane/state/runtime.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { stageStopWatchdog } from '../../control-plane/state/session-lifecycle.js';
import { stagePortalEvent } from '../../control-plane/state/portal-events.js';
import { observedNativeTask, supervisorHasOutstandingWork } from './policy.js';

/** Repair only incidents created by the old abandonment-to-crash transition. */
export async function cleanupAbandonedObservation(db: Database, keyring: Keyring, at: string) {
  const owner = requireOwnerRuntime(db), snapshot = owner.state.snapshot();
  const candidates = snapshot.table('agentWorkStates').all().filter(work => {
    const session = snapshot.sessions.get(work.sessionId),
      dog = work.watchdogId ? snapshot.table('agentWatchdogs').get(work.watchdogId) : undefined,
      currentSessionId = snapshot.addresses.get(work.addressId)?.currentSessionId;
    return work.state === 'working' && !work.paused &&
      observedNativeTask(work) && session?.status === 'failed' && !!session.endedAt &&
      work.incidentAt === session.endedAt && dog?.createdBy === 'supervisor' &&
      (!currentSessionId || currentSessionId === work.sessionId || !!snapshot.sessions.get(currentSessionId)?.endedAt) &&
      !supervisorHasOutstandingWork(snapshot, work.addressId);
  });
  if (!candidates.length) return;
  const sessionIds = candidates.map(w => w.sessionId);
  const markers = await db.select().from(agentEvents).where(and(
    inArray(agentEvents.sessionId, sessionIds), eq(agentEvents.clientEventId, ABANDONED_SESSION_EVENT_ID),
  ));
  // Cold receipts prove that cleanup, rather than a native failure, ended this session.
  const abandoned = new Map(markers.map(m => [m.sessionId, m.createdAt]));
  if (!abandoned.size) return;
  const notices = await db.select().from(agentChatNotices).where(inArray(agentChatNotices.sessionId, sessionIds));
  await mutateOwnerState(owner, {
    kind: 'supervisor.cleanup-abandoned', payload: { sessions: [...abandoned.keys()] },
    prepare(ctx) {
      for (const before of candidates) {
        const work = ctx.draft.table('agentWorkStates').get(before.addressId),
          session = work ? ctx.draft.table('agentSessions').get(work.sessionId) : undefined,
          dog = work?.watchdogId ? ctx.draft.table('agentWatchdogs').get(work.watchdogId) : undefined,
          target = ctx.draft.table('agentBusAddresses').get(before.addressId);
        if (!work || work.version !== before.version || work.state !== 'working' || work.paused || !session?.endedAt ||
            abandoned.get(session.id) !== session.endedAt || work.incidentAt !== session.endedAt ||
            target?.lastUpstreamSessionId !== work.nativeSessionId || dog?.createdBy !== 'supervisor' ||
            (target.currentSessionId && target.currentSessionId !== work.sessionId && !ctx.draft.table('agentSessions').get(target.currentSessionId)?.endedAt) ||
            supervisorHasOutstandingWork(ctx.draft.view(), work.addressId)) continue;
        stageStopWatchdog(ctx, dog, 'disabled', 'session_abandoned', at);
        stageUpdate(ctx, 'agentWorkStates', work.addressId, {
          state: 'canceled', reason: 'session_abandoned', escalation: null,
          version: work.version + 1, updatedAt: at,
        });
        for (const notice of notices) {
          const current = ctx.draft.table('agentChatNotices').get(notice.id);
          if (notice.sessionId !== work.sessionId || !current || current.resolvedAt) continue;
          let payload: { summary?: string; content?: string };
          try { payload = JSON.parse(decrypt(notice.payloadEnc, keyring)); } catch { continue; }
          if (payload.summary !== 'Task supervision needs attention: recovery deadline' ||
              !payload.content?.startsWith(`agent:${work.addressId}, task ${work.taskKey}: recovery_deadline.`)) continue;
          stageUpdate(ctx, 'agentChatNotices', notice.id, { resolvedAt: at });
          stagePortalEvent(ctx, {
            sessionId: work.sessionId, clientEventId: `supervisor:abandoned:${notice.id}`,
            eventType: 'attention_resolved', source: 'server',
            payloadEnc: encrypt(JSON.stringify({ notice_id: notice.id,
              summary: 'Retired an abandoned-session recovery warning; no outstanding execution receipt.' }), keyring),
            createdAt: at,
          });
        }
      }
      return null;
    },
  });
}
