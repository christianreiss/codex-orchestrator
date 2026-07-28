import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpMemories } from '../../../src/db/schema.js';
import type { Host } from '../../../src/db/schema.js';
import { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import { ValidationError } from '../../../src/http/errors.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { wsPublisher } from '../../../src/ws/publisher.js';

const host: Host = { id: 1, fqdn: 'host.example' } as unknown as Host;

type MemorySeed = {
  memoryKey: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  tags?: string[] | null;
};

function makeDb(memories: MemorySeed[] = []): DbFake {
  const db = createDbFake();
  db.tables.set(
    mcpMemories,
    memories.map((m, i) => ({
      id: i + 1,
      hostId: host.id,
      memoryKey: m.memoryKey,
      content: m.content,
      metadata: m.metadata ?? null,
      tags: m.tags ?? null,
      tagsText: m.tags?.join(' ') ?? null,
      summary: null,
      engine: null,
      createdAt: '2026-07-01T09:00:00Z',
      updatedAt: '2026-07-01T09:00:00Z',
      deletedAt: null,
    })),
  );
  return db;
}

function makeService(memories: MemorySeed[] = []): { db: DbFake; service: McpMemoriesService } {
  const db = makeDb(memories);
  return { db, service: new McpMemoriesService(db as never) };
}

let events: Array<{ type: string; payload: unknown }> = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  events = [];
  unsubscribe = wsPublisher.subscribe((e) => events.push({ type: e.type, payload: e.payload }));
});

afterEach(() => {
  unsubscribe();
});

const memoryEventTypes = () => events.map((e) => e.type).filter((t) => t.startsWith('memory.'));

describe('normalizeKey', () => {
  const service = new McpMemoriesService(makeDb() as never);

  it('returns null without an error when null is allowed', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeKey(undefined, true, errors)).toBeNull();
    expect(service.normalizeKey(null, true, errors)).toBeNull();
    expect(service.normalizeKey('   ', true, errors)).toBeNull();
    expect(errors).toEqual({});
  });

  it('requires an id when null is not allowed', () => {
    const missing: Record<string, string[]> = {};
    expect(service.normalizeKey(undefined, false, missing)).toBeNull();
    expect(missing['id']).toEqual(['id is required']);

    const blank: Record<string, string[]> = {};
    expect(service.normalizeKey('   ', false, blank)).toBeNull();
    expect(blank['id']).toEqual(['id is required']);
  });

  it('rejects non-string input', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeKey(42, true, errors)).toBeNull();
    expect(errors['id']).toEqual(['id must be a string']);
  });

  it('trims and accepts the documented key shape', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeKey('  deploy.crane:v2-1_a  ', false, errors)).toBe('deploy.crane:v2-1_a');
    expect(errors).toEqual({});
  });

  it('rejects a key longer than 128 characters', () => {
    const errors: Record<string, string[]> = {};
    service.normalizeKey('a'.repeat(129), false, errors);
    expect(errors['id']).toEqual(['id must be 128 characters or fewer']);
  });

  it('rejects characters outside the allowed charset', () => {
    const errors: Record<string, string[]> = {};
    service.normalizeKey('bad key!', false, errors);
    expect(errors['id']).toEqual([
      'id may only contain letters, numbers, dots, underscores, hyphens, and colons',
    ]);
  });

  // ^coco is reserved so agents are steered to shared projects instead of
  // host-scoped memory; the boundary characters are the whole point of the guard.
  it.each(['coco', 'COCO', 'coco.x', 'coco_x', 'coco:x', 'coco-x'])('reserves %s', (key) => {
    const errors: Record<string, string[]> = {};
    service.normalizeKey(key, false, errors);
    expect(errors['id']).toEqual([expect.stringContaining('reserved for CoCo shared handoffs')]);
  });

  it('does not reserve a key that merely starts with the letters coco', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeKey('cocoa', false, errors)).toBe('cocoa');
    expect(errors).toEqual({});
  });
});

