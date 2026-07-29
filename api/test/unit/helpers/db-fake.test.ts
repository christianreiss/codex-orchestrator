import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sharedMemoryChunks } from '../../../src/db/schema.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

type Row = Record<string, unknown>;

interface InsertBuilder {
  values(vals: Row | Row[]): Promise<Array<{ insertId: number; affectedRows: number }>>;
}

interface DeleteBuilder {
  where(w: unknown): Promise<Array<{ affectedRows: number }>>;
}

function chunkRow(ordinal: number, revision = 1): Row {
  return {
    memoryId: 7,
    revision,
    ordinal,
    heading: null,
    content: `chunk ${ordinal}`,
    charStart: 0,
    charEnd: 10,
    tagsText: null,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function insertChunks(db: DbFake, vals: Row | Row[]) {
  return (db.insert(sharedMemoryChunks) as InsertBuilder).values(vals);
}

function chunkIds(db: DbFake): unknown[] {
  return (db.tables.get(sharedMemoryChunks) ?? []).map((row) => row.id);
}

describe('createDbFake id allocation', () => {
  it('gives every row of a batch insert its own id', async () => {
    const db = createDbFake();

    await insertChunks(db, [chunkRow(0), chunkRow(1), chunkRow(2)]);

    expect(chunkIds(db)).toEqual([1, 2, 3]);
  });

  it('resolves insertId to the first row of the batch', async () => {
    const db = createDbFake();

    const [first] = await insertChunks(db, [chunkRow(0), chunkRow(1)]);
    const [second] = await insertChunks(db, [chunkRow(2), chunkRow(3)]);

    expect(first).toEqual({ insertId: 1, affectedRows: 2 });
    expect(second).toEqual({ insertId: 3, affectedRows: 2 });
  });

  it('does not reissue ids freed by a delete', async () => {
    const db = createDbFake();

    await insertChunks(db, [chunkRow(0), chunkRow(1)]);
    await (db.delete(sharedMemoryChunks) as DeleteBuilder).where(eq(sharedMemoryChunks.revision, 1));
    expect(chunkIds(db)).toEqual([]);

    const [result] = await insertChunks(db, chunkRow(0, 2));

    expect(chunkIds(db)).toEqual([3]);
    expect(result?.insertId).toBe(3);
  });

  it('keeps an explicit id instead of allocating one', async () => {
    const db = createDbFake();

    const [explicit] = await insertChunks(db, { id: 42, ...chunkRow(0) });
    await insertChunks(db, chunkRow(1));

    expect(explicit?.insertId).toBe(42);
    expect(chunkIds(db)[0]).toBe(42);
    expect(chunkIds(db)[1]).not.toBe(42);
  });
});
