import { connectorRecords } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import {
  mutateOwnerState,
  ownerRuntimeFor,
  type OwnerMutationContext,
} from '../../control-plane/state/runtime.js';
import { stageDelete } from '../../control-plane/state/rows.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';

export class ConnectorStore {
  constructor(readonly db: Database) {}
  snapshot(): OwnerStateSnapshot {
    const owner = ownerRuntimeFor(this.db);
    if (!owner) throw new Error('Connectors require the control-plane owner');
    owner.assertOwner();
    return owner.state.snapshot();
  }
  get<T>(id: string, snapshot = this.snapshot()): T | null {
    const row = snapshot.table('connectorRecords').get(id);
    if (!row || (row.expiresAt && Date.parse(row.expiresAt) <= Date.now())) return null;
    return JSON.parse(row.bodyJson) as T;
  }
  async change<T extends import('../../control-plane/commands.js').Json>(
    kind: string,
    prepare: (ctx: OwnerMutationContext) => T,
  ): Promise<T> {
    const owner = ownerRuntimeFor(this.db);
    if (!owner) throw new Error('Connectors require the control-plane owner');
    return (await mutateOwnerState(owner, {
      kind: `connector.${kind}`,
      payload: {},
      prepare: (ctx) => {
        for (const row of ctx.snapshot.table('connectorRecords').all())
          if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) this.remove(ctx, row.id);
        return prepare(ctx);
      },
    })) as T;
  }
  put(ctx: OwnerMutationContext, id: string, kind: string, body: unknown, seconds?: number): void {
    if (
      !ctx.draft.table('connectorRecords').has(id) &&
      ctx.draft.table('connectorRecords').all().length >= 10000
    )
      throw new Error('Connector record capacity reached');
    const row = {
      id,
      kind,
      bodyJson: JSON.stringify(body),
      createdAt: ctx.draft.table('connectorRecords').get(id)?.createdAt ?? new Date().toISOString(),
      expiresAt: seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null,
    };
    ctx.draft.upsert('connectorRecords', row);
    ctx.write(async (tx) =>
      tx
        .insert(connectorRecords)
        .values(row)
        .onDuplicateKeyUpdate({ set: { bodyJson: row.bodyJson, expiresAt: row.expiresAt } }),
    );
  }
  remove(ctx: OwnerMutationContext, id: string): void {
    stageDelete(ctx, 'connectorRecords', id);
  }
}
