import { describe, expect, it } from 'vitest';
import {
  coordProjectEvents,
  coordProjectFeedback,
  coordProjectFiles,
  coordProjectMemories,
  coordProjectNotes,
  coordProjects,
  coordProjectTodos,
} from '../../../src/db/schema.js';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { createDbFake } from '../../helpers/db-fake.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * The lean read paths, which exist because the fat ones could not be called.
 * Measured against live projects before this suite existed: `project_bootstrap`
 * 62 KB, `project_detail` 597 KB, `project_file_list` 347 KB — every one of them
 * over the limit an agent can take in a single tool result, and three quarters of
 * each was file bodies.
 *
 * NOT covered here, by construction: `size_bytes` on a lean listing. `db-fake`
 * discards the projection passed to `select()` and returns whole rows, so the
 * `octet_length(content)` expression that computes it server-side evaluates to
 * nothing and the fake reports 0 for every file. That number is asserted against
 * real MySQL in `test/integration/projects-client/lean-reads.test.ts`; a unit
 * test for it here would only be testing the fake.
 */

const host: Host = { id: 1, fqdn: 'host.example' } as unknown as Host;

interface SeedFile {
  id: number;
  storedName: string;
  content: string;
}

function seed(files: SeedFile[] = [], notes: { id: number; header: string; body: string }[] = []) {
  const db = createDbFake();
  db.tables.set(coordProjects, [
    {
      id: 1,
      slug: 'demo',
      aboutJson: { purpose: 'test' },
      rosterMarkdown: '',
      latestEventSeq: 3,
      createdAt: '2026-09-22T08:00:00Z',
      updatedAt: '2026-09-22T08:01:00Z',
      archivedAt: null,
    },
  ]);
  db.tables.set(
    coordProjectNotes,
    notes.map((n) => ({
      id: n.id,
      projectId: 1,
      header: n.header,
      body: n.body,
      sourceHostId: 1,
      createdAt: '2026-09-22T08:00:00Z',
      updatedAt: '2026-09-22T08:00:00Z',
    })),
  );
  db.tables.set(coordProjectTodos, []);
  db.tables.set(coordProjectFeedback, []);
  db.tables.set(coordProjectEvents, []);
  db.tables.set(coordProjectMemories, []);
  db.tables.set(
    coordProjectFiles,
    files.map((f) => ({
      id: f.id,
      projectId: 1,
      storedName: f.storedName,
      description: null,
      content: f.content,
      contentSha256: 'sha-' + f.id,
      mimeType: 'text/markdown',
      sourceHostId: 1,
      createdAt: '2026-09-22T08:00:00Z',
      updatedAt: '2026-09-22T08:00:00Z',
    })),
  );
  return db;
}

describe('project_files', () => {
  it('lists file metadata without any body', async () => {
    const db = seed([
      { id: 5, storedName: 'context/PLAN.md', content: 'x'.repeat(20000) },
      { id: 6, storedName: 'context/notes.md', content: 'y'.repeat(300) },
    ]);
    const service = new HostProjectsService(db as never);
    const out = (await service.listFileSummaries('demo', host)) as {
      project: string;
      files: Record<string, unknown>[];
    };

    expect(out.project).toBe('demo');
    expect(out.files).toHaveLength(2);
    for (const file of out.files) {
      expect(file).not.toHaveProperty('content');
      expect(file).toMatchObject({
        stored_name: expect.any(String),
        content_sha256: expect.any(String),
        mime_type: 'text/markdown',
      });
    }
    // The whole point: the response cannot grow with the size of what is stored.
    expect(JSON.stringify(out).length).toBeLessThan(1000);
  });
});

describe('project_file_read windowing', () => {
  const body = 'abcdefghij'.repeat(1000); // 10_000 bytes

  it('returns the whole body when no window is asked for, exactly as before', async () => {
    const service = new HostProjectsService(seed([{ id: 5, storedName: 'a.md', content: body }]) as never);
    const { file } = await service.readFile('demo', { storedName: 'a.md' }, host);
    expect(file.content).toBe(body);
    expect(file).not.toHaveProperty('truncated');
  });

  it('windows on offset/limit and reports where to continue', async () => {
    const service = new HostProjectsService(seed([{ id: 5, storedName: 'a.md', content: body }]) as never);
    const { file } = await service.readFile('demo', { storedName: 'a.md', offset: 0, limit: 4096 }, host);
    expect(file.content).toHaveLength(4096);
    expect(file.offset).toBe(0);
    expect(file.next_offset).toBe(4096);
    expect(file.truncated).toBe(true);
    expect(file.size_bytes).toBe(10000);
  });

  it('walks to the end and reassembles the original', async () => {
    const service = new HostProjectsService(seed([{ id: 5, storedName: 'a.md', content: body }]) as never);
    let offset = 0;
    let assembled = '';
    let guard = 0;
    for (;;) {
      if (++guard > 50) throw new Error('window walk did not terminate');
      const { file } = await service.readFile('demo', { storedName: 'a.md', offset, limit: 4096 }, host);
      assembled += file.content;
      if (!file.truncated) break;
      offset = file.next_offset!;
    }
    expect(assembled).toBe(body);
  });

  it('caps an absurd limit rather than honouring it', async () => {
    const service = new HostProjectsService(seed([{ id: 5, storedName: 'a.md', content: body }]) as never);
    const { file } = await service.readFile('demo', { storedName: 'a.md', offset: 0, limit: 99999999 }, host);
    expect(file.content).toBe(body);
    expect(file.truncated).toBe(false);
  });

  it('clamps an offset past the end to an empty final window', async () => {
    const service = new HostProjectsService(seed([{ id: 5, storedName: 'a.md', content: body }]) as never);
    const { file } = await service.readFile('demo', { storedName: 'a.md', offset: 99999, limit: 100 }, host);
    expect(file.content).toBe('');
    expect(file.truncated).toBe(false);
    expect(file.next_offset).toBe(10000);
  });
});

