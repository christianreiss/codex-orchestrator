import { describe, expect, it } from 'vitest';
import { kimiUsageSnapshots, providerAccounts } from '../../../src/db/schema.js';
import { parseKimiUsage, readKimiUsage } from '../../../src/services/kimi-usage.js';
import { quotaSnapshot } from '../../../src/services/quota-observation.js';
import { kimiPlanName } from '../../../src/services/provider-plan.js';
import { createDbFake } from '../../helpers/db-fake.js';

describe('Kimi managed usage', () => {
  it('normalizes ratios and four optional windows without inventing legacy weekly limits', () => {
    expect(
      parseKimiUsage({
        usages: {
          limit_5h: { used_ratio: '0.42', reset_time: '2026-12-01T12:00:00Z' },
          limit_month_total: { used_ratio: 0 },
        },
      }),
    ).toEqual({
      windows: [
        { kind: 'five_hour', used_percent: 42, resets_at: '2026-12-01T12:00:00.000Z' },
        { kind: 'month_total', used_percent: 0, resets_at: null },
      ],
      extra_usage: null,
    });
    expect(parseKimiUsage({ usages: { limit_7d: { used_ratio: Infinity } } })?.windows).toEqual([]);
    expect(parseKimiUsage({})).toBeNull();
  });
  it('parses the provider booster wallet fixed point amounts', () => {
    expect(
      parseKimiUsage({
        usages: {},
        boosterWallet: {
          balance: { type: 'BOOSTER', amount: '2000000', amountLeft: '500000' },
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimit: { priceInCents: '99', currency: 'CNY' },
        },
      })?.extra_usage,
    ).toEqual({
      balanceCents: 1,
      totalCents: 2,
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimitCents: 99,
      monthlyUsedCents: 0,
      currency: 'CNY',
    });
  });
  it('takes plan names only from the managed userinfo field', () => {
    expect(kimiPlanName({ user_level_name: 'Vivace', user_level: 30 })).toBe('Vivace');
    expect(kimiPlanName({ user_level: 30 })).toBeNull();
  });
  it('exposes the contract windows and maps 5h/weekly onto quota short/long', async () => {
    const now = new Date().toISOString(),
      reset = new Date(Date.now() + 86400000).toISOString();
    const db = createDbFake();
    db.tables.set(providerAccounts, [
      { id: 7, engine: 'kimi', label: 'Kimi', state: 'enabled', mergedIntoAccountId: null },
    ]);
    db.tables.set(kimiUsageSnapshots, [
      {
        accountId: 7,
        planName: 'Vivace',
        planFetchedAt: now,
        planErrorCode: null,
        fiveHourUsedPercent: 97,
        fiveHourResetsAt: reset,
        weeklyUsedPercent: 10,
        weeklyResetsAt: reset,
        monthTotalUsedPercent: null,
        monthTotalResetsAt: null,
        monthCodeUsedPercent: null,
        monthCodeResetsAt: null,
        extraUsageJson: null,
        fetchedAt: now,
        checkedAt: now,
        errorCode: null,
      },
    ]);
    expect(await readKimiUsage(db as never, 7)).toMatchObject({
      plan_name: 'Vivace',
      stale: false,
      windows: [
        { kind: 'five_hour', used_percent: 97, resets_at: reset },
        { kind: 'weekly', used_percent: 10, resets_at: reset },
      ],
    });
    expect(await quotaSnapshot(db as never, 7, 'kimi')).toMatchObject({
      status: 'fresh',
      short: { used_percent: 97 },
      long: { used_percent: 10 },
    });
    expect((await readKimiUsage(db as never, 8)).windows).toEqual([]);
  });
});
