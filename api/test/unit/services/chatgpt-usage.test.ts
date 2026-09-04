import { describe, expect, it } from 'vitest';
import {
  buildChatGptHistorySeries,
  ChatGptUsageService,
  normalizeChatGptUsageSnapshot,
  parseChatGptUsageJson,
} from '../../../src/services/chatgpt-usage.js';
import { createDbFake } from '../../helpers/db-fake.js';
import type { RunnerValidationService } from '../../../src/services/runner-validation.js';

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

  it("carries each slot's current window length and drops readings from a different window", () => {
    // chatgpt.com moved the normal lane's weekly quota out of
    // secondary_window and into primary_window on 2026-07-11. Without this
    // the 5-hour readings from before that date and the weekly readings from
    // after it are drawn as one continuous `normal_primary` line.
    const series = buildChatGptHistorySeries(
      [
        {
          fetched_at: '2026-07-10T09:00:00Z',
          primary_used_percent: 41,
          secondary_used_percent: 12,
          spark_primary_used_percent: null,
          spark_secondary_used_percent: null,
          primary_limit_seconds: 18000,
          secondary_limit_seconds: 604800,
        },
        {
          fetched_at: '2026-07-13T09:00:00Z',
          primary_used_percent: 24,
          secondary_used_percent: null,
          spark_primary_used_percent: null,
          spark_secondary_used_percent: null,
          primary_limit_seconds: 604800,
          secondary_limit_seconds: null,
        },
      ],
      { lane: 'normal', window: 'both' },
    );

    const primary = series.find((item) => item.key === 'normal_primary');
    expect(primary?.limit_seconds).toBe(604800);
    expect(primary?.lane).toBe('normal');
    expect(primary?.window).toBe('primary');
    expect(primary?.points).toEqual([{ ts: '2026-07-13T09:00:00Z', value: 24 }]);

    // The slot the provider stopped filling leaves the chart entirely. Left
    // in, it would resolve to the weekly window too and print a second legend
    // entry reading exactly the same as the live one.
    const secondary = series.find((item) => item.key === 'normal_secondary');
    expect(secondary?.limit_seconds).toBeNull();
    expect(secondary?.points).toEqual([]);
  });

  it('does not retire every slot when the newest snapshot recorded nothing', () => {
    // 70 production snapshots carry no readings at all. One of those landing
    // at the end of a range must not blank the chart.
    const series = buildChatGptHistorySeries(
      [
        {
          fetched_at: '2026-09-03T09:00:00Z',
          primary_used_percent: 24,
          secondary_used_percent: null,
          spark_primary_used_percent: null,
          spark_secondary_used_percent: null,
          primary_limit_seconds: 604800,
        },
        {
          fetched_at: '2026-09-03T15:07:36Z',
          primary_used_percent: null,
          secondary_used_percent: null,
          spark_primary_used_percent: null,
          spark_secondary_used_percent: null,
        },
      ],
      { lane: 'normal', window: 'primary' },
    );

    expect(series[0]?.limit_seconds).toBe(604800);
    expect(series[0]?.points).toEqual([{ ts: '2026-09-03T09:00:00Z', value: 24 }]);
  });

  it('keeps every point when no window length was ever recorded', () => {
    const series = buildChatGptHistorySeries(
      [
        {
          fetched_at: '2026-05-20T09:00:00Z',
          primary_used_percent: 2,
          secondary_used_percent: null,
          spark_primary_used_percent: null,
          spark_secondary_used_percent: null,
        },
      ],
      { lane: 'normal', window: 'primary' },
    );

    expect(series[0]?.limit_seconds).toBeNull();
    expect(series[0]?.points).toEqual([{ ts: '2026-05-20T09:00:00Z', value: 2 }]);
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

describe('ChatGptUsageService.fetchAndStore', () => {
  function fakeValidation(): RunnerValidationService {
    return {
      resolveCanonicalPayload: async () => ({}) as never,
      canonicalAuthFromPayload: () => ({ tokens: { access_token: 'tok', account_id: 'acct' } }),
    } as unknown as RunnerValidationService;
  }

  // Regression: chatgpt.com returns 429 once an account is already at its
  // limit, but the body still carries the real rate_limit payload. Treating
  // any non-2xx status as a bare error discarded that payload and left the
  // dashboard showing "no data" right when the user was nearly out of quota.
  it('keeps the parsed rate_limit payload when the HTTP status is 429 but the body is usable', async () => {
    const db = createDbFake();
    const service = new ChatGptUsageService(db as never, undefined, {
      runnerValidation: fakeValidation(),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            plan_type: 'pro',
            rate_limit: {
              allowed: false,
              limit_reached: true,
              primary_window: {
                used_percent: 96,
                limit_window_seconds: 18000,
                reset_after_seconds: 300,
                reset_at: '2026-08-19T13:00:00Z',
              },
              secondary_window: {
                used_percent: 41,
                limit_window_seconds: 604800,
                reset_after_seconds: 86000,
                reset_at: '2026-08-24T13:00:00Z',
              },
            },
          }),
          { status: 429 },
        )) as unknown as typeof fetch,
    });

    const result = await service.refresh();

    expect(result.status).toBe('rate_limited');
    expect(result.error).toBe('HTTP 429');
    expect(result.snapshot).toMatchObject({
      status: 'rate_limited',
      rate_limit_reached: true,
      primary_used_percent: 96,
      secondary_used_percent: 41,
    });
  });

  it('still falls back to a bare error when the non-2xx body has no usable rate_limit data', async () => {
    const db = createDbFake();
    const service = new ChatGptUsageService(db as never, undefined, {
      runnerValidation: fakeValidation(),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 })) as unknown as typeof fetch,
    });

    const result = await service.refresh();

    expect(result.status).toBe('error');
    expect((result.snapshot as Record<string, unknown> | null)?.['status']).toBe('error');
    expect((result.snapshot as Record<string, unknown> | null)?.['primary_used_percent']).toBeFalsy();
    expect((result.snapshot as Record<string, unknown> | null)?.['secondary_used_percent']).toBeFalsy();
  });
});
