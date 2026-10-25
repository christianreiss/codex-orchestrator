import { eq } from 'drizzle-orm';
import { versions } from '../../db/schema.js';
import {
  DEFAULT_SERVER_RETENTION,
  parseServerRetention,
  serverRetentionPolicy,
  RETENTION_POLICY_KEY,
  RETENTION_RUN_KEY,
} from './policy.js';
import { isColdFamily, purgeCold } from './cold.js';
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
import { hasOwnerHistoryWork, readOwnerRetentionClock } from './ram.js';

const bindings = new WeakMap<OwnerRuntime, RetentionDeadlineIndex>();
export async function hydrateRetentionIndex(
  tx: PersistenceTransaction,
  env: Env,
): Promise<RetentionDeadlineIndex> {
  const index = new RetentionDeadlineIndex();
  const [stored] = await tx.select().from(versions).where(eq(versions.name, RETENTION_POLICY_KEY));
  const policy = stored
    ? parseServerRetention(stored.version)
    : { ...DEFAULT_SERVER_RETENTION, history_hours: env.AGENT_PORTAL_RETENTION_HOURS };
  if (!stored)
    await tx
      .insert(versions)
      .values({
        name: RETENTION_POLICY_KEY,
        version: JSON.stringify(policy),
        updatedAt: new Date().toISOString(),
      });
  await index.hydrate((family, now) =>
    readRetentionClock(tx, family, now, env.AGENT_PORTAL_RELAY_FRESH_SECONDS * 10_000, policy),
  );
  return index;
}
export function bindOwnerRetention(
  runtime: OwnerRuntime,
  index: RetentionDeadlineIndex,
  workingTurnMs = 600000,
): void {
  if (bindings.has(runtime)) throw new Error('Owner retention already bound');
  index.obligations();
  bindings.set(runtime, index);
  const pendingRun = JSON.parse(runtime.state.snapshot().setting(RETENTION_RUN_KEY) ?? '{}') as {
    status?: string;
  };
  if (pendingRun.status === 'running')
    index.force(RETENTION_FAMILIES.filter((f) => !['turns', 'credentials'].includes(f)));
  const dependencies = [
    'controlPlaneOutbox',
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
    controlPlaneOutbox: ['status', 'completedAt'],
    agentSessions: ['agentBusAddressId', 'endedAt', 'status', 'activeTurnId', 'bindingGeneration'],
    agentBusAddresses: ['hostId', 'currentSessionId', 'archivedAt', 'enabled'],
    agentSchedules: ['targetAddressId', 'deletedAt'],
    agentWatchdogs: ['targetAddressId', 'status'],
    agentRebootHandoffs: ['addressId', 'oldSessionId', 'newSessionId', 'status'],
    agentRoleProposals: ['authorAddressId', 'reviewerAddressId', 'status'],
    agentBusMessages: [
      'senderAddressId',
      'targetAddressId',
      'conversationId',
      'status',
      'taskResultStatus',
      'leaseOwner',
    ],
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
  type Clock<K extends OwnedTableName> = {
    field: keyof StateRow<K> & string;
    family?: RetentionFamily;
    delay: number;
  };
  const clocks: { [K in OwnedTableName]?: readonly Clock<K>[] } = {
    agentSessions: [
      { field: 'portalAcceptedAt', family: 'turns', delay: workingTurnMs },
      { field: 'heartbeatAt', delay: day },
      { field: 'expiresAt', family: 'portal', delay: 0 },
    ],
    agentBusAddresses: [
      { field: 'lastSeenAt', delay: day },
      { field: 'lastSeenAt', family: 'addresses', delay: day },
    ],
    hostDaemonSessions: [{ field: 'lastActivityAt', family: 'daemons', delay: day }],
    agentBusConferences: [
      { field: 'createdAt', family: 'rooms', delay: day },
      { field: 'adjournedAt', family: 'rooms', delay: day },
    ],
    agentChatNotices: [{ field: 'createdAt', family: 'portal', delay: day }],
    chattySessions: [{ field: 'updatedAt', family: 'chatty', delay: day }],
    chattyRuns: [
      { field: 'updatedAt', family: 'chatty', delay: day },
      { field: 'leaseUntil', family: 'chatty', delay: day },
    ],
    agentBusConversations: [{ field: 'lastActivityAt', family: 'conversations', delay: day }],
    agentRoomEvents: [{ field: 'createdAt', family: 'rooms', delay: day }],
    agentScopeEvents: [{ field: 'createdAt', family: 'rooms', delay: day }],
    agentChatAttachments: [
      { field: 'updatedAt', family: 'rooms', delay: day },
      { field: 'updatedAt', family: 'attachments', delay: day + 1 },
    ],
  };
  const selected = [...dependencies, 'chattySessions'] as const;
  const project = (view: EntityView<OwnedTableName>) =>
    new Map(
      view.all().map((row) => {
        const value = row as unknown as Record<string, unknown>;
        return [
          view.keyFor(row),
          {
            guard: JSON.stringify((fields[view.name] ?? []).map((field) => value[field])),
            clocks: (clocks[view.name] ?? []).map((clock) =>
              typeof value[clock.field] === 'string'
                ? Date.parse(value[clock.field] as string) +
                  (clock.delay === day || clock.delay === day + 1
                    ? serverRetentionPolicy(runtime.state.snapshot()).history_hours * 3600000 +
                      (clock.delay - day)
                    : clock.delay)
                : NaN,
            ),
          },
        ];
      }),
    );
  let views = selected.map((table) => runtime.state.snapshot().table(table));
  const projections = views.map(project);
  let quotaViews = [
    runtime.state.snapshot().table('chatgptUsageSnapshots'),
    runtime.state.snapshot().table('claudeUsageSnapshots'),
  ];
  let policyRaw = runtime.state.snapshot().setting(RETENTION_POLICY_KEY);
  let auditHead = runtime.state.snapshot().setting('owner_latest_log_at');
  let adminHead = runtime.state.snapshot().setting('owner_admin_event_id');
  runtime.state.subscribe((snapshot, persistence) => {
    const policy = serverRetentionPolicy(snapshot);
    const nextPolicy = snapshot.setting(RETENTION_POLICY_KEY);
    if (nextPolicy !== policyRaw) {
      policyRaw = nextPolicy;
      index.force(RETENTION_FAMILIES.filter((f) => !['turns', 'credentials'].includes(f)));
    }
    if (policy.armed) {
      index.stage('receipts', Date.now() + 7 * 86400000);
      const audit = snapshot.setting('owner_latest_log_at'),
        admin = snapshot.setting('owner_admin_event_id');
      if (audit !== auditHead && audit)
        index.stage('auditlogs', Date.parse(audit) + policy.audit_days * 86400000);
      if (admin !== adminHead) index.stage('adminaudit', Date.now() + policy.audit_days * 86400000);
      const nextQuota = [snapshot.table('chatgptUsageSnapshots'), snapshot.table('claudeUsageSnapshots')];
      if (persistence !== 'volatile' && nextQuota.some((v, i) => v !== quotaViews[i])) {
        index.invalidate(['quota']);
        index.stage('quota', Date.now() + policy.quota_days * 86400000);
      }
      quotaViews = nextQuota;
      auditHead = audit;
      adminHead = admin;
    }
    const next = selected.map((table) => snapshot.table(table));
    for (let i = 0; i < selected.length; i++) {
      if (next[i] === views[i]) continue;
      const table = selected[i]!,
        before = projections[i]!,
        after = project(next[i]!);
      if (
        table === 'agentSessions' &&
        next[i]!.all().some((row) => {
          const session = row as StateRow<'agentSessions'>;
          return !session.endedAt && session.activeTurnId && !session.portalAcceptedAt;
        })
      )
        index.force(['turns']);
      const families = ['chattySessions', 'chattyRuns', 'chattyActions'].includes(table)
        ? (['chatty'] as const)
        : RETENTION_FAMILIES.filter((family) => !isColdFamily(family));
      if (
        before.size !== after.size ||
        [...after].some(([key, value]) => before.get(key)?.guard !== value.guard)
      ) {
        index.invalidate(families);
        if (['controlPlaneOutbox', 'agentBusMessages', 'agentMessages', 'chattyActions'].includes(table))
          index.invalidate(['receipts']);
      }
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
      const policy = serverRetentionPolicy(context.snapshot);
      if (
        !isColdFamily(family) &&
        !hasOwnerHistoryWork(
          context.snapshot,
          family,
          new Date(now.getTime() - policy.history_hours * 3600000).toISOString(),
          now.toISOString(),
          ownerPresence(runtime),
        )
      ) {
        next = readOwnerRetentionClock(
          context.snapshot,
          family as Parameters<typeof readOwnerRetentionClock>[1],
          now.getTime(),
          policy.history_hours,
        );
        stageRetentionSweep(context, family, 0);
        return { changed: 0 };
      }
      context.write(async (tx) => {
        const service = new ServerRetentionService(
          db,
          new RetentionProjection(context.draft),
          tx as unknown as Parameters<Parameters<Database['transaction']>[0]>[0],
          ownerPresence(runtime),
          policy,
        );
        changed = isColdFamily(family)
          ? await purgeCold(context, tx, family, policy, now.getTime())
          : await service.purgeFamily(family, now);
        next = isColdFamily(family)
          ? await readRetentionClock(
              tx,
              family,
              now.getTime(),
              env.AGENT_PORTAL_RELAY_FRESH_SECONDS * 10_000,
              policy,
            )
          : readOwnerRetentionClock(
              context.draft.view(),
              family as Parameters<typeof readOwnerRetentionClock>[1],
              now.getTime(),
              policy.history_hours,
            );
        await recordRetentionSweep(context, tx, family, changed);
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

/** One bounded status record; no history-of-cleanup log or autonomous timer. */
export function stageRetentionSweep(
  context: import('../../control-plane/state/runtime.js').OwnerMutationContext,
  family: RetentionFamily,
  changed: number,
) {
  const previous = JSON.parse(context.draft.table('versions').get(RETENTION_RUN_KEY)?.version ?? '{}') as {
    id?: string;
    status?: string;
    started_at?: string;
    completed_at?: string;
    counts?: Record<string, number>;
    families?: Record<string, { at: string; changed: number }>;
  };
  if (changed === 0 && previous.status !== 'running') return null;
  const at = new Date().toISOString();
  const families = { ...previous.families, [family]: { at, changed } };
  const counts = { ...previous.counts };
  if (previous.status === 'running') counts[family] = (counts[family] ?? 0) + changed;
  const status = { ...previous, families, counts };
  const row = { name: RETENTION_RUN_KEY, version: JSON.stringify(status), updatedAt: at };
  context.draft.upsert('versions', row);
  return row;
}
export async function recordRetentionSweep(
  context: import('../../control-plane/state/runtime.js').OwnerMutationContext,
  tx: PersistenceTransaction,
  family: RetentionFamily,
  changed: number,
): Promise<void> {
  const row = stageRetentionSweep(context, family, changed);
  if (row && changed > 0)
    await tx
      .insert(versions)
      .values(row)
      .onDuplicateKeyUpdate({ set: { version: row.version, updatedAt: row.updatedAt } });
}

export async function finishRetentionRun(runtime: OwnerRuntime): Promise<void> {
  const current = JSON.parse(runtime.state.snapshot().setting(RETENTION_RUN_KEY) ?? '{}') as {
    id?: string;
    status?: string;
    started_at?: string;
    families?: Record<string, { at: string }>;
  };
  if (current.status !== 'running' || !current.started_at) return;
  const families = RETENTION_FAMILIES.filter((f) => !['turns', 'credentials'].includes(f));
  if (families.some((f) => !current.families?.[f] || current.families[f]!.at < current.started_at!)) return;
  if (
    ownerRetention(runtime)
      .obligations()
      .some((v) => families.includes(retentionFamily(v.key)) && v.dueAt <= Date.now() + 1000)
  )
    return;
  await mutateOwnerState(runtime, {
    kind: 'retention.run.complete',
    payload: { id: current.id ?? null },
    prepare(context) {
      const run = JSON.parse(context.snapshot.setting(RETENTION_RUN_KEY) ?? '{}') as typeof current;
      if (run.id !== current.id || run.status !== 'running') return null;
      const at = new Date().toISOString(),
        row = {
          name: RETENTION_RUN_KEY,
          version: JSON.stringify({ ...run, status: 'completed', completed_at: at }),
          updatedAt: at,
        };
      context.draft.upsert('versions', row);
      context.write((tx) =>
        tx
          .insert(versions)
          .values(row)
          .onDuplicateKeyUpdate({ set: { version: row.version, updatedAt: at } }),
      );
      return null;
    },
  });
  wsPublisher.publish('settings.changed', { key: RETENTION_RUN_KEY });
}