describe('normalizeTags', () => {
  const service = new McpMemoriesService(makeDb() as never);

  it('returns no tags for null and undefined', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeTags(null, errors)).toEqual([]);
    expect(service.normalizeTags(undefined, errors)).toEqual([]);
    expect(errors).toEqual({});
  });

  it('rejects a non-array', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeTags('ops', errors)).toEqual([]);
    expect(errors['tags']).toEqual(['tags must be an array of strings']);
  });

  it('trims, drops blanks and de-duplicates case-insensitively keeping the first form', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeTags(['  Ops ', '', '   ', 'ops', 'OPS', 'deploy'], errors)).toEqual(['Ops', 'deploy']);
    expect(errors).toEqual({});
  });

  it('flags non-string entries but keeps the valid ones', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeTags(['ops', 7, null], errors)).toEqual(['ops']);
    expect(errors['tags']).toEqual(['tags must be strings', 'tags must be strings']);
  });

  it('rejects a tag longer than 64 characters and skips it', () => {
    const errors: Record<string, string[]> = {};
    const long = 'a'.repeat(65);
    expect(service.normalizeTags([long, 'ops'], errors)).toEqual(['ops']);
    expect(errors['tags']).toEqual([`tag "${long}" is longer than 64 characters`]);
  });

  it('rejects more than 32 tags', () => {
    const errors: Record<string, string[]> = {};
    const tags = Array.from({ length: 33 }, (_, i) => `t${i}`);
    expect(service.normalizeTags(tags, errors)).toHaveLength(33);
    expect(errors['tags']).toEqual(['no more than 32 tags allowed']);
  });

  it('accepts exactly 32 tags', () => {
    const errors: Record<string, string[]> = {};
    service.normalizeTags(Array.from({ length: 32 }, (_, i) => `t${i}`), errors);
    expect(errors).toEqual({});
  });
});

describe('normalizeMetadata', () => {
  const service = new McpMemoriesService(makeDb() as never);

  it('passes null and undefined through as null', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeMetadata(null, errors)).toBeNull();
    expect(service.normalizeMetadata(undefined, errors)).toBeNull();
    expect(errors).toEqual({});
  });

  it('accepts an object', () => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeMetadata({ a: 1 }, errors)).toEqual({ a: 1 });
    expect(errors).toEqual({});
  });

  it.each([
    ['an array', [1, 2]],
    ['a string', 'nope'],
    ['a number', 5],
  ])('rejects %s', (_label, value) => {
    const errors: Record<string, string[]> = {};
    expect(service.normalizeMetadata(value, errors)).toBeNull();
    expect(errors['metadata']).toEqual(['metadata must be an object']);
  });
});

