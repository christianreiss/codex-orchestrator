import { and, count, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import type { StateSeed } from './catalog.js';
import type { OwnerStateDraft } from './store.js';
export interface BusTotal {
  sourceEngine: string;
  targetEngine: string;
  status: string;
  count: number;
}
export interface PortalTotal {
  engine: string;
  status: string;
  count: number;
}
export interface ResponseTotal {
  engine: string;
  count: number;
}
export interface MessagingTotals {
  readonly bus: readonly BusTotal[];
  readonly portal: readonly PortalTotal[];
  readonly responses: readonly ResponseTotal[];
}
export interface MessagingTotalsDelta {
  bus?: readonly BusTotal[];
  portal?: readonly PortalTotal[];
  responses?: readonly ResponseTotal[];
}
const key = (values: readonly string[]) => JSON.stringify(values);
function combine<T extends { count: number }>(
  rows: readonly T[],
  changes: readonly T[],
  identity: (row: T) => string,
): T[] {
  const values = new Map(rows.map((row) => [identity(row), { ...row }]));
  for (const change of changes) {
    const id = identity(change),
      count = (values.get(id)?.count ?? 0) + change.count;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid historical messaging total');
    if (count === 0) values.delete(id);
    else values.set(id, { ...change, count });
  }
  return [...values.values()].sort((a, b) => identity(a).localeCompare(identity(b)));
}
export function updateMessagingTotals(value: MessagingTotals, delta: MessagingTotalsDelta): MessagingTotals {
  return {
    bus: combine(value.bus, delta.bus ?? [], (r) => key([r.sourceEngine, r.targetEngine, r.status])),
    portal: combine(value.portal, delta.portal ?? [], (r) => key([r.engine, r.status])),
    responses: combine(value.responses, delta.responses ?? [], (r) => key([r.engine])),
  };
}
export const emptyMessagingTotals = (): MessagingTotals => ({ bus: [], portal: [], responses: [] });
/** Fixture-only default. Production hydration supplies aggregates over all retained SQL rows. */
export function messagingTotalsFromSeed(seed: StateSeed): MessagingTotals {
  const engines = new Map(seed.agentSessions?.map((row) => [row.id, row.engine]) ?? []);
  return updateMessagingTotals(emptyMessagingTotals(), {
    bus: seed.agentBusMessages?.map((row) => ({
      sourceEngine: row.sourceEngine,
      targetEngine: row.targetEngine,
      status: row.status,
      count: 1,
    })),
    portal: seed.agentMessages?.flatMap((row) => {
      const engine = engines.get(row.sessionId);
      return engine ? [{ engine, status: row.status, count: 1 }] : [];
    }),
  });
}
export async function hydrateMessagingTotals(db: Pick<Database, 'select'>): Promise<MessagingTotals> {
  const bus = await db
    .select({
      sourceEngine: schema.agentBusMessages.sourceEngine,
      targetEngine: schema.agentBusMessages.targetEngine,
      status: schema.agentBusMessages.status,
      count: count(),
    })
    .from(schema.agentBusMessages)
    .groupBy(
      schema.agentBusMessages.sourceEngine,
      schema.agentBusMessages.targetEngine,
      schema.agentBusMessages.status,
    );
  const portal = await db
    .select({ engine: schema.agentSessions.engine, status: schema.agentMessages.status, count: count() })
    .from(schema.agentMessages)
    .innerJoin(schema.agentSessions, sql`BINARY ${schema.agentSessions.id} = BINARY ${schema.agentMessages.sessionId}`)
    .groupBy(schema.agentSessions.engine, schema.agentMessages.status);
  const responses = await db
    .select({ engine: schema.agentSessions.engine, count: count() })
    .from(schema.agentEvents)
    .innerJoin(schema.agentSessions, sql`BINARY ${schema.agentSessions.id} = BINARY ${schema.agentEvents.sessionId}`)
    .where(
      and(
        eq(schema.agentEvents.eventType, 'assistant_message'),
        inArray(schema.agentEvents.source, ['bridge', 'engine']),
      ),
    )
    .groupBy(schema.agentSessions.engine);
  return updateMessagingTotals(emptyMessagingTotals(), {
    bus: bus.map((r) => ({ ...r, count: Number(r.count) })),
    portal: portal.map((r) => ({ ...r, count: Number(r.count) })),
    responses: responses.map((r) => ({ ...r, count: Number(r.count) })),
  });
}
type CountedRow = { sourceEngine?: string; targetEngine?: string; status: string; sessionId?: string };
/** Only persistence helpers call this; working-set hydration/eviction never changes historical counts. */
export function recordMessagingRowChange(
  draft: OwnerStateDraft,
  table: string,
  previous: CountedRow | null,
  next: CountedRow | null,
): void {
  if (table === 'agentBusMessages') {
    const rows = [
      previous
        ? {
            sourceEngine: previous.sourceEngine!,
            targetEngine: previous.targetEngine!,
            status: previous.status,
            count: -1,
          }
        : null,
      next
        ? {
            sourceEngine: next.sourceEngine!,
            targetEngine: next.targetEngine!,
            status: next.status,
            count: 1,
          }
        : null,
    ].filter((r): r is BusTotal => !!r);
    if (
      previous &&
      next &&
      previous.sourceEngine === next.sourceEngine &&
      previous.targetEngine === next.targetEngine &&
      previous.status === next.status
    )
      return;
    draft.adjustMessagingTotals({ bus: rows });
  } else if (table === 'agentMessages') {
    const rows = [
      previous ? { row: previous, count: -1 } : null,
      next ? { row: next, count: 1 } : null,
    ].flatMap((entry) => {
      if (!entry?.row.sessionId) return [];
      const session = draft.table('agentSessions').get(entry.row.sessionId);
      return session ? [{ engine: session.engine, status: entry.row.status, count: entry.count }] : [];
    });
    if (previous && next && previous.sessionId === next.sessionId && previous.status === next.status) return;
    draft.adjustMessagingTotals({ portal: rows });
  }
}
export function recordAssistantResponse(
  draft: OwnerStateDraft,
  event: { sessionId: string; eventType: string; source: string },
): void {
  if (event.eventType !== 'assistant_message' || !['bridge', 'engine'].includes(event.source)) return;
  const session = draft.table('agentSessions').get(event.sessionId);
  if (session) draft.adjustMessagingTotals({ responses: [{ engine: session.engine, count: 1 }] });
}
