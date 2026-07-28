import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDbFake, versionsTable, type DbFake } from '../../helpers/db-fake.js';
import { SettingsService } from '../../../src/services/settings.js';
import { wsPublisher } from '../../../src/ws/publisher.js';

const SEEDED_AT = '2020-01-01T00:00:00Z';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

interface Harness {
  db: DbFake;
  svc: SettingsService;
}

function harness(rows: Record<string, string> = {}): Harness {
  const tables = new Map<unknown, Record<string, unknown>[]>();
  tables.set(
    versionsTable,
    Object.entries(rows).map(([name, version]) => ({ name, version, updatedAt: SEEDED_AT })),
  );
  const db = createDbFake(tables);
  return { db, svc: new SettingsService(db as never) };
}

function versionRows(db: DbFake): Record<string, unknown>[] {
  return db.tables.get(versionsTable) ?? [];
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

describe('reads', () => {
  it('returns null for a missing row and the stored value for a present one', async () => {
    const h = harness({ kill_switch: 'on' });

    await expect(h.svc.getRaw('nope')).resolves.toBeNull();
    await expect(h.svc.getRaw('kill_switch')).resolves.toBe('on');
  });

  it('reports value and updatedAt through getWithMeta', async () => {
    const h = harness({ kill_switch: 'on' });

    await expect(h.svc.getWithMeta('nope')).resolves.toEqual({ value: null, updatedAt: null });
    await expect(h.svc.getWithMeta('kill_switch')).resolves.toEqual({
      value: 'on',
      updatedAt: SEEDED_AT,
    });
  });
});

describe('coercion', () => {
  it('treats 1/true/yes/on as true regardless of case or padding and anything else as false', async () => {
    const h = harness({
      one: '1',
      lower: 'true',
      upper: 'TRUE',
      yes: 'yes',
      on: 'on',
      padded: ' ON ',
      zero: '0',
      no: 'no',
    });

    await expect(h.svc.getFlag('one')).resolves.toBe(true);
    await expect(h.svc.getFlag('lower')).resolves.toBe(true);
    await expect(h.svc.getFlag('upper')).resolves.toBe(true);
    await expect(h.svc.getFlag('yes')).resolves.toBe(true);
    await expect(h.svc.getFlag('on')).resolves.toBe(true);
    await expect(h.svc.getFlag('padded')).resolves.toBe(true);
    await expect(h.svc.getFlag('zero')).resolves.toBe(false);
    await expect(h.svc.getFlag('no')).resolves.toBe(false);
    // A set value wins over the default even when they disagree.
    await expect(h.svc.getFlag('zero', true)).resolves.toBe(false);
    await expect(h.svc.getFlag('one', false)).resolves.toBe(true);
  });

  it('falls back to the default for an empty string and a missing key', async () => {
    const h = harness({ empty: '' });

    await expect(h.svc.getFlag('empty')).resolves.toBe(false);
    await expect(h.svc.getFlag('empty', true)).resolves.toBe(true);
    await expect(h.svc.getFlag('missing')).resolves.toBe(false);
    await expect(h.svc.getFlag('missing', true)).resolves.toBe(true);
  });

  it('truncates ints, passes negatives through and falls back on unparseable input', async () => {
    const h = harness({ fractional: '7.9', junk: 'abc', empty: '', negative: '-5' });

    await expect(h.svc.getInt('fractional', 99)).resolves.toBe(7);
    await expect(h.svc.getInt('junk', 99)).resolves.toBe(99);
    await expect(h.svc.getInt('empty', 99)).resolves.toBe(99);
    await expect(h.svc.getInt('missing', 99)).resolves.toBe(99);
    await expect(h.svc.getInt('negative', 99)).resolves.toBe(-5);
  });

  it('returns the string default only when no row exists', async () => {
    const h = harness({ model: 'gpt-5' });

    await expect(h.svc.getString('model', 'fallback')).resolves.toBe('gpt-5');
    await expect(h.svc.getString('missing', 'fallback')).resolves.toBe('fallback');
    await expect(h.svc.getString('missing')).resolves.toBeNull();
  });
});

describe('set', () => {
  it('inserts when no row exists', async () => {
    const h = harness();

    await h.svc.set('kill_switch', '1');

    expect(h.db.inserts).toEqual([
      {
        table: versionsTable,
        values: { name: 'kill_switch', version: '1', updatedAt: expect.stringMatching(ISO) },
      },
    ]);
    expect(h.db.updates).toHaveLength(0);
    await expect(h.svc.getRaw('kill_switch')).resolves.toBe('1');
  });

  it('updates in place and refreshes updatedAt when a row exists', async () => {
    const h = harness({ kill_switch: '0' });

    await h.svc.set('kill_switch', '1');

    expect(h.db.inserts).toHaveLength(0);
    expect(h.db.updates).toHaveLength(1);
    const rows = versionRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'kill_switch', version: '1' });
    expect(rows[0]!.updatedAt).not.toBe(SEEDED_AT);
    expect(rows[0]!.updatedAt).toMatch(ISO);
  });

  it('falls back to an update when the insert loses a write race', async () => {
    const h = harness();
    h.db.insert = () => ({ values: () => Promise.reject(new Error('duplicate key')) });

    await h.svc.set('kill_switch', '1');

    expect(h.db.updates).toEqual([
      {
        table: versionsTable,
        set: { version: '1', updatedAt: expect.stringMatching(ISO) },
        where: expect.anything(),
      },
    ]);
    expect(events).toEqual([{ type: 'settings.changed', payload: { key: 'kill_switch' } }]);
  });
});

