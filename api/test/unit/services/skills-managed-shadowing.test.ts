/**
 * Managed slugs shadow same-named `skills` rows: the row stays in the table but
 * hosts receive the code-derived manifest (host-skills.ts). The admin list used
 * to return the raw row, so a stale row read as live and editable while the
 * fleet ran something else. These tests pin the admin surface to what hosts get.
 */
import { describe, expect, it } from 'vitest';
import { skills as skillsTable, versions as versionsTable } from '../../../src/db/schema.js';
import { buildManagedCocoSkill, PROJECTS_ENABLED_FLAG } from '../../../src/services/managed-coco-skill.js';
import { buildManagedContextSkill } from '../../../src/services/managed-context-skill.js';
import { SkillsService } from '../../../src/services/skills.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

const STALE_AT = '2026-01-01T00:00:00Z';
const COCO_ENABLED_AT = '2026-03-03T00:00:00Z';

// `updated_at` is a constant stand-in for a row timestamp; only sha256 matters.
const context = buildManagedContextSkill('2026-07-27T00:00:00Z');
const coco = buildManagedCocoSkill(COCO_ENABLED_AT);

function staleRow(slug: string, id: number): Record<string, unknown> {
  return {
    id,
    slug,
    sha256: 'a'.repeat(64),
    displayName: 'Stale Context',
    description: 'The version somebody stored by hand',
    manifest: '# stale body',
    sourceHostId: 3,
    engine: 'codex',
    createdAt: STALE_AT,
    updatedAt: STALE_AT,
    deletedAt: null,
  };
}

function makeService(rows: Record<string, unknown>[] = [], projectsEnabled = false): {
  service: SkillsService;
  db: DbFake;
} {
  const db = createDbFake();
  db.tables.set(skillsTable, rows);
  if (projectsEnabled) {
    db.tables.set(versionsTable, [
      { id: 1, name: PROJECTS_ENABLED_FLAG, version: '1', updatedAt: COCO_ENABLED_AT },
    ]);
  }
  return { service: new SkillsService(db as never), db };
}

describe('SkillsService managed shadowing', () => {
  it('serves the code-derived manifest for a slug with a stale row', async () => {
    const { service } = makeService([staleRow('context', 1)]);

    const listed = await service.list({ includeDeleted: true });
    expect(listed.map((s) => s.slug)).toEqual(['context']);
    expect(listed[0]).toMatchObject({
      id: null,
      slug: 'context',
      sha256: context.sha256,
      manifest: context.manifest,
      display_name: context.display_name,
      description: context.description,
      uri: 'skill://context',
      canonical_uri: 'skill://context',
      engine: null,
      deleted_at: null,
      managed: true,
    });
    expect(listed[0]?.sha256).not.toBe('a'.repeat(64));
    expect(listed[0]?.updated_at).not.toBe(STALE_AT);
  });

  it('find resolves a managed slug to the code-derived manifest, not the row', async () => {
    const { service } = makeService([staleRow('context', 1)]);

    await expect(service.find('context')).resolves.toMatchObject({
      id: null,
      sha256: context.sha256,
      manifest: context.manifest,
      managed: true,
    });
    await expect(service.requireBySlug('context')).resolves.toMatchObject({ managed: true });
  });

  it('lists a managed skill that has no row at all', async () => {
    const { service } = makeService();

    const listed = await service.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ slug: 'context', sha256: context.sha256, managed: true });
  });

  it('leaves a non-managed row untouched and ordered alongside the managed ones', async () => {
    const { service } = makeService([staleRow('context', 1), staleRow('agentic', 2)]);

    const listed = await service.list();

    expect(listed.map((s) => s.slug)).toEqual(['agentic', 'context']);
    expect(listed[0]).toMatchObject({
      id: 2,
      slug: 'agentic',
      sha256: 'a'.repeat(64),
      manifest: '# stale body',
      display_name: 'Stale Context',
      source_host_id: 3,
      engine: 'codex',
      updated_at: STALE_AT,
      managed: false,
    });
    await expect(service.find('agentic')).resolves.toMatchObject({ id: 2, managed: false });
  });

  it('keeps soft-deleted ordinary rows out of list() but returns them under includeDeleted', async () => {
    const { service } = makeService([
      staleRow('agentic', 1),
      { ...staleRow('retired', 2), deletedAt: '2026-02-02T00:00:00Z' },
    ]);

    await expect(service.list()).resolves.toMatchObject([{ slug: 'agentic' }, { slug: 'context' }]);
    const all = await service.list({ includeDeleted: true });
    expect(all.map((s) => s.slug)).toEqual(['agentic', 'context', 'retired']);
    expect(all[2]).toMatchObject({ slug: 'retired', deleted_at: '2026-02-02T00:00:00Z', managed: false });
  });

  it('shadows coco only while the Projects module is on', async () => {
    const withModule = makeService([staleRow('coco', 1)], true);
    const listedOn = await withModule.service.list();
    expect(listedOn.map((s) => s.slug)).toEqual(['coco', 'context']);
    expect(listedOn[0]).toMatchObject({ id: null, sha256: coco.sha256, manifest: coco.manifest, managed: true });

    // With the module off no coco manifest is served, so the row is what hosts
    // get -- but the slug is still code-owned, so it stays flagged as managed.
    const withoutModule = makeService([staleRow('coco', 1)]);
    const listedOff = await withoutModule.service.list();
    expect(listedOff.map((s) => s.slug)).toEqual(['coco', 'context']);
    expect(listedOff[0]).toMatchObject({ id: 1, sha256: 'a'.repeat(64), managed: true });
  });
});
