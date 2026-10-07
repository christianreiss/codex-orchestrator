import { describe, expect, it } from 'vitest';
import { parseGrokUsage } from '../../../src/services/grok-usage.js';

describe('Grok provider billing normalization', () => {
  it('reads the live unified weekly contract, including fractional-second UTC offsets', () => {
    expect(
      parseGrokUsage({
        config: {
          creditUsagePercent: 5,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-10-06T19:22:05.583926+00:00',
            end: '2026-10-13T19:22:05.583926+00:00',
          },
          isUnifiedBillingUser: true,
          productUsage: [{ product: 'GrokBuild', usagePercent: 5 }],
        },
      }),
    ).toEqual({
      used_percent: 5,
      period: 'weekly',
      starts_at: '2026-10-06T19:22:05.583Z',
      resets_at: '2026-10-13T19:22:05.583Z',
      shared: true,
    });
  });

  it('preserves a real zero and does not invent a weekly period or reset', () => {
    expect(parseGrokUsage({ config: { creditUsagePercent: 0 } })).toEqual({
      used_percent: 0,
      period: null,
      starts_at: null,
      resets_at: null,
      shared: null,
    });
  });

  it('uses the new percentage over legacy amounts and distinguishes monthly periods', () => {
    expect(
      parseGrokUsage({
        config: {
          creditUsagePercent: 42.56,
          monthlyLimit: { val: '100' },
          used: { val: '99' },
          currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: 'invalid' },
          isUnifiedBillingUser: false,
        },
      }),
    ).toMatchObject({ used_percent: 42.56, period: 'monthly', resets_at: null, shared: false });
  });

  it('accepts the legacy monthly budget, including protobuf zero-valued Cent', () => {
    expect(
      parseGrokUsage({ config: { monthlyLimit: { val: '5000' }, used: { val: '1000' } } }),
    ).toMatchObject({ used_percent: 20, period: 'monthly' });
    expect(parseGrokUsage({ config: { monthlyLimit: { val: 5000 }, used: {} } })).toMatchObject({
      used_percent: 0,
      period: 'monthly',
    });
  });

  it.each([
    undefined,
    null,
    {},
    { config: null },
    { config: {} },
    { config: { monthlyLimit: {}, used: {} } },
  ])('keeps missing or unsupported billing data unknown: %j', (body) =>
    expect(parseGrokUsage(body)).toBeNull(),
  );
  it.each(['5', -1, 101, NaN, Infinity, false, {}])('rejects malformed percentages: %j', (value) => {
    expect(parseGrokUsage({ config: { creditUsagePercent: value } })).toBeNull();
  });
});
