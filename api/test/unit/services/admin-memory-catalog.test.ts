/**
 * Direct coverage for AdminMemoryCatalog's read path. The route tests only see
 * the service wrapper, so the three per-scope `loadRow` shapes — which differ in
 * key/title/summary/owner/source/engine/revision mapping and in where the
 * content length comes from — and the filter normalization that derives the
 * cursor fingerprint are only pinned here. A copy-paste slip between the
 * branches still typechecks, hence the field-by-field assertions.
 */
import { Column, getTableName, Param, SQL, type Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../../src/http/errors.js';
import {
  AdminMemoryCatalog,
  boundedFacetItems,
  MEMORY_FACET_LIMIT,
} from '../../../src/services/admin-memory-catalog.js';
import {
  encodeGraphPosition,
  MEMORY_SCOPES,
  toMemoryDetail,
  type GraphFilters,
  type MemoryScope,
} from '../../../src/services/admin-memory-model.js';
import type { Database } from '../../../src/db/client.js';

interface RecordedQuery {
  from: string;
  joins: Array<{ kind: 'inner' | 'left'; table: string }>;
  /** `table.column` for every column named by the WHERE tree. */
  whereColumns: string[];
  whereValues: unknown[];
  limit: number | null;
}

interface QueryChain {
  from(table: Table): QueryChain;
  innerJoin(table: Table, on: unknown): QueryChain;
  leftJoin(table: Table, on: unknown): QueryChain;
  where(condition: unknown): QueryChain;
  limit(count: number): Promise<unknown[]>;
}

interface CatalogDb {
  db: Database;
  queries: RecordedQuery[];
}

/**
 * The joined selects `loadRow` issues are out of reach for test/helpers/db-fake.ts,
 * so this stub records the drizzle chain and hands back the canned rows verbatim —
 * the projection is irrelevant because the fixtures are already row-shaped.
 */
function createCatalogDb(rows: unknown[]): CatalogDb {
  const queries: RecordedQuery[] = [];
  const db = {
    select(_fields?: unknown) {
      const query: RecordedQuery = {
        from: '',
        joins: [],
        whereColumns: [],
        whereValues: [],
        limit: null,
      };
      const chain: QueryChain = {
        from(table: Table) {
          query.from = getTableName(table);
          queries.push(query);
          return chain;
        },
        innerJoin(table: Table, _on: unknown) {
          query.joins.push({ kind: 'inner', table: getTableName(table) });
          return chain;
        },
        leftJoin(table: Table, _on: unknown) {
          query.joins.push({ kind: 'left', table: getTableName(table) });
          return chain;
        },
        where(condition: unknown) {
          collectCondition(condition, query);
          return chain;
        },
        limit: async (count: number) => {
          query.limit = count;
          return rows;
        },
      };
      return chain;
    },
  };
  return { db: db as unknown as Database, queries };
}

/** Flattens a drizzle condition tree into the columns it reads and the values it binds. */
function collectCondition(node: unknown, into: { whereColumns: string[]; whereValues: unknown[] }): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCondition(item, into);
    return;
  }
  if (node instanceof Column) {
    into.whereColumns.push(`${getTableName(node.table)}.${node.name}`);
    return;
  }
  if (node instanceof Param) {
    into.whereValues.push(node.value);
    return;
  }
  if (node instanceof SQL) collectCondition(node.queryChunks, into);
}

function caught(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

const HOST_CONTENT = `crane deploy runbook — ${'x'.repeat(400)}`;
const PROJECT_CONTENT = `coordination plan — ${'y'.repeat(400)}`;
const SHARED_CONTENT = `fleet-wide note — ${'z'.repeat(400)}`;
const CREATED_AT = '2026-07-01T08:00:00Z';
const UPDATED_AT = '2026-07-28T09:00:00Z';

/** `select({ memory: mcpMemories, host: hosts.fqdn })` for a host-scoped memory. */
function hostSelection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory: {
      id: 17,
      hostId: 4,
      memoryKey: 'deploy.crane',
      content: HOST_CONTENT,
      metadata: { owner: 'ops' },
      tags: ['Ops', 'deploy'],
      tagsText: 'Ops deploy',
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      deletedAt: null,
      summary: 'How prod is deployed',
      engine: 'codex',
      ...overrides,
    },
    host: 'crane.alpha-labs.net',
  };
}