describe('store', () => {
  it('creates a new key and publishes memory.created', async () => {
    const { service } = makeService();

    const out = (await service.store({ id: 'deploy.crane', content: ' ship it ', tags: ['ops'] }, host)) as {
      status: string;
      id: string;
      memory: Record<string, unknown> | null;
    };

    expect(out.status).toBe('created');
    expect(out.id).toBe('deploy.crane');
    expect(out.memory).toMatchObject({ id: 'deploy.crane', content: 'ship it', tags: ['ops'] });
    expect(memoryEventTypes()).toEqual(['memory.created']);
    expect(events[0]!.payload).toEqual({ id: 'deploy.crane', host_id: host.id });
  });

  it('generates a key when the payload omits one', async () => {
    const { service } = makeService();

    const out = (await service.store({ content: 'body' }, host)) as { status: string; id: string };

    expect(out.status).toBe('created');
    expect(out.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // The unchanged verdict is what stops every re-store from looking like a real
  // write, so tag order/case and metadata key order must not defeat it.
  it('reports unchanged when content, tags and metadata match up to case and order', async () => {
    const { db, service } = makeService([
      { memoryKey: 'k', content: 'same', tags: ['Ops', 'deploy'], metadata: { zulu: 1, alpha: 2 } },
    ]);

    const out = (await service.store(
      { id: 'k', content: 'same', tags: ['DEPLOY', 'ops'], metadata: { alpha: 2, zulu: 1 } },
      host,
    )) as { status: string };

    expect(out.status).toBe('unchanged');
    expect(memoryEventTypes()).toEqual(['memory.changed']);
    expect(db.inserts.some((i) => i.table === mcpMemories)).toBe(true);
  });

  it('reports updated when the content differs', async () => {
    const { service } = makeService([{ memoryKey: 'k', content: 'old' }]);

    const out = (await service.store({ id: 'k', content: 'new' }, host)) as { status: string };

    expect(out.status).toBe('updated');
    expect(memoryEventTypes()).toEqual(['memory.changed']);
  });

  it('reports updated when only the tags differ', async () => {
    const { service } = makeService([{ memoryKey: 'k', content: 'same', tags: ['ops'] }]);

    const out = (await service.store({ id: 'k', content: 'same', tags: ['ops', 'deploy'] }, host)) as {
      status: string;
    };

    expect(out.status).toBe('updated');
    expect(memoryEventTypes()).toEqual(['memory.changed']);
  });

  it('reports updated when only the metadata differs', async () => {
    const { service } = makeService([{ memoryKey: 'k', content: 'same', metadata: { a: 1 } }]);

    const out = (await service.store({ id: 'k', content: 'same', metadata: { a: 2 } }, host)) as { status: string };

    expect(out.status).toBe('updated');
    expect(memoryEventTypes()).toEqual(['memory.changed']);
  });

  it('persists tags as both a JSON array and the fulltext tags_text column', async () => {
    const { db, service } = makeService();

    await service.store({ id: 'k', content: 'body', tags: ['ops', 'deploy'] }, host, 'codex');

    const inserted = db.inserts.find((i) => i.table === mcpMemories)!.values as Record<string, unknown>;
    expect(inserted).toMatchObject({ tags: ['ops', 'deploy'], tagsText: 'ops deploy', engine: 'codex' });
  });

  it('nulls tags and tags_text when no tags are given', async () => {
    const { db, service } = makeService();

    await service.store({ id: 'k', content: 'body' }, host);

    const inserted = db.inserts.find((i) => i.table === mcpMemories)!.values as Record<string, unknown>;
    expect(inserted).toMatchObject({ tags: null, tagsText: null, metadata: null });
  });

  it.each([
    ['a blank content', { id: 'k', content: '   ' }],
    ['content over 32000 characters', { id: 'k', content: 'x'.repeat(32001) }],
    ['an illegal key', { id: 'bad key!', content: 'body' }],
    ['a reserved coco key', { id: 'coco.handoff', content: 'body' }],
    ['array metadata', { id: 'k', content: 'body', metadata: [1] }],
    ['non-array tags', { id: 'k', content: 'body', tags: 'ops' }],
  ])('rejects %s without touching the store', async (_label, payload) => {
    const { db, service } = makeService();

    await expect(service.store(payload as Record<string, unknown>, host)).rejects.toThrow(ValidationError);
    expect(db.inserts.some((i) => i.table === mcpMemories)).toBe(false);
    expect(memoryEventTypes()).toEqual([]);
  });
});

describe('retrieve', () => {
  it('returns found with the formatted row', async () => {
    const { service } = makeService([{ memoryKey: 'k', content: 'body', tags: ['ops'] }]);

    const out = (await service.retrieve({ memory_id: 'k' }, host)) as {
      status: string;
      memory: Record<string, unknown> | null;
    };

    expect(out.status).toBe('found');
    expect(out.memory).toMatchObject({ id: 'k', content: 'body', tags: ['ops'], host_id: host.id });
  });

  it('returns missing rather than throwing for an unknown key', async () => {
    const { service } = makeService();

    const out = (await service.retrieve({ key: 'nope' }, host)) as { status: string; memory: unknown };

    expect(out).toMatchObject({ status: 'missing', id: 'nope', memory: null });
  });

  it('rejects a blank id', async () => {
    const { service } = makeService();

    await expect(service.retrieve({ id: '  ' }, host)).rejects.toThrow(ValidationError);
    await expect(service.retrieve({}, host)).rejects.toThrow(ValidationError);
  });
});

describe('delete', () => {
  it('soft-deletes an existing key and publishes memory.deleted', async () => {
    const { db, service } = makeService([{ memoryKey: 'gone', content: 'bye' }]);

    const out = (await service.delete({ id: 'gone' }, host)) as { status: string; id: string };

    expect(out).toMatchObject({ status: 'deleted', id: 'gone' });
    const update = db.updates.find((u) => u.table === mcpMemories)!;
    expect(update.set['deletedAt']).toEqual(expect.any(String));
    expect(memoryEventTypes()).toEqual(['memory.deleted']);
  });

  it('reports missing without updating or publishing', async () => {
    const { db, service } = makeService();

    const out = (await service.delete({ id: 'nope' }, host)) as { status: string };

    expect(out.status).toBe('missing');
    expect(db.updates.some((u) => u.table === mcpMemories)).toBe(false);
    expect(memoryEventTypes()).toEqual([]);
  });

  it('rejects a blank id', async () => {
    const { service } = makeService();

    await expect(service.delete({ id: '  ' }, host)).rejects.toThrow(ValidationError);
    await expect(service.delete({}, host)).rejects.toThrow(ValidationError);
  });
});

describe('formatMemory', () => {
  const service = new McpMemoriesService(makeDb() as never);

  // Rows reach here from Drizzle (camelCase) and from the raw fulltext SELECT
  // (snake_case); both have to format identically.
  it('reads the snake_case shape of the raw fulltext query', () => {
    expect(
      service.formatMemory({
        id: '4',
        memory_key: 'k',
        host_id: 1,
        host_fqdn: 'host.example',
        content: 'body',
        metadata: { a: 1 },
        tags: '["ops"]',
        summary: 'sum',
        created_at: '2026-07-01T09:00:00Z',
        updated_at: '2026-07-02T09:00:00Z',
      }),
    ).toEqual({
      id: 'k',
      record_id: 4,
      host_id: 1,
      host: 'host.example',
      content: 'body',
      metadata: { a: 1 },
      tags: ['ops'],
      summary: 'sum',
      created_at: '2026-07-01T09:00:00Z',
      updated_at: '2026-07-02T09:00:00Z',
      score: null,
    });
  });

  it('reads the camelCase shape Drizzle returns', () => {
    expect(
      service.formatMemory({
        id: 4,
        memoryKey: 'k',
        hostId: 1,
        content: 'body',
        tags: ['ops'],
        createdAt: '2026-07-01T09:00:00Z',
        updatedAt: '2026-07-02T09:00:00Z',
      }),
    ).toMatchObject({
      id: 'k',
      record_id: 4,
      host_id: 1,
      host: null,
      metadata: null,
      tags: ['ops'],
      summary: null,
      created_at: '2026-07-01T09:00:00Z',
      updated_at: '2026-07-02T09:00:00Z',
    });
  });

  it('defaults the absent fields', () => {
    expect(service.formatMemory({})).toMatchObject({ id: null, record_id: null, content: '', tags: [], score: null });
  });

  it('prefers the explicit score and otherwise falls back to the row score', () => {
    expect(service.formatMemory({ memory_key: 'k', score: 1.5 })['score']).toBe(1.5);
    expect(service.formatMemory({ memory_key: 'k', score: 1.5 }, 2.5)['score']).toBe(2.5);
    expect(service.formatMemory({ memory_key: 'k', score: 'nope' })['score']).toBeNull();
  });
});
