import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { skills as skillsTable, versions as versionsTable } from '../../../src/db/schema.js';
import { HostSkillsService } from '../../../src/services/host-skills.js';
import { MANAGED_COCO_SKILL_SLUG, PROJECTS_ENABLED_FLAG } from '../../../src/services/managed-coco-skill.js';
import { createDbShim } from '../../helpers/db-shim.js';
import type { Host } from '../../../src/db/schema.js';

const host: Host = { id: 1, fqdn: 'host.example' } as unknown as Host;

function skillRow(overrides: Record<string, unknown>): Record<string, unknown> {
  const manifest = String(overrides.manifest ?? 'Skill body');
  return {
    id: 1,
    slug: 'agentic',
    sha256: createHash('sha256').update(manifest).digest('hex'),
    displayName: 'Agentic',
    description: 'Agentic skill',
    manifest,
    sourceHostId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    engine: null,
    ...overrides,
  };
}

function makeService(projectsEnabled: boolean, rows: Record<string, unknown>[] = []): HostSkillsService {
  const db = createDbShim();
  db.tables.set(versionsTable, projectsEnabled
    ? [{ name: PROJECTS_ENABLED_FLAG, version: '1', updatedAt: '2026-06-03T08:00:00Z' }]
    : [{ name: PROJECTS_ENABLED_FLAG, version: '0', updatedAt: '2026-06-03T08:00:00Z' }]);
  db.tables.set(skillsTable, rows);
  return new HostSkillsService(db as never);
}

describe('HostSkillsService managed CoCo skill', () => {
  it('lists managed coco when Projects is enabled and hides stale stored coco rows', async () => {
    const service = makeService(true, [
      skillRow({ id: 1, slug: 'agentic' }),
      skillRow({ id: 2, slug: MANAGED_COCO_SKILL_SLUG, displayName: 'Stale CoCo Toolkit' }),
    ]);

    const out = await service.listSkills(host, 'codex');
    const coco = out.skills.filter((s) => s['slug'] === MANAGED_COCO_SKILL_SLUG);

    expect(coco).toHaveLength(1);
    expect(coco[0]).toMatchObject({
      slug: MANAGED_COCO_SKILL_SLUG,
      managed: true,
      uri: 'skill://coco',
      canonical_uri: 'skill://coco',
    });
  });

  it('retrieves managed coco over the skill surface with cache sha support', async () => {
    const service = makeService(true);

    const first = await service.retrieve(MANAGED_COCO_SKILL_SLUG, null, host);
    expect(first).toMatchObject({
      status: 'updated',
      slug: MANAGED_COCO_SKILL_SLUG,
      managed: true,
      uri: 'skill://coco',
    });
    expect(String(first['manifest'])).toContain('project_bootstrap');
    expect(String(first['manifest'])).toContain('Do not use memory://');

    const unchanged = await service.retrieve(MANAGED_COCO_SKILL_SLUG, String(first['sha256']), host);
    expect(unchanged).toMatchObject({ status: 'unchanged', managed: true });
    expect(unchanged).not.toHaveProperty('manifest');
  });

  it('returns missing for coco when Projects is disabled and no stored row exists', async () => {
    const service = makeService(false);

    await expect(service.retrieve(MANAGED_COCO_SKILL_SLUG, null, host)).resolves.toMatchObject({
      status: 'missing',
      slug: MANAGED_COCO_SKILL_SLUG,
    });
  });

  it('rejects host-side attempts to overwrite managed coco while Projects is enabled', async () => {
    const service = makeService(true);

    await expect(
      service.store({ slug: MANAGED_COCO_SKILL_SLUG, manifest: 'replacement' }, host),
    ).rejects.toMatchObject({ code: 'managed_skill' });
  });

  it('emits managed coco as an on-disk SKILL.md in the claude bundle (name = slug)', async () => {
    const service = makeService(true, [skillRow({ id: 1, slug: 'agentic' })]);
    const out = await service.bundle(host, 'claude', {});
    const coco = out.find((s) => s.slug === MANAGED_COCO_SKILL_SLUG);
    expect(coco).toBeDefined();
    expect(coco?.status).toBe('updated');
    expect(coco?.content).toContain('name: coco');
    expect(coco?.content).toContain('CoCo Project Coordination');
    // If-None-Match: re-bundling with the rendered sha omits content.
    const again = await service.bundle(host, 'claude', { [MANAGED_COCO_SKILL_SLUG]: coco!.sha256 });
    expect(again.find((s) => s.slug === MANAGED_COCO_SKILL_SLUG)?.status).toBe('unchanged');
  });

  it('omits managed coco from the bundle when Projects is disabled', async () => {
    const service = makeService(false, [skillRow({ id: 1, slug: 'agentic' })]);
    const out = await service.bundle(host, 'claude', {});
    expect(out.find((s) => s.slug === MANAGED_COCO_SKILL_SLUG)).toBeUndefined();
  });
});
