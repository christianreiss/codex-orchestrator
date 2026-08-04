/**
 * Managed slugs shadow same-named `skills` rows: the row stays in the table but
 * hosts receive the code-derived manifest (host-skills.ts). The admin list used
 * to return the raw row, so a stale row read as live and editable while the
 * fleet ran something else. These tests pin the admin surface to what hosts get.
 */
import { describe, expect, it } from 'vitest';
import { skills as skillsTable, versions as versionsTable } from '../../../src/db/schema.js';
import { buildManagedCocoSkill, PROJECTS_ENABLED_FLAG } from '../../../src/services/managed-coco-skill.js';
import { buildManagedAfkSkill } from '../../../src/services/managed-afk-skill.js';
import { SkillsService } from '../../../src/services/skills.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

const STALE_AT = '2026-01-01T00:00:00Z';
const COCO_ENABLED_AT = '2026-03-03T00:00:00Z';

// `updated_at` is a constant stand-in for a row timestamp; only sha256 matters.
const afk = buildManagedAfkSkill('2026-07-27T00:00:00Z');
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
    const { service } = makeService([staleRow('afk', 1)]);

    const listed = await service.list({ includeDeleted: true });
    expect(listed.map((s) => s.slug)).toEqual(['afk', 'conference', 'skill-manager']);
    expect(listed.find((skill) => skill.slug === 'afk')).toMatchObject({
      id: null,
      slug: 'afk',
      sha256: afk.sha256,
      manifest: afk.manifest,
      display_name: afk.display_name,
      description: afk.description,
      uri: 'skill://afk',
      canonical_uri: 'skill://afk',
      engine: null,
      deleted_at: null,
      managed: true,
    });
    expect(listed.find((skill) => skill.slug === 'afk')?.sha256).not.toBe('a'.repeat(64));
    expect(listed.find((skill) => skill.slug === 'afk')?.updated_at).not.toBe(STALE_AT);
  });

  it('find resolves a managed slug to the code-derived manifest, not the row', async () => {
    const { service } = makeService([staleRow('afk', 1)]);

    await expect(service.find('afk')).resolves.toMatchObject({
      id: null,
      sha256: afk.sha256,
      manifest: afk.manifest,
      managed: true,
    });
    await expect(service.requireBySlug('afk')).resolves.toMatchObject({ managed: true });
  });

  it('lists a managed skill that has no row at all', async () => {
    const { service } = makeService();

    const listed = await service.list();

    expect(listed.map((skill) => skill.slug)).toEqual(['afk', 'conference', 'skill-manager']);
    expect(listed.find((skill) => skill.slug === 'afk')).toMatchObject({ slug: 'afk', sha256: afk.sha256, managed: true });
  });

  it('leaves a non-managed row untouched and ordered alongside the managed ones', async () => {
    const { service } = makeService([staleRow('afk', 1), staleRow('agentic', 2)]);

    const listed = await service.list();

    expect(listed.map((s) => s.slug)).toEqual(['afk', 'agentic', 'conference', 'skill-manager']);
    expect(listed.find((skill) => skill.slug === 'agentic')).toMatchObject({
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

    await expect(service.list()).resolves.toMatchObject([
      { slug: 'afk' },
      { slug: 'agentic' },
      { slug: 'conference' },
      { slug: 'skill-manager' },
    ]);
    const all = await service.list({ includeDeleted: true });
    expect(all.map((s) => s.slug)).toEqual(['afk', 'agentic', 'conference', 'retired', 'skill-manager']);
    expect(all[3]).toMatchObject({ slug: 'retired', deleted_at: '2026-02-02T00:00:00Z', managed: false });
  });

  // The retirement hazard, pinned. `context` is still code-owned (so the admin
  // store/delete paths keep refusing it) but is no longer served, and shadowing
  // is computed from the served list. A live row at that slug is therefore what
  // hosts would get -- which is why retire-context-skill.ts tombstones it in the
  // same release. If this ever starts returning the row's manifest to the fleet,
  // the boot hook did not run.
  it('no longer serves context, but keeps the slug code-owned', async () => {
    const { service } = makeService([staleRow('context', 1)]);

    const listed = await service.list();
    expect(listed.map((s) => s.slug)).toEqual(['afk', 'conference', 'context', 'skill-manager']);

    const row = listed.find((skill) => skill.slug === 'context');
    // Served from the row, not from code: nothing generates a context manifest now.
    expect(row).toMatchObject({ id: 1, sha256: 'a'.repeat(64), managed: true });
  });

  it('shadows coco only while the Projects module is on', async () => {
    const withModule = makeService([staleRow('coco', 1)], true);
    const listedOn = await withModule.service.list();
    expect(listedOn.map((s) => s.slug)).toEqual(['afk', 'coco', 'conference', 'skill-manager']);
    expect(listedOn.find((skill) => skill.slug === 'coco')).toMatchObject({ id: null, sha256: coco.sha256, manifest: coco.manifest, managed: true });

    // With the module off no coco manifest is served, so the row is what hosts
    // get -- but the slug is still code-owned, so it stays flagged as managed.
    const withoutModule = makeService([staleRow('coco', 1)]);
    const listedOff = await withoutModule.service.list();
    expect(listedOff.map((s) => s.slug)).toEqual(['afk', 'coco', 'conference', 'skill-manager']);
    expect(listedOff.find((skill) => skill.slug === 'coco')).toMatchObject({ id: 1, sha256: 'a'.repeat(64), managed: true });
  });
});
