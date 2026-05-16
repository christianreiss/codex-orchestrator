import { eq } from 'drizzle-orm';
import { skills, type Skill } from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface MakeSkillOverrides {
  slug?: string;
  displayName?: string;
  description?: string;
  manifest?: string;
  engine?: 'codex' | 'claude';
  sourceHostId?: number;
}

export async function makeSkill(
  db: TestDb,
  overrides: MakeSkillOverrides = {},
): Promise<Skill> {
  const slug = overrides.slug ?? `skill-${Math.random().toString(36).slice(2, 8)}`;
  const manifest = overrides.manifest ?? JSON.stringify({ name: slug, version: 1 });
  const now = nowIso();

  await db.insert(skills).values({
    slug,
    sha256: sha256(manifest),
    displayName: overrides.displayName ?? slug,
    description: overrides.description ?? null,
    manifest,
    sourceHostId: overrides.sourceHostId ?? null,
    createdAt: now,
    updatedAt: now,
    engine: overrides.engine ?? null,
  });
  const [row] = await db.select().from(skills).where(eq(skills.slug, slug)).limit(1);
  if (!row) throw new Error('makeSkill: row not found after insert');
  return row;
}
