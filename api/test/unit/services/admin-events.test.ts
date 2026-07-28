/**
 * The two writers behind the admin audit trail. Both hand-shape the
 * `admin_events` row -- blank type -> 'event', empty payload -> null, absent
 * host -> null -- and both publish on the WS bus, but they disagree about what
 * goes out: `record` broadcasts the raw payload and can be silenced, while
 * `appendAndPublish` injects `event_id`, takes wsType/wsPayload overrides and
 * swallows publisher failures. `latestEventId` is the `/admin/ws/info` resume
 * cursor, so its empty-table null matters to reconnecting clients.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminEvents } from '../../../src/db/schema.js';
import { createAdminEventsService } from '../../../src/services/admin-events.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

const NOW = '2026-07-28T21:00:00Z';

type Row = Record<string, unknown>;

/**
 * db-fake ignores `orderBy`, so `admin_events` is kept newest-first: the
 * service's `orderBy(desc(id)).limit(1)` then lands on the highest id the way
 * MySQL would, and `rows(db)[0]` is the row just written.
 */
function makeDb(): DbFake {
  const db = createDbFake(new Map<unknown, Row[]>([[adminEvents, []]]));
  db.insert = (table: unknown) => ({
    values: (vals: Row) => {
      const stored = db.tables.get(table) ?? [];
      const id = stored.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1;
      db.inserts.push({ table, values: vals });
      stored.unshift({ id, ...vals });
      db.tables.set(table, stored);
      // mysql2 returns [{ insertId, affectedRows }]
      return Promise.resolve([{ insertId: id, affectedRows: 1 }]);
    },
  });
  return db;
}

function rows(db: DbFake): Row[] {
  return db.tables.get(adminEvents) ?? [];
}

