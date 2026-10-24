import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import type { Env } from '../env.js';
import { agentSessions } from '../db/schema.js';
import { quotaSnapshot } from '../services/quota-observation.js';
import { startOwnerWorker } from './owner-worker.js';
import { requireOwnerMaintenanceCommands } from './owner-maintenance.js';
import { dependencyRevision } from './schedule-obligations.js';
import { readFleetEngineState } from '../services/engine-switch.js';
import { isEngine } from '../util/engine.js';

export function quotaNoticeId(key: string) {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export async function warnQuotaSessions(db: Database, notify: (ids: string[], content: string, key: string) => Promise<unknown>) {
  const engines = await readFleetEngineState(db, { fresh: true });
  const sessions = await db.select().from(agentSessions).where(and(isNull(agentSessions.endedAt), eq(agentSessions.status, 'active')));
  const snapshots = new Map<number, Awaited<ReturnType<typeof quotaSnapshot>>>();
  for (const session of sessions) {
    if (Date.parse(session.heartbeatAt) < Date.now() - 90000 || !session.providerAccountId || !session.agentBusAddressId || !isEngine(session.engine) || !engines[session.engine]) continue;
    if (!snapshots.has(session.providerAccountId)) snapshots.set(session.providerAccountId, await quotaSnapshot(db, session.providerAccountId, session.engine));
    const q = snapshots.get(session.providerAccountId);
    if (!q || q.unlimited || !['enabled', 'paused'].includes(q.account_state)) continue;
    for (const w of q.windows) {
      const threshold = w.kind === 'short' ? q.policy.short_warn_percent : q.policy.long_warn_percent;
      // A usable reset timestamp identifies a period across samples and restarts.
      if (w.status !== 'fresh' || !w.resets_at || threshold === null || w.used_percent < threshold) continue;
      const level = w.used_percent >= 100 ? 'limit' : 'warning';
      const id = quotaNoticeId([session.agentBusAddressId, q.account_id, w.kind, w.resets_at, level].join(':'));
      const content = `QUOTA/1 ${level}: ${q.engine} account ${q.account_label}; ${w.kind} window ${w.used_percent}% used. Reset ${w.resets_at}; observed ${w.observed_at}. Save a continuation checkpoint and assess remaining work before more delegation. This notice does not pause work. Use quota_get for current policy.`;
      await notify([session.agentBusAddressId], content, id);
    }
  }
}
export function startQuotaWorker(app: FastifyInstance, db: Database, _env: Env, _keyring: Keyring) {
  const commands = requireOwnerMaintenanceCommands(db);
  const tables = ['versions', 'agentSessions', 'agentBusAddresses', 'providerAccounts', 'chatgptUsageSnapshots', 'claudeUsageSnapshots', 'grokUsageSnapshots'] as const;
  startOwnerWorker(app, db, {
    name: 'quota-notices', tables,
    subscribe: wake => commands.subscribeFacts(wake),
    select(snapshot) {
      const revision = `${dependencyRevision(snapshot, tables)}:${commands.facts.revision()}`;
      return snapshot.sessions.all().filter(session => !session.endedAt && session.status === 'active' && session.providerAccountId && session.agentBusAddressId)
        .map(session => ({ key: session.id, revision, dueAt: 0 }));
    },
    run: work => commands.run('quota-notices', work),
    error: error => app.log.warn({ err: error }, 'owner quota notice failed'),
  });
}
