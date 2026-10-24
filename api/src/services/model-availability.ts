import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';
import { mutateOwnerState, requireOwnerRuntime } from '../control-plane/state/runtime.js';
import { adminAudit } from '../control-plane/state/admin.js';

/** Merge one model toggle inside the serialized command, preserving concurrent
 * changes to other models on the same API surface. */
export async function setOwnedModelEnabled(
  db: Database,
  flag: string,
  model: string,
  enabled: boolean,
): Promise<void> {
  const owner = requireOwnerRuntime(db);
  await mutateOwnerState(owner, {
    kind: 'gateway.model.enabled',
    payload: { flag, model, enabled },
    prepare(ctx) {
      const disabled = new Set(
        (ctx.snapshot.setting(flag) ?? '')
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      );
      if (enabled) disabled.delete(model);
      else disabled.add(model);
      const row = {
        name: flag,
        version: [...disabled].sort().join(','),
        updatedAt: new Date().toISOString(),
      };
      ctx.draft.upsert('versions', row);
      ctx.write((tx) => tx.insert(versions).values(row).onDuplicateKeyUpdate({ set: row }));
      adminAudit(ctx, 'gateway.model.enabled', { flag, model, enabled });
      return null;
    },
  });
}
