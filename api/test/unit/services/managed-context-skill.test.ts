/**
 * `#context` is RETIRED. This file used to assert that it was served; it now
 * asserts that it is not, and that retiring it did not open the hole it left.
 *
 * The doctrine it carried — add, update, delete — moved into the always-on
 * managed AGENTS.md/CLAUDE.md block (managed-agents-memory.test.ts covers the
 * text) because a skill only loads when invoked, and this one was invoked once in
 * 9354 sessions, to test itself. Its project bootstrap and substrate-routing
 * halves moved to `#coco` (managed-coco-skill.test.ts).
 *
 * The dangerous part of retirement is not the removal, it is the shadowing:
 * host-skills.ts hides a `skills` row when the slug is in the *served* managed
 * list, so dropping `context` from that list un-hides any surviving row and
 * starts serving the superseded hand-seeded manifest to the whole fleet. Crane
 * had exactly such a row (id 22, deleted_at NULL). Hence the tombstone below.
 */
import { describe, it, expect } from 'vitest';
import { skills as skillsTable, versions as versionsTable } from '../../../src/db/schema.js';
import { retireManagedContextRow } from '../../../src/ops/retire-context-skill.js';
import { findManagedSkill, isManagedSkillSlug, listManagedSkills } from '../../../src/services/managed-skills.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

const LEGACY_ROW = {
  id: 22,
  slug: 'context',
  sha256: 'b'.repeat(64),
  displayName: 'Durable task context',
  description: 'Use #context for work that spans sessions or weeks: bootstrap from durable project memory before acting.',
  manifest: '---\nname: context\n---\n\nlegacy body',
  createdAt: '2026-07-19T14:03:58Z',
  updatedAt: '2026-07-19T14:03:58Z',
  deletedAt: null as string | null,
};

function makeDb(rows: Array<Record<string, unknown>> = []): DbFake {
  const db = createDbFake();
  db.tables.set(versionsTable, []);
  db.tables.set(skillsTable, rows);
  return db;
}

describe('retired #context skill', () => {
  it('is no longer served', async () => {
    const listed = await listManagedSkills(makeDb() as never);
    expect(listed.map((s) => s.slug)).not.toContain('context');
    await expect(findManagedSkill(makeDb() as never, 'context')).resolves.toBeNull();
  });

  // Un-reserving the slug is Release B, and only once the fleet has converged.
  // While it stays reserved the admin store/delete paths keep refusing it, so
  // nobody can hand-create a replacement inside the window.
  it('keeps its slug code-owned so the admin paths still refuse it', () => {
    expect(isManagedSkillSlug('context')).toBe(true);
    expect(isManagedSkillSlug('CONTEXT')).toBe(true);
  });
});

describe('legacy #context row retirement', () => {
  it('tombstones the seeded row so it cannot un-shadow', async () => {
    await expect(retireManagedContextRow(makeDb([{ ...LEGACY_ROW }]) as never)).resolves.toMatchObject({
      retired: true,
      reason: 'tombstoned',
    });
  });

  it('is a no-op when there is no row', async () => {
    await expect(retireManagedContextRow(makeDb() as never)).resolves.toMatchObject({
      retired: false,
      reason: 'absent',
    });
  });

  it('is idempotent — an already-tombstoned row is not matched again', async () => {
    const db = makeDb([{ ...LEGACY_ROW, deletedAt: '2026-07-31T00:00:00Z' }]);
    await expect(retireManagedContextRow(db as never)).resolves.toMatchObject({
      retired: false,
      reason: 'absent',
    });
  });

  // Signature-matched, not `WHERE slug='context'`. If an operator deliberately
  // authors a new skill at this slug it is theirs, and deleting it would be us
  // reaching into their data to tidy up after ourselves.
  it('leaves an operator-authored replacement alone', async () => {
    const db = makeDb([{
      ...LEGACY_ROW,
      displayName: 'Our own context playbook',
      description: 'Team-authored replacement, nothing to do with the retired managed skill.',
    }]);

    await expect(retireManagedContextRow(db as never)).resolves.toMatchObject({
      retired: false,
      reason: 'left_alone',
    });
  });
});
