import type { OwnedTableName, StateRow } from '../../control-plane/state/catalog.js';
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
import { SERVER_RETENTION_SECONDS } from './guards.js';
import type { EntityView } from '../../control-plane/state/store.js';

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
    'hosts',
    'agentBusConversations',
    'agentBusGroups',
    'agentScopes',
    'agentRoomDeliveries',
    'agentRoomEvents',
    'agentScopeEvents',
    'agentChatAttachments',
    'chattyRuns',
    'chattyActions',
  ] as const satisfies readonly OwnedTableName[];
  // Only fields used by retention eligibility can unpark protected history.
  // Receiver/heartbeat/activity updates do not release durable protection.
  const fields: { [K in OwnedTableName]?: readonly (keyof StateRow<K> & string)[] } = {
    agentSessions: ['agentBusAddressId', 'endedAt', 'status', 'activeTurnId', 'bindingGeneration'],
    agentBusAddresses: ['hostId', 'currentSessionId', 'archivedAt', 'enabled'],
    agentSchedules: ['targetAddressId', 'deletedAt'],
    agentWatchdogs: ['targetAddressId', 'status'],
    agentRebootHandoffs: ['addressId', 'oldSessionId', 'newSessionId', 'status'],
    agentRoleProposals: ['authorAddressId', 'reviewerAddressId', 'status'],
    agentBusMessages: ['senderAddressId', 'targetAddressId', 'conversationId', 'status', 'leaseOwner'],
    agentBusSubscriptions: ['subscriberAddressId', 'topic'],
    agentBusConferenceMembers: ['conferenceId', 'addressId', 'conversationId'],
    agentBusConferences: ['ownerAddressId', 'status'],
    agentScopeMembers: ['scopeId', 'sessionId'],
    agentResourceClaims: ['sessionId', 'state'],
    agentMessages: ['sessionId', 'status'],
    hostDaemonOperations: ['sessionId', 'status'],
    hostDaemonSessions: ['addressId', 'sessionId', 'status'],
    advisorSessions: ['conversationId', 'status'],
    workflowRuns: ['status'],
    agentChatNotices: ['sessionId', 'resolvedAt'],
    chattySessions: ['generation'],
    hosts: ['internalRole'],
    agentBusConversations: ['addressAId', 'addressBId'],
    agentBusGroups: ['slug'],
    agentScopes: [],
    agentRoomDeliveries: ['eventId', 'messageId'],
    agentRoomEvents: ['roomId'],
    agentScopeEvents: ['scopeId', 'dispatched'],
    agentChatAttachments: ['sessionId', 'status'],
    chattyRuns: ['userId', 'status'],
    chattyActions: ['userId', 'status'],
  };
  const day = SERVER_RETENTION_SECONDS * 1000;
  type Clock<K extends OwnedTableName> = { field: keyof StateRow<K> & string; family?: RetentionFamily; delay: number };
  const clocks: { [K in OwnedTableName]?: readonly Clock<K>[] } = {
    agentSessions: [{ field: 'heartbeatAt', delay: day }, { field: 'expiresAt', family: 'portal', delay: 0 }],
    agentBusAddresses: [{ field: 'lastSeenAt', delay: day }, { field: 'lastSeenAt', family: 'addresses', delay: day }],
    hostDaemonSessions: [{ field: 'lastActivityAt', family: 'daemons', delay: day }],
    agentBusConferences: [{ field: 'createdAt', family: 'rooms', delay: day }, { field: 'adjournedAt', family: 'rooms', delay: day }],
    agentChatNotices: [{ field: 'createdAt', family: 'portal', delay: day }],
    chattySessions: [{ field: 'updatedAt', family: 'chatty', delay: day }],
    chattyRuns: [{ field: 'updatedAt', family: 'chatty', delay: day }, { field: 'leaseUntil', family: 'chatty', delay: day }],
    agentBusConversations: [{ field: 'lastActivityAt', family: 'conversations', delay: day }],
    agentRoomEvents: [{ field: 'createdAt', family: 'rooms', delay: day }],
    agentScopeEvents: [{ field: 'createdAt', family: 'rooms', delay: day }],
    agentChatAttachments: [{ field: 'updatedAt', family: 'rooms', delay: day }, { field: 'updatedAt', family: 'attachments', delay: day + 1 }],
  };
  const selected = [...dependencies, 'chattySessions'] as const;
  const project = (view: EntityView<OwnedTableName>) => new Map(view.all().map(row => {
    const value = row as unknown as Record<string, unknown>;
    return [view.keyFor(row), {
      guard: JSON.stringify((fields[view.name] ?? []).map(field => value[field])),
      clocks: (clocks[view.name] ?? []).map(clock => typeof value[clock.field] === 'string' ? Date.parse(value[clock.field] as string) + clock.delay : NaN),
    }];
  }));
  let views = selected.map(table => runtime.state.snapshot().table(table));
  const projections = views.map(project);
  runtime.state.subscribe(snapshot => {
    const next = selected.map(table => snapshot.table(table));
    for (let i = 0; i < selected.length; i++) {
      if (next[i] === views[i]) continue;
      const table = selected[i]!, before = projections[i]!, after = project(next[i]!);
      const families = ['chattySessions', 'chattyRuns', 'chattyActions'].includes(table) ? ['chatty'] as const : RETENTION_FAMILIES;
      if (before.size !== after.size || [...after].some(([key, value]) => before.get(key)?.guard !== value.guard))
        index.invalidate(families);
      for (const [key, value] of after) {
        const previous = before.get(key);
        value.clocks.forEach((dueAt, position) => {
          if (!Number.isFinite(dueAt) || dueAt === previous?.clocks[position]) return;
          const clock = clocks[table]![position]!;
          if (clock.family) index.stage(clock.family, dueAt);
          else if (dueAt > Date.now()) index.stageGuard(dueAt);
          else index.invalidate(); // A contact correction can remove age protection.
        });
      }
      projections[i] = after;
    }
    views = next;
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
