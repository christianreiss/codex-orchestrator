import { describe, expect, it } from 'vitest';
import {
  decodeMemoryGraphCursor,
  memoryEtagForState,
  memoryNodeId,
  parseMemoryNodeId,
  sanitizeMemoryAuditDetails,
} from '../../../src/services/admin-memories.js';
import { resolveMemoryAuditContext } from '../../../src/services/admin-memory-audit.js';
import { boundedFacetItems, MEMORY_FACET_LIMIT } from '../../../src/services/admin-memory-catalog.js';
import { decodeGraphPosition, encodeGraphPosition } from '../../../src/services/admin-memory-model.js';

describe('AdminMemoriesService public helpers', () => {
  it('round-trips stable memory node identifiers', () => {
    expect(memoryNodeId('shared', 42)).toBe('memory:shared:42');
    expect(parseMemoryNodeId('memory:project:7')).toEqual({ scope: 'project', recordId: 7 });
    expect(() => parseMemoryNodeId('memory:host:key')).toThrow(/memory:<scope>:<recordId>/);
  });

  it('computes a deterministic full-state etag', () => {
    const a = memoryEtagForState({ content: 'body', metadata: { z: 1, a: { y: 2, x: 1 } }, tags: ['ops'] });
    const reordered = memoryEtagForState({
      tags: ['ops'],
      metadata: { a: { x: 1, y: 2 }, z: 1 },
      content: 'body',
    });
    const changedBody = memoryEtagForState({
      content: 'body 2',
      metadata: { z: 1, a: { y: 2, x: 1 } },
      tags: ['ops'],
    });
    const changedTags = memoryEtagForState({
      content: 'body',
      metadata: { z: 1, a: { y: 2, x: 1 } },
      tags: ['deploy'],
    });

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(a);
    expect(changedBody).not.toBe(a);
    expect(changedTags).not.toBe(a);
  });

  it('rejects a cursor copied to different filters', () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, offset: 25, fingerprint: 'filters-a' }),
      'utf8',
    ).toString('base64url');
    expect(decodeMemoryGraphCursor(cursor, 'filters-a')).toBe(25);
    expect(() => decodeMemoryGraphCursor(cursor, 'filters-b')).toThrow(/cursor is invalid/);
    expect(() => decodeMemoryGraphCursor('not-json', 'filters-a')).toThrow(/cursor is invalid/);
  });

  it('round-trips the bounded graph keyset cursor', () => {
    const cursor = encodeGraphPosition(
      { updatedAt: '2026-07-28T09:00:00Z', scope: 'project', recordId: 41 },
      'filters-a',
    );
    expect(decodeGraphPosition(cursor, 'filters-a')).toEqual({
      updatedAt: '2026-07-28T09:00:00Z',
      scope: 'project',
      recordId: 41,
    });
    expect(() => decodeGraphPosition(cursor, 'filters-b')).toThrow(/cursor is invalid/);
  });

  it('bounds high-cardinality facet responses and reports truncation', () => {
    const values = Array.from({ length: MEMORY_FACET_LIMIT + 1 }, (_, index) => ({ value: `tag-${index}` }));
    expect(boundedFacetItems(values)).toEqual({
      items: values.slice(0, MEMORY_FACET_LIMIT),
      truncated: true,
    });
    expect(boundedFacetItems(values.slice(0, MEMORY_FACET_LIMIT))).toMatchObject({ truncated: false });
  });

  it('retains body-free length/count evidence while redacting bodies and metadata', () => {
    expect(
      sanitizeMemoryAuditDetails({
        content: 'secret body',
        old_content: 'older secret body',
        preview: 'secret preview',
        metadata: { secret: true },
        content_length: 123,
        old_content_length: 100,
        tag_count: 4,
        content_sha256: 'abc',
      }),
    ).toEqual({
      content_length: 123,
      old_content_length: 100,
      tag_count: 4,
      content_sha256: 'abc',
    });
  });

  it('recovers legacy correlation context from the retained delete event after the row is gone', () => {
    expect(
      resolveMemoryAuditContext(null, {
        node_id: 'memory:project:77',
        memory_id: 'deploy.crane',
        project_id: 12,
        project_slug: 'orchestrator',
        host_id: null,
        content: 'must not be needed for correlation',
        metadata: { secret: true },
      }),
    ).toEqual({
      key: 'deploy.crane',
      hostId: null,
      projectId: 12,
      projectSlug: 'orchestrator',
    });
  });
});