function newest(db: DbFake): Row {
  return rows(db)[0]!;
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

describe('AdminEventsService.record', () => {
  it('writes the full audit row', async () => {
    const db = makeDb();
    await createAdminEventsService(db as never).record({
      type: 'host.updated',
      hostId: 4,
      payload: { host_id: 4, name: 'crane' },
    });
    expect(rows(db)).toHaveLength(1);
    expect(newest(db)).toEqual({
      id: 1,
      type: 'host.updated',
      hostId: 4,
      payload: { host_id: 4, name: 'crane' },
      createdAt: NOW,
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('falls back to type "event" for a %s type', async (_label, type) => {
    const db = makeDb();
    await createAdminEventsService(db as never).record({ type });
    expect(newest(db).type).toBe('event');
  });

  it.each([
    ['an omitted payload', undefined],
    ['an empty payload', {}],
  ])('stores %s as null', async (_label, payload) => {
    const db = makeDb();
    await createAdminEventsService(db as never).record({ type: 'host.updated', payload });
    expect(newest(db).payload).toBeNull();
  });

  it('defaults hostId to null', async () => {
    const db = makeDb();
    await createAdminEventsService(db as never).record({ type: 'host.updated' });
    expect(newest(db).hostId).toBeNull();
  });

  it('returns the createdAt it stored', async () => {
    const db = makeDb();
    const { createdAt } = await createAdminEventsService(db as never).record({ type: 'host.updated' });
    expect(createdAt).toBe(NOW);
    expect(newest(db).createdAt).toBe(createdAt);
  });

  it('publishes the type with the payload as given', async () => {
    const db = makeDb();
    await createAdminEventsService(db as never).record({
      type: 'host.updated',
      payload: { host_id: 4 },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('host.updated', { host_id: 4 });
  });

  it('publishes an empty object where the row stores null', async () => {
    const db = makeDb();
    await createAdminEventsService(db as never).record({ type: 'host.updated' });
    expect(publish).toHaveBeenCalledWith('host.updated', {});
    expect(newest(db).payload).toBeNull();
  });

  it('publishes nothing when broadcast is false but still writes the row', async () => {
    const db = makeDb();
    await createAdminEventsService(db as never).record(
      { type: 'host.updated', payload: { host_id: 4 } },
      { broadcast: false },
    );
    expect(publish).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(1);
  });
});

describe('makeAdminEventsWriter.append', () => {
  it('writes the full audit row and returns it', async () => {
    const db = makeDb();
    const record = await makeAdminEventsWriter(db as never).append('host.updated', { host_id: 4 }, 4);
    expect(record).toEqual({
      id: 1,
      type: 'host.updated',
      hostId: 4,
      payload: { host_id: 4 },
      createdAt: NOW,
    });
    expect(newest(db)).toEqual(record);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('falls back to type "event" for a %s type', async (_label, type) => {
    const db = makeDb();
    const record = await makeAdminEventsWriter(db as never).append(type, {});
    expect(record.type).toBe('event');
    expect(newest(db).type).toBe('event');
  });

  it('stores an empty payload as null', async () => {
    const db = makeDb();
    const record = await makeAdminEventsWriter(db as never).append('host.updated', {});
    expect(record.payload).toBeNull();
    expect(newest(db).payload).toBeNull();
  });

  it('defaults hostId to null', async () => {
    const db = makeDb();
    const record = await makeAdminEventsWriter(db as never).append('host.updated', {});
    expect(record.hostId).toBeNull();
    expect(newest(db).hostId).toBeNull();
  });

  it('publishes nothing on its own', async () => {
    const db = makeDb();
    await makeAdminEventsWriter(db as never).append('host.updated', { host_id: 4 });
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('makeAdminEventsWriter.appendAndPublish', () => {
  it('returns the insert id the driver reported', async () => {
    const db = makeDb();
    const writer = makeAdminEventsWriter(db as never);
    await writer.appendAndPublish('host.updated', {});
    const second = await writer.appendAndPublish('host.updated', {});
    expect(second.id).toBe(2);
  });

  it('publishes the payload with the row id under the event type', async () => {
    const db = makeDb();
    const record = await makeAdminEventsWriter(db as never).appendAndPublish('host.updated', { host_id: 4 });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('host.updated', { host_id: 4, event_id: record.id });
  });

  it('publishes under wsType while the row keeps the audit type', async () => {
    const db = makeDb();
    await makeAdminEventsWriter(db as never).appendAndPublish(
      'host.updated',
      { host_id: 4 },
      { wsType: 'project.changed' },
    );
    expect(publish).toHaveBeenCalledWith('project.changed', { host_id: 4, event_id: 1 });
    expect(newest(db).type).toBe('host.updated');
  });

  it('publishes wsPayload verbatim, without the event id', async () => {
    const db = makeDb();
    await makeAdminEventsWriter(db as never).appendAndPublish(
      'host.updated',
      { host_id: 4, secret: 'redacted' },
      { wsPayload: { host_id: 4 } },
    );
    expect(publish).toHaveBeenCalledWith('host.updated', { host_id: 4 });
    expect(newest(db).payload).toEqual({ host_id: 4, secret: 'redacted' });
  });

  it('records hostId from the options', async () => {
    const db = makeDb();
    const record = await makeAdminEventsWriter(db as never).appendAndPublish('host.updated', {}, { hostId: 9 });
    expect(record.hostId).toBe(9);
    expect(newest(db).hostId).toBe(9);
  });

  it('returns the record when the publisher throws', async () => {
    const db = makeDb();
    publish.mockImplementationOnce(() => {
      throw new Error('socket gone');
    });
    const record = await makeAdminEventsWriter(db as never).appendAndPublish('host.updated', { host_id: 4 });
    expect(record.id).toBe(1);
    expect(rows(db)).toHaveLength(1);
  });

  it('degrades the id to 0 when the result is not an [{ insertId }] array', async () => {
    const db = makeDb();
    db.insert = (table: unknown) => ({
      values: (vals: Row) => {
        db.tables.set(table, [{ id: 1, ...vals }]);
        return Promise.resolve({ affectedRows: 1 });
      },
    });
    const record = await makeAdminEventsWriter(db as never).appendAndPublish('host.updated', { host_id: 4 });
    expect(record.id).toBe(0);
    expect(publish).toHaveBeenCalledWith('host.updated', { host_id: 4, event_id: 0 });
  });
});

describe('AdminEventsService.latestEventId', () => {
  it('returns null while the table is empty', async () => {
    const db = makeDb();
    expect(await createAdminEventsService(db as never).latestEventId()).toBeNull();
  });

  it('returns the highest id once rows exist', async () => {
    const db = makeDb();
    const service = createAdminEventsService(db as never);
    await service.record({ type: 'host.updated' });
    await service.record({ type: 'host.updated' });
    await service.record({ type: 'host.updated' });
    expect(await service.latestEventId()).toBe(3);
  });
});
