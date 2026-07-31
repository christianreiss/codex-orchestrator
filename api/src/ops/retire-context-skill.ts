/**
 * One-shot retirement of the legacy `#context` skill row.
 *
 * Why this exists at all. Managed skills SHADOW a same-named `skills` row rather
 * than deleting it (managed-skills.ts), and host-skills.ts computes that shadow
 * from the *served* list. `context` has now been removed from that list, so
 * without this hook the surviving row — id 22 on crane, `deleted_at` NULL, last
 * touched 2026-07-19 — would stop being shadowed and start being served to the
 * whole fleet. Retiring a skill would therefore have SHIPPED the superseded
 * hand-seeded manifest that b183c7e6 replaced, which is the precise failure the
 * new memory doctrine tells agents to avoid. The row must be tombstoned in the
 * same release that stops serving the managed version.
 *
 * Why it cannot go through the admin path: skills.ts and host-skills.ts both
 * throw `managed_skill` for any slug in `isManagedSkillSlug`, and `context` stays
 * reserved there deliberately.
 *
 * Signature-matched, not `WHERE slug='context'`. If an operator has deliberately
 * authored a *new* skill at that slug, it is theirs and must survive; only the
 * known-stale seeded row is retired. Same approach as the PHP-era
 * `retireLegacyCocoToolkit()` (91a935d0), removed once the fleet converged.
 *
 * Idempotent and safe to delete after the fleet has converged (Release B): it
 * matches nothing once the row is tombstoned.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { skills } from '../db/schema.js';
import { nowIso } from '../util/timestamp.js';

/** Display name of the seeded row, from the live crane database. */
const LEGACY_DISPLAY_NAME = 'Durable task context';

/**
 * Distinctive prefix of the seeded description. The managed manifest said
 * "spans sessions, hosts, or weeks"; the seeded row predates hosts being in
 * scope and says "spans sessions or weeks", so this cannot match the text we
 * ourselves used to ship.
 */
const LEGACY_DESCRIPTION_PREFIX = 'Use #context for work that spans sessions or weeks';

export interface ContextSkillRetirement {
  retired: boolean;
  reason: 'tombstoned' | 'absent' | 'left_alone';
}

export async function retireManagedContextRow(db: Database): Promise<ContextSkillRetirement> {
  const rows = await db
    .select({ id: skills.id, displayName: skills.displayName, description: skills.description })
    .from(skills)
    .where(and(eq(skills.slug, 'context'), isNull(skills.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return { retired: false, reason: 'absent' };

  // The signature is checked here rather than in the UPDATE's WHERE clause on
  // purpose. Deciding in SQL would make the "is this ours to delete?" judgement
  // invisible to anything but a real MySQL, and this is a destructive one-shot
  // that runs unattended on every boot — it should be readable, and it should be
  // provable without a database.
  if (!isLegacySeededRow(row)) return { retired: false, reason: 'left_alone' };

  const now = nowIso();
  await db.update(skills).set({ deletedAt: now, updatedAt: now }).where(eq(skills.id, row.id));
  return { retired: true, reason: 'tombstoned' };
}

function isLegacySeededRow(row: { displayName: string | null; description: string | null }): boolean {
  if (row.displayName === LEGACY_DISPLAY_NAME) return true;
  return (row.description ?? '').startsWith(LEGACY_DESCRIPTION_PREFIX);
}
