/**
 * SkillsService is the admin-facing upsert path, and every interesting branch
 * in it is silent: an unchanged store returns without touching `updated_at`, an
 * omitted description keeps whatever is stored while an explicit null clears
 * it, and an update resurrects a soft-deleted row. The fake db is enough here
 * because the service reads and writes one table.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { skills as skillsTable } from '../../../src/db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/http/errors.js';
import { SkillsService } from '../../../src/services/skills.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

const SEEDED_AT = '2026-01-01T00:00:00Z';
const BODY = 'Skill body';

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function skillRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const manifest = String(overrides.manifest ?? BODY);
  return {
    id: 1,
    slug: 'agentic',
    sha256: sha(manifest),
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
    engine: null,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    deletedAt: null,
    ...overrides,
  };
}

function makeService(rows: Record<string, unknown>[] = []): {
  service: SkillsService;
  db: DbFake;
  rows: Record<string, unknown>[];
} {
  const db = createDbFake();
  db.tables.set(skillsTable, rows);
  return { service: new SkillsService(db as never), db, rows };
}

async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (error: unknown) => error,
  );
}

async function expectValidationParam(call: Promise<unknown>, param: string): Promise<void> {
  const error = await rejectionOf(call);
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).param).toBe(param);
}

async function expectManagedConflict(call: Promise<unknown>): Promise<void> {
  const error = await rejectionOf(call);
  expect(error).toBeInstanceOf(ConflictError);
  expect((error as ConflictError).code).toBe('managed_skill');
}

describe('SkillsService.store validation', () => {
  it('refuses to store over a code-managed slug', async () => {
    const { service, db } = makeService();

    await expectManagedConflict(service.store({ slug: 'coco', manifest: BODY }));
    await expectManagedConflict(service.store({ slug: 'context', manifest: BODY }));
    await expectManagedConflict(service.store({ slug: 'skill-manager', manifest: BODY }));
    expect(db.inserts).toEqual([]);
  });

  it('refuses to store over a source-owned row', async () => {
    const { service, db } = makeService([
      skillRow({
        sourceType: 'github',
        sourceRepository: 'mattpocock/skills',
        sourcePath: 'skills/agentic/SKILL.md',
      }),
    ]);

    await expectManagedConflict(service.store({ slug: 'agentic', manifest: 'replacement' }));
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it('rechecks source ownership under a row-or-gap lock before storing', async () => {
    const { service, db } = makeService();
    const originalTransaction = db.transaction.bind(db);
    let injected = false;
    db.transaction = async (callback, config) => {
      if (!injected) {
        injected = true;
        db.tables.set(skillsTable, [skillRow({
          id: 9,
          slug: 'arrived-during-store',
          sourceType: 'github',
        })]);
      }
      return originalTransaction(callback, config);
    };

    await expectManagedConflict(service.store({
      slug: 'arrived-during-store',
      manifest: 'replacement',
    }));
    expect(db.transactions).toContainEqual({ isolationLevel: 'repeatable read' });
    expect(db.locks.some((lock) => lock.table === skillsTable && lock.strength === 'update')).toBe(true);
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('requires a non-blank manifest under either key', async () => {
    const { service } = makeService();

    await expectValidationParam(service.store({ slug: 'agentic' }), 'manifest');
    await expectValidationParam(service.store({ slug: 'agentic', manifest: '   ' }), 'manifest');
    await expectValidationParam(service.store({ slug: 'agentic', content: '' }), 'manifest');
    // A non-string manifest falls through to `content`, which is absent here.
    await expectValidationParam(service.store({ slug: 'agentic', manifest: 42 }), 'manifest');
  });

  it('accepts `content` as an alias when `manifest` is absent', async () => {
    const { service } = makeService();

    const result = await service.store({ slug: 'agentic', content: BODY });

    expect(result).toMatchObject({ status: 'created', sha256: sha(BODY) });
  });

  it('rejects a malformed sha256 and one that does not match the manifest', async () => {
    const { service, db } = makeService();

    await expectValidationParam(
      service.store({ slug: 'agentic', manifest: BODY, sha256: 'not-a-digest' }),
      'sha256',
    );
    await expectValidationParam(
      service.store({ slug: 'agentic', manifest: BODY, sha256: sha('other body') }),
      'sha256',
    );
    expect(db.inserts).toEqual([]);
  });

  it('accepts a matching sha256 regardless of case, and ignores a blank one', async () => {
    const { service } = makeService();

    await expect(
      service.store({ slug: 'agentic', manifest: BODY, sha256: sha(BODY).toUpperCase() }),
    ).resolves.toMatchObject({ status: 'created', sha256: sha(BODY) });
    await expect(
      service.store({ slug: 'other', manifest: BODY, sha256: '  ' }),
    ).resolves.toMatchObject({ status: 'created' });
  });
});

describe('SkillsService.store upsert', () => {
  it('inserts a fresh slug as created', async () => {
    const { service, db, rows } = makeService();

    const result = await service.store({ slug: 'agentic', manifest: BODY, display_name: ' Agentic ', engine: ' codex ' }, 7);

    expect(result).toMatchObject({
      status: 'created',
      slug: 'agentic',
      uri: 'skill://agentic',
      canonical_uri: 'skill://agentic',
      sha256: sha(BODY),
      managed: false,
    });
    expect(db.inserts).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: 'agentic',
      sha256: sha(BODY),
      displayName: 'Agentic',
      description: null,
      manifest: BODY,
      sourceHostId: 7,
      engine: 'codex',
      createdAt: result.updated_at,
      updatedAt: result.updated_at,
    });
  });

  it('returns unchanged with the prior updated_at when nothing differs', async () => {
    const { service, db, rows } = makeService([skillRow()]);

    const result = await service.store({
      slug: 'agentic',
      manifest: BODY,
      display_name: 'Agentic',
      description: 'Agentic skill',
    });

    expect(result).toMatchObject({
      status: 'unchanged',
      sha256: sha(BODY),
      updated_at: SEEDED_AT,
    });
    expect(db.updates).toEqual([]);
    expect(rows[0]).toMatchObject({ updatedAt: SEEDED_AT });
  });

  it('reports updated for a metadata-only change', async () => {
    const { service, rows } = makeService([skillRow()]);

    const result = await service.store({
      slug: 'agentic',
      manifest: BODY,
      display_name: 'Agentic Toolkit',
      description: 'Agentic skill',
    });

    expect(result).toMatchObject({ status: 'updated', sha256: sha(BODY) });
    expect(result.updated_at).not.toBe(SEEDED_AT);
    expect(rows[0]).toMatchObject({
      displayName: 'Agentic Toolkit',
      sha256: sha(BODY),
      updatedAt: result.updated_at,
    });
  });

  it('keeps the stored description when it is omitted and clears it on an explicit null', async () => {
    const { service, rows } = makeService([skillRow()]);

    await service.store({ slug: 'agentic', manifest: 'Revised body', display_name: 'Agentic' });
    expect(rows[0]).toMatchObject({ description: 'Agentic skill' });

    // A non-string, non-null value is treated the same as an omission.
    await service.store({ slug: 'agentic', manifest: BODY, display_name: 'Agentic', description: 5 });
    expect(rows[0]).toMatchObject({ description: 'Agentic skill' });

    await service.store({ slug: 'agentic', manifest: BODY, display_name: 'Agentic', description: null });
    expect(rows[0]).toMatchObject({ description: null });
  });

  it('resurrects a soft-deleted slug on update but not on an unchanged store', async () => {
    const { service, rows } = makeService([skillRow({ deletedAt: '2026-02-02T00:00:00Z' })]);

    await expect(
      service.store({ slug: 'agentic', manifest: BODY, display_name: 'Agentic', description: 'Agentic skill' }),
    ).resolves.toMatchObject({ status: 'unchanged' });
    expect(rows[0]).toMatchObject({ deletedAt: '2026-02-02T00:00:00Z' });

    await expect(
      service.store({ slug: 'agentic', manifest: 'Revised body', display_name: 'Agentic' }),
    ).resolves.toMatchObject({ status: 'updated' });
    expect(rows[0]).toMatchObject({ deletedAt: null, manifest: 'Revised body', sha256: sha('Revised body') });
  });
});

describe('SkillsService.softDelete', () => {
  it('returns false for an unknown slug and for one already soft-deleted', async () => {
    const { service, db } = makeService([skillRow({ deletedAt: '2026-02-02T00:00:00Z' })]);

    await expect(service.softDelete('missing')).resolves.toBe(false);
    await expect(service.softDelete('agentic')).resolves.toBe(false);
    expect(db.updates).toEqual([]);
  });

  it('stamps deleted_at on a live row', async () => {
    const { service, rows } = makeService([skillRow()]);

    await expect(service.softDelete('agentic')).resolves.toBe(true);
    expect(rows[0]?.deletedAt).toEqual(rows[0]?.updatedAt);
    expect(rows[0]?.deletedAt).not.toBe(SEEDED_AT);
  });

  it('refuses managed and reserved coordination slugs', async () => {
    const { service, db } = makeService([
      skillRow({ id: 1, slug: 'codex-project-coordination' }),
      skillRow({ id: 2, slug: 'claude-project-coordination' }),
    ]);

    await expectManagedConflict(service.softDelete('coco'));
    await expectManagedConflict(service.softDelete('context'));
    await expectManagedConflict(service.softDelete('skill-manager'));
    await expectManagedConflict(service.softDelete('codex-project-coordination'));
    await expectManagedConflict(service.softDelete('claude-project-coordination'));
    expect(db.updates).toEqual([]);
  });

  it('refuses to delete a source-owned row, including an already retired one', async () => {
    const live = makeService([skillRow({ sourceType: 'github' })]);
    await expectManagedConflict(live.service.softDelete('agentic'));
    expect(live.db.updates).toEqual([]);

    const retired = makeService([
      skillRow({ sourceType: 'github', deletedAt: '2026-02-02T00:00:00Z' }),
    ]);
    await expectManagedConflict(retired.service.softDelete('agentic'));
    expect(retired.db.updates).toEqual([]);
  });

  it('rechecks source ownership under the row lock before deleting', async () => {
    const row = skillRow();
    const { service, db } = makeService([row]);
    const originalTransaction = db.transaction.bind(db);
    let injected = false;
    db.transaction = async (callback, config) => {
      if (!injected) {
        injected = true;
        row.sourceType = 'github';
      }
      return originalTransaction(callback, config);
    };

    await expectManagedConflict(service.softDelete('agentic'));
    expect(db.transactions).toContainEqual({ isolationLevel: 'repeatable read' });
    expect(db.locks.some((lock) => lock.table === skillsTable && lock.strength === 'update')).toBe(true);
    expect(db.updates).toEqual([]);
  });

  it('leaves other codex-/claude-prefixed slugs deletable', async () => {
    const { service } = makeService([skillRow({ slug: 'codex-review' })]);

    await expect(service.softDelete('codex-review')).resolves.toBe(true);
  });
});

describe('SkillsService reads', () => {
  it('requireBySlug returns the view and throws skill_not_found otherwise', async () => {
    const { service } = makeService([skillRow()]);

    await expect(service.requireBySlug('agentic')).resolves.toMatchObject({
      slug: 'agentic',
      uri: 'skill://agentic',
      canonical_uri: 'skill://agentic',
      display_name: 'Agentic',
      manifest: BODY,
      deleted_at: null,
    });

    const error = await rejectionOf(service.requireBySlug('missing'));
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).code).toBe('skill_not_found');
    await expect(service.find('missing')).resolves.toBeNull();
  });

  it('list hides soft-deleted rows unless includeDeleted is set', async () => {
    const { service } = makeService([
      skillRow({ id: 1, slug: 'agentic' }),
      skillRow({ id: 2, slug: 'retired', deletedAt: '2026-02-02T00:00:00Z' }),
    ]);

    // `afk` and `skill-manager` are code-derived and always served. `context`
    // used to be too; it is retired, so it appears only if a row survives.
    const live = await service.list();
    expect(live.map((s) => s.slug)).toEqual(['afk', 'agentic', 'skill-manager']);
    const all = await service.list({ includeDeleted: true });
    expect(all.map((s) => s.slug)).toEqual(['afk', 'agentic', 'retired', 'skill-manager']);
  });

  it('exposes provenance and marks a source-owned row read-only', async () => {
    const bundleSha = 'b'.repeat(64);
    const { service } = makeService([
      skillRow({
        sourceType: 'github',
        sourceRepository: 'mattpocock/skills',
        sourcePath: 'skills/agentic/SKILL.md',
        sourceRevision: 'a'.repeat(40),
        sourceLicense: 'MIT',
        bundleSha256: bundleSha,
      }),
    ]);

    await expect(service.find('agentic')).resolves.toMatchObject({
      slug: 'agentic',
      sha256: sha(BODY),
      bundle_sha256: bundleSha,
      source_type: 'github',
      source_repository: 'mattpocock/skills',
      source_path: 'skills/agentic/SKILL.md',
      source_revision: 'a'.repeat(40),
      source_license: 'MIT',
      managed: true,
      allow_implicit_invocation: true,
    });
  });

  it('exposes explicit-only invocation policy from manifest frontmatter', async () => {
    const manifest = '---\nname: explicit\ndisable-model-invocation: true\n---\n\nBody\n';
    const { service } = makeService([
      skillRow({ slug: 'explicit', manifest, sourceType: 'github' }),
    ]);

    await expect(service.find('explicit')).resolves.toMatchObject({
      allow_implicit_invocation: false,
      managed: true,
    });
  });
});
