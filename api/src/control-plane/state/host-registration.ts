import { persistAuditLog } from '../../services/audit-log.js';
import { getTableColumns } from 'drizzle-orm';
import { hosts, type Host } from '../../db/schema.js';
import { NotFoundError } from '../../http/errors.js';
import type { OwnerMutationContext } from './runtime.js';

/** Registration grace comes from its durable audit, never arbitrary updatedAt. */
export function stageHostRegistration(
  ctx: OwnerMutationContext,
  hostId: number,
  action: 'host.created' | 'host.rotated',
  details: Record<string, unknown>,
  at = new Date().toISOString(),
): void {
  const host = ctx.draft.table('hosts').get(hostId);
  if (!host) throw new NotFoundError('Host not found', 'host_not_found');
  ctx.draft.upsert('hosts', { ...host, registrationAt: at });
  ctx.write(async (tx) =>
    persistAuditLog(tx, { hostId, action, details: JSON.stringify(details), createdAt: at }),
  );
}

export type ManagedHost = Omit<Host, 'apiKey' | 'apiKeyEnc'>;

/** Materialize declared literal defaults before insert; never reread an owned row. */
export function materializeHost(values: typeof hosts.$inferInsert & { id: number }): Host {
  const row: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(hosts))) {
    const supplied = (values as Record<string, unknown>)[key];
    if (supplied !== undefined) row[key] = supplied;
    else if (column.default !== undefined && (column.default === null || typeof column.default !== 'object'))
      row[key] = column.default;
    else if (!column.notNull) row[key] = null;
    else throw new Error(`Host factory requires explicit value for ${key}`);
  }
  return row as Host;
}
