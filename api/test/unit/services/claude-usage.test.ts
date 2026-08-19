import { describe, expect, it } from 'vitest';
import {
  ClaudeUsageService,
  normalizeClaudeUsageSnapshot,
} from '../../../src/services/claude-usage.js';
import { claudeUsageSnapshots } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

describe('ClaudeUsageService.store', () => {
  it('stores a reported five_hour/seven_day reading and clamps/rounds the percentages', async () => {
    const db = createDbFake();
    const svc = new ClaudeUsageService(db as never);

    const row = await svc.store({
      hostId: 7,
      fiveHourUsedPercent: 41.6,
      fiveHourResetsAt: '2026-08-19T18:00:00Z',
      sevenDayUsedPercent: 132, // out of range on purpose
      sevenDayResetsAt: '2026-08-24T00:00:00Z',
    });

    expect(row).not.toBeNull();
    const snapshot = normalizeClaudeUsageSnapshot(row!);
    expect(snapshot).toMatchObject({
      host_id: 7,
      source: 'statusline',
      five_hour_used_percent: 42,
      seven_day_used_percent: 100,
    });
    // fetched_at is never caller-supplied (see the regression note on the
    // service): it must always be the server's own receipt time.
    expect(typeof snapshot.fetched_at).toBe('string');
    expect(snapshot.fetched_at).not.toBe('');

    const latest = await svc.latest();
    expect(latest?.id).toBe(row!.id);
  });

  it('stores nothing and returns null when neither window carries a usable percentage', async () => {
    const db = createDbFake();
    const svc = new ClaudeUsageService(db as never);

    const row = await svc.store({ hostId: 1, fiveHourResetsAt: '2026-08-19T18:00:00Z' });

    expect(row).toBeNull();
    expect(await svc.latest()).toBeNull();
  });

  it('stores a reading with only one window present', async () => {
    const db = createDbFake();
    const svc = new ClaudeUsageService(db as never);

    const row = await svc.store({ hostId: 1, sevenDayUsedPercent: 12 });

    expect(row).not.toBeNull();
    expect(normalizeClaudeUsageSnapshot(row!)).toMatchObject({
      five_hour_used_percent: null,
      seven_day_used_percent: 12,
    });
  });
});

describe('ClaudeUsageService.history', () => {
  it('splits stored rows into five_hour and seven_day series, skipping nulls', async () => {
    const db = createDbFake();
    // fetchedAt is server-assigned, not caller-controllable (see
    // ClaudeUsageService.store), so an ordered fixture is seeded directly
    // into the fake table rather than round-tripped through store().
    db.tables.set(claudeUsageSnapshots, [
      {
        id: 1,
        fetchedAt: '2026-08-19T10:00:00Z',
        fiveHourUsedPercent: 10,
        sevenDayUsedPercent: 3,
      },
      {
        id: 2,
        fetchedAt: '2026-08-19T11:00:00Z',
        fiveHourUsedPercent: 20,
        sevenDayUsedPercent: null,
      },
    ]);
    const svc = new ClaudeUsageService(db as never);

    // db-fake's `.where(gte(...), lte(...))` support is a param-membership
    // fallback, not a real range comparison (see db-fake.ts), so the bounds
    // are set to exactly the two seeded fetchedAt values rather than a wider
    // window that a real database would include correctly but the fake would
    // silently return empty for.
    const history = await svc.history({
      days: 7,
      from: '2026-08-19T10:00:00Z',
      until: '2026-08-19T11:00:00Z',
    });
    const fiveHour = history.series.find((s) => s.key === 'five_hour');
    const sevenDay = history.series.find((s) => s.key === 'seven_day');

    expect(fiveHour?.points).toEqual([
      { ts: '2026-08-19T10:00:00Z', value: 10 },
      { ts: '2026-08-19T11:00:00Z', value: 20 },
    ]);
    expect(sevenDay?.points).toEqual([{ ts: '2026-08-19T10:00:00Z', value: 3 }]);
  });
});

describe('normalizeClaudeUsageSnapshot', () => {
  it('nests each window under its own key alongside the flat fields', () => {
    const snapshot = normalizeClaudeUsageSnapshot({
      id: 1,
      hostId: 3,
      source: 'statusline',
      fiveHourUsedPercent: 5,
      fiveHourResetsAt: '2026-08-19T18:00:00Z',
      sevenDayUsedPercent: null,
      sevenDayResetsAt: null,
      fetchedAt: '2026-08-19T13:00:00Z',
      createdAt: '2026-08-19T13:00:00Z',
    } as never);

    expect(snapshot).toMatchObject({
      five_hour_window: { used_percent: 5, resets_at: '2026-08-19T18:00:00Z' },
      seven_day_window: { used_percent: null, resets_at: null },
    });
  });
});
