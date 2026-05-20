import { describe, expect, it } from 'vitest';
import {
  buildChatGptHistorySeries,
  normalizeChatGptUsageSnapshot,
  parseChatGptUsageJson,
} from '../../../src/services/chatgpt-usage.js';

describe('ChatGPT usage compatibility shape', () => {
  it('normalizes flat snapshot rows into nested quota windows', () => {
    const snapshot = normalizeChatGptUsageSnapshot({
      id: 1,
      hostId: 12,
      status: 'ok',
      planType: 'pro',
      rateAllowed: 1,
      rateLimitReached: 0,
      primaryUsedPercent: 2,
      primaryLimitSeconds: 18000,
      primaryResetAfterSeconds: 1200,
      primaryResetAt: '2026-05-20T10:00:00Z',
      secondaryUsedPercent: 3,
      secondaryLimitSeconds: 604800,
      secondaryResetAfterSeconds: 86400,
      secondaryResetAt: '2026-05-21T10:00:00Z',
      sparkLimitName: 'spark',
      sparkMeteredFeature: 'spark',
      sparkRateAllowed: 1,
      sparkRateLimitReached: 0,
      sparkPrimaryUsedPercent: 0,
      sparkPrimaryLimitSeconds: 18000,
      sparkPrimaryResetAfterSeconds: 1200,
      sparkPrimaryResetAt: '2026-05-20T10:00:00Z',
      sparkSecondaryUsedPercent: 1,
      sparkSecondaryLimitSeconds: 604800,
      sparkSecondaryResetAfterSeconds: 86400,
      sparkSecondaryResetAt: '2026-05-21T10:00:00Z',
      hasCredits: null,
      unlimited: null,
      creditBalance: null,
      approxLocalMessages: null,
      approxCloudMessages: null,
      raw: null,
      error: null,
      fetchedAt: '2026-05-20T09:00:00Z',
      nextEligibleAt: '2026-05-20T09:05:00Z',
      createdAt: '2026-05-20T09:00:00Z',
    });

    expect(snapshot.primary_used_percent).toBe(2);
    expect(snapshot.rate_allowed).toBe(true);
    expect(snapshot.rate_limit_reached).toBe(false);
    expect(snapshot.primary_window).toMatchObject({ used_percent: 2, resets_at: '2026-05-20T10:00:00Z' });
    expect(snapshot.normal_window).toMatchObject({
      primary_window: { used_percent: 2 },
      secondary_window: { used_percent: 3 },
    });
    expect(snapshot.spark_window).toMatchObject({
      primary_window: { used_percent: 0 },
      secondary_window: { used_percent: 1 },
    });
  });

  it('builds frontend-compatible history series', () => {
    const series = buildChatGptHistorySeries(
      [
        {
          fetched_at: '2026-05-20T09:00:00Z',
          primary_used_percent: 2,
          secondary_used_percent: 3,
          spark_primary_used_percent: 0,
          spark_secondary_used_percent: 1,
        },
      ],
      { lane: 'both', window: 'both' },
    );

    expect(series.map((item) => item.key)).toEqual([
      'normal_primary',
      'normal_secondary',
      'spark_primary',
      'spark_secondary',
    ]);
    expect(series.find((item) => item.key === 'normal_secondary')?.points).toEqual([
      { ts: '2026-05-20T09:00:00Z', value: 3 },
    ]);
  });

  it('parses ChatGPT wham usage payloads including the Spark lane', () => {
    const parsed = parseChatGptUsageJson({
      plan_type: 'pro',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 4,
          limit_window_seconds: 18000,
          reset_after_seconds: 900,
          reset_at: '2026-05-20T12:00:00Z',
        },
        secondary_window: {
          used_percent: 7,
          limit_window_seconds: 604800,
          reset_after_seconds: 86400,
          reset_at: '2026-05-21T12:00:00Z',
        },
      },
      additional_rate_limits: [
        {
          limit_name: 'Spark',
          metered_feature: 'bengalfox',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 1, limit_window_seconds: 18000 },
            secondary_window: { used_percent: 2, limit_window_seconds: 604800 },
          },
        },
      ],
    });

    expect(parsed).toMatchObject({
      planType: 'pro',
      rateAllowed: 1,
      rateLimitReached: 0,
      primaryUsedPercent: 4,
      secondaryUsedPercent: 7,
      sparkLimitName: 'Spark',
      sparkPrimaryUsedPercent: 1,
      sparkSecondaryUsedPercent: 2,
    });
  });
});