/** `select({ memory: coordProjectMemories, projectId, projectSlug, sourceHost })`. */
function projectSelection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory: {
      id: 41,
      projectId: 7,
      memoryKey: 'coco.plan',
      content: PROJECT_CONTENT,
      metadata: null,
      // The JSON column arrives as a string from some drivers; parseTags takes both.
      tags: '["Coord","plan"]',
      tagsText: 'Coord plan',
      sourceHostId: 9,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      ...overrides,
    },
    projectId: 7,
    projectSlug: 'orchestrator',
    sourceHost: 'worker.alpha-labs.net',
  };
}

/** `select({ memory: sharedMemories, sourceHost: hosts.fqdn })`. */
function sharedSelection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory: {
      id: 5,
      slug: 'shared-memory-substrate',
      title: 'Shared memory substrate',
      summary: 'Fleet-wide memory tables',
      content: SHARED_CONTENT,
      contentSha256: 'a'.repeat(64),
      // Deliberately not SHARED_CONTENT.length: shared reads the stored column.
      contentLength: 4096,
      chunkCount: 3,
      revision: 12,
      metadata: { source: 'crane' },
      tags: ['fleet'],
      tagsText: 'fleet',
      sourceHostId: 4,
      sourceEngine: 'claude',
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      deletedAt: null,
      ...overrides,
    },
    sourceHost: 'crane.alpha-labs.net',
  };
}

