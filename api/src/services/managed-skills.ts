/**
 * Registry of skills derived from code rather than stored as `skills` rows.
 *
 * A managed skill ships with the API image: its manifest is a constant, its
 * sha256 changes when the text does, and the fleet picks up a change on the next
 * sync with no admin action. That is the point — a skill that lives only in the
 * database drifts from the repo and needs a manual store to ship, which is how
 * `#context` ended up with two disagreeing versions and no way to tell which one
 * hosts were running.
 *
 * Managed slugs SHADOW any same-named `skills` row (the row is skipped, not
 * deleted, so an existing deployment needs no migration) and are rejected by the
 * admin store/delete paths.
 */
import type { Database } from '../db/client.js';
import { getManagedCocoSkillIfEnabled, isManagedCocoSlug } from './managed-coco-skill.js';
import { buildManagedContextSkill, isManagedContextSlug, type ManagedSkillManifest } from './managed-context-skill.js';

export type { ManagedSkillManifest };

/**
 * Stable stand-in for a row timestamp. Managed skills have no row, and a moving
 * value would make every sync look like a change; clients compare `sha256`.
 */
const MANAGED_UPDATED_AT = '2026-07-27T00:00:00Z';

/** True for any slug owned by code, whether or not it is currently served. */
export function isManagedSkillSlug(slug: string): boolean {
  return isManagedCocoSlug(slug) || isManagedContextSlug(slug);
}

/**
 * Every managed skill currently served. `coco` is gated on the Projects module;
 * `context` is unconditional because the memory tools it documents always exist.
 */
export async function listManagedSkills(db: Database): Promise<ManagedSkillManifest[]> {
  const out: ManagedSkillManifest[] = [];
  const coco = await getManagedCocoSkillIfEnabled(db);
  if (coco) out.push(coco as unknown as ManagedSkillManifest);
  out.push(buildManagedContextSkill(MANAGED_UPDATED_AT));
  out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return out;
}

/** The managed skill for `slug`, or null when the slug is not managed (or not served). */
export async function findManagedSkill(db: Database, slug: string): Promise<ManagedSkillManifest | null> {
  const normalized = slug.trim().toLowerCase();
  if (!isManagedSkillSlug(normalized)) return null;
  const all = await listManagedSkills(db);
  return all.find((s) => s.slug === normalized) ?? null;
}
