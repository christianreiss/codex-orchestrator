/**
 * Payload rules and not-found branches of the project sub-resource service.
 * The admin projects routes hand raw JSON straight to these methods, so the
 * stored_name traversal guard, the alias/fallback fields and the error codes
 * clients branch on are all contract surface.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  coordProjectEvents,
  coordProjectFeedback,
  coordProjectFiles,
  coordProjectNotes,
  coordProjects,
  coordProjectTodos,
} from '../../../src/db/schema.js';
import { ApiError, NotFoundError, ValidationError } from '../../../src/http/errors.js';
import { ProjectContentService } from '../../../src/services/project-content.js';
import { ProjectsService } from '../../../src/services/projects.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

const PROJECT_ID = 7;

type Row = Record<string, unknown>;

interface Seed {
  notes?: Row[];
  todos?: Row[];
  files?: Row[];
}

/**
 * db-fake mirrors the host-api services, which never call `.$returningId()`.
 * ProjectContentService and ProjectsService.recordEvent both do, so surface
 * the generated id on top of the fake's insert builder.
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

function makeDb(seed: Seed = {}): DbFake {
  const db = withReturningId(createDbFake());
  db.tables.set(coordProjects, [{
    id: PROJECT_ID,
    slug: 'demo',
    aboutJson: null,
    rosterMarkdown: '',
    latestEventSeq: 3,
    createdAt: '2026-07-01T08:00:00Z',
    updatedAt: '2026-07-01T08:00:00Z',
    archivedAt: null,
  }]);
  db.tables.set(coordProjectNotes, seed.notes ?? []);
  db.tables.set(coordProjectTodos, seed.todos ?? []);
  db.tables.set(coordProjectFiles, seed.files ?? []);
  db.tables.set(coordProjectFeedback, []);
  db.tables.set(coordProjectEvents, []);
  return db;
}

function makeService(db: DbFake): ProjectContentService {
  return new ProjectContentService(db as never, new ProjectsService(db as never));
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

// A row that exists but hangs off a different project must read as absent:
// that is the tenant boundary these lookups enforce.
const foreignProjectId = 99;

describe('ProjectContentService.upsertFile stored_name', () => {
  it.each([
    ['blank', '   '],
    ['NUL-bearing', 'a\0b'],
    ['parent dot segment', 'a/../b'],
    ['leading dot segment', './a'],
    ['slash only', '///'],
  ])('rejects a %s stored_name', async (_label, storedName) => {
    const service = makeService(makeDb());

    const err = await caught(service.upsertFile('demo', { stored_name: storedName, content: 'body' }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.param).toBe('stored_name');
  });

  it.each([
    ['backslashes', 'a\\b'],
    ['repeated slashes', 'a//b'],
  ])('normalizes %s to a single forward slash', async (_label, storedName) => {
    const service = makeService(makeDb());

    const out = await service.upsertFile('demo', { stored_name: storedName, content: 'body' });

    expect(out.file.stored_name).toBe('a/b');
  });
});

describe('ProjectContentService.upsertFile payload', () => {
  it('accepts name/text as aliases for stored_name/content', async () => {
    const service = makeService(makeDb());

    const out = await service.upsertFile('demo', { name: 'notes/todo.md', text: 'hello' });

    expect(out.file).toMatchObject({ stored_name: 'notes/todo.md', content: 'hello' });
  });

  it.each([
    ['missing content', {}],
    ['empty content', { content: '' }],
  ])('rejects %s', async (_label, extra) => {
    const service = makeService(makeDb());

    const err = await caught(service.upsertFile('demo', { stored_name: 'a.md', ...extra }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.param).toBe('content');
  });

  it('stores the sha256 of the content', async () => {
    const db = makeDb();
    const service = makeService(db);

    const out = await service.upsertFile('demo', { stored_name: 'a.md', content: 'hello' });

    const sha = createHash('sha256').update('hello').digest('hex');
    expect(out.file.content_sha256).toBe(sha);
    const inserted = db.inserts.find((i) => i.table === coordProjectFiles)!.values as Row;
    expect(inserted['contentSha256']).toBe(sha);
  });
});

describe('ProjectContentService required fields', () => {
  it.each([
    ['a note without a header', 'header', (s: ProjectContentService) => s.upsertNote('demo', null, { body: 'b' })],
    ['a note without a body', 'body', (s: ProjectContentService) => s.upsertNote('demo', null, { header: 'h' })],
    ['a todo without a title', 'title', (s: ProjectContentService) => s.createTodo('demo', { detail: 'd' })],
    ['feedback without a title', 'title', (s: ProjectContentService) => s.createFeedback('demo', { body: 'b' })],
    ['feedback without a body', 'body', (s: ProjectContentService) => s.createFeedback('demo', { title: 't' })],
  ])('rejects %s', async (_label, param, call) => {
    const service = makeService(makeDb());

    const err = await caught(call(service));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.param).toBe(param);
  });

  it('rejects an unknown feedback type', async () => {
    const service = makeService(makeDb());

    const err = await caught(service.createFeedback('demo', { type: 'wishlist', title: 't', body: 'b' }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.param).toBe('type');
  });

  it('defaults a blank feedback type to feature', async () => {
    const service = makeService(makeDb());

    const out = await service.createFeedback('demo', { type: '  ', title: 't', body: 'b' });

    expect(out.feedback.type).toBe('feature');
  });
});

describe('ProjectContentService not-found branches', () => {
  it.each([
    ['upsertNote', 'note_not_found', (s: ProjectContentService) => s.upsertNote('demo', 5, { header: 'h', body: 'b' })],
    ['deleteNote', 'note_not_found', (s: ProjectContentService) => s.deleteNote('demo', 5)],
    ['updateTodo', 'todo_not_found', (s: ProjectContentService) => s.updateTodo('demo', 5, { title: 't' })],
    ['setTodoDone', 'todo_not_found', (s: ProjectContentService) => s.setTodoDone('demo', 5, true)],
    ['deleteTodo', 'todo_not_found', (s: ProjectContentService) => s.deleteTodo('demo', 5)],
    ['deleteFile', 'project_file_not_found', (s: ProjectContentService) => s.deleteFile('demo', 5)],
  ])('%s reports %s for a row outside the project', async (_label, code, call) => {
    const db = makeDb({
      notes: [{ id: 5, projectId: foreignProjectId, header: 'h', body: 'b' }],
      todos: [{ id: 5, projectId: foreignProjectId, title: 't', detail: '', done: 0 }],
      files: [{ id: 5, projectId: foreignProjectId, storedName: 'a.md', content: 'x' }],
    });
    const service = makeService(db);

    const err = await caught(call(service));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe(code);
  });
});