describe('AdminMemoryCatalog.loadRow', () => {
  it('maps a host memory onto the unified row', async () => {
    const stub = createCatalogDb([hostSelection()]);
    const row = await new AdminMemoryCatalog(stub.db).loadRow('host', 17);

    expect(row).toEqual({
      scope: 'host',
      recordId: 17,
      key: 'deploy.crane',
      title: 'deploy.crane',
      summary: 'How prod is deployed',
      content: HOST_CONTENT,
      metadata: { owner: 'ops' },
      tags: ['Ops', 'deploy'],
      contentLength: HOST_CONTENT.length,
      preview: HOST_CONTENT.slice(0, 280),
      ownerHostId: 4,
      ownerHost: 'crane.alpha-labs.net',
      projectId: null,
      projectSlug: null,
      sourceHostId: null,
      sourceHost: null,
      engine: 'codex',
      revision: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    expect(row?.preview).toHaveLength(280);
    expect(row?.contentLength).toBeGreaterThan(280);

    expect(stub.queries).toEqual([
      {
        from: 'mcp_memories',
        joins: [{ kind: 'left', table: 'hosts' }],
        whereColumns: ['mcp_memories.id', 'mcp_memories.deleted_at'],
        whereValues: [17],
        limit: 1,
      },
    ]);
  });

  it('maps a project memory onto the unified row', async () => {
    const stub = createCatalogDb([projectSelection()]);
    const row = await new AdminMemoryCatalog(stub.db).loadRow('project', 41);

    expect(row).toEqual({
      scope: 'project',
      recordId: 41,
      key: 'coco.plan',
      title: 'coco.plan',
      summary: null,
      content: PROJECT_CONTENT,
      metadata: null,
      tags: ['Coord', 'plan'],
      contentLength: PROJECT_CONTENT.length,
      preview: PROJECT_CONTENT.slice(0, 280),
      ownerHostId: null,
      ownerHost: null,
      projectId: 7,
      projectSlug: 'orchestrator',
      sourceHostId: 9,
      sourceHost: 'worker.alpha-labs.net',
      engine: null,
      revision: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });

    // coord_project_memories has no soft-delete column; the project id comes
    // from the joined row, not from the memory's own project_id.
    expect(stub.queries).toEqual([
      {
        from: 'coord_project_memories',
        joins: [
          { kind: 'inner', table: 'coord_projects' },
          { kind: 'left', table: 'hosts' },
        ],
        whereColumns: ['coord_project_memories.id'],
        whereValues: [41],
        limit: 1,
      },
    ]);
  });

  it('maps a shared memory onto the unified row', async () => {
    const stub = createCatalogDb([sharedSelection()]);
    const row = await new AdminMemoryCatalog(stub.db).loadRow('shared', 5);

    expect(row).toEqual({
      scope: 'shared',
      recordId: 5,
      key: 'shared-memory-substrate',
      title: 'Shared memory substrate',
      summary: 'Fleet-wide memory tables',
      content: SHARED_CONTENT,
      metadata: { source: 'crane' },
      tags: ['fleet'],
      contentLength: 4096,
      preview: SHARED_CONTENT.slice(0, 280),
      ownerHostId: null,
      ownerHost: null,
      projectId: null,
      projectSlug: null,
      sourceHostId: 4,
      sourceHost: 'crane.alpha-labs.net',
      engine: 'claude',
      revision: 12,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    expect(row?.contentLength).not.toBe(SHARED_CONTENT.length);

    expect(stub.queries).toEqual([
      {
        from: 'shared_memories',
        joins: [{ kind: 'left', table: 'hosts' }],
        whereColumns: ['shared_memories.id', 'shared_memories.deleted_at'],
        whereValues: [5],
        limit: 1,
      },
    ]);
  });

  it('collapses the missing host columns and join miss to null', async () => {
    const stub = createCatalogDb([
      { ...hostSelection({ metadata: null, summary: null, engine: null, tags: null }), host: null },
    ]);
    const row = await new AdminMemoryCatalog(stub.db).loadRow('host', 17);

    expect(row).toMatchObject({
      summary: null,
      metadata: null,
      tags: [],
      ownerHostId: 4,
      ownerHost: null,
      engine: null,
      revision: null,
    });
  });

  it('collapses an unattributed project source host to null', async () => {
    const stub = createCatalogDb([{ ...projectSelection({ sourceHostId: null }), sourceHost: null }]);
    const row = await new AdminMemoryCatalog(stub.db).loadRow('project', 41);

    expect(row).toMatchObject({ sourceHostId: null, sourceHost: null, projectId: 7 });
  });

  it('collapses an unattributed shared source host and engine to null', async () => {
    const stub = createCatalogDb([
      { ...sharedSelection({ sourceHostId: null, sourceEngine: null, summary: null }), sourceHost: null },
    ]);
    const row = await new AdminMemoryCatalog(stub.db).loadRow('shared', 5);

    expect(row).toMatchObject({
      summary: null,
      sourceHostId: null,
      sourceHost: null,
      engine: null,
      revision: 12,
    });
  });

  it.each(MEMORY_SCOPES)('returns null when no %s row matches', async (scope) => {
    const stub = createCatalogDb([]);
    await expect(new AdminMemoryCatalog(stub.db).loadRow(scope, 999)).resolves.toBeNull();
    expect(stub.queries).toHaveLength(1);
  });
});

describe('AdminMemoryCatalog.detail', () => {
  it('throws a 404 memory_not_found when the row is gone', async () => {
    const catalog = new AdminMemoryCatalog(createCatalogDb([]).db);
    const error = await catalog.detail('host', 17, true).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).status).toBe(404);
    expect((error as NotFoundError).code).toBe('memory_not_found');
  });

  it('returns the toMemoryDetail projection of the loaded row', async () => {
    const catalog = new AdminMemoryCatalog(createCatalogDb([sharedSelection()]).db);
    const row = await catalog.loadRow('shared', 5);
    if (!row) throw new Error('expected the shared fixture row');

    const detail = await catalog.detail('shared', 5, true);

    expect(detail).toEqual(toMemoryDetail(row, true));
    expect(detail.node_id).toBe('memory:shared:5');
    expect(detail.id).toBe('shared-memory-substrate');
    expect(detail.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.capabilities).toEqual({
      read: true,
      create: true,
      update: true,
      delete: true,
      append: true,
    });
  });

  it('passes canMutate through to the capabilities', async () => {
    const catalog = new AdminMemoryCatalog(createCatalogDb([hostSelection()]).db);
    const detail = await catalog.detail('host', 17, false);

    expect(detail.capabilities).toEqual({
      read: true,
      create: false,
      update: false,
      delete: false,
      append: false,
    });
  });
});

/** normalizeGraphFilters is private; graph() would need the whole facet fan-out. */
interface FilterProbe {
  normalizeGraphFilters(input: Record<string, unknown>): GraphFilters;
}

function normalizeFilters(input: Record<string, unknown>): GraphFilters {
  const catalog = new AdminMemoryCatalog(createCatalogDb([]).db);
  return (catalog as unknown as FilterProbe).normalizeGraphFilters(input);
}

describe('AdminMemoryCatalog graph filter normalization', () => {
  it('rejects an unknown scope', () => {
    const error = caught(() => normalizeFilters({ scopes: ['host', 'galaxy'] }));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).param).toBe('scopes');
    expect((error as ValidationError).message).toContain('galaxy');
  });

  it.each([{}, { scopes: [] }, { scopes: '' }, { scope: '  ' }])(
    'defaults %j to every memory scope',
    (input) => {
      expect(normalizeFilters(input).scopes).toEqual([...MEMORY_SCOPES]);
    },
  );

  it('accepts the singular scope alias and a comma list', () => {
    expect(normalizeFilters({ scope: 'shared' }).scopes).toEqual(['shared']);
    expect(normalizeFilters({ scopes: 'host, shared' }).scopes).toEqual(['host', 'shared']);
    // `scopes` wins when both are present.
    expect(normalizeFilters({ scopes: 'project', scope: 'shared' }).scopes).toEqual(['project']);
  });

  it('lowercases tags', () => {
    expect(normalizeFilters({ tags: 'Ops,DEPLOY' }).tags).toEqual(['ops', 'deploy']);
    expect(normalizeFilters({ tags: ['Fleet', ' Ops '] }).tags).toEqual(['fleet', 'ops']);
    expect(normalizeFilters({}).tags).toEqual([]);
  });

  it('reads the search term from q or the query alias', () => {
    expect(normalizeFilters({ q: '  crane  ' }).q).toBe('crane');
    expect(normalizeFilters({ query: ' fleet ' }).q).toBe('fleet');
    expect(normalizeFilters({ q: 'crane', query: 'fleet' }).q).toBe('crane');
    expect(normalizeFilters({ q: 7, query: 'fleet' }).q).toBe('fleet');
    expect(normalizeFilters({}).q).toBe('');
  });

  it.each([{}, { host_id: null }, { host_id: '' }])('collapses %j to a null host_id', (input) => {
    expect(normalizeFilters(input).hostId).toBeNull();
  });

  it('parses and validates a supplied host_id', () => {
    expect(normalizeFilters({ host_id: '7' }).hostId).toBe(7);
    expect(normalizeFilters({ host_id: 7 }).hostId).toBe(7);
    const error = caught(() => normalizeFilters({ host_id: 0 }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).param).toBe('host_id');
  });

  it.each([{}, { engine: null }, { engine: '' }])('collapses %j to a null engine', (input) => {
    expect(normalizeFilters(input).engine).toBeNull();
  });

  it('parses and validates a supplied engine', () => {
    expect(normalizeFilters({ engine: 'codex' }).engine).toBe('codex');
    expect(normalizeFilters({ engine: 'claude' }).engine).toBe('claude');
    const error = caught(() => normalizeFilters({ engine: 'gemini' }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).param).toBe('engine');
  });

  it('trims a project_slug and treats a blank one as absent', () => {
    expect(normalizeFilters({ project_slug: ' orchestrator ' }).projectSlug).toBe('orchestrator');
    expect(normalizeFilters({ project_slug: '   ' }).projectSlug).toBeNull();
    expect(normalizeFilters({}).projectSlug).toBeNull();
  });

  it.each([
    [undefined, 500],
    [0, 1],
    [-5, 1],
    [5000, 2000],
    [2000, 2000],
    ['not-a-number', 500],
    [Number.POSITIVE_INFINITY, 500],
    ['250', 250],
    [12.9, 12],
  ])('clamps limit %j to %i', (limit, expected) => {
    expect(normalizeFilters(limit === undefined ? {} : { limit }).limit).toBe(expected);
  });

  it('binds the cursor to the fingerprint it derives from the filters', () => {
    const filters = normalizeFilters({ scopes: 'shared', tags: 'Ops' });
    expect(filters.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(filters.position).toBeNull();
    // Only the normalized values feed the fingerprint.
    expect(normalizeFilters({ tags: ['OPS'], scopes: 'shared' }).fingerprint).toBe(filters.fingerprint);

    const cursor = encodeGraphPosition(
      { updatedAt: UPDATED_AT, scope: 'shared', recordId: 5 },
      filters.fingerprint,
    );
    expect(normalizeFilters({ scopes: 'shared', tags: 'Ops', cursor }).position).toEqual({
      updatedAt: UPDATED_AT,
      scope: 'shared' as MemoryScope,
      recordId: 5,
    });
    expect(normalizeFilters({ scopes: 'shared', tags: 'Ops', cursor: '' }).position).toBeNull();

    const error = caught(() => normalizeFilters({ scopes: 'shared', tags: 'Ops', limit: 10, cursor }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).param).toBe('cursor');
  });
});

describe('boundedFacetItems', () => {
  const items = (count: number): Array<{ value: string }> =>
    Array.from({ length: count }, (_, index) => ({ value: `tag-${index}` }));

  it('passes a facet list one item under the cap through untouched', () => {
    const values = items(MEMORY_FACET_LIMIT - 1);
    expect(boundedFacetItems(values)).toEqual({ items: values, truncated: false });
  });

  it('reports exactly the cap as untruncated', () => {
    const values = items(MEMORY_FACET_LIMIT);
    expect(boundedFacetItems(values)).toEqual({ items: values, truncated: false });
  });

  it('trims one item over the cap and flags truncation', () => {
    const values = items(MEMORY_FACET_LIMIT + 1);
    expect(boundedFacetItems(values)).toEqual({
      items: values.slice(0, MEMORY_FACET_LIMIT),
      truncated: true,
    });
  });
});
