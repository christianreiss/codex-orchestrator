import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { claudeArtifacts, logs } from '../../../src/db/schema.js';
import { HostClaudeArtifactsService } from '../../../src/services/host-claude-artifacts.js';
import { ARTIFACT_KINDS } from '../../../src/services/claude-frontmatter.js';
import { ValidationError } from '../../../src/http/errors.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import type { Database } from '../../../src/db/client.js';
import type { Host } from '../../../src/db/schema.js';

const host = { id: 7, fqdn: 'host.example' } as unknown as Host;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const bodyReviewer = '---\nname: reviewer\ndescription: Reviews code\n---\n\nYou review.\n';
const bodyDeploy = '---\ndescription: Deploys\n---\n\nDeploy it.\n';
const bodyTerse = '---\n---\n\nBe terse.\n';

function artifactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body = String(overrides.body ?? bodyReviewer);
  return {
    id: 1,
    kind: 'subagent',
    slug: 'reviewer',
    sha256: sha(body),
    displayName: 'Reviewer',
    description: 'Reviews code',
    model: 'claude-opus-4-6',
    frontmatter: {},
    body,
    sourceHostId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    deletedAt: null,
    engine: null,
    ...overrides,
  };
}

function makeService(rows: Record<string, unknown>[] = []): { svc: HostClaudeArtifactsService; db: DbFake } {
  const db = createDbFake();
  db.tables.set(claudeArtifacts, rows);
  db.tables.set(logs, []);
  return { svc: new HostClaudeArtifactsService(db as unknown as Database), db };
}

/** The log rows the service appended, with `details` parsed back out of JSON. */
function logRows(db: DbFake): Array<{ hostId: unknown; action: string; details: Record<string, unknown> }> {
  return (db.tables.get(logs) ?? []).map((r) => ({
    hostId: r.hostId,
    action: String(r.action),
    details: JSON.parse(String(r.details)) as Record<string, unknown>,
  }));
}

describe('HostClaudeArtifactsService.list', () => {
  it('returns the host-facing field shape and logs one claude_artifact.list row', async () => {
    const { svc, db } = makeService([
      artifactRow({ id: 1, slug: 'reviewer' }),
      artifactRow({ id: 2, slug: 'zbare', body: bodyTerse, displayName: null, description: null, model: null }),
    ]);

    const out = await svc.list('subagent', host, 'claude');

    expect(out.kind).toBe('subagent');
    expect(out.engine).toBe('claude');
    expect(out.items[0]).toEqual({
      slug: 'reviewer',
      sha256: sha(bodyReviewer),
      display_name: 'Reviewer',
      description: 'Reviews code',
      model: 'claude-opus-4-6',
      updated_at: '2026-01-02T00:00:00Z',
      engine: null,
    });
    // Nullable columns come back as explicit nulls, never undefined.
    expect(out.items[1]).toEqual({
      slug: 'zbare',
      sha256: sha(bodyTerse),
      display_name: null,
      description: null,
      model: null,
      updated_at: '2026-01-02T00:00:00Z',
      engine: null,
    });
    // Body is never part of the list payload -- that is what retrieve/bundle are for.
    expect(out.items[0]).not.toHaveProperty('content');

    expect(logRows(db)).toEqual([
      { hostId: 7, action: 'claude_artifact.list', details: { kind: 'subagent', count: 2, engine: 'claude' } },
    ]);
  });

  it('treats a null or empty row engine as fleet-wide and hides the other engine', async () => {
    const { svc, db } = makeService([
      artifactRow({ id: 1, slug: 'a-null', engine: null }),
      artifactRow({ id: 2, slug: 'b-empty', engine: '' }),
      artifactRow({ id: 3, slug: 'c-claude', engine: 'claude' }),
      artifactRow({ id: 4, slug: 'd-codex', engine: 'codex' }),
    ]);

    const forClaude = await svc.list('subagent', host, 'claude');
    expect(forClaude.items.map((i) => i['slug'])).toEqual(['a-null', 'b-empty', 'c-claude']);

    const forCodex = await svc.list('subagent', host, 'codex');
    expect(forCodex.items.map((i) => i['slug'])).toEqual(['a-null', 'b-empty', 'd-codex']);

    // No engine asked for == no scoping at all: every row, including both
    // engine-pinned ones.
    const unscoped = await svc.list('subagent', host, null);
    expect(unscoped.engine).toBeNull();
    expect(unscoped.items.map((i) => i['slug'])).toEqual(['a-null', 'b-empty', 'c-claude', 'd-codex']);

    // One log row per call, each carrying the count it actually returned.
    expect(logRows(db).map((r) => r.details)).toEqual([
      { kind: 'subagent', count: 3, engine: 'claude' },
      { kind: 'subagent', count: 3, engine: 'codex' },
      { kind: 'subagent', count: 4, engine: null },
    ]);
  });

  it('scopes to the requested kind and excludes soft-deleted rows', async () => {
    const { svc } = makeService([
      artifactRow({ id: 1, kind: 'subagent', slug: 'reviewer' }),
      artifactRow({ id: 2, kind: 'subagent', slug: 'gone', deletedAt: '2026-01-03T00:00:00Z' }),
      artifactRow({ id: 3, kind: 'command', slug: 'deploy', body: bodyDeploy }),
    ]);

    expect((await svc.list('subagent', host, 'claude')).items.map((i) => i['slug'])).toEqual(['reviewer']);
    expect((await svc.list('command', host, 'claude')).items.map((i) => i['slug'])).toEqual(['deploy']);
    expect((await svc.list('output-style', host, 'claude')).items).toEqual([]);
  });
});

