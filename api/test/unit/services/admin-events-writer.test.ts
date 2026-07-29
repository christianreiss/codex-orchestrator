/**
 * `makeAdminEventsWriter` is the audit-first write path every admin mutation
 * goes through: the `admin_events` row is persisted before anything reaches the
 * WS bus, and a publisher that throws must never turn into a failed request.
 * These tests drive it over the db fake -- whose insert already returns mysql2's
 * `[{ insertId, affectedRows }]` -- so the row shaping (blank type -> 'event',
 * empty payload -> SQL NULL) and the insertId extraction with its 0 fallback
 * are pinned without a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminEvents } from '../../../src/db/schema.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

const NOW = '2026-07-29T09:30:00Z';

type Row = Record<string, unknown>;

function makeDb(): DbFake {
  return createDbFake(new Map<unknown, Row[]>([[adminEvents, []]]));
}

function writerOver(db: DbFake) {
  return makeAdminEventsWriter(db as never);
}

function rows(db: DbFake): Row[] {
  return db.tables.get(adminEvents) ?? [];
}

/** The fake appends, so the row just written is the last one. */
function written(db: DbFake): Row {
  return rows(db).at(-1)!;
}

/** Swap in an insert whose result never carries a usable insertId. */
function stubInsertResult(db: DbFake, result: unknown): void {
  db.insert = (table: unknown) => ({
    values: (vals: Row) => {
      db.tables.set(table, [...(db.tables.get(table) ?? []), vals]);
      return Promise.resolve(result);
    },
  });
}

const spyPublish = () => vi.spyOn(wsPublisher, 'publish').mockImplementation(() => {});
let publish: ReturnType<typeof spyPublish>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  publish = spyPublish();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('makeAdminEventsWriter.append', () => {
  it('persists the audit row and returns it unchanged', async () => {
    const db = makeDb();
    const record = await writerOver(db).append('host.updated', { host_id: 7, name: 'crane' }, 7);
    expect(record).toEqual({
      id: 1,
      type: 'host.updated',
      hostId: 7,
      payload: { host_id: 7, name: 'crane' },
      createdAt: NOW,
    });
    expect(written(db)).toEqual(record);
  });

  it.each([
    ['an empty', ''],
    ['a whitespace-only', '   '],
  ])('stores and returns "event" for %s type', async (_label, type) => {
    const db = makeDb();
    const record = await writerOver(db).append(type, { host_id: 7 });
    expect(record.type).toBe('event');
    expect(written(db).type).toBe('event');
  });

  it('stores an empty payload as null', async () => {
    const db = makeDb();
    const record = await writerOver(db).append('host.updated', {});
    expect(record.payload).toBeNull();
    expect(written(db).payload).toBeNull();
  });

  it('round-trips a non-empty payload', async () => {
    const db = makeDb();
    const payload = { host_id: 7, engines: ['codex', 'claude'], nested: { on: true } };
    const record = await writerOver(db).append('host.updated', payload);
    expect(record.payload).toEqual(payload);
    expect(written(db).payload).toEqual(payload);
  });

  it('defaults hostId to null', async () => {
    const db = makeDb();
    const record = await writerOver(db).append('host.updated', { host_id: 7 });
    expect(record.hostId).toBeNull();
    expect(written(db).hostId).toBeNull();
  });

  it('returns the insertId the driver reported', async () => {
    const db = makeDb();
    const writer = writerOver(db);
    expect((await writer.append('host.updated', {})).id).toBe(1);
    expect((await writer.append('host.updated', {})).id).toBe(2);
    expect((await writer.append('host.updated', {})).id).toBe(3);
  });

  it.each([
    ['a bare result object', { affectedRows: 1 }],
    ['an array without an insertId', [{ affectedRows: 1 }]],
    ['a non-numeric insertId', [{ insertId: '4' }]],
    ['an empty array', []],
    ['undefined', undefined],
  ])('degrades the id to 0 for %s', async (_label, result) => {
    const db = makeDb();
    stubInsertResult(db, result);
    const record = await writerOver(db).append('host.updated', { host_id: 7 });
    expect(record.id).toBe(0);
    expect(rows(db)).toHaveLength(1);
  });

  it('returns the createdAt it wrote to the row', async () => {
    const db = makeDb();
    const record = await writerOver(db).append('host.updated', { host_id: 7 });
    expect(record.createdAt).toBe(NOW);
    expect(written(db).createdAt).toBe(record.createdAt);
  });
});

describe('makeAdminEventsWriter.appendAndPublish', () => {
  it('publishes the audit type with the payload plus the row id', async () => {
    const db = makeDb();
    const record = await writerOver(db).appendAndPublish('host.updated', { host_id: 7 });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('host.updated', { host_id: 7, event_id: record.id });
  });

  it('carries the fallback id into the published payload', async () => {
    const db = makeDb();
    stubInsertResult(db, { affectedRows: 1 });
    await writerOver(db).appendAndPublish('host.updated', { host_id: 7 });
    expect(publish).toHaveBeenCalledWith('host.updated', { host_id: 7, event_id: 0 });
  });

  it('publishes under wsType while the row keeps the audit type', async () => {
    const db = makeDb();
    await writerOver(db).appendAndPublish('host.updated', { host_id: 7 }, { wsType: 'project.changed' });
    expect(publish).toHaveBeenCalledWith('project.changed', { host_id: 7, event_id: 1 });
    expect(written(db).type).toBe('host.updated');
  });

  it('publishes wsPayload verbatim, without injecting the event id', async () => {
    const db = makeDb();
    await writerOver(db).appendAndPublish(
      'host.updated',
      { host_id: 7, api_key: 'secret' },
      { wsPayload: { host_id: 7 } },
    );
    expect(publish).toHaveBeenCalledWith('host.updated', { host_id: 7 });
    expect(written(db).payload).toEqual({ host_id: 7, api_key: 'secret' });
  });

  it('honours wsType and wsPayload together', async () => {
    const db = makeDb();
    await writerOver(db).appendAndPublish(
      'host.updated',
      { host_id: 7 },
      { wsType: 'project.changed', wsPayload: { project_id: 3 } },
    );
    expect(publish).toHaveBeenCalledWith('project.changed', { project_id: 3 });
  });

  it('records hostId from the options', async () => {
    const db = makeDb();
    const record = await writerOver(db).appendAndPublish('host.updated', {}, { hostId: 7 });
    expect(record.hostId).toBe(7);
    expect(written(db).hostId).toBe(7);
  });

  it('resolves with the record, row already written, when the publisher throws', async () => {
    const db = makeDb();
    publish.mockImplementation(() => {
      throw new Error('socket gone');
    });
    const record = await writerOver(db).appendAndPublish('host.updated', { host_id: 7 }, { hostId: 7 });
    expect(record).toEqual({
      id: 1,
      type: 'host.updated',
      hostId: 7,
      payload: { host_id: 7 },
      createdAt: NOW,
    });
    expect(written(db)).toEqual(record);
  });
});
