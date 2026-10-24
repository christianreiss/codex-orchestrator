import type { OwnedTableName } from '../../control-plane/state/catalog.js';
import type { Database } from '../../db/client.js';
import type { Env } from '../../env.js';
import type { PersistenceTransaction } from '../../control-plane/persistence.js';
import { mutateOwnerState, type OwnerRuntime } from '../../control-plane/state/runtime.js';
import { ownerPresence } from '../../control-plane/presence.js';
import {
  RetentionDeadlineIndex,
  RETENTION_FAMILIES,
  readRetentionClock,
  type RetentionFamily,
  type RetentionClockSnapshot,
} from './deadlines.js';
import { RetentionProjection } from './projection.js';
import { ServerRetentionService } from './index.js';
import { wsPublisher } from '../../ws/publisher.js';

const bindings = new WeakMap<OwnerRuntime, RetentionDeadlineIndex>();
export async function hydrateRetentionIndex(
  tx: PersistenceTransaction,
  env: Env,
): Promise<RetentionDeadlineIndex> {
  const index = new RetentionDeadlineIndex();
  await index.hydrate((family, now) =>
    readRetentionClock(tx, family, now, env.AGENT_PORTAL_RELAY_FRESH_SECONDS * 10_000),
  );
  return index;
}
export function bindOwnerRetention(runtime: OwnerRuntime, index: RetentionDeadlineIndex): void {
  if (bindings.has(runtime)) throw new Error('Owner retention already bound');
  index.obligations();
  bindings.set(runtime, index);
  const dependencies = [
    'agentBusAddresses',
    'agentSessions',
    'agentSchedules',
    'agentWatchdogs',
    'agentRebootHandoffs',
    'agentRoleProposals',
    'agentBusMessages',
    'agentBusSubscriptions',
    'agentBusConferenceMembers',
    'agentBusConferences',
    'agentScopeMembers',
    'agentResourceClaims',
    'agentMessages',
    'hostDaemonOperations',
    'hostDaemonSessions',
    'advisorSessions',
    'workflowRuns',
    'agentChatNotices',
  ] as const satisfies readonly OwnedTableName[];
  let views = dependencies.map((table) => runtime.state.snapshot().table(table));
  let chatty = runtime.state.snapshot().table('chattySessions');
  runtime.state.subscribe((snapshot) => {
    const next = snapshot.table('chattySessions');
    if (next === chatty) return;
    for (const row of next.all()) {
      const previous = chatty.get(row.userId);
      if (previous?.eventCursor !== row.eventCursor || previous?.updatedAt !== row.updatedAt)
        index.stage('chatty', Date.now() + 86_400_000);
    }
    chatty = next;
    index.invalidate(['chatty']);
  });
  runtime.state.subscribe((snapshot) => {
    const next = dependencies.map((table) => snapshot.table(table));
    if (next.every((view, i) => view === views[i])) return;
    views = next;
    index.invalidate();
  });
}
export function ownerRetention(runtime: OwnerRuntime): RetentionDeadlineIndex {
  const index = bindings.get(runtime);
  if (!index) throw new Error('Owner retention index not bound');
  return index;
}
export function retentionFamily(key: string): RetentionFamily {
  const family = key.slice('history:'.length) as RetentionFamily;
  if (!key.startsWith('history:') || !RETENTION_FAMILIES.includes(family))
    throw new Error('Unknown retention obligation');
  return family;
}
/** Due-only guarded SQL; no legacy transaction and no periodic SQL discovery. */
export async function runOwnerHistoryRetention(
  db: Database,
  runtime: OwnerRuntime,
  family: RetentionFamily,
  env: Env,
): Promise<number> {
  if (['turns', 'portal', 'attachments'].includes(family))
    throw new Error('Use portal maintenance for this retention family');
  const index = ownerRetention(runtime);
  let changed = 0,
    next: RetentionClockSnapshot | undefined;
  await mutateOwnerState(runtime, {
    kind: 'retention.history',
    payload: { family },
    prepare(context) {
      const now = new Date();
      context.write(async (tx) => {
        const service = new ServerRetentionService(
          db,
          new RetentionProjection(context.draft),
          tx as unknown as Parameters<Parameters<Database['transaction']>[0]>[0],
          ownerPresence(runtime),
        );
        changed = await service.purgeFamily(family, now);
        next = await readRetentionClock(
          tx,
          family,
          now.getTime(),
          env.AGENT_PORTAL_RELAY_FRESH_SECONDS * 10_000,
        );
      });
      return () => ({ changed });
    },
  });
  if (!next) throw new Error('Retention command returned without committed clock');
  index.publishSweep(family, next, changed);
  if (changed) {
    wsPublisher.publish('agent_messaging.queue.changed', { retention: family, changed });
    wsPublisher.publish('agent_portal.sessions.changed', { retention: family });
    wsPublisher.publish('agent_room_chat.changed', { retention: family });
    wsPublisher.publish('agent_messaging.conference.changed', { retention: family });
    wsPublisher.publish('host.daemon.changed', { retention: family });
    wsPublisher.publish('chatty.changed', { retention: family });
  }
  return changed;
}
