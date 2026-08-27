/**
 * ProjectsService itself, over the in-memory db fake: the seq allocator every
 * mutation funnels through (host-projects and project-content reach the same
 * one via `_recordEvent`), the six-table cascade delete, the detail/change
 * feed shapes clients poll, and the projects_module_enabled flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coordProjectEvents,
  coordProjectFeedback,
  coordProjectFiles,
  coordProjectMemories,
  coordProjectNotes,
  coordProjects,
  coordProjectTodos,
  coordProjectBoards,
  coordProjectBoardColumns,
  coordProjectCards,
  versions,
} from '../../../src/db/schema.js';
import { ApiError, ConflictError, NotFoundError } from '../../../src/http/errors.js';
import { ProjectsService } from '../../../src/services/projects.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

type Row = Record<string, unknown>;

const NOW = '2026-07-20T10:00:00Z';
const LATER = '2026-07-20T11:30:00Z';
const FLAG = 'projects_module_enabled';
const MANAGED_SKILL = { slug: 'coco', uri: 'skill://coco' };

/**
 * db-fake mirrors the host-api services, which never call `.$returningId()`.
 * ProjectsService needs it for both the project row and every event row, so
 * surface the generated id on top of the fake's insert builder.
 */
function withReturningId(db: DbFake): DbFake {
  const insert = db.insert.bind(db);
  db.insert = (table: unknown) => {
    const builder = insert(table) as { values(vals: Row): Promise<Array<{ insertId: number }>> };
    return {
      values: (vals: Row) => {
        const result = builder.values(vals);
        return Object.assign(result, {
          $returningId: async () => (await result).map((row) => ({ id: row.insertId })),
        });
      },
    };
  };
  return db;
}

/**
 * db-fake's select only decodes `eq(...)`, ignores `orderBy` and hands back
 * whole rows. ProjectsService projects a single column (`select({ seq })` in
 * recordEvent), filters the change feed with `gt(seq, since)` and relies on
 * `desc(seq)` + LIMIT to pick the newest events, so layer those three on top
 * of the fake's eq filtering.
 */
function withRichSelect(db: DbFake): DbFake {
  const select = db.select.bind(db);
  db.select = (fields?: unknown) => {
    const projection = fields as Record<string, unknown> | undefined;
    return {
      from(table: unknown) {
        const source = (select() as { from(table: unknown): unknown }).from(table) as PromiseLike<Row[]> & {
          where(condition: unknown): PromiseLike<Row[]>;
        };
        let rows: PromiseLike<Row[]> = source;
        let above: Array<{ column: string; value: number }> = [];
        let order: unknown[] = [];
        let max: number | null = null;
        const run = async (): Promise<Row[]> => {
          let out = [...(await rows)].filter((row) =>
            above.every(({ column, value }) => Number(rowValue(row, column)) > value),
          );
          if (order.length > 0) out.sort(comparator(order));
          if (max !== null) out = out.slice(0, max);
          return projection ? out.map((row) => project(row, projection)) : out;
        };
        const chain: SelectChain = {
          where(condition: unknown) {
            rows = source.where(condition);
            above = greaterThans(condition);
            return chain;
          },
          orderBy(...terms: unknown[]) {
            order = terms;
            return chain;
          },
          limit(count: number) {
            max = count;
            return chain;
          },
          for() {
            return chain;
          },
          then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
        };
        return chain;
      },
    };
  };
  return db;
}

interface SelectChain extends PromiseLike<Row[]> {
  where(condition: unknown): SelectChain;
  orderBy(...terms: unknown[]): SelectChain;
  limit(count: number): SelectChain;
  for(strength?: unknown): SelectChain;
}

function chunksOf(node: unknown): unknown[] {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  return Array.isArray(chunks) ? chunks : [];
}

function isColumn(chunk: unknown): chunk is { name: string } {
  return (
    !!chunk &&
    typeof chunk === 'object' &&
    typeof (chunk as { name?: unknown }).name === 'string' &&
    'table' in chunk
  );
}