describe('project_changes payload previews', () => {
  function withEvents(db: ReturnType<typeof seed>) {
    db.tables.set(coordProjectEvents, [
      {
        seq: 1,
        projectId: 1,
        eventType: 'note',
        action: 'update',
        entityType: 'note',
        entityId: '9',
        payloadJson: { header: 'Start here', body: 'n'.repeat(30000) },
        sourceHostId: 1,
        createdAt: '2026-09-22T08:00:00Z',
      },
      {
        seq: 2,
        projectId: 1,
        eventType: 'file',
        action: 'create',
        entityType: 'file',
        entityId: '5',
        payloadJson: { stored_name: 'a.md', content_sha256: 'sha' },
        sourceHostId: 1,
        createdAt: '2026-09-22T08:01:00Z',
      },
    ]);
    return db;
  }

  it('leaves payloads alone by default', async () => {
    const service = new HostProjectsService(withEvents(seed()) as never);
    const out = (await service.listChanges('demo', 0, host)) as {
      changes: { payload: Record<string, unknown> }[];
    };
    expect(String(out.changes[0]!.payload['body'])).toHaveLength(30000);
  });

  it('trims note bodies to a preview when asked, and leaves other payloads intact', async () => {
    const service = new HostProjectsService(withEvents(seed()) as never);
    const out = (await service.listChanges('demo', 0, host, { payloads: 'preview' })) as {
      changes: { payload: Record<string, unknown> }[];
    };
    expect(String(out.changes[0]!.payload['body'])).toHaveLength(280);
    expect(out.changes[0]!.payload['body_length']).toBe(30000);
    // A file event was already metadata; nothing to trim, nothing added.
    expect(out.changes[1]!.payload).toEqual({ stored_name: 'a.md', content_sha256: 'sha' });
  });

  it('resumes from a sequence beyond 2^31 instead of wrapping to zero', async () => {
    const service = new HostProjectsService(withEvents(seed()) as never);
    const out = (await service.listChanges('demo', 4_000_000_000, host)) as { since: number };
    expect(out.since).toBe(4_000_000_000);
  });
});

describe('project_summary', () => {
  it('carries orientation without carrying the artifacts', async () => {
    const db = seed(
      [{ id: 5, storedName: 'context/PLAN.md', content: 'x'.repeat(50000) }],
      [{ id: 9, header: 'Start here', body: 'n'.repeat(5000) }],
    );
    const service = new HostProjectsService(db as never);
    const out = await service.summary('demo', {}, host);

    expect(out['project']).toBe('demo');
    expect(out['about']).toEqual({ purpose: 'test' });
    expect(out['skill']).toMatchObject({ slug: 'coco', managed: true });

    const counts = out['counts'] as Record<string, unknown>;
    expect(counts).toMatchObject({ files: 1, notes: 1 });
    expect(counts['feedback_by_type']).toEqual({});

    const files = out['files'] as Record<string, unknown>[];
    expect(files[0]).not.toHaveProperty('content');

    const notes = out['recent_notes'] as Record<string, unknown>[];
    expect(String(notes[0]!['body'] ?? '')).toBe('');
    expect(notes[0]!['preview']).toHaveLength(280);
    expect(notes[0]!['content_length']).toBe(5000);

    // 55 KB of stored artifacts; the orientation payload stays small, and most
    // of what is left is the fixed CoCo guidance block rather than project data.
    // That it does not GROW with the artifacts is asserted against real MySQL in
    // test/integration/projects-client/lean-reads.test.ts.
    expect(JSON.stringify(out).length).toBeLessThan(5000);
  });

  it('reports a disabled board rather than failing, like project_board_list', async () => {
    const service = new HostProjectsService(seed() as never);
    const out = await service.summary('demo', {}, host);
    expect(out['board']).toMatchObject({ status: 'disabled' });
  });
});
