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
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import type { Host } from '../../../src/db/schema.js';

const host: Host = { id: 1, fqdn: 'host.example' } as unknown as Host;
const otherHost: Host = { id: 2, fqdn: 'other.example' } as unknown as Host;

type MemorySeed = {
  id: number;
  memoryKey: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  tags?: string[] | null;
  sourceHostId?: number | null;
};

function makeDb(memories: MemorySeed[] = []): DbFake {
  const db = createDbFake();
  db.tables.set(coordProjects, [{
    id: 7,
    slug: 'demo',
    aboutJson: null,
    rosterMarkdown: '',
    latestEventSeq: 3,
    createdAt: '2026-07-01T08:00:00Z',
    updatedAt: '2026-07-01T08:00:00Z',
    archivedAt: null,
  }]);
  db.tables.set(coordProjectNotes, []);
  db.tables.set(coordProjectTodos, []);
  db.tables.set(coordProjectFiles, []);
  db.tables.set(coordProjectFeedback, []);
  db.tables.set(coordProjectEvents, []);
  db.tables.set(
    coordProjectMemories,
    memories.map((m) => ({
      id: m.id,
      projectId: 7,
      memoryKey: m.memoryKey,
      content: m.content,
      metadata: m.metadata ?? null,
      tags: m.tags ?? null,
      tagsText: m.tags?.join(' ') ?? null,
      sourceHostId: m.sourceHostId ?? 1,
      createdAt: '2026-07-01T09:00:00Z',
      updatedAt: '2026-07-01T09:00:00Z',
    })),
  );
  return db;
}

const eventInserts = (db: DbFake) => db.inserts.filter((i) => i.table === coordProjectEvents);
const memoryEvents = (db: DbFake) =>
  eventInserts(db).map((i) => i.values as Record<string, unknown>).filter((v) => v['eventType'] === 'memory');

