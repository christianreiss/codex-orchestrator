import type { Database } from '../../db/client.js';
import type { Json } from '../../control-plane/commands.js';
import type { PersistenceTransaction } from '../../control-plane/persistence.js';
import { mutateOwnerState, ownerRuntimeFor } from '../../control-plane/state/runtime.js';

/**
 * `external_clients` is a cold table, but once the owner has hydrated the
 * public pool handle refuses writes ("Owner database boundary"): every write
 * runs inside an owner command's transaction. Without a bound owner (boot,
 * unit tests) the handle is used directly.
 */
export async function writeExternalClients(
  db: Database,
  kind: string,
  payload: Json,
  operation: (tx: PersistenceTransaction) => Promise<unknown>,
): Promise<void> {
  const runtime = ownerRuntimeFor(db);
  if (!runtime) {
    await operation(db as unknown as PersistenceTransaction);
    return;
  }
  await mutateOwnerState(runtime, {
    kind,
    payload,
    prepare(ctx) {
      ctx.write(async (tx) => {
        await operation(tx);
      });
      return null;
    },
  });
}
