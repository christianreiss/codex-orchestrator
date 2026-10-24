import { AsyncLocalStorage } from 'node:async_hooks';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentTransfers, agentTransferEvents, type AgentTransfer } from '../../db/schema.js';
import {
  mutateOwnerState,
  ownerRuntimeFor,
  type OwnerMutationContext,
  type OwnerRuntime,
} from '../../control-plane/state/runtime.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import type { Json } from '../../control-plane/commands.js';
interface Scope {
  owner: OwnerRuntime;
  context: OwnerMutationContext;
  after: Array<() => void>;
}
const current = new AsyncLocalStorage<Scope>();
/** Transfer-only composition. SQL is never interpreted or intercepted. */
export async function transferCommand<T>(
  db: Database,
  kind: string,
  payload: Json,
  run: () => Promise<T>,
): Promise<T> {
  const owner = ownerRuntimeFor(db);
  if (!owner) throw new Error('Transfer owner unavailable');
  if (current.getStore()) throw new Error('Nested transfer command');
  const after: Array<() => void> = [];
  const result = await mutateOwnerState(owner, {
    kind,
    payload,
    prepare: (context) =>
      current.run({ owner, context, after }, async () => {
        const result = await run();
        return result === undefined ? null : (result as Json);
      }),
  });
  for (const notify of after) notify();
  return result as T;
}
function scope(db: object) {
  const value = current.getStore();
  if (value && ownerRuntimeFor(db) !== value.owner) throw new Error('Transfer owner mismatch');
  return value;
}
export function transferRows(db: object): readonly Readonly<AgentTransfer>[] | undefined {
  const owner = ownerRuntimeFor(db);
  if (!owner) return undefined;
  owner.assertOwner();
  return (
    scope(db)?.context.draft.table('agentTransfers') ?? owner.state.snapshot().table('agentTransfers')
  ).all();
}
export async function insertTransfer(db: Database, row: typeof agentTransfers.$inferInsert) {
  const value = scope(db);
  if (value) {
    value.context.draft.upsert('agentTransfers', {
      ...row,
      expectedSizeBytes: row.expectedSizeBytes ?? null,
      expectedSha256: row.expectedSha256 ?? null,
    } as AgentTransfer);
    value.context.write(async (tx) => {
      await tx.insert(agentTransfers).values(row);
    });
    return;
  }
  if (ownerRuntimeFor(db)) throw new Error('Transfer insert requires a domain command');
  await db.insert(agentTransfers).values(row);
}
export async function updateTransfer(db: Database, id: string, patch: Partial<AgentTransfer>) {
  const value = scope(db);
  if (value) {
    stageUpdate(value.context, 'agentTransfers', id, patch);
    return;
  }
  if (ownerRuntimeFor(db)) throw new Error('Transfer update requires a domain command');
  await db.update(agentTransfers).set(patch).where(eq(agentTransfers.id, id));
}
export async function transferEvent(db: Database, row: typeof agentTransferEvents.$inferInsert) {
  const value = scope(db);
  if (value) {
    value.context.write(async (tx) => {
      await tx.insert(agentTransferEvents).values(row);
    });
    return;
  }
  if (ownerRuntimeFor(db)) {
    await transferCommand(db, 'transfer.audit', { id: row.transferId, action: row.action }, async () => {
      await transferEvent(db, row);
      return null;
    });
    return;
  }
  await db.insert(agentTransferEvents).values(row);
}
export function transferNotify(db: object, notify: () => void) {
  const value = scope(db);
  if (value) value.after.push(notify);
  else notify();
}
