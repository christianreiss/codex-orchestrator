import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { grokUsageSnapshots, providerAccounts, versions } from '../../../src/db/schema.js';
import { GROK_AUTH_SCOPE } from '../../../src/services/grok-auth.js';
import { GrokUsageService, GROK_USAGE_URL, readGrokUsage } from '../../../src/services/grok-usage.js';
import type { Database } from '../../../src/db/client.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Grok subscription observations in the account dashboard', () => {
  let db: Database;
  const ids: number[] = [];
  const access = 'private-test-grok-access-token';
  const auth = {
    grok_auth: {
      [GROK_AUTH_SCOPE]: {
        auth_mode: 'external',
        key: access,
        user_id: 'test-account',
        create_time: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    },
  };
  const ensureFresh = vi.fn(async () => ({ auth }) as never);
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  let service: GrokUsageService;
  const response = (used = 5) =>
    new Response(
      JSON.stringify({
        config: {
          creditUsagePercent: used,
          isUnifiedBillingUser: true,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            end: new Date(Date.now() + 604_800_000).toISOString(),
          },
        },
      }),
    );

  beforeAll(async () => {
    db = handle!.db;
    for (let i = 0; i < 2; i++) {
      const label = `usage-${randomUUID()}`;
      await db
        .insert(providerAccounts)
        .values({
          engine: 'grok',
          label,
          state: 'enabled',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      ids.push((await db.select().from(providerAccounts).where(eq(providerAccounts.label, label)))[0]!.id);
    }
  });
  beforeEach(async () => {
    ensureFresh.mockClear();
    request = vi.fn<typeof fetch>(async () => response());
    service = new GrokUsageService({ db: db, authOwner: { ensureFresh }, fetchImpl: request });
    await db.delete(grokUsageSnapshots).where(inArray(grokUsageSnapshots.accountId, ids));
    await db.update(providerAccounts).set({ state: 'enabled' }).where(inArray(providerAccounts.id, ids));
    await db
      .insert(versions)
      .values({ name: 'grok_engine_disabled', version: '0', updatedAt: new Date().toISOString() })
      .onDuplicateKeyUpdate({ set: { version: '0' } });
  });
  afterAll(async () => {
    if (!handle) return;
    await db.delete(grokUsageSnapshots).where(inArray(grokUsageSnapshots.accountId, ids));
    await db.delete(providerAccounts).where(inArray(providerAccounts.id, ids));
    await db.update(versions).set({ version: '0' }).where(eq(versions.name, 'grok_engine_disabled'));
    await handle.pool.end();
  });

  it('polls through the auth owner and publishes only account-scoped non-secret display data', async () => {
    await service.refreshAccount(ids[0]!);
    expect(ensureFresh).toHaveBeenCalledWith({ accountId: ids[0], minValiditySeconds: 60 });
    expect(request).toHaveBeenCalledWith(
      GROK_USAGE_URL,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${access}`,
          'X-XAI-Token-Auth': 'xai-grok-cli',
          Accept: 'application/json',
          'x-userid': 'test-account',
        },
      }),
    );
    const usage = await new ProviderAccountsService(db, testKeyring()).usage(ids[0]!, 'grok');
    expect(usage).toMatchObject({
      supported: true,
      stale: false,
      error_code: null,
      current_window: { used_percent: 5, period: 'weekly', shared: true },
    });
    expect(usage.short_used_percent).toBeNull();
    expect(usage.weekly_used_percent).toBeNull(); // display does not introduce automatic quota gating
    expect(JSON.stringify(usage)).not.toContain(access);
    expect(await readGrokUsage(db, ids[1]!)).toMatchObject({ stale: true, current_window: null });
  });

  it('keeps a known zero distinct from unavailable data and caches across service restarts', async () => {
    request.mockImplementation(async () => response(0));
    await service.refreshAccount(ids[0]!);
    await new GrokUsageService({ db: db, authOwner: { ensureFresh }, fetchImpl: request }).refreshAccount(
      ids[0]!,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(await readGrokUsage(db, ids[0]!)).toMatchObject({
      stale: false,
      current_window: { used_percent: 0 },
    });
  });

  it('preserves the last reading on provider failure and backs off unsuccessful polls', async () => {
    await service.refreshAccount(ids[0]!);
    const previous = await readGrokUsage(db, ids[0]!);
    await db
      .update(grokUsageSnapshots)
      .set({ checkedAt: new Date(Date.now() - 360_000).toISOString() })
      .where(eq(grokUsageSnapshots.accountId, ids[0]!));
    request.mockImplementation(async () => new Response('private upstream message', { status: 503 }));
    await service.refreshAccount(ids[0]!);
    await service.refreshAccount(ids[0]!);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await readGrokUsage(db, ids[0]!)).toMatchObject({
      stale: true,
      fetched_at: previous.fetched_at,
      error_code: 'provider_http_503',
      current_window: { used_percent: 5 },
    });
  });

  it('does not contact suspended engines, paused accounts, or accounts suspended during a fetch', async () => {
    await db.update(versions).set({ version: '1' }).where(eq(versions.name, 'grok_engine_disabled'));
    await service.refreshAccount(ids[0]!);
    await db.update(versions).set({ version: '0' }).where(eq(versions.name, 'grok_engine_disabled'));
    await db.update(providerAccounts).set({ state: 'paused' }).where(eq(providerAccounts.id, ids[0]!));
    await service.refreshAccount(ids[0]!);
    expect(ensureFresh).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    request.mockImplementation(async () => {
      await db.update(providerAccounts).set({ state: 'paused' }).where(eq(providerAccounts.id, ids[1]!));
      return response();
    });
    await service.refreshAccount(ids[1]!);
    expect(await readGrokUsage(db, ids[1]!)).toMatchObject({ fetched_at: null, current_window: null });
  });

  it('never replaces unknown data with zero or exposes credential errors', async () => {
    ensureFresh.mockRejectedValueOnce(new Error(`sensitive: ${access}`));
    await service.refreshAccount(ids[0]!);
    const result = await readGrokUsage(db, ids[0]!);
    expect(result).toMatchObject({
      fetched_at: null,
      stale: true,
      current_window: null,
      error_code: 'auth_unavailable',
    });
    expect(JSON.stringify(result)).not.toContain(access);
    request.mockImplementation(async () => new Response(JSON.stringify({ config: null })));
    await service.refreshAccount(ids[1]!);
    expect(await readGrokUsage(db, ids[1]!)).toMatchObject({
      current_window: null,
      error_code: 'usage_unavailable',
    });
  });

  it('marks an old or reset period stale without inventing a reset reading', async () => {
    await service.refreshAccount(ids[0]!);
    await db
      .update(grokUsageSnapshots)
      .set({ periodResetsAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(grokUsageSnapshots.accountId, ids[0]!));
    expect(await readGrokUsage(db, ids[0]!)).toMatchObject({
      stale: true,
      current_window: { used_percent: 5 },
    });
  });
});
