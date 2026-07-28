import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '../../../src/http/errors.js';
import {
  assertEtag,
  etagForRow,
  memoryCapabilities,
  memoryNodeId,
  normalizeContent,
  normalizeEngine,
  normalizeMemoryKey,
  normalizeNullableText,
  normalizePositiveInt,
  normalizeSharedSlug,
  normalizeTags,
  parseMemoryNodeId,
} from '../../../src/services/admin-memory-model.js';
import type { UnifiedMemoryRow } from '../../../src/services/admin-memory-model.js';

function makeRow(overrides: Partial<UnifiedMemoryRow> = {}): UnifiedMemoryRow {
  return {
    scope: 'project',
    recordId: 41,
    key: 'deploy.crane',
    title: 'Deploy crane',
    summary: 'How prod is deployed',
    content: 'ssh crane && npm run build',
    metadata: { owner: 'ops', links: { runbook: 'docs/deploy.md', ticket: 'OPS-12' } },
    tags: ['ops', 'deploy'],
    contentLength: 25,
    preview: 'ssh crane',
    ownerHostId: null,
    ownerHost: null,
    projectId: 7,
    projectSlug: 'orchestrator',
    sourceHostId: 1,
    sourceHost: 'host.example',
    engine: 'codex',
    revision: 3,
    createdAt: '2026-07-01T08:00:00Z',
    updatedAt: '2026-07-28T09:00:00Z',
    ...overrides,
  };
}

