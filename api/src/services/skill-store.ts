import { eq } from 'drizzle-orm';
import type { Json } from '../control-plane/commands.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { mutateOwnerState, ownerRuntimeFor, type OwnerMutationContext } from '../control-plane/state/runtime.js';
import type { Database } from '../db/client.js';
import { skills } from '../db/schema.js';
import { ConflictError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { isSourceOwnedSkill } from './skill-provenance.js';

/**
 * The one authored-Skill upsert behind both store entry points: the admin
 * side (`SkillsService.store`: `/admin/skills/store`, the assistant, the
 * connector catalog) and the host side (`HostSkillsService.store`: MCP
 * `skill_store`, `/skills` store). Until 2026-11-20 each had its own copy;
 * the admin copy wiped `display_name` and `engine` whenever a request left
 * them out (the admin UI never sends `engine`) and left a soft-deleted Skill
 * deleted when the stored content was unchanged (API-KNOW-04).
 *
 * Row semantics, identical for every caller:
 * - `displayName`, `description`, `engine`: `undefined` keeps the stored
 *   value, `null` clears it. Callers map blank strings to `null`.
 * - Storing over a soft-deleted row revives it, even with identical content.
 * - Source-owned rows are refused, on the plain path under the row lock.
 *
 * Input validation, authorization, the owner command record, audit and WS
 * events stay with each entry point (`SkillStoreEntry`).
 */
export type SkillStoreStatus = 'created' | 'updated' | 'unchanged';

export interface SkillStoreWrite {
  slug: string;
  manifest: string;
  /** sha256 of `manifest`, already checked against any client-supplied digest. */
  sha256: string;
  displayName: string | null | undefined;
  description: string | null | undefined;
  engine: string | null | undefined;
  sourceHostId: number | null;
}

export interface SkillStoreEntry {
  /** Owner command kind and recorded payload. */
  command: { kind: string; payload: Json };
  /** Message of the `managed_skill` conflict for a source-owned row. */
  sourceOwnedMessage: string;
  /** Owner path: audit staged in the same mutation. */
  ownerAudit?(ctx: OwnerMutationContext, status: SkillStoreStatus, now: string): void;
  /** Plain path: audit after the transaction committed. */
  plainAudit?(status: SkillStoreStatus): Promise<void>;
}

export interface SkillStoreOutcome {
  status: SkillStoreStatus;
  sha256: string;
  updatedAt: string;
}

// Owner RAM holds skill rows without their manifest body.
type SkillRow = Pick<typeof skills.$inferSelect, 'sha256' | 'displayName' | 'description' | 'engine' | 'deletedAt'>;

/** Metadata to persist: an omitted field keeps the stored value. */
function nextMetadata(existing: SkillRow | undefined, write: SkillStoreWrite) {
  return {
    displayName: write.displayName === undefined ? (existing?.displayName ?? null) : write.displayName,
    description: write.description === undefined ? (existing?.description ?? null) : write.description,
    engine: write.engine === undefined ? (existing?.engine ?? null) : write.engine,
  };
}

function statusFor(existing: SkillRow | undefined, write: SkillStoreWrite, next: ReturnType<typeof nextMetadata>): SkillStoreStatus {
  if (!existing) return 'created';
  const unchanged =
    existing.sha256 === write.sha256 &&
    (existing.displayName ?? null) === next.displayName &&
    (existing.description ?? null) === next.description &&
    (existing.engine ?? null) === next.engine &&
    !existing.deletedAt;
  return unchanged ? 'unchanged' : 'updated';
}

export async function upsertAuthoredSkill(db: Database, write: SkillStoreWrite, entry: SkillStoreEntry): Promise<SkillStoreOutcome> {
  const { slug, manifest, sha256, sourceHostId } = write;
  const owner = ownerRuntimeFor(db);
  if (owner) {
    return (await mutateOwnerState(owner, {
      kind: entry.command.kind,
      payload: entry.command.payload,
      prepare: (ctx) => {
        const existing = ctx.snapshot.table('skills').by('slug', slug)[0];
        if (existing && isSourceOwnedSkill(existing)) throw new ConflictError(entry.sourceOwnedMessage, 'managed_skill');
        const next = nextMetadata(existing, write);
        const status = statusFor(existing, write, next);
        const now = nowIso();
        if (status !== 'unchanged') {
          const values = { slug, sha256, manifest, ...next, sourceHostId, updatedAt: now, deletedAt: null };
          if (existing) stageUpdate(ctx, 'skills', existing.id, values);
          else {
            const row = {
              ...values,
              sourceType: null,
              sourceRepository: null,
              sourcePath: null,
              sourceRevision: null,
              sourceLicense: null,
              bundleSha256: null,
              createdAt: now,
            };
            ctx.write(async (tx) => {
              const inserted = await tx.insert(skills).values(row);
              ctx.draft.upsert('skills', { id: Number(inserted[0].insertId), ...row });
            });
          }
        }
        entry.ownerAudit?.(ctx, status, now);
        return { status, sha256, updatedAt: status === 'unchanged' ? existing!.updatedAt : now };
      },
    })) as unknown as SkillStoreOutcome;
  }

  // The unique slug lookup is a locking read. Under REPEATABLE READ it locks
  // either the existing row or the unique-index gap, so source promotion or an
  // importer cannot change ownership between this check and the write.
  const outcome = await db.transaction(
    async (tx) => {
      const existing = (await tx.select().from(skills).where(eq(skills.slug, slug)).for('update').limit(1))[0];
      if (existing && isSourceOwnedSkill(existing)) throw new ConflictError(entry.sourceOwnedMessage, 'managed_skill');
      const next = nextMetadata(existing, write);
      const status = statusFor(existing, write, next);
      if (status === 'unchanged') return { status, sha256, updatedAt: existing!.updatedAt };
      const now = nowIso();
      const values = { sha256, manifest, ...next, sourceHostId, updatedAt: now, deletedAt: null };
      if (existing) await tx.update(skills).set(values).where(eq(skills.id, existing.id));
      else await tx.insert(skills).values({ slug, ...values, createdAt: now });
      return { status, sha256, updatedAt: now };
    },
    { isolationLevel: 'repeatable read' },
  );
  await entry.plainAudit?.(outcome.status);
  return outcome;
}