function isParam(chunk: unknown): chunk is { value: unknown } {
  return !!chunk && typeof chunk === 'object' && chunk.constructor?.name === 'Param' && 'value' in chunk;
}

/** The literal SQL of a fragment, e.g. `' > '` for gt or `' desc'` for desc. */
function sqlText(chunks: unknown[]): string {
  return chunks
    .map((chunk) => {
      if (!chunk || typeof chunk !== 'object' || chunk.constructor?.name !== 'StringChunk') return '';
      const raw = (chunk as { value?: unknown }).value;
      return Array.isArray(raw) ? raw.join('') : String(raw ?? '');
    })
    .join('');
}

/** The `gt(column, value)` comparisons db-fake's eq-only filter drops. */
function greaterThans(
  condition: unknown,
  out: Array<{ column: string; value: number }> = [],
): Array<{ column: string; value: number }> {
  const chunks = chunksOf(condition);
  const column = chunks.find(isColumn);
  const param = chunks.find(isParam);
  if (column && param && /\s>\s/.test(sqlText(chunks))) {
    out.push({ column: column.name, value: Number(param.value) });
    return out;
  }
  for (const chunk of chunks) greaterThans(chunk, out);
  return out;
}

/** Turn drizzle's `asc(column)` / `desc(column)` terms into a row comparator. */
function comparator(terms: unknown[]): (a: Row, b: Row) => number {
  const keys = terms.map((term) => {
    const chunks = chunksOf(term);
    return {
      column: chunks.find(isColumn)?.name ?? '',
      descending: /\sdesc$/.test(sqlText(chunks)),
    };
  });
  return (a, b) => {
    for (const { column, descending } of keys) {
      const left = rowValue(a, column);
      const right = rowValue(b, column);
      if (left === right) continue;
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
      return descending ? -order : order;
    }
    return 0;
  };
}

function project(row: Row, fields: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [alias, column] of Object.entries(fields)) {
    if (isColumn(column)) out[alias] = rowValue(row, column.name);
  }
  return out;
}

function rowValue(row: Row, column: string): unknown {
  if (column in row) return row[column];
  return row[column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())];
}

function makeDb(): DbFake {
  const db = withReturningId(withRichSelect(createDbFake()));
  db.tables.set(coordProjects, []);
  db.tables.set(coordProjectEvents, []);
  db.tables.set(versions, []);
  return db;
}

function rowsOf(db: DbFake, table: unknown): Row[] {
  return db.tables.get(table) ?? [];
}

function makeService(db: DbFake): ProjectsService {
  return new ProjectsService(db as never);
}