describe('admin memory etag concurrency gate', () => {
  it('ignores key insertion order but tracks every hashed field', () => {
    const base = makeRow();
    const reordered = makeRow({
      metadata: { links: { ticket: 'OPS-12', runbook: 'docs/deploy.md' }, owner: 'ops' },
    });

    expect(etagForRow(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(etagForRow(reordered)).toBe(etagForRow(base));

    const mutations: Partial<UnifiedMemoryRow>[] = [
      { scope: 'shared' },
      { recordId: 42 },
      { key: 'deploy.other' },
      { title: 'Deploy crane v2' },
      { summary: null },
      { content: 'ssh crane && npm run build --force' },
      { metadata: { owner: 'sre', links: { runbook: 'docs/deploy.md', ticket: 'OPS-12' } } },
      { tags: ['ops'] },
      { ownerHostId: 4 },
      { projectId: 8 },
      { sourceHostId: 2 },
      { engine: 'claude' },
      { revision: 4 },
      { createdAt: '2026-07-02T08:00:00Z' },
      { updatedAt: '2026-07-28T10:00:00Z' },
    ];
    for (const mutation of mutations) {
      expect(etagForRow(makeRow(mutation)), Object.keys(mutation)[0]).not.toBe(etagForRow(base));
    }
  });

  it('accepts the current etag in bare, quoted and weak forms', () => {
    const row = makeRow();
    const current = etagForRow(row);

    expect(() => assertEtag(current, row)).not.toThrow();
    expect(() => assertEtag(`"${current}"`, row)).not.toThrow();
    expect(() => assertEtag(`W/"${current}"`, row)).not.toThrow();
    expect(() => assertEtag(`  W/${current}  `, row)).not.toThrow();
  });

  it('requires a non-blank string expected_etag', () => {
    const row = makeRow();
    for (const expected of [undefined, null, '', '   ', 42, { etag: etagForRow(row) }]) {
      expect(() => assertEtag(expected, row)).toThrow(ValidationError);
    }
    expect(() => assertEtag(undefined, row)).toThrow(/expected_etag is required/);
  });

  it('reports the current etag and node id when the row moved on', () => {
    const stale = etagForRow(makeRow());
    const changed = makeRow({ content: 'ssh crane && npm run build --force' });

    let caught: unknown;
    try {
      assertEtag(stale, changed);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught).toMatchObject({
      status: 409,
      code: 'memory_conflict',
      extra: { current_etag: etagForRow(changed), node_id: 'memory:project:41' },
    });
  });
});

describe('admin memory node identifiers and capabilities', () => {
  it('round-trips node identifiers and rejects malformed ones', () => {
    expect(memoryNodeId('host', 3)).toBe('memory:host:3');
    expect(parseMemoryNodeId(memoryNodeId('shared', 42))).toEqual({ scope: 'shared', recordId: 42 });
    expect(parseMemoryNodeId('  memory:project:7  ')).toEqual({ scope: 'project', recordId: 7 });

    for (const value of ['memory:global:1', 'memory:host:0', 'memory:host:01', 'memory:host:key', 'nope']) {
      expect(() => parseMemoryNodeId(value), value).toThrow(ValidationError);
    }
  });

  it('offers append only on shared memories the caller may mutate', () => {
    expect(memoryCapabilities('shared', true)).toEqual({
      read: true,
      create: true,
      update: true,
      delete: true,
      append: true,
    });
    expect(memoryCapabilities('project', true)).toMatchObject({ update: true, append: false });
    expect(memoryCapabilities('host', true)).toMatchObject({ update: true, append: false });
    expect(memoryCapabilities('shared', false)).toEqual({
      read: true,
      create: false,
      update: false,
      delete: false,
      append: false,
    });
  });
});

describe('admin memory input normalizers', () => {
  it('bounds memory keys and reserves coco ids outside project scope', () => {
    expect(normalizeMemoryKey('  deploy.crane  ', 'host')).toBe('deploy.crane');
    expect(normalizeMemoryKey('a-b_c:d.1', 'host')).toBe('a-b_c:d.1');
    expect(normalizeMemoryKey('k'.repeat(128), 'host')).toHaveLength(128);

    expect(() => normalizeMemoryKey('k'.repeat(129), 'host')).toThrow(/at most 128/);
    expect(() => normalizeMemoryKey('deploy crane', 'host')).toThrow(ValidationError);
    expect(() => normalizeMemoryKey('deploy/crane', 'host')).toThrow(ValidationError);
    expect(() => normalizeMemoryKey('   ', 'host')).toThrow(/id is required/);
    expect(() => normalizeMemoryKey(42, 'host')).toThrow(/id is required/);

    expect(() => normalizeMemoryKey('coco', 'host')).toThrow(/reserved/);
    expect(() => normalizeMemoryKey('COCO.plan', 'host')).toThrow(/reserved/);
    expect(normalizeMemoryKey('cocoa.beans', 'host')).toBe('cocoa.beans');
    expect(normalizeMemoryKey('coco.plan', 'project')).toBe('coco.plan');
  });

  it('lowercases shared slugs and rejects invalid ones', () => {
    expect(normalizeSharedSlug('  Deploy.Crane  ')).toBe('deploy.crane');
    expect(normalizeSharedSlug('s'.repeat(160))).toHaveLength(160);

    expect(() => normalizeSharedSlug('s'.repeat(161))).toThrow(/shared-memory slug/);
    expect(() => normalizeSharedSlug('-leading-hyphen')).toThrow(/shared-memory slug/);
    expect(() => normalizeSharedSlug('has space')).toThrow(ValidationError);
    expect(() => normalizeSharedSlug('')).toThrow(/id is required/);
    expect(() => normalizeSharedSlug(null)).toThrow(/id is required/);
  });

  it('normalizes, dedupes and bounds tags', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(['Ops', ' ops ', 'OPS', 'Deploy'])).toEqual(['Ops', 'Deploy']);
    expect(normalizeTags('ops, deploy ,')).toEqual(['ops', 'deploy']);
    expect(normalizeTags(['ops', 42, null])).toEqual(['ops']);
    expect(normalizeTags(Array.from({ length: 32 }, (_, index) => `tag-${index}`))).toHaveLength(32);
    expect(normalizeTags(['t'.repeat(64)])).toEqual(['t'.repeat(64)]);

    expect(() => normalizeTags(Array.from({ length: 33 }, (_, index) => `tag-${index}`))).toThrow(
      /no more than 32 tags/,
    );
    expect(() => normalizeTags(['t'.repeat(65)])).toThrow(/longer than 64 characters/);
    expect(() => normalizeTags({ ops: true })).toThrow(/tags must be an array of strings/);
    expect(() => normalizeTags(7)).toThrow(ValidationError);
  });

  it('requires trimmed content within the caller-supplied limit', () => {
    expect(normalizeContent('  body  ', 16)).toBe('body');
    expect(normalizeContent('b'.repeat(16), 16)).toHaveLength(16);

    expect(() => normalizeContent('b'.repeat(17), 16)).toThrow(/content must be 16 characters or fewer/);
    expect(() => normalizeContent('   ', 16)).toThrow(/content is required/);
    expect(() => normalizeContent(null, 16)).toThrow(/content is required/);
  });

  it('treats empty nullable text as null and bounds the rest', () => {
    expect(normalizeNullableText(undefined, 'summary', 8)).toBeNull();
    expect(normalizeNullableText(null, 'summary', 8)).toBeNull();
    expect(normalizeNullableText('', 'summary', 8)).toBeNull();
    expect(normalizeNullableText('   ', 'summary', 8)).toBeNull();
    expect(normalizeNullableText('  hi  ', 'summary', 8)).toBe('hi');

    expect(() => normalizeNullableText(42, 'summary', 8)).toThrow(/summary must be a string or null/);
    expect(() => normalizeNullableText('s'.repeat(9), 'summary', 8)).toThrow(
      /summary must be 8 characters or fewer/,
    );
  });

  it('accepts the known engines and null', () => {
    expect(normalizeEngine('codex')).toBe('codex');
    expect(normalizeEngine('claude')).toBe('claude');
    expect(normalizeEngine(undefined)).toBeNull();
    expect(normalizeEngine(null)).toBeNull();
    expect(normalizeEngine('')).toBeNull();

    expect(() => normalizeEngine('gemini')).toThrow(/engine must be codex, claude, or null/);
    expect(() => normalizeEngine(1)).toThrow(ValidationError);
  });

  it('parses positive integers and names the offending param', () => {
    expect(normalizePositiveInt(1, 'limit')).toBe(1);
    expect(normalizePositiveInt('42', 'limit')).toBe(42);

    for (const value of [0, -1, 1.5, 'abc', '', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => normalizePositiveInt(value, 'limit'), String(value)).toThrow(ValidationError);
    }
    expect(() => normalizePositiveInt(0, 'record_id')).toThrow(/record_id must be a positive integer/);
  });
});
