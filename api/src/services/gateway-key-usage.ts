import {
  mutateOwnerState,
  requireOwnerRuntime,
  withOwnerBackgroundScope,
  type OwnerRuntime,
} from '../control-plane/state/runtime.js';
import { stageUpdate } from '../control-plane/state/rows.js';

interface PendingUsage {
  count: number;
  at: string;
}
const buffers = new WeakMap<OwnerRuntime, Map<number, PendingUsage>>();
/** Approximate telemetry is coalesced for 30 seconds. No dirty keys means no
 * timer or SQL. A crash can lose only the current unflushed usage counters. */
export function recordGatewayKeyUse(db: object, id: number): void {
  const owner = requireOwnerRuntime(db);
  if (!owner.state.snapshot().table('openaiApiKeys').has(id)) return;
  let buffer = buffers.get(owner);
  if (!buffer) {
    buffer = new Map();
    buffers.set(owner, buffer);
  }
  const wasEmpty = buffer.size === 0,
    prior = buffer.get(id);
  buffer.set(id, { count: (prior?.count ?? 0) + 1, at: new Date().toISOString() });
  if (wasEmpty)
    owner.deadlines.schedule('gateway-key-usage', Date.now() + 30000, () => flushGatewayKeyUsage(owner));
}
export function pendingGatewayKeyUse(owner: OwnerRuntime, id: number): Readonly<PendingUsage> | undefined {
  return buffers.get(owner)?.get(id);
}
export async function flushGatewayKeyUsage(owner: OwnerRuntime): Promise<void> {
  const buffer = buffers.get(owner);
  if (!buffer?.size) return;
  const batch = new Map(buffer);
  buffer.clear();
  owner.deadlines.cancel('gateway-key-usage');
  try {
    await withOwnerBackgroundScope(() =>
      mutateOwnerState(owner, {
        kind: 'gateway.usage',
        principal: 'system:gateway-usage',
        payload: { keys: [...batch].map(([id, row]) => ({ id, ...row })) },
        prepare(ctx) {
          for (const [id, use] of batch) {
            const row = ctx.snapshot.table('openaiApiKeys').get(id);
            if (row)
              stageUpdate(ctx, 'openaiApiKeys', id, {
                useCount: row.useCount + use.count,
                lastUsedAt: !row.lastUsedAt || use.at > row.lastUsedAt ? use.at : row.lastUsedAt,
                updatedAt: row.updatedAt > use.at ? row.updatedAt : use.at,
              });
          }
          return null;
        },
      }),
    );
  } catch (error) {
    // Retain observations when a retryable command failed; a fenced owner will
    // refuse the retry and is never allowed to write through another connection.
    for (const [id, use] of batch) {
      const newer = buffer.get(id);
      buffer.set(id, {
        count: use.count + (newer?.count ?? 0),
        at: newer?.at && newer.at > use.at ? newer.at : use.at,
      });
    }
    owner.deadlines.schedule('gateway-key-usage', Date.now() + 30000, () => flushGatewayKeyUsage(owner));
    throw error;
  }
}
