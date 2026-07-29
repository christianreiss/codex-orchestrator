import { and, eq, inArray, lt } from 'drizzle-orm';
import {
  authCanonicalHeads,
  authEntries,
  authPayloads,
  hostAuthStates,
  versions,
} from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { decryptOrNull } from '../security/secret-box.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
import { nowIso } from '../util/timestamp.js';
import { credentialMetadata, inspectCredential } from './auth-generation.js';
import { createRunnerValidationService } from './runner-validation.js';

const BACKFILL_MARKER = 'auth_generation_ledger_v1';
export const AUTH_HISTORY_RETENTION_DAYS = 180;
/** Rows deleted per prune call; a full batch means more history is waiting. */
export const AUTH_PRUNE_BATCH_LIMIT = 500;

export async function ensureAuthGenerationBackfill(db: Database, keyring: Keyring): Promise<void> {
  const marker = await db.select().from(versions).where(eq(versions.name, BACKFILL_MARKER));
  if (marker[0]?.version === 'complete') return;

  const validation = createRunnerValidationService({ db, keyring });
  const selected = new Map<Engine, number>();
  for (const engine of [ENGINE_CODEX, ENGINE_CLAUDE] as const) {
    const current = await validation.resolveCanonicalPayload(engine);
    if (current) selected.set(engine, current.id);
  }

  const rows = await db.select().from(authPayloads);
  for (const engine of [ENGINE_CODEX, ENGINE_CLAUDE] as const) {
    const engineRows = rows.filter((row) => row.engine === engine).sort((a, b) => a.id - b.id);
    const currentId = selected.get(engine);
    for (let i = 0; i < engineRows.length; i += 1) {
      const row = engineRows[i]!;
      const generation = i + 1;
      const plaintext = decryptOrNull(row.body, keyring);
      let extracted: ReturnType<typeof credentialMetadata> | null = null;
      if (plaintext) {
        try {
          const auth = JSON.parse(plaintext) as Record<string, unknown>;
          const identity = inspectCredential(auth, engine);
          if (identity) extracted = credentialMetadata(identity, keyring.active());
        } catch {
          // Structurally corrupt history remains encrypted history, but cannot
          // participate in credential replay matching.
        }
      }
      const supersededAt = row.id === currentId
        ? null
        : (engineRows[i + 1]?.createdAt ?? nowIso());
      await db
        .update(authPayloads)
        .set({
          generation,
          ...(extracted ?? {}),
          supersededAt,
          purgeAfter: supersededAt ? retentionDeadline(supersededAt) : null,
        })
        .where(eq(authPayloads.id, row.id));
    }
    if (currentId) {
      const current = engineRows.find((row) => row.id === currentId);
      const generation = current ? engineRows.indexOf(current) + 1 : engineRows.length;
      await db
        .insert(authCanonicalHeads)
        .values({ engine, payloadId: currentId, generation, updatedAt: nowIso() })
        .onDuplicateKeyUpdate({ set: { payloadId: currentId, generation, updatedAt: nowIso() } });
    }
  }

  await db
    .insert(versions)
    .values({ name: BACKFILL_MARKER, version: 'complete', updatedAt: nowIso() })
    .onDuplicateKeyUpdate({ set: { version: 'complete', updatedAt: nowIso() } });
}

export async function pruneSupersededAuth(
  db: Database,
  now = nowIso(),
  limit = AUTH_PRUNE_BATCH_LIMIT,
): Promise<number> {
  const heads = await db.select().from(authCanonicalHeads);
  const protectedIds = new Set(heads.map((head) => head.payloadId));
  const candidates = await db
    .select()
    .from(authPayloads)
    .where(and(lt(authPayloads.purgeAfter, now), lt(authPayloads.supersededAt, now)));
  const ids = candidates
    .filter((row) => !protectedIds.has(row.id))
    .slice(0, limit)
    .map((row) => row.id);
  if (ids.length === 0) return 0;

  await db.transaction(async (tx) => {
    await tx.delete(hostAuthStates).where(inArray(hostAuthStates.payloadId, ids));
    await tx.delete(authEntries).where(inArray(authEntries.payloadId, ids));
    await tx.delete(authPayloads).where(inArray(authPayloads.id, ids));
  });
  return ids.length;
}

export function retentionDeadline(supersededAt: string): string {
  const instant = Date.parse(supersededAt);
  if (!Number.isFinite(instant)) throw new Error('invalid auth superseded_at');
  return new Date(instant + AUTH_HISTORY_RETENTION_DAYS * 86_400_000).toISOString();
}
