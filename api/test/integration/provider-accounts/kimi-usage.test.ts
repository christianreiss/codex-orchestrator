import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { kimiUsageSnapshots, providerAccounts, versions } from '../../../src/db/schema.js';
import { KimiUsageService, readKimiUsage } from '../../../src/services/kimi-usage.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import type { Database } from '../../../src/db/client.js';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Kimi subscription usage observations', () => {
  let db: Database;
  const ids: number[] = [];
  const auth = {
    kimi_code: {
      access_token: 'fixture-kimi-access',
      refresh_token: 'fixture-private-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
    },
    device_id: 'a'.repeat(32),
    base_url: 'https://api.kimi.com/coding/v1',
    oauth_host: 'https://auth.kimi.com',
    last_refresh: new Date().toISOString(),
  };
  const ensureFresh = vi.fn(async () => ({ auth }) as never);
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  let service: KimiUsageService;
  const response = (weekly = true) =>
    new Response(
      JSON.stringify({
        usages: {
          limit_5h: { used_ratio: '0.42', reset_time: new Date(Date.now() + 3_600_000).toISOString() },
          ...(weekly
            ? { limit_7d: { used_ratio: 0.75, reset_time: new Date(Date.now() + 604_800_000).toISOString() } }
            : {}),
        },
      }),
    );
  beforeAll(async () => {
    db = handle!.db;
    for (let i = 0; i < 2; i++) {
      const label = `kimi-usage-${randomUUID()}`;
      await db.insert(providerAccounts).values({
        engine: 'kimi',
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
    request = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/me') ? new Response(JSON.stringify({ user_level_name: 'Vivace' })) : response(),
    );
    service = new KimiUsageService({ db, authOwner: { ensureFresh }, fetchImpl: request });
    await db.delete(kimiUsageSnapshots).where(inArray(kimiUsageSnapshots.accountId, ids));
    await db.update(providerAccounts).set({ state: 'enabled' }).where(inArray(providerAccounts.id, ids));
    await db
      .insert(versions)
      .values({ name: 'kimi_engine_disabled', version: '0', updatedAt: new Date().toISOString() })
      .onDuplicateKeyUpdate({ set: { version: '0' } });
  });
  afterAll(async () => {
    await db.delete(kimiUsageSnapshots).where(inArray(kimiUsageSnapshots.accountId, ids));
    await db.delete(providerAccounts).where(inArray(providerAccounts.id, ids));
    await handle?.pool.end();
  });
  const expireCheck = () =>
    db
      .update(kimiUsageSnapshots)
      .set({ checkedAt: new Date(Date.now() - 600_000).toISOString() })
      .where(eq(kimiUsageSnapshots.accountId, ids[0]!));
  it('uses the canonical owner and publishes plan plus both account-scoped quota windows without credentials', async () => {
    await service.refreshAccount(ids[0]!);
    expect(ensureFresh).toHaveBeenCalledWith({ accountId: ids[0], minValiditySeconds: 60 });
    expect(request).toHaveBeenCalledWith(
      `${auth.base_url}/usages`,
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: `Bearer ${auth.kimi_code.access_token}`, Accept: 'application/json' },
        redirect: 'error',
      }),
    );
    const usage = await new ProviderAccountsService(db, testKeyring()).usage(ids[0]!, 'kimi');
    expect(usage).toMatchObject({
      supported: true,
      plan_name: 'Vivace',
      error_code: null,
      windows: [
        { kind: 'five_hour', used_percent: 42 },
        { kind: 'weekly', used_percent: 75 },
      ],
    });
    expect(JSON.stringify(usage)).not.toContain('fixture-');
    expect(await readKimiUsage(db, ids[1]!)).toMatchObject({ windows: [], fetched_at: null });
    await service.refreshAccount(ids[0]!);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('retains a failed observation and its provenance instead of replacing it with zero', async () => {
    await service.refreshAccount(ids[0]!);
    await expireCheck();
    request.mockImplementation(async () => new Response('', { status: 503 }));
    await service.refreshAccount(ids[0]!);
    expect(await readKimiUsage(db, ids[0]!)).toMatchObject({
      stale: true,
      error_code: 'provider_http_503',
      windows: [
        { kind: 'five_hour', used_percent: 42 },
        { kind: 'weekly', used_percent: 75 },
      ],
    });
  });
  it('clears an absent weekly limit rather than inventing a long window', async () => {
    await service.refreshAccount(ids[0]!);
    await expireCheck();
    request.mockImplementation(async (url) =>
      String(url).endsWith('/me') ? new Response('{}') : response(false),
    );
    await service.refreshAccount(ids[0]!);
    expect(await readKimiUsage(db, ids[0]!)).toMatchObject({
      plan_name: null,
      windows: [{ kind: 'five_hour', used_percent: 42 }],
      weekly_used_percent: null,
    });
  });
  it('does not publish after the account is suspended during the provider request', async () => {
    request.mockImplementation(async () => {
      await db.update(providerAccounts).set({ state: 'disabled' }).where(eq(providerAccounts.id, ids[0]!));
      return response();
    });
    await service.refreshAccount(ids[0]!);
    expect(await readKimiUsage(db, ids[0]!)).toMatchObject({ windows: [], fetched_at: null });
  });
});
