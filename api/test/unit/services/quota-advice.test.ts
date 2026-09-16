import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_ADVICE,
  parseQuotaAdvice,
  quotaAdviceSnapshot,
  readQuotaAdvice,
} from '../../../src/services/quota-advice.js';
import { SettingsService } from '../../../src/services/settings.js';
import { createDbFake } from '../../helpers/db-fake.js';

describe('quota advice settings', () => {
  it('defaults, validates, persists and disables corrupt settings', async () => {
    const settings = new SettingsService(createDbFake() as never);
    expect(await readQuotaAdvice(settings)).toEqual(DEFAULT_QUOTA_ADVICE);
    const configured = parseQuotaAdvice({ ...DEFAULT_QUOTA_ADVICE, mode: 'hint', max_age_minutes: 15 });
    await settings.set('quota_advice', JSON.stringify(configured));
    expect(await readQuotaAdvice(settings)).toEqual(configured);
    await settings.set('quota_advice', '{broken');
    expect((await readQuotaAdvice(settings)).mode).toBe('off');
  });
  it.each([
    null,
    [],
    { mode: 'auto' },
    { mode: ['ask'] },
    { remember_day: 'true' },
    { high_usage_percent: 0 },
    { high_usage_percent: 101 },
    { projected_usage_percent: 99 },
    { min_pressure_gap: -1 },
    { max_age_minutes: 121 },
    { max_age_minutes: 1.5 },
    { max_age_minutes: '30' },
    { surprise: true },
  ])('rejects invalid settings %j', (value) => {
    expect(() => parseQuotaAdvice(value)).toThrow();
  });
});
describe('comparison boundary', () => {
  it('selects the active lane, preserves zero and never exposes credentials', () => {
    const codex = {
      status: 'ok',
      active_quota_lane: 'spark',
      fetched_at: '2026-09-14T12:00:00Z',
      auth: { token: 'do-not-return' },
      primary_used_percent: 99,
      spark_window: {
        primary_window: { used_percent: 0, limit_seconds: 18000, reset_at: '2026-09-14T13:00:00Z' },
      },
    };
    const result = quotaAdviceSnapshot(DEFAULT_QUOTA_ADVICE, ['codex', 'claude'], codex, {
      five_hour_used_percent: 95,
      seven_day_used_percent: null,
    });
    expect(result.codex.windows).toEqual([
      { used_percent: 0, limit_seconds: 18000, reset_at: '2026-09-14T13:00:00Z' },
      { used_percent: null, limit_seconds: null, reset_at: null },
    ]);
    expect(result.claude.windows[1]?.used_percent).toBeNull();
    expect(JSON.stringify(result)).not.toContain('do-not-return');
  });
  it('normal weekly-only lane uses its actual duration and host membership', () => {
    const result = quotaAdviceSnapshot(
      DEFAULT_QUOTA_ADVICE,
      ['codex'],
      {
        status: 'ok',
        primary_used_percent: 40,
        primary_limit_seconds: 604800,
        rate_allowed: false,
      },
      { status: 'unavailable' },
    );
    expect(result.codex.windows[0]).toMatchObject({ used_percent: 40, limit_seconds: 604800 });
    expect(result.codex.limit_reached).toBe(true);
    expect(result.claude.available).toBe(false);
    expect(result.claude.status).toBe('unavailable');
  });
});
