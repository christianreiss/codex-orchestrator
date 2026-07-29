import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { skillFiles as skillFilesTable, skills as skillsTable, versions as versionsTable } from '../../../src/db/schema.js';
import { HostSkillsService } from '../../../src/services/host-skills.js';
import { MANAGED_COCO_SKILL_SLUG, PROJECTS_ENABLED_FLAG } from '../../../src/services/managed-coco-skill.js';
import { computeSkillBundleDigest } from '../../../src/services/skill-provenance.js';
import { createDbFake } from '../../helpers/db-fake.js';
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
    sourceType: null,
    sourceRepository: null,
    sourcePath: null,
    sourceRevision: null,
    sourceLicense: null,
    bundleSha256: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    engine: null,
    ...overrides,
  };
}

function makeService(
  projectsEnabled: boolean,
  rows: Record<string, unknown>[] = [],
  files: Record<string, unknown>[] = [],
): HostSkillsService {
  return new HostSkillsService(makeDb(projectsEnabled, rows, files) as never);
}

function makeDb(
  projectsEnabled: boolean,
  rows: Record<string, unknown>[] = [],
  files: Record<string, unknown>[] = [],
) {
  const db = createDbFake();
  db.tables.set(versionsTable, projectsEnabled
    ? [{ name: PROJECTS_ENABLED_FLAG, version: '1', updatedAt: '2026-06-03T08:00:00Z' }]
    : [{ name: PROJECTS_ENABLED_FLAG, version: '0', updatedAt: '2026-06-03T08:00:00Z' }]);
  db.tables.set(skillsTable, rows);
  db.tables.set(skillFilesTable, files);
  return db;
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
    // The manifest must keep steering agents away from host-scoped memory and
    // must name all three substrates now that a fleet-wide one exists.
    expect(String(first['manifest'])).toContain('Never valid for cross-host handoffs');
    expect(String(first['manifest'])).toContain('shared_memory_list');
    expect(String(first['manifest'])).toContain('project_memory_*');

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

describe('HostSkillsService source-owned skills', () => {
  const revision = 'a'.repeat(40);
  const sourceBase = {
    sourceType: 'github',
    sourceRepository: 'mattpocock/skills',
    sourcePath: 'skills/agentic/SKILL.md',
    sourceRevision: revision,
    sourceLicense: 'MIT',
  };

  function sourceFor(manifest: string, files: Array<{ path: string; sha256: string }> = []) {
    const manifestSha = createHash('sha256').update(manifest).digest('hex');
    return {
      ...sourceBase,
      bundleSha256: computeSkillBundleDigest([{ path: 'SKILL.md', sha256: manifestSha }, ...files]),
    };
  }

  it('uses the bundle digest and complete support files in list, retrieve, and Claude bundle responses', async () => {
    const manifest = '---\nname: agentic\ndescription: Agentic\n---\n\nBody\n';
    const supportContent = '# Guide';
    const supportSha = createHash('sha256').update(supportContent).digest('hex');
    const source = sourceFor(manifest, [{ path: 'references/guide.md', sha256: supportSha }]);
    const bundleSha = source.bundleSha256;
    const row = skillRow({ id: 1, slug: 'agentic', manifest, ...source });
    const supportFile = {
      id: 1,
      skillId: 1,
      path: 'references/guide.md',
      sha256: supportSha,
      content: supportContent,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const service = makeService(false, [row], [supportFile]);

    const listed = await service.listSkills(host, 'codex');
    expect(listed.skills.find((item) => item['slug'] === 'agentic')).toMatchObject({
      sha256: bundleSha,
      manifest_sha256: row.sha256,
      bundle_sha256: bundleSha,
      source_type: 'github',
      source_repository: 'mattpocock/skills',
      source_path: 'skills/agentic/SKILL.md',
      source_revision: revision,
      source_license: 'MIT',
      allow_implicit_invocation: true,
      managed: true,
    });

    const unchanged = await service.retrieve('agentic', bundleSha, host);
    expect(unchanged).toMatchObject({
      status: 'unchanged',
      sha256: bundleSha,
      manifest_sha256: row.sha256,
      bundle_sha256: bundleSha,
      managed: true,
    });
    expect(unchanged).not.toHaveProperty('manifest');

    const bundled = await service.bundle(host, 'claude', {});
    expect(bundled.find((item) => item.slug === 'agentic')).toMatchObject({
      sha256: bundleSha,
      status: 'updated',
      content: expect.stringContaining('name: agentic'),
      files: [
        {
          path: 'references/guide.md',
          sha256: supportSha,
          content: supportContent,
        },
      ],
    });
    const cached = await service.bundle(host, 'claude', { agentic: bundleSha });
    expect(cached.find((item) => item.slug === 'agentic')).toEqual({
      slug: 'agentic',
      sha256: bundleSha,
      status: 'unchanged',
    });
  });

  it('rejects host-side overwrite attempts', async () => {
    const manifest = 'Skill body';
    const service = makeService(false, [skillRow({ id: 1, slug: 'agentic', manifest, ...sourceFor(manifest) })]);

    await expect(service.store({ slug: 'agentic', manifest: 'replacement' }, host)).rejects.toMatchObject({
      code: 'managed_skill',
    });
  });

  it('marks disable-model-invocation skills explicit-only', async () => {
    const manifest = '---\nname: explicit\ndisable-model-invocation: true\n---\n\nBody\n';
    const service = makeService(false, [
      skillRow({
        id: 1,
        slug: 'explicit',
        manifest,
        ...sourceFor(manifest),
      }),
    ]);

    const listed = await service.listSkills(host, 'codex');
    expect(listed.skills.find((item) => item['slug'] === 'explicit')).toMatchObject({
      allow_implicit_invocation: false,
    });
    await expect(service.retrieve('explicit', null, host)).resolves.toMatchObject({
      allow_implicit_invocation: false,
    });
  });

  it('lists and retrieves exact support files without accepting traversal paths', async () => {
    const manifest = 'Skill body';
    const supportContent = '# Guide';
    const supportSha = createHash('sha256').update(supportContent).digest('hex');
    const service = makeService(
      false,
      [skillRow({
        id: 7,
        slug: 'agentic',
        manifest,
        ...sourceFor(manifest, [{ path: 'references/guide.md', sha256: supportSha }]),
      })],
      [
        {
          id: 1,
          skillId: 7,
          path: 'references/guide.md',
          sha256: supportSha,
          content: supportContent,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    );

    await expect(service.listFiles('agentic', host)).resolves.toEqual([
      { path: 'references/guide.md', sha256: supportSha },
    ]);
    await expect(service.retrieveFile('agentic', 'references/guide.md', host)).resolves.toEqual({
      path: 'references/guide.md',
      sha256: supportSha,
      content: supportContent,
    });
    await expect(service.retrieveFile('agentic', '../secret', host)).rejects.toMatchObject({
      param: 'path',
    });
  });

  it('takes a repeatable-read consistent snapshot before bundling rows and files', async () => {
    const db = makeDb(false, [skillRow({ id: 1, slug: 'agentic' })]);
    const service = new HostSkillsService(db as never);

    await service.bundle(host, 'claude');

    expect(db.transactions).toContainEqual({
      isolationLevel: 'repeatable read',
      withConsistentSnapshot: true,
    });
  });

  it('rechecks source ownership under a row-or-gap lock before writing', async () => {
    const manifest = 'Skill body';
    const sourceRow = skillRow({
      id: 9,
      slug: 'arrived-during-store',
      manifest,
      ...sourceFor(manifest),
    });
    const db = makeDb(false);
    const originalTransaction = db.transaction.bind(db);
    let injected = false;
    db.transaction = async (callback, config) => {
      if (!injected) {
        injected = true;
        db.tables.set(skillsTable, [sourceRow]);
      }
      return originalTransaction(callback, config);
    };
    const service = new HostSkillsService(db as never);

    await expect(service.store({ slug: 'arrived-during-store', manifest: 'replacement' }, host)).rejects.toMatchObject({
      code: 'managed_skill',
    });
    expect(db.locks.some((lock) => lock.table === skillsTable && lock.strength === 'update')).toBe(true);
    expect(db.inserts.some((insert) => insert.table === skillsTable)).toBe(false);
  });

  it('fails closed when stored source content no longer matches its bundle digest', async () => {
    const manifest = '---\nname: agentic\ndescription: Agentic\n---\n\nBody\n';
    const expectedContent = '# Guide';
    const supportSha = createHash('sha256').update(expectedContent).digest('hex');
    const row = skillRow({
      id: 4,
      slug: 'agentic',
      manifest,
      ...sourceFor(manifest, [{ path: 'guide.md', sha256: supportSha }]),
    });
    const corruptFile = {
      id: 1,
      skillId: 4,
      path: 'guide.md',
      sha256: supportSha,
      content: 'tampered',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const service = makeService(false, [row], [corruptFile]);

    await expect(service.bundle(host, 'claude')).rejects.toMatchObject({ code: 'skill_bundle_invalid' });
    await expect(service.retrieve('agentic', null, host)).rejects.toMatchObject({ code: 'skill_bundle_invalid' });
    await expect(service.listFiles('agentic', host)).rejects.toMatchObject({ code: 'skill_bundle_invalid' });
  });

  it('makes cross-engine direct reads indistinguishable from a missing skill', async () => {
    const manifest = 'Skill body';
    const row = skillRow({
      id: 5,
      slug: 'claude-only',
      manifest,
      engine: 'claude',
      ...sourceFor(manifest),
    });
    const service = makeService(false, [row]);

    await expect(service.retrieve('claude-only', null, host)).resolves.toMatchObject({ status: 'missing' });
    await expect(service.listFiles('claude-only', host)).rejects.toMatchObject({ code: 'skill_not_found' });
    await expect(service.retrieveFile('claude-only', 'guide.md', host)).rejects.toMatchObject({ code: 'skill_not_found' });
    await expect(service.retrieve('claude-only', null, host, 'claude')).resolves.toMatchObject({ status: 'updated' });
    await expect(service.listFiles('claude-only', host, 'claude')).resolves.toEqual([]);
  });
});
