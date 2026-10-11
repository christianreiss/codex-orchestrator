import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getTestDb } from '../../helpers/test-db.js';
import { chatgptUsageSnapshots, providerAccounts } from '../../../src/db/schema.js';
import { ChatGptUsageService, normalizeChatGptUsageSnapshot } from '../../../src/services/chatgpt-usage.js';
import type { RunnerValidationService } from '../../../src/services/runner-validation.js';

const handle = await getTestDb();
const accountIds: number[] = [];
const oldTime = '2020-01-01T00:00:00Z';
const validation = {
  resolveCanonicalPayload: async () => ({}),
  canonicalAuthFromPayload: () => ({ tokens: { access_token: 'test' } }),
} as unknown as RunnerValidationService;

describe.skipIf(!handle)('ChatGPT quota failure preservation against MySQL', () => {
  let accountId: number;
  beforeEach(async () => {
    const result = await handle!.db.insert(providerAccounts).values({
      engine: 'codex', label: 'ztest-quota-preservation', createdAt: oldTime, updatedAt: oldTime,
    });
    accountId = Number(result[0].insertId);
    accountIds.push(accountId);
  });
  afterAll(async () => {
    if (accountIds.length) {
      await handle!.db.delete(chatgptUsageSnapshots).where(inArray(chatgptUsageSnapshots.accountId, accountIds));
      await handle!.db.delete(providerAccounts).where(inArray(providerAccounts.id, accountIds));
    }
    await handle!.pool.end();
  });

  it.each(['ok', 'rate_limited'])('preserves %s quota and original age across forced failure, restart and cooldown', async (status) => {
    await handle!.db.insert(chatgptUsageSnapshots).values({
      accountId, status, primaryUsedPercent: 99, rateLimitReached: 1, rateAllowed: 0,
      fetchedAt: oldTime, nextEligibleAt: oldTime, createdAt: oldTime,
    });
    const fetchImpl = vi.fn(async () => { throw new Error('request timed out'); });
    const service = new ChatGptUsageService(handle!.db, undefined, { accountId, runnerValidation: validation, fetchImpl });
    const result = await service.fetchLatest(true);
    expect(result).toMatchObject({ status: 'error', cached: true, error: 'request timed out' });
    expect(result.snapshot).toMatchObject({
      status, primary_used_percent: 99, rate_limit_reached: true, rate_allowed: false,
      fetched_at: oldTime, refresh_error: 'request timed out', cached: true,
    });
    expect(result.snapshot!.refresh_attempted_at).not.toBe(oldTime);
    const restarted = new ChatGptUsageService(handle!.db, undefined, { accountId, runnerValidation: validation, fetchImpl });
    const view = normalizeChatGptUsageSnapshot((await restarted.latest())!);
    expect(view).toMatchObject(result.snapshot!);
    expect(await restarted.fetchLatest()).toMatchObject({ status: 'error', cached: true, snapshot: result.snapshot });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const rows = await handle!.db.select().from(chatgptUsageSnapshots).where(eq(chatgptUsageSnapshots.accountId, accountId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.status === 'error')!.primaryUsedPercent).toBeNull();
  });

  it('does not borrow a usable snapshot from another account or fabricate a first reading', async () => {
    const service = new ChatGptUsageService(handle!.db, undefined, {
      accountId, runnerValidation: validation, fetchImpl: vi.fn(async () => new Response('unavailable', { status: 503 })),
    });
    expect(await service.fetchLatest(true)).toMatchObject({
      status: 'error', cached: false, snapshot: { status: 'error', primary_used_percent: null },
    });
    expect(await service.fetchLatest()).toMatchObject({ status: 'error', cached: true });
  });

  it('aborts a provider fetch without persisting shutdown as a quota observation', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const service = new ChatGptUsageService(handle!.db, undefined, {
      accountId, runnerValidation: validation,
      fetchImpl: vi.fn(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        started();
      })),
    });
    const pending = service.fetchLatest(true, controller.signal);
    await ready;
    controller.abort(new Error('worker stopped'));
    await expect(pending).rejects.toThrow('worker stopped');
    expect(await service.latest()).toBeNull();
  });

  it('restores the UTC-day weekly delta across provider slot changes and excludes other accounts/errors', async () => {
    const db = handle!.db;
    const [foreign] = await db.insert(providerAccounts).values({
      engine: 'codex', label: 'ztest-other-daily-quota', createdAt: oldTime, updatedAt: oldTime,
    });
    accountIds.push(Number(foreign.insertId));
    await db.insert(chatgptUsageSnapshots).values([
      { accountId: Number(foreign.insertId), status: 'ok', secondaryUsedPercent: 0, secondaryLimitSeconds: 604800, fetchedAt: '2026-10-11T00:00:00Z', nextEligibleAt: oldTime, createdAt: oldTime },
      { accountId, status: 'ok', secondaryUsedPercent: 1, secondaryLimitSeconds: 604800, fetchedAt: '2026-10-10T23:00:00Z', nextEligibleAt: oldTime, createdAt: oldTime },
      { accountId, status: 'error', secondaryUsedPercent: null, fetchedAt: '2026-10-11T00:01:00Z', nextEligibleAt: oldTime, createdAt: oldTime },
      { accountId, status: 'rate_limited', primaryUsedPercent: 99, primaryLimitSeconds: 18000, secondaryUsedPercent: 10, secondaryLimitSeconds: 604800, fetchedAt: '2026-10-11T00:02:00Z', nextEligibleAt: oldTime, createdAt: oldTime },
      { accountId, status: 'ok', primaryUsedPercent: 35, primaryLimitSeconds: 604800, fetchedAt: '2026-10-11T12:00:00Z', nextEligibleAt: oldTime, createdAt: oldTime },
    ]);
    const service = new ChatGptUsageService(db, undefined, { accountId, runnerValidation: validation });
    const row = (await service.latest())!;
    expect(await service.dailyUsage(row, new Date('2026-10-11T13:00:00Z'))).toEqual({
      daily_used_percent: 25, daily_baseline_at: '2026-10-11T00:02:00Z',
    });
    expect(await service.dailyUsage(row, new Date('2026-10-12T00:00:00Z'))).toEqual({
      daily_used_percent: null, daily_baseline_at: null,
    });
    expect(await service.dailyUsage({ ...row, primaryLimitSeconds: 18000 }, new Date('2026-10-11T13:00:00Z'))).toEqual({
      daily_used_percent: null, daily_baseline_at: null,
    });
    expect(await service.dailyUsage({ ...row, primaryUsedPercent: 4 }, new Date('2026-10-11T13:00:00Z'))).toEqual({
      daily_used_percent: 0, daily_baseline_at: '2026-10-11T00:02:00Z',
    });
  });

});