describe('typed writers and delete', () => {
  it('writes 1/0 for flags', async () => {
    const on = harness();
    const off = harness();

    await on.svc.setFlag('kill_switch', true);
    await off.svc.setFlag('kill_switch', false);

    expect(on.db.inserts[0]!.values).toMatchObject({ version: '1' });
    expect(off.db.inserts[0]!.values).toMatchObject({ version: '0' });
  });

  it('writes a truncated string for ints', async () => {
    const h = harness();

    await h.svc.setInt('inactivity_window_days', 7.9);

    expect(h.db.inserts[0]!.values).toMatchObject({ version: '7' });
    await expect(h.svc.getInt('inactivity_window_days', 0)).resolves.toBe(7);
  });

  it('removes the row', async () => {
    const h = harness({ kill_switch: '1', other: '1' });

    await h.svc.delete('kill_switch');

    expect(h.db.deletes).toHaveLength(1);
    expect(versionRows(h.db)).toEqual([expect.objectContaining({ name: 'other' })]);
    await expect(h.svc.getRaw('kill_switch')).resolves.toBeNull();
  });
});

describe('settings.changed publishing', () => {
  it('emits exactly one event per mutation', async () => {
    const h = harness({ existing: '0' });

    await h.svc.set('inserted', 'a');
    await h.svc.set('existing', 'b');
    await h.svc.setFlag('flag', true);
    await h.svc.setInt('number', 3);
    await h.svc.delete('existing');

    expect(events).toEqual([
      { type: 'settings.changed', payload: { key: 'inserted' } },
      { type: 'settings.changed', payload: { key: 'existing' } },
      { type: 'settings.changed', payload: { key: 'flag' } },
      { type: 'settings.changed', payload: { key: 'number' } },
      { type: 'settings.changed', payload: { key: 'existing' } },
    ]);
  });

  it('stays silent when publish is false', async () => {
    const h = harness({ existing: '0' });

    await h.svc.set('inserted', 'a', { publish: false });
    await h.svc.set('existing', 'b', { publish: false });
    await h.svc.setFlag('flag', true, { publish: false });
    await h.svc.setInt('number', 3, { publish: false });
    await h.svc.delete('existing', { publish: false });

    expect(h.db.inserts.length + h.db.updates.length + h.db.deletes.length).toBe(5);
    expect(events).toEqual([]);
  });
});
