import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/client.js';
import type { Keyring } from '../../../src/security/keyring.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import { chatgptUsageSnapshots, claudeUsageSnapshots } from '../../../src/db/schema.js';

async function usage(snapshot: Record<string, unknown> | null, engine: 'codex' | 'claude' = 'codex') {
  const query = {
    from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue(snapshot ? [snapshot] : []),
  };
  const reader = { select: vi.fn(() => query) } as unknown as Database;
  const result = await new ProviderAccountsService(reader, {} as Keyring).usage(2, engine);
  expect(query.from).toHaveBeenCalledWith(engine === 'codex' ? chatgptUsageSnapshots : claudeUsageSnapshots);
  return result;
}

describe('account quota window projection', () => {
  const fresh = () => ({ fetchedAt: new Date().toISOString() });

  it.each([false, true])('keeps duration, zero usage and reset together when slots are swapped: %s', async (swapped) => {
    const short = { UsedPercent: 0, LimitSeconds: 18000, ResetAt: '2026-10-13T17:00:00Z' };
    const weekly = { UsedPercent: 42, LimitSeconds: 604800, ResetAt: '2026-10-20T17:00:00Z' };
    const row: Record<string, unknown> = fresh();
    for (const [slot, window] of [['primary', swapped ? weekly : short], ['secondary', swapped ? short : weekly]] as const) {
      for (const [key, value] of Object.entries(window)) row[slot + key] = value;
    }
    expect(await usage(row)).toMatchObject({
      stale: false, short_used_percent: 0, short_limit_seconds: 18000,
      short_resets_at: short.ResetAt, weekly_used_percent: 42, weekly_limit_seconds: 604800,
      weekly_resets_at: weekly.ResetAt,
    });
  });

  it('does not manufacture a short window from a weekly-only snapshot', async () => {
    expect(await usage({ ...fresh(), primaryUsedPercent: 15, primaryLimitSeconds: 604800 })).toMatchObject({
      short_used_percent: null, short_limit_seconds: null, short_resets_at: null,
      weekly_used_percent: 15, weekly_limit_seconds: 604800,
    });
  });

  it('does not classify a second weekly slot as a short window', async () => {
    expect(await usage({ ...fresh(), primaryUsedPercent: 15, primaryLimitSeconds: 604800,
      secondaryUsedPercent: 25, secondaryLimitSeconds: 604860 })).toMatchObject({
      short_used_percent: null, weekly_used_percent: 15,
    });
  });

  it('keeps absent readings null and marks old readings stale', async () => {
    expect(await usage(null)).toMatchObject({
      fetched_at: null, stale: true, short_used_percent: null, weekly_used_percent: null,
      short_limit_seconds: null, weekly_limit_seconds: null,
    });
    expect(await usage({ fetchedAt: '2026-01-01T00:00:00Z', primaryUsedPercent: 0, primaryLimitSeconds: 18000 }))
      .toMatchObject({ stale: true, short_used_percent: 0, short_limit_seconds: 18000 });
  });

  it('reports Claude durations only alongside an actual reading', async () => {
    expect(await usage({ ...fresh(), fiveHourUsedPercent: 0, sevenDayUsedPercent: null }, 'claude'))
      .toMatchObject({ short_used_percent: 0, short_limit_seconds: 18000, weekly_limit_seconds: null });
  });
});
