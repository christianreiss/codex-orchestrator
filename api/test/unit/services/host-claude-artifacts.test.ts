import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { claudeArtifacts, logs } from '../../../src/db/schema.js';
import { HostClaudeArtifactsService } from '../../../src/services/host-claude-artifacts.js';
import { ARTIFACT_KINDS } from '../../../src/services/claude-frontmatter.js';
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