describe('HostClaudeArtifactsService.retrieve', () => {
  it('reports missing for an unknown slug', async () => {
    const { svc, db } = makeService([artifactRow({ id: 1, slug: 'reviewer' })]);

    await expect(svc.retrieve('subagent', 'nope', null, host)).resolves.toEqual({
      status: 'missing',
      kind: 'subagent',
      slug: 'nope',
    });
    expect(logRows(db)).toEqual([
      { hostId: 7, action: 'claude_artifact.retrieve', details: { kind: 'subagent', slug: 'nope', status: 'missing' } },
    ]);
  });

  it('reports deleted with the deletion timestamp so the wrapper can unlink', async () => {
    const { svc, db } = makeService([
      artifactRow({ id: 1, slug: 'gone', deletedAt: '2026-01-03T00:00:00Z' }),
    ]);

    await expect(svc.retrieve('subagent', 'gone', null, host)).resolves.toEqual({
      status: 'deleted',
      kind: 'subagent',
      slug: 'gone',
      deleted_at: '2026-01-03T00:00:00Z',
    });
    expect(logRows(db)).toEqual([
      { hostId: 7, action: 'claude_artifact.retrieve', details: { kind: 'subagent', slug: 'gone', status: 'deleted' } },
    ]);
  });

  it('omits content when the supplied digest matches', async () => {
    const { svc, db } = makeService([artifactRow({ id: 1, slug: 'reviewer' })]);

    const out = await svc.retrieve('subagent', 'reviewer', sha(bodyReviewer), host);

    expect(out).toEqual({
      status: 'unchanged',
      kind: 'subagent',
      slug: 'reviewer',
      sha256: sha(bodyReviewer),
      display_name: 'Reviewer',
      description: 'Reviews code',
      model: 'claude-opus-4-6',
      updated_at: '2026-01-02T00:00:00Z',
    });
    expect(out).not.toHaveProperty('content');
    expect(logRows(db)).toEqual([
      {
        hostId: 7,
        action: 'claude_artifact.retrieve',
        details: { kind: 'subagent', slug: 'reviewer', status: 'unchanged' },
      },
    ]);
  });

  it('accepts an upper-case digest past the hex guard but compares it byte-exactly', async () => {
    const { svc } = makeService([artifactRow({ id: 1, slug: 'reviewer' })]);

    // SHA_RE is case-insensitive, so this gets past validation; the comparison
    // itself is not, so a case-shifted digest counts as changed and ships content.
    const out = await svc.retrieve('subagent', 'reviewer', sha(bodyReviewer).toUpperCase(), host);

    expect(out.status).toBe('updated');
    expect(out.content).toBe(bodyReviewer);
  });

  it('carries content when the digest is absent or stale', async () => {
    const { svc, db } = makeService([artifactRow({ id: 1, slug: 'reviewer' })]);

    const noDigest = await svc.retrieve('subagent', 'reviewer', null, host);
    expect(noDigest).toMatchObject({ status: 'updated', sha256: sha(bodyReviewer), content: bodyReviewer });

    const stale = await svc.retrieve('subagent', 'reviewer', 'f'.repeat(64), host);
    expect(stale).toMatchObject({ status: 'updated', content: bodyReviewer });

    expect(logRows(db).map((r) => r.details)).toEqual([
      { kind: 'subagent', slug: 'reviewer', status: 'updated' },
      { kind: 'subagent', slug: 'reviewer', status: 'updated' },
    ]);
  });

  it('rejects a digest that is not 64 hex characters', async () => {
    const { svc, db } = makeService([artifactRow({ id: 1, slug: 'reviewer' })]);

    await expect(svc.retrieve('subagent', 'reviewer', 'nothex', host)).rejects.toBeInstanceOf(ValidationError);
    for (const bad of ['z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '']) {
      await expect(svc.retrieve('subagent', 'reviewer', bad, host)).rejects.toMatchObject({
        status: 422,
        code: 'validation_failed',
        extra: { errors: { sha256: ['sha256 must be a 64-char hex digest'] } },
      });
    }
    // A rejected request never reaches the row, so it never logs one either.
    expect(logRows(db)).toEqual([]);
  });

  it('normalizes the raw slug before looking the row up', async () => {
    const { svc, db } = makeService([artifactRow({ id: 1, slug: 'reviewer' })]);

    const out = await svc.retrieve('subagent', '  reviewer  ', null, host);

    expect(out).toMatchObject({ status: 'updated', slug: 'reviewer', content: bodyReviewer });
    expect(logRows(db)[0]?.details).toEqual({ kind: 'subagent', slug: 'reviewer', status: 'updated' });
  });
});

describe('HostClaudeArtifactsService.bundle', () => {
  function seeded() {
    return makeService([
      artifactRow({ id: 1, kind: 'subagent', slug: 'reviewer' }),
      artifactRow({ id: 2, kind: 'subagent', slug: 'gone', deletedAt: '2026-01-03T00:00:00Z' }),
      artifactRow({ id: 3, kind: 'command', slug: 'deploy', body: bodyDeploy }),
      artifactRow({ id: 4, kind: 'output-style', slug: 'terse', body: bodyTerse }),
    ]);
  }

  it('returns a key for every artifact kind, even when a kind is empty', async () => {
    const { svc } = makeService([artifactRow({ id: 1, kind: 'subagent', slug: 'reviewer' })]);

    const out = await svc.bundle(host, 'claude', {});

    expect(Object.keys(out).sort()).toEqual([...ARTIFACT_KINDS].sort());
    expect(out.subagent.map((e) => e.slug)).toEqual(['reviewer']);
    expect(out.command).toEqual([]);
    expect(out['output-style']).toEqual([]);
  });

  it('marks unchanged only on a well-formed matching digest', async () => {
    const { svc } = seeded();

    const out = await svc.bundle(host, 'claude', {
      subagent: { reviewer: sha(bodyReviewer) },
      // Truncated and non-hex on-disk digests are junk, not a match: the
      // wrapper must be sent the content rather than left with a bad file.
      command: { deploy: sha(bodyDeploy).slice(0, 32) },
      'output-style': { terse: 'z'.repeat(64) },
    });

    expect(out.subagent[0]).toEqual({ slug: 'reviewer', sha256: sha(bodyReviewer), status: 'unchanged' });
    expect(out.subagent[0]?.content).toBeUndefined();
    expect(out.command[0]).toEqual({
      slug: 'deploy',
      sha256: sha(bodyDeploy),
      status: 'updated',
      content: bodyDeploy,
    });
    expect(out['output-style'][0]).toEqual({
      slug: 'terse',
      sha256: sha(bodyTerse),
      status: 'updated',
      content: bodyTerse,
    });
  });

  it('sends content for every kind when the wrapper supplies no digests', async () => {
    const { svc } = seeded();

    const out = await svc.bundle(host, 'claude');

    for (const kind of ARTIFACT_KINDS) {
      expect(out[kind].map((e) => e.status)).toEqual(['updated']);
      expect(out[kind][0]?.content).toBeTruthy();
    }
  });

  it('excludes soft-deleted rows and rows pinned to the other engine', async () => {
    const { svc } = makeService([
      artifactRow({ id: 1, kind: 'subagent', slug: 'reviewer', engine: null }),
      artifactRow({ id: 2, kind: 'subagent', slug: 'gone', deletedAt: '2026-01-03T00:00:00Z' }),
      artifactRow({ id: 3, kind: 'subagent', slug: 'claude-only', engine: 'claude' }),
      artifactRow({ id: 4, kind: 'subagent', slug: 'codex-only', engine: 'codex' }),
      artifactRow({ id: 5, kind: 'subagent', slug: 'empty-engine', engine: '' }),
    ]);

    const forClaude = await svc.bundle(host, 'claude', {});
    expect(forClaude.subagent.map((e) => e.slug)).toEqual(['claude-only', 'empty-engine', 'reviewer']);

    const forCodex = await svc.bundle(host, 'codex', {});
    expect(forCodex.subagent.map((e) => e.slug)).toEqual(['codex-only', 'empty-engine', 'reviewer']);
  });
});
