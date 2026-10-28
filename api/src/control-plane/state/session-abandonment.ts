import type { Env } from '../../env.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { ABANDONED_SESSION_EVENT_ID } from '../../services/agent-session-finished.js';
import { historyRetentionHours } from '../../services/server-retention/policy.js';
import { lastSeenStamps, sessionAbandonDueAt, sessionLastSeen } from './owner-liveness.js';
import { stagePortalEvent } from './portal-events.js';
import { stagePortalSessionFinish } from './portal-lifecycle.js';
import { stageUpdate } from './rows.js';
import type { OwnerMutationContext, OwnerRuntime } from './runtime.js';
import type { OwnerStateSnapshot } from './store.js';

/**
 * Owner mode had no counterpart to the legacy `expireAbandonedSessions` sweep:
 * a session ended only through its own finish, an operator force-close or a
 * reboot. A SIGKILLed or never-resumed agent stayed `active` forever, and every
 * cleanup keyed on `endedAt` (claims, bindings, retention) never ran for it.
 */
export function livenessReconciliationNeeded(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  env: Pick<Env, 'AGENT_PORTAL_BRIDGE_TTL_SECONDS'>,
  now: number,
): boolean {
  if (lastSeenStamps(owner, snapshot, now).length) return true;
  const ttl = env.AGENT_PORTAL_BRIDGE_TTL_SECONDS * 1000;
  return snapshot.sessions.all().some((session) => {
    const due = sessionAbandonDueAt(owner, snapshot, session.id, ttl);
    return due !== null && due <= now;
  });
}

export function stageOwnerLiveness(
  ctx: OwnerMutationContext,
  owner: OwnerRuntime,
  keyring: Keyring,
  env: Pick<Env, 'AGENT_PORTAL_BRIDGE_TTL_SECONDS' | 'AGENT_PORTAL_RETENTION_HOURS'>,
  now: number,
): boolean {
  let changed = false;
  for (const [sessionId, seenAt] of lastSeenStamps(owner, ctx.draft.view(), now)) {
    stageUpdate(ctx, 'agentSessions', sessionId, { heartbeatAt: new Date(seenAt).toISOString() });
    changed = true;
  }
  const ttl = env.AGENT_PORTAL_BRIDGE_TTL_SECONDS * 1000;
  for (const session of ctx.draft.table('agentSessions').all()) {
    const view = ctx.draft.view();
    const due = sessionAbandonDueAt(owner, view, session.id, ttl);
    if (due === null || due > now) continue;
    const at = new Date(now).toISOString();
    const seen = sessionLastSeen(owner, view, session.id);
    const from = seen !== null && Number.isFinite(seen) ? seen : now;
    const expiresAt = new Date(from + historyRetentionHours(view, env.AGENT_PORTAL_RETENTION_HOURS) * 3600_000).toISOString();
    if (!stagePortalSessionFinish(ctx, session, 'failed', expiresAt, at, keyring)) continue;
    // The event makes a returning wrapper's agent_session_finished say
    // "abandoned", exactly as the legacy sweep did. No supervisor arm: an
    // offline laptop is not a crash.
    stagePortalEvent(ctx, {
      sessionId: session.id,
      clientEventId: ABANDONED_SESSION_EVENT_ID,
      eventType: 'failed',
      source: 'bridge',
      payloadEnc: encrypt(JSON.stringify({ summary: 'Agent disconnected before finalization' }), keyring),
      createdAt: at,
    });
    changed = true;
  }
  return changed;
}
