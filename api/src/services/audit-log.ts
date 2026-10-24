import type { Database } from '../db/client.js';
import { logs } from '../db/schema.js';
import {
  mutateOwnerState,
  ownerRuntimeFor,
  ownerMutationContextFor,
} from '../control-plane/state/runtime.js';

export const LATEST_LOG_HEAD = 'owner_latest_log_at';
const ROUTINE_ACTIONS = new Set([
  'cron.update_reported',
  'cron.update_available',
  'agent_message.delivery',
  'agent_message.completed',
]);
/** Explicit audit persistence, shared by domain commands and legacy fixtures.
 * The immutable body remains cold; only the latest timestamp joins owned state.
 * An owner handle outside its actual persistence transaction is rejected. */
export async function persistAuditLog(db: Pick<Database, 'insert'>, row: typeof logs.$inferInsert) {
  const owner = ownerRuntimeFor(db),
    context = ownerMutationContextFor(db);
  if (owner && !context) throw new Error('Audit writes require the current owner transaction');
  if (ROUTINE_ACTIONS.has(row.action)) return null;
  const result = await db.insert(logs).values(row);
  if (context) {
    const previous = context.draft.table('versions').get(LATEST_LOG_HEAD)?.version;
    if (!previous || row.createdAt > previous)
      context.draft.upsert('versions', {
        name: LATEST_LOG_HEAD,
        version: row.createdAt,
        updatedAt: row.createdAt,
      });
  }
  return result;
}
/** Standalone observations use the exclusive writer. Domain transitions compose
 * persistAuditLog inside ctx.write so audit and state commit atomically. */
export async function appendAuditLog(db: Database, row: typeof logs.$inferInsert): Promise<void> {
  if (ROUTINE_ACTIONS.has(row.action)) return;
  const owner = ownerRuntimeFor(db);
  if (owner)
    await mutateOwnerState(owner, {
      kind: 'audit.observation',
      payload: { action: row.action, hostId: row.hostId ?? null },
      prepare(ctx) {
        ctx.write((tx) => persistAuditLog(tx, row));
        return null;
      },
    });
  else await persistAuditLog(db, row);
}
