import { deriveCanonicalBodyProof } from '../state/canonical-metadata.js';
import type { Keyring } from '../../security/keyring.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { authPayloads, grokAuthRefreshState } from '../../db/schema.js';
import { ownerRuntimeFor, mutateOwnerState, type OwnerMutationContext } from '../state/runtime.js';
import { stageUpdate } from '../state/rows.js';
import { ConflictError } from '../../http/errors.js';

export type CanonicalDb = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;
const context = new AsyncLocalStorage<OwnerMutationContext>();
export function canonicalContext() {
  return context.getStore();
}
export function canonicalState(db: object) {
  return context.getStore()?.draft ?? ownerRuntimeFor(db)?.state.snapshot();
}

/** A credential domain transaction publishes only its explicitly staged metadata rows. */
export async function canonicalTransaction(
  db: Database,
  kind: string,
  run: (tx: CanonicalDb) => Promise<void>,
) {
  const owner = ownerRuntimeFor(db);
  if (!owner) {
    await db.transaction(run);
    return;
  }
  await mutateOwnerState(owner, {
    kind,
    payload: {},
    prepare(c) {
      c.write((tx) => context.run(c, () => run(tx)));
      return null;
    },
  });
}
export async function insertCanonicalPayload(
  tx: CanonicalDb,
  input: typeof authPayloads.$inferInsert,
  keyring?: Keyring,
): Promise<number> {
  const values = {
    accountId: null,
    sourceHostId: null,
    body: null,
    verificationState: 'pending',
    verificationCheckedAt: null,
    verificationReason: null,
    engine: 'codex',
    generation: null,
    sourceKind: 'legacy',
    parentPayloadId: null,
    credentialKind: null,
    fingerprintKid: null,
    accessFingerprint: null,
    refreshFingerprint: null,
    pairFingerprint: null,
    credentialIssuedAt: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
    supersededAt: null,
    purgeAfter: null,
    ...input,
  };
  const result = await tx.insert(authPayloads).values(values);
  const id = Number((result[0] as { insertId: number | bigint }).insertId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Credential insert returned invalid identity');
  canonicalContext()?.draft.upsert('authPayloads', {
    ...values,
    id,
    canonicalBodyProof: deriveCanonicalBodyProof(tx, { ...values, id }, keyring),
  });
  return id;
}
export async function patchCanonicalPayload(
  db: CanonicalDb,
  id: number,
  patch: Partial<typeof authPayloads.$inferSelect>,
) {
  const c = canonicalContext();
  if (c) {
    const row = c.draft.table('authPayloads').get(id);
    if (!row) throw new Error('Credential metadata missing');
    await db.update(authPayloads).set(patch).where(eq(authPayloads.id, id));
    c.draft.upsert('authPayloads', { ...row, ...patch });
    return;
  }
  const owner = ownerRuntimeFor(db);
  if (owner) {
    await mutateOwnerState(owner, {
      kind: 'auth.payload.verification',
      payload: { id, ...patch },
      prepare(c) {
        stageUpdate(c, 'authPayloads', id, patch);
        return null;
      },
    });
    return;
  }
  await db.update(authPayloads).set(patch).where(eq(authPayloads.id, id));
}
export async function setOwnedGrokState(
  db: Database,
  accountId: number,
  patch: Partial<typeof grokAuthRefreshState.$inferSelect>,
) {
  const owner = ownerRuntimeFor(db);
  if (!owner) {
    await db
      .insert(grokAuthRefreshState)
      .values({ accountId, state: 'idle', updatedAt: new Date().toISOString(), ...patch })
      .onDuplicateKeyUpdate({ set: patch });
    return;
  }
  await mutateOwnerState(owner, {
    kind: 'auth.grok.refresh-state',
    payload: { accountId, state: patch.state ?? null, attemptId: patch.attemptId ?? null },
    prepare(c) {
      const account = c.snapshot.table('providerAccounts').get(accountId);
      if (!account || account.engine !== 'grok' || account.state === 'removed' || account.mergedIntoAccountId)
        throw new ConflictError('Grok account changed', 'grok_generation_conflict');
      if (
        patch.state === 'refreshing' &&
        (account.payloadId !== patch.basePayloadId || account.generation !== patch.baseGeneration)
      )
        throw new ConflictError('Grok canonical changed before refresh', 'grok_generation_conflict');
      const prior = c.snapshot.table('grokAuthRefreshState').get(accountId);
      if (prior) stageUpdate(c, 'grokAuthRefreshState', accountId, patch);
      else {
        const row = {
          accountId,
          state: 'idle',
          attemptId: null,
          basePayloadId: null,
          baseGeneration: null,
          pendingPayloadId: null,
          responseEnc: null,
          nextAttemptAt: null,
          errorCode: null,
          startedAt: null,
          updatedAt: new Date().toISOString(),
          ...patch,
        };
        c.draft.upsert('grokAuthRefreshState', row);
        c.write((tx) => tx.insert(grokAuthRefreshState).values(row));
      }
      return null;
    },
  });
}