describe('HostProjectsService project memories', () => {
  describe('listMemories', () => {
    it('previews by default and never leaks full content', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'deploy.crane', content: 'x'.repeat(500) }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.listMemories('demo', {}, host)) as {
        count: number;
        memories: Array<Record<string, unknown>>;
      };

      expect(out.count).toBe(1);
      const first = out.memories[0]!;
      expect(first).not.toHaveProperty('content');
      expect(first['content_length']).toBe(500);
      expect(String(first['preview'])).toHaveLength(280);
    });

    it('returns full content when include_content is set', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'deploy.crane', content: 'full text' }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.listMemories('demo', { include_content: true }, host)) as {
        memories: Array<Record<string, unknown>>;
      };

      expect(out.memories[0]!['content']).toBe('full text');
    });

    it('coerces the query-string form of include_content that REST GETs deliver', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'deploy.crane', content: 'full text' }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.listMemories('demo', { include_content: 'true' }, host)) as {
        memories: Array<Record<string, unknown>>;
      };

      expect(out.memories[0]!['content']).toBe('full text');
    });

    it('reports truncation when the limit cuts the corpus short', async () => {
      const db = makeDb([
        { id: 1, memoryKey: 'a', content: 'one' },
        { id: 2, memoryKey: 'b', content: 'two' },
      ]);
      const service = new HostProjectsService(db as never);

      const out = (await service.listMemories('demo', { limit: 1 }, host)) as {
        count: number;
        truncated: boolean;
      };

      expect(out).toMatchObject({ count: 1, truncated: true });
    });
  });

  describe('getMemory', () => {
    it('reports found with the hydrated row', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'deploy.crane', content: 'ship it', tags: ['ops'] }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.getMemory('demo', 'deploy.crane', host)) as {
        status: string;
        memory: Record<string, unknown> | null;
      };

      expect(out.status).toBe('found');
      expect(out.memory).toMatchObject({ key: 'deploy.crane', content: 'ship it', tags: ['ops'] });
    });

    it('reports missing rather than throwing', async () => {
      const db = makeDb();
      const service = new HostProjectsService(db as never);

      const out = (await service.getMemory('demo', 'nope', host)) as { status: string; memory: unknown };

      expect(out).toMatchObject({ status: 'missing', memory: null });
    });
  });

  describe('upsertMemory', () => {
    it('creates a new key and records a memory create event', async () => {
      const db = makeDb();
      const service = new HostProjectsService(db as never);

      const out = (await service.upsertMemory('demo', { key: 'deploy.crane', content: 'ship it' }, host)) as {
        status: string;
      };

      expect(out.status).toBe('created');
      expect(db.inserts.some((i) => i.table === coordProjectMemories)).toBe(true);
      const events = memoryEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: 'memory', action: 'create', entityType: 'memory' });
    });

    it('updates an existing key in place and records an update event', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'deploy.crane', content: 'old' }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.upsertMemory('demo', { key: 'deploy.crane', content: 'new' }, host)) as {
        status: string;
      };

      expect(out.status).toBe('updated');
      expect(db.updates.some((u) => u.table === coordProjectMemories)).toBe(true);
      expect(memoryEvents(db)[0]).toMatchObject({ action: 'update' });
    });

    // The whole point of the unchanged short-circuit: a no-op re-store must not
    // touch the event log, or every other host re-syncs for nothing.
    it('reports unchanged for an identical re-store without writing or emitting an event', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'deploy.crane', content: 'same', tags: ['ops'] }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.upsertMemory(
        'demo',
        { key: 'deploy.crane', content: 'same', tags: ['ops'] },
        host,
      )) as { status: string };

      expect(out.status).toBe('unchanged');
      expect(db.updates.some((u) => u.table === coordProjectMemories)).toBe(false);
      expect(db.inserts.some((i) => i.table === coordProjectMemories)).toBe(false);
      expect(memoryEvents(db)).toHaveLength(0);
      // latest_event_seq must not move either.
      expect(db.updates.some((u) => u.table === coordProjects)).toBe(false);
    });

    it('treats tag reordering and case as unchanged', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'k', content: 'same', tags: ['Ops', 'deploy'] }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.upsertMemory('demo', { key: 'k', content: 'same', tags: ['deploy', 'OPS'] }, host)) as {
        status: string;
      };

      expect(out.status).toBe('unchanged');
    });

    it('treats a metadata change as an update', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'k', content: 'same', metadata: { a: 1 } }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.upsertMemory('demo', { key: 'k', content: 'same', metadata: { a: 2 } }, host)) as {
        status: string;
      };

      expect(out.status).toBe('updated');
    });

    // coord_project_events.entity_id is VARCHAR(64); memory_key is VARCHAR(128).
    // Using the key as entity_id would be a strict-mode error for long keys.
    it('uses the numeric row id as entity_id and keeps the key in the payload', async () => {
      const longKey = 'a'.repeat(120);
      const db = makeDb();
      const service = new HostProjectsService(db as never);

      await service.upsertMemory('demo', { key: longKey, content: 'body' }, host);

      const event = memoryEvents(db)[0]!;
      expect(String(event['entityId']).length).toBeLessThanOrEqual(64);
      expect(Number(event['entityId'])).toBeGreaterThan(0);
      expect((event['payloadJson'] as Record<string, unknown>)['key']).toBe(longKey);
    });

    it('puts a preview in the event payload, never the full content', async () => {
      const db = makeDb();
      const service = new HostProjectsService(db as never);

      await service.upsertMemory('demo', { key: 'k', content: 'y'.repeat(1000) }, host);

      const payload = memoryEvents(db)[0]!['payloadJson'] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('content');
      expect(payload['content_length']).toBe(1000);
      expect(String(payload['preview'])).toHaveLength(280);
    });

    it('attributes the write to the calling host', async () => {
      const db = makeDb();
      const service = new HostProjectsService(db as never);

      await service.upsertMemory('demo', { key: 'k', content: 'body' }, otherHost);

      const inserted = db.inserts.find((i) => i.table === coordProjectMemories)!.values as Record<string, unknown>;
      expect(inserted['sourceHostId']).toBe(otherHost.id);
    });
  });

  describe('deleteMemory', () => {
    it('deletes an existing key and records a delete event', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'gone', content: 'bye' }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.deleteMemory('demo', 'gone', host)) as { status: string };

      expect(out.status).toBe('deleted');
      expect(db.deletes.some((d) => d.table === coordProjectMemories)).toBe(true);
      expect(memoryEvents(db)[0]).toMatchObject({ action: 'delete' });
    });

    it('reports missing without emitting an event', async () => {
      const db = makeDb();
      const service = new HostProjectsService(db as never);

      const out = (await service.deleteMemory('demo', 'nope', host)) as { status: string };

      expect(out.status).toBe('missing');
      expect(memoryEvents(db)).toHaveLength(0);
    });
  });

  describe('searchMemories', () => {
    it('degrades to a recency listing when the query is empty', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'a', content: 'one' }]);
      const service = new HostProjectsService(db as never);

      const out = (await service.searchMemories('demo', {}, host)) as { count: number; matches: unknown[] };

      expect(out.count).toBe(1);
      expect(out.matches).toHaveLength(1);
    });

    // Regression: Drizzle wraps driver errors in a DrizzleQueryError whose own
    // message is the failed SQL and whose errno lives on `.cause`. Checking only
    // the top-level error meant the fallback never fired and search hard-failed
    // on any DB missing the index — exactly what the fallback exists to prevent.
    it('degrades to a substring scan when the fulltext index is missing', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'deploy.crane', content: 'crane deploys are manual' }]);
      const wrapped = Object.assign(new Error('Failed query: SELECT ... MATCH(content, tags_text) ...'), {
        cause: Object.assign(new Error("Can't find FULLTEXT index matching the column list"), {
          errno: 1191,
          code: 'ER_FT_MATCHING_KEY_NOT_FOUND',
        }),
      });
      (db as unknown as { execute: () => Promise<never> }).execute = async () => {
        throw wrapped;
      };
      const service = new HostProjectsService(db as never);

      const out = (await service.searchMemories('demo', { query: 'crane' }, host)) as {
        degraded: boolean;
        count: number;
        matches: Array<Record<string, unknown>>;
      };

      expect(out.degraded).toBe(true);
      expect(out.count).toBe(1);
      expect(out.matches[0]!['key']).toBe('deploy.crane');
    });

    it('propagates unrelated query errors instead of mislabelling them degraded', async () => {
      const db = makeDb([{ id: 1, memoryKey: 'k', content: 'body' }]);
      (db as unknown as { execute: () => Promise<never> }).execute = async () => {
        throw Object.assign(new Error('Failed query'), {
          cause: Object.assign(new Error("Table 'x' doesn't exist"), { errno: 1146, code: 'ER_NO_SUCH_TABLE' }),
        });
      };
      const service = new HostProjectsService(db as never);

      await expect(service.searchMemories('demo', { query: 'body' }, host)).rejects.toThrow();
    });

    it('AND-filters an empty-query listing by tags', async () => {
      const db = makeDb([
        { id: 1, memoryKey: 'a', content: 'one', tags: ['ops', 'deploy'] },
        { id: 2, memoryKey: 'b', content: 'two', tags: ['ops'] },
      ]);
      const service = new HostProjectsService(db as never);

      const out = (await service.searchMemories('demo', { tags: ['ops', 'deploy'] }, host)) as {
        matches: Array<Record<string, unknown>>;
      };

      expect(out.matches).toHaveLength(1);
      expect(out.matches[0]!['key']).toBe('a');
    });
  });

  describe('validation', () => {
    const service = new HostProjectsService(makeDb() as never);

    it.each([
      ['empty key', { key: '', content: 'x' }],
      ['key with illegal characters', { key: 'bad key!', content: 'x' }],
      ['key over 128 chars', { key: 'a'.repeat(129), content: 'x' }],
      ['empty content', { key: 'k', content: '' }],
      ['content over 32000 chars', { key: 'k', content: 'x'.repeat(32001) }],
      ['array metadata', { key: 'k', content: 'x', metadata: [1, 2] }],
      ['non-array tags', { key: 'k', content: 'x', tags: 'ops' }],
      ['non-string tag', { key: 'k', content: 'x', tags: [1] }],
      ['tag over 64 chars', { key: 'k', content: 'x', tags: ['a'.repeat(65)] }],
      ['more than 32 tags', { key: 'k', content: 'x', tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }],
    ])('rejects %s', (_label, payload) => {
      expect(() => service.normalizeMemoryPayload(payload as Record<string, unknown>)).toThrow();
    });

    it('accepts the documented key shape', () => {
      expect(service.normalizeMemoryKey('deploy.crane:v2-1_a')).toBe('deploy.crane:v2-1_a');
    });

    // mcp_memories reserves ^coco to redirect callers to project-scoped state --
    // i.e. to here. Reserving it again would reject the agent that complied.
    it('does not reserve the coco prefix that host memory redirects here', () => {
      expect(service.normalizeMemoryKey('coco.handoff')).toBe('coco.handoff');
    });
  });

  describe('bootstrap integration', () => {
    it('exposes memory counts, capped previews, and a memories route', async () => {
      const db = makeDb(
        Array.from({ length: 12 }, (_, i) => ({ id: i + 1, memoryKey: `k${i}`, content: 'z'.repeat(400) })),
      );
      const service = new HostProjectsService(db as never);

      const out = await service.bootstrap('demo', host);

      expect((out['counts'] as Record<string, number>)['memories']).toBe(12);
      const recent = out['recent_memories'] as Array<Record<string, unknown>>;
      expect(recent).toHaveLength(8);
      expect(recent[0]).not.toHaveProperty('content');
      expect(String(recent[0]!['preview'])).toHaveLength(280);
      expect((out['routes'] as Record<string, string>)['memories']).toBe('/projects/demo/memories');
    });
  });
});
