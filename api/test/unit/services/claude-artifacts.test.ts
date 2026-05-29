import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createDbShim } from '../../helpers/db-shim.js';
import { claudeArtifacts } from '../../../src/db/schema.js';
import { ClaudeArtifactsService } from '../../../src/services/claude-artifacts.js';
import { HostClaudeArtifactsService } from '../../../src/services/host-claude-artifacts.js';
import type { Database } from '../../../src/db/client.js';
import type { Host } from '../../../src/db/schema.js';

const host = { id: 1 } as unknown as Host;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function freshDb() {
  const db = createDbShim();
  db.tables.set(claudeArtifacts, []);
  return db;
}

describe('ClaudeArtifactsService.store', () => {
  it('builds a canonical body, computes sha, and inserts a created row', async () => {
    const db = freshDb();
    const svc = new ClaudeArtifactsService(db as unknown as Database);
    const res = await svc.store('subagent', {
      slug: 'reviewer',
      description: 'Reviews code',
      tools: 'Read, Grep',
      model: 'sonnet',
      body: 'You are a reviewer.',
    });
    expect(res.status).toBe('created');
    const row = db.tables.get(claudeArtifacts)![0]!;
    expect(row.kind).toBe('subagent');
    expect(row.slug).toBe('reviewer');
    expect(row.sha256).toBe(sha(row.body as string));
    expect(row.body).toContain('name: reviewer'); // defaulted from slug
    expect(row.body).toContain('description: Reviews code');
    expect(row.body).toContain('  - Read');
    expect(row.model).toBe('sonnet');
  });

  it('rejects a subagent missing the required description', async () => {
    const db = freshDb();
    const svc = new ClaudeArtifactsService(db as unknown as Database);
    await expect(svc.store('subagent', { slug: 'x', body: 'hi' })).rejects.toThrow();
  });

  it('reports unchanged on identical re-store', async () => {
    const db = freshDb();
    const svc = new ClaudeArtifactsService(db as unknown as Database);
    const input = { slug: 'r', description: 'd', body: 'b' };
    const first = await svc.store('subagent', input);
    expect(first.status).toBe('created');
    const second = await svc.store('subagent', input);
    expect(second.status).toBe('unchanged');
    expect(second.sha256).toBe(first.sha256);
  });

  it('lets the same slug coexist across kinds', async () => {
    const db = freshDb();
    const svc = new ClaudeArtifactsService(db as unknown as Database);
    await svc.store('subagent', { slug: 'shared', description: 'a', body: 'x' });
    await svc.store('command', { slug: 'shared', description: 'b', body: 'y' });
    const subs = await svc.list('subagent');
    const cmds = await svc.list('command');
    expect(subs.map((r) => r.slug)).toEqual(['shared']);
    expect(cmds.map((r) => r.slug)).toEqual(['shared']);
    expect(subs[0]!.sha256).not.toBe(cmds[0]!.sha256);
  });

  it('soft-deletes via deleted_at and hides from the live list', async () => {
    const db = freshDb();
    const svc = new ClaudeArtifactsService(db as unknown as Database);
    await svc.store('output-style', { slug: 'concise', body: 'be terse' });
    expect((await svc.list('output-style')).length).toBe(1);
    const deleted = await svc.softDelete('output-style', 'concise');
    expect(deleted).toBe(true);
    expect((await svc.list('output-style')).length).toBe(0);
    expect((await svc.list('output-style', { includeDeleted: true })).length).toBe(1);
  });
});

describe('HostClaudeArtifactsService bundle/retrieve', () => {
  function seeded() {
    const db = freshDb();
    const bodyA = '---\nname: a\ndescription: d\n---\n\nalpha\n';
    const bodyC = '---\ndescription: d\n---\n\ncmd\n';
    db.tables.set(claudeArtifacts, [
      { id: 1, kind: 'subagent', slug: 'a', sha256: sha(bodyA), body: bodyA, displayName: 'a', description: 'd', model: null, frontmatter: {}, engine: null, sourceHostId: null, createdAt: 't', updatedAt: 't', deletedAt: null },
      { id: 2, kind: 'subagent', slug: 'gone', sha256: sha('x'), body: 'x', displayName: null, description: null, model: null, frontmatter: {}, engine: null, sourceHostId: null, createdAt: 't', updatedAt: 't', deletedAt: 't-deleted' },
      { id: 3, kind: 'command', slug: 'c', sha256: sha(bodyC), body: bodyC, displayName: null, description: 'd', model: null, frontmatter: {}, engine: null, sourceHostId: null, createdAt: 't', updatedAt: 't', deletedAt: null },
    ]);
    return { db, bodyA, bodyC, shaA: sha(bodyA), shaC: sha(bodyC) };
  }

  it('returns the complete live set, omits content on sha match, excludes deleted', async () => {
    const { db, bodyC, shaA, shaC } = seeded();
    const svc = new HostClaudeArtifactsService(db as unknown as Database);
    const bundle = await svc.bundle(host, 'claude', { subagent: { a: shaA } });
    expect(bundle.subagent.map((e) => e.slug)).toEqual(['a']); // 'gone' (deleted) excluded
    expect(bundle.subagent[0]).toMatchObject({ slug: 'a', sha256: shaA, status: 'unchanged' });
    expect(bundle.subagent[0]!.content).toBeUndefined();
    expect(bundle.command[0]).toMatchObject({ slug: 'c', sha256: shaC, status: 'updated', content: bodyC });
    expect(bundle['output-style']).toEqual([]);
  });

  it('retrieve reports unchanged / updated / missing', async () => {
    const { db, bodyA, shaA } = seeded();
    const svc = new HostClaudeArtifactsService(db as unknown as Database);
    expect((await svc.retrieve('subagent', 'a', shaA, host)).status).toBe('unchanged');
    const upd = await svc.retrieve('subagent', 'a', 'f'.repeat(64), host);
    expect(upd.status).toBe('updated');
    expect(upd.content).toBe(bodyA);
    expect((await svc.retrieve('subagent', 'nope', null, host)).status).toBe('missing');
  });
});