/** Resolve to the error a call threw, failing the test if it resolved instead. */
async function caught(promise: Promise<unknown>): Promise<ApiError> {
  return await promise.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (err: ApiError) => err,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProjectsService.create', () => {
  it('stores the project at seq 0 and lands its create event at seq 1', async () => {
    const db = makeDb();

    const detail = await makeService(db).create({ slug: 'demo', about: { title: 'Demo' } });

    expect(db.inserts[0]!.table).toBe(coordProjects);
    expect(db.inserts[0]!.values).toMatchObject({ slug: 'demo', latestEventSeq: 0, createdAt: NOW });
    expect(rowsOf(db, coordProjectEvents)).toHaveLength(1);
    expect(rowsOf(db, coordProjectEvents)[0]).toMatchObject({
      projectId: 1,
      seq: 1,
      eventType: 'project',
      action: 'create',
      entityType: 'project',
      entityId: '1',
      payloadJson: { slug: 'demo', about: { title: 'Demo' } },
    });
    expect(rowsOf(db, coordProjects)[0]).toMatchObject({ latestEventSeq: 1 });
    expect(detail.project).toMatchObject({ slug: 'demo', latest_seq: 1, about: { title: 'Demo' } });
  });

  it('rejects a second project on the same slug', async () => {
    const db = makeDb();
    const service = makeService(db);
    await service.create({ slug: 'demo' });

    const err = await caught(service.create({ slug: 'demo' }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('project_slug_taken');
    expect(rowsOf(db, coordProjects)).toHaveLength(1);
  });
});

describe('ProjectsService on an unknown slug', () => {
  it.each([
    ['detail', (service: ProjectsService) => service.detail('ghost')],
    ['updateAbout', (service: ProjectsService) => service.updateAbout('ghost', { about: { title: 'x' } })],
    ['updateRoster', (service: ProjectsService) => service.updateRoster('ghost', { roster_markdown: '# x' })],
  ])('%s reports project_not_found', async (_label, call) => {
    const err = await caught(call(makeService(makeDb())));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('project_not_found');
  });
});

describe('ProjectsService event sequence', () => {
  it('allocates one strictly increasing seq per mutation and refreshes updated_at', async () => {
    const db = makeDb();
    const service = makeService(db);
    await service.create({ slug: 'demo' });
    vi.setSystemTime(new Date(LATER));

    await service.updateAbout('demo', { about: { title: 'Demo' } });
    await service.updateRoster('demo', { roster_markdown: '# Roster' });
    await service._recordEvent(1, 'note', 'create', 'note', 7, { header: 'h' }, 3);

    expect(rowsOf(db, coordProjectEvents).map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(rowsOf(db, coordProjects)[0]).toMatchObject({
      latestEventSeq: 4,
      createdAt: NOW,
      updatedAt: LATER,
    });
    expect((await service.listChanges('demo')).latest_seq).toBe(4);
  });

  it('stores entity ids as strings and leaves a null payload null', async () => {
    const db = makeDb();
    const service = makeService(db);
    await service.create({ slug: 'demo' });

    await service._recordEvent(1, 'todo', 'delete', 'todo', 42, null, null);
    await service._recordEvent(1, 'roster', 'update', null, null, null, null);

    expect(rowsOf(db, coordProjectEvents)[1]).toMatchObject({
      entityId: '42',
      payloadJson: null,
      sourceHostId: null,
    });
    expect(rowsOf(db, coordProjectEvents)[2]).toMatchObject({ entityType: null, entityId: null });
  });
});

// Only project_id matters to the cascade, so the child rows carry nothing else.
const CASCADE_TABLES = [
  ['coord_project_notes', coordProjectNotes],
  ['coord_project_todos', coordProjectTodos],
  ['coord_project_files', coordProjectFiles],
  ['coord_project_feedback', coordProjectFeedback],
  ['coord_project_memories', coordProjectMemories],
  ['coord_project_events', coordProjectEvents],
] as const;

function seedTwoProjects(db: DbFake): void {
  db.tables.set(coordProjects, [
    { id: 1, slug: 'demo', aboutJson: null, rosterMarkdown: '', latestEventSeq: 1, createdAt: NOW, updatedAt: NOW, archivedAt: null },
    { id: 2, slug: 'other', aboutJson: null, rosterMarkdown: '', latestEventSeq: 1, createdAt: NOW, updatedAt: NOW, archivedAt: null },
  ]);
  for (const [, table] of CASCADE_TABLES) {
    db.tables.set(table, [{ id: 1, projectId: 1 }, { id: 2, projectId: 2 }]);
  }
}

describe('ProjectsService.deleteBySlug', () => {
  it.each(CASCADE_TABLES)('clears %s for the deleted project only', async (_name, table) => {
    const db = makeDb();
    seedTwoProjects(db);

    await makeService(db).deleteBySlug('demo');

    expect(rowsOf(db, table)).toEqual([{ id: 2, projectId: 2 }]);
  });

  it('drops the project row and echoes the deleted slug', async () => {
    const db = makeDb();
    seedTwoProjects(db);

    expect(await makeService(db).deleteBySlug('demo')).toEqual({ deleted: 'demo' });

    expect(rowsOf(db, coordProjects).map((row) => row.slug)).toEqual(['other']);
  });

  it('reports project_not_found for an unknown slug', async () => {
    const err = await caught(makeService(makeDb()).deleteBySlug('ghost'));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('project_not_found');
  });
});

/** A project with 25 events, so detail()'s LIMIT 20 has something to cut. */
const BOARD_ID = '11111111-1111-4111-8111-111111111111';
const BACKLOG_ID = '22222222-2222-4222-8222-222222222222';
const DONE_ID = '33333333-3333-4333-8333-333333333333';

/** A card row with the columns `todoRowsFor` reads, and nothing else. */
function card(over: Record<string, unknown>): Record<string, unknown> {
  return {
    projectId: 1,
    boardId: BOARD_ID,
    detail: '',
    labels: null,
    priority: 0,
    blockedReason: null,
    sourceTodoId: null,
    createdByHostId: null,
    claimRole: null,
    claimedByHostId: null,
    claimedByUsername: null,
    claimedWorktreePath: null,
    claimedWorktreeHash: null,
    claimedAgentBusAddressId: null,
    claimClientRequestId: null,
    claimedAt: null,
    claimExpiresAt: null,
    claimReleasedAt: null,
    claimReleaseReason: null,
    enteredColumnAt: NOW,
    archivedAt: null,
    createdAt: NOW,
    ...over,
  };
}

function seedBusyProject(db: DbFake): void {
  db.tables.set(coordProjects, [{
    id: 1,
    slug: 'demo',
    aboutJson: null,
    rosterMarkdown: '# Roster',
    latestEventSeq: 25,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  }]);
  db.tables.set(coordProjectNotes, [
    { id: 1, projectId: 1, header: 'a', body: 'a', createdAt: NOW, updatedAt: NOW },
    { id: 2, projectId: 1, header: 'b', body: 'b', createdAt: NOW, updatedAt: LATER },
  ]);
  // Todos are cards since migration 0026, and `done` is whether the card sits in
  // the terminal lane rather than a flag on the row. Seeding
  // `coord_project_todos` here would pass against storage nothing reads.
  db.tables.set(coordProjectBoards, [
    { id: BOARD_ID, projectId: 1, slug: 'default', title: 'Board', nextCardNumber: 4, claimTtlSeconds: null, archivedAt: null, createdAt: NOW, updatedAt: NOW },
  ]);
  db.tables.set(coordProjectBoardColumns, [
    { id: BACKLOG_ID, boardId: BOARD_ID, projectId: 1, columnKey: 'backlog', title: 'Backlog', position: 0, wipLimit: null, allowedRoles: null, defaultNextColumnId: DONE_ID, isIntake: 1, isTerminal: 0, isBlocked: 0, createdAt: NOW, updatedAt: NOW },
    { id: DONE_ID, boardId: BOARD_ID, projectId: 1, columnKey: 'done', title: 'Done', position: 1, wipLimit: null, allowedRoles: null, defaultNextColumnId: null, isIntake: 0, isTerminal: 1, isBlocked: 0, createdAt: NOW, updatedAt: NOW },
  ]);
  db.tables.set(coordProjectCards, [
    card({ id: 'card-1', cardNumber: 1, title: 'open', columnId: BACKLOG_ID, updatedAt: NOW }),
    card({ id: 'card-2', cardNumber: 2, title: 'also open', columnId: BACKLOG_ID, updatedAt: NOW }),
    card({ id: 'card-3', cardNumber: 3, title: 'done', columnId: DONE_ID, updatedAt: LATER }),
  ]);
  db.tables.set(coordProjectFiles, [
    { id: 1, projectId: 1, storedName: 'a.md', description: null, content: 'body', contentSha256: 'x'.repeat(64), mimeType: null, createdAt: NOW, updatedAt: NOW },
  ]);
  db.tables.set(coordProjectFeedback, [
    { id: 1, projectId: 1, type: 'bug', title: 't', body: 'b', status: 'open', createdAt: NOW, updatedAt: NOW },
  ]);
  db.tables.set(
    coordProjectEvents,
    Array.from({ length: 25 }, (_unused, index) => ({
      id: index + 1,
      projectId: 1,
      seq: index + 1,
      eventType: 'note',
      action: 'create',
      entityType: 'note',
      entityId: String(index + 1),
      payloadJson: null,
      sourceHostId: null,
      createdAt: NOW,
    })),
  );
}

describe('ProjectsService.detail', () => {
  it('splits the todo counts on the done flag', async () => {
    const db = makeDb();
    seedBusyProject(db);

    const detail = await makeService(db).detail('demo');

    expect(detail.project.counts).toEqual({ notes: 2, open_todos: 2, done_todos: 1, files: 1, feedback: 1 });
    expect(detail.todos.map((todo) => todo.done).sort()).toEqual([false, false, true]);
  });

  it('caps recent_changes at the newest 20, oldest first', async () => {
    const db = makeDb();
    seedBusyProject(db);

    const detail = await makeService(db).detail('demo');

    expect(detail.recent_changes.map((change) => change.seq)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => index + 6),
    );
    expect(detail.project.latest_seq).toBe(25);
  });
});

/** Five events on one project, so the change feed has a window to cut on. */
function seedChangeFeed(db: DbFake): void {
  db.tables.set(coordProjects, [{
    id: 1,
    slug: 'demo',
    aboutJson: null,
    rosterMarkdown: '',
    latestEventSeq: 5,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  }]);
  db.tables.set(
    coordProjectEvents,
    Array.from({ length: 5 }, (_unused, index) => ({
      id: index + 1,
      projectId: 1,
      seq: index + 1,
      eventType: 'note',
      action: 'create',
      entityType: 'note',
      entityId: String(index + 1),
      payloadJson: null,
      sourceHostId: null,
      createdAt: NOW,
    })),
  );
}

describe('ProjectsService.listChanges', () => {
  it('returns the whole feed for since=0', async () => {
    const db = makeDb();
    seedChangeFeed(db);

    const out = await makeService(db).listChanges('demo');

    expect(out.project).toBe('demo');
    expect(out.since).toBe(0);
    expect(out.latest_seq).toBe(5);
    expect(out.changes.map((change) => change.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns only the events past since', async () => {
    const db = makeDb();
    seedChangeFeed(db);

    const out = await makeService(db).listChanges('demo', 3);

    expect(out.since).toBe(3);
    expect(out.latest_seq).toBe(5);
    expect(out.changes.map((change) => change.seq)).toEqual([4, 5]);
  });

  it('clamps a negative since to 0', async () => {
    const db = makeDb();
    seedChangeFeed(db);

    const out = await makeService(db).listChanges('demo', -5);

    expect(out.since).toBe(0);
    expect(out.changes.map((change) => change.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('ProjectsService module flag', () => {
  it('reports disabled while no flag row exists', async () => {
    expect(await makeService(makeDb()).adminState()).toEqual({
      enabled: false,
      updated_at: null,
      managed_skill: MANAGED_SKILL,
    });
  });

  it('inserts the flag row the first time it is set', async () => {
    const db = makeDb();

    const out = await makeService(db).setEnabled(true);

    expect(rowsOf(db, versions)).toHaveLength(1);
    expect(rowsOf(db, versions)[0]).toMatchObject({ name: FLAG, version: '1', updatedAt: NOW });
    expect(out).toEqual({ enabled: true, updated_at: NOW, managed_skill: MANAGED_SKILL });
  });

  it('updates the existing flag row instead of inserting a second', async () => {
    const db = makeDb();
    db.tables.set(versions, [{ name: FLAG, version: '1', updatedAt: LATER }]);

    const out = await makeService(db).setEnabled(false);

    expect(db.inserts).toHaveLength(0);
    expect(rowsOf(db, versions)).toEqual([{ name: FLAG, version: '0', updatedAt: NOW }]);
    expect(out).toEqual({ enabled: false, updated_at: NOW, managed_skill: MANAGED_SKILL });
  });

  it('reads a stored "0" as disabled', async () => {
    const db = makeDb();
    db.tables.set(versions, [{ name: FLAG, version: '0', updatedAt: LATER }]);

    expect(await makeService(db).adminState()).toEqual({
      enabled: false,
      updated_at: LATER,
      managed_skill: MANAGED_SKILL,
    });
  });
});
