import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/db/schema.js';
import {
  authCanonicalHeads,
  authEntries,
  authPayloads,
  kimiAuthRefreshState,
  providerAccounts,
  providerAccountSessions,
  logs,
} from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import { getTestDb, readDbConfig } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { createPooledAuthStoreService } from '../../../src/services/pooled-auth-store.js';
import { createKimiAuthOwner } from '../../../src/services/kimi-auth-owner.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import { KIMI_OIDC_CLIENT_ID, selectKimiCredential } from '../../../src/services/kimi-auth.js';
import { decrypt, encrypt } from '../../../src/security/secret-box.js';
import type { RunnerClient, RunnerVerifyResult } from '../../../src/services/runner-client.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Kimi fenced OAuth owner on MySQL', () => {
  const db = handle?.db as Database;
  const keyring = testKeyring();
  const validation = createRunnerValidationService({ db, keyring });
  const accounts = new ProviderAccountsService(db, keyring);
  const otherPools: mysql.Pool[] = [];
  let verdict: RunnerVerifyResult;
  let spendCount = 0;
  let verificationCount = 0;
  let renewal: () => Promise<Response>;
  const verified: RunnerVerifyResult = { ok: true, status: 'ok', reachable: true, definitive: true };
  const runner: RunnerClient = {
    isConfigured: () => true,
    verify: async () => verified,
    verifyClaude: async () => verified,
    verifyKimi: async ({ authJson }) => {
      verificationCount++;
      expect(selectKimiCredential(authJson, true)?.refresh).toBeNull();
      expect(selectKimiCredential(authJson, true)?.native.expires_at).toBe(0);
      return verdict;
    },
  };
  const store = createPooledAuthStoreService({ db, keyring, runnerValidation: validation, runner });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const replacement = (tag = 'rotated', lifetime = 7200, includeRefresh = true) => ({
    access_token: `fixture-${tag}-access-token-123456789`,
    expires_in: lifetime,
    ...(includeRefresh && { refresh_token: `fixture-${tag}-refresh-token-123456789` }),
  });
  const request: typeof fetch = async (url, init) => {
    expect(init?.redirect).toBe('error');
    expect(String(url)).toBe('https://auth.kimi.com/api/oauth/token');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'X-Msh-Platform': 'kimi_code_cli',
      'X-Msh-Device-Id': '0123456789abcdef0123456789abcdef',
    });
    const form = init?.body as URLSearchParams;
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('client_id')).toBe(KIMI_OIDC_CLIENT_ID);
    expect(form.get('refresh_token')).toMatch(/^fixture-/);
    spendCount++;
    return renewal();
  };
  const owner = (connection: Database = db) =>
    createKimiAuthOwner({ db: connection, keyring, runner, fetchImpl: request });
  const auth = (tag = 'original', lifetime = 500) => ({
    kimi_code: {
      access_token: `fixture-${tag}-access-token-123456789`,
      refresh_token: `fixture-${tag}-refresh-token-123456789`,
      expires_at: Math.floor(Date.now() / 1000) + lifetime,
      expires_in: 1800,
      scope: 'kimi-code',
      token_type: 'Bearer',
    },
    device_id: '0123456789abcdef0123456789abcdef',
    oauth_host: 'https://auth.kimi.com',
    base_url: 'https://api.kimi.com/coding/v1',
    last_refresh: new Date(Date.now() - 1000).toISOString(),
  });
  const enroll = async (lifetime = 500) => {
    const result = await store.storeCandidate({
      engine: 'kimi',
      auth: auth('original', lifetime),
      sourceHostId: null,
      requireLastRefresh: false,
      logAction: 'test.kimi.login',
      enrollAccount: true,
    });
    expect(JSON.stringify(result.auth)).not.toContain('fixture-original-refresh-token');
    return result.account_id!;
  };
  const lease = async (accountId: number) => {
    await accounts.acquire(1, 'kimi', 'fixture-scope', 'fixture-session', 95, accountId);
    return { accountId, sourceHostId: 1, sessionId: 'fixture-session' };
  };
  const refreshState = async (accountId: number) =>
    (await db.select().from(kimiAuthRefreshState).where(eq(kimiAuthRefreshState.accountId, accountId)))[0]!;
  const head = (accountId: number) => validation.resolveCanonicalPayload('kimi', accountId);
  const cleanup = async () => {
    await db.delete(kimiAuthRefreshState);
    await db.delete(providerAccountSessions);
    await db.delete(authCanonicalHeads);
    await db.delete(authEntries);
    await db.delete(schema.chatgptUsageSnapshots);
    await db.delete(schema.claudeUsageSnapshots);
    await db.delete(authPayloads);
    await db.delete(providerAccounts);
    await db.delete(logs);
  };
  beforeEach(async () => {
    await cleanup();
    verdict = verified;
    spendCount = 0;
    verificationCount = 0;
    renewal = async () => json(replacement());
  });
  afterAll(async () => {
    await cleanup();
    await Promise.all(otherPools.map((pool) => pool.end()));
    await handle!.pool.end();
  });

  it('serializes two API pools and returns one successor for the same observed generation', async () => {
    const accountId = await enroll();
    const input = await lease(accountId);
    const base = (await head(accountId))!;
    const pool = mysql.createPool(readDbConfig()!);
    otherPools.push(pool);
    const secondDb = drizzle(pool, { schema, mode: 'default' }) as Database;
    renewal = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return json(replacement());
    };
    const results = await Promise.all([
      owner().ensureFresh({ ...input, refreshIfGeneration: base.generation! }),
      owner(secondDb).ensureFresh({ ...input, refreshIfGeneration: base.generation! }),
    ]);
    expect(spendCount).toBe(1);
    expect(results[0].canonical_generation).toBe(base.generation! + 1);
    expect(results[1].canonical_generation).toBe(results[0].canonical_generation);
    expect(results[1].access_token_digest).toBe(results[0].access_token_digest);
    expect(JSON.stringify(results.map((result) => result.auth))).not.toMatch(
      /fixture-original-refresh-token|fixture-rotated-refresh-token/,
    );
    const canonical = validation.validateCanonicalPayload(await head(accountId))!.auth;
    expect(selectKimiCredential(canonical)?.refresh).toBe(replacement().refresh_token);
  });

  it('captures rotation and the ledger before verification, then retries only the static probe', async () => {
    const accountId = await enroll();
    const base = (await head(accountId))!;
    verdict = { ok: false, status: 'fail', reachable: false, definitive: false };
    await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({ code: 'kimi_refresh_pending' });
    const pendingState = await refreshState(accountId);
    expect(pendingState.state).toBe('pending_verification');
    expect(pendingState.responseEnc).toMatch(/^sbox:v1/);
    expect(JSON.parse(decrypt(pendingState.responseEnc!, keyring)).body).toContain(
      replacement().refresh_token,
    );
    const pending = (
      await db.select().from(authPayloads).where(eq(authPayloads.id, pendingState.pendingPayloadId!))
    )[0]!;
    expect(pending).toMatchObject({
      sourceKind: 'kimi_refresh',
      parentPayloadId: base.id,
      verificationState: 'pending',
    });
    expect(selectKimiCredential(validation.validateCanonicalPayload(pending)!.auth)?.refresh).toBe(
      replacement().refresh_token,
    );
    expect((await head(accountId))?.id).toBe(base.id);
    expect(verificationCount).toBe(2);
    verdict = verified;
    const result = await owner().ensureFresh({ accountId });
    expect(result.canonical_generation).toBe(pending.generation);
    expect(spendCount).toBe(1);
    expect(verificationCount).toBe(3);
    expect((await refreshState(accountId)).responseEnc).toBeNull();
  });

  it('fences an owner lost after durable intent without replaying its refresh grant', async () => {
    const accountId = await enroll();
    const base = (await head(accountId))!;
    await db
      .insert(kimiAuthRefreshState)
      .values({
        accountId,
        state: 'refreshing',
        attemptId: 'lost-owner',
        basePayloadId: base.id,
        baseGeneration: base.generation,
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      })
      .onDuplicateKeyUpdate({ set: { state: 'refreshing', attemptId: 'lost-owner', responseEnc: null } });
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({
        code: 'kimi_refresh_uncertain',
      });
    expect(spendCount).toBe(0);
    expect(await refreshState(accountId)).toMatchObject({
      state: 'uncertain',
      errorCode: 'owner_lost_after_intent',
    });
  });

  it('recovers a durable successful response without spending the old grant again', async () => {
    const accountId = await enroll();
    const base = (await head(accountId))!;
    const received = new Date().toISOString();
    await db
      .update(kimiAuthRefreshState)
      .set({
        state: 'refreshing',
        attemptId: 'captured-owner',
        basePayloadId: base.id,
        baseGeneration: base.generation,
        responseEnc: encrypt(
          JSON.stringify({ received_at: received, body: JSON.stringify(replacement('captured')) }),
          keyring,
        ),
      })
      .where(eq(kimiAuthRefreshState.accountId, accountId));
    const result = await owner().ensureFresh({ accountId });
    expect(result.canonical_generation).toBe(base.generation! + 1);
    expect(selectKimiCredential(result.auth, true)?.access).toBe(replacement('captured').access_token);
    expect(spendCount).toBe(0);
  });

  it.each(['transport', 'ambiguous_status', 'invalid_success'] as const)(
    'keeps %s outcomes fenced through subsequent owner calls',
    async (kind) => {
      const accountId = await enroll();
      renewal = async () => {
        if (kind === 'transport') throw new TypeError('network connection lost');
        if (kind === 'ambiguous_status')
          return new Response('<html>upstream failure</html>', { status: 503 });
        return json({ access_token: 'fixture-missing-expiry-and-refresh' });
      };
      await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({
        code: 'kimi_refresh_uncertain',
      });
      await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({
        code: 'kimi_refresh_uncertain',
      });
      expect(spendCount).toBe(1);
      expect((await refreshState(accountId)).state).toBe('uncertain');
    },
  );

  it.each(['invalid_grant', 'invalid_client'])(
    'requires a new login after %s without automatic retries',
    async (error) => {
      const accountId = await enroll();
      renewal = async () => json({ error }, 400);
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({
          code: 'kimi_login_required',
        });
      expect(spendCount).toBe(1);
      expect(await refreshState(accountId)).toMatchObject({ state: 'login_required', errorCode: error });
    },
  );

  it('backs off an explicit transient OAuth rejection without fencing the grant permanently', async () => {
    const accountId = await enroll();
    renewal = async () => json({ error: 'temporarily_unavailable' }, 503, { 'retry-after': '10' });
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({
        code: 'kimi_refresh_transient',
      });
    expect(spendCount).toBe(1);
    expect(await refreshState(accountId)).toMatchObject({
      state: 'idle',
      errorCode: 'temporarily_unavailable',
    });
  });

  it('fences a successful response missing the mandatory rotated refresh token', async () => {
    const accountId = await enroll();
    renewal = async () => json(replacement('access-only-response', 7200, false));
    await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({
      code: 'kimi_refresh_uncertain',
    });
    await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({
      code: 'kimi_refresh_uncertain',
    });
    expect(spendCount).toBe(1);
    expect((await refreshState(accountId)).responseEnc).toMatch(/^sbox:v1/);
  });

  it('rejects expired or foreign sessions before reactive renewal and never revives an expired lease', async () => {
    const accountId = await enroll();
    const input = await lease(accountId);
    const generation = (await head(accountId))!.generation!;
    await expect(
      owner().ensureFresh({ ...input, sourceHostId: 2, refreshIfGeneration: generation }),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .update(providerAccountSessions)
      .set({ expiresAt: new Date(Date.now() - 1).toISOString() })
      .where(eq(providerAccountSessions.id, input.sessionId));
    await expect(owner().ensureFresh({ ...input, refreshIfGeneration: generation })).rejects.toMatchObject({
      status: 404,
    });
    await expect(accounts.heartbeat(1, 'kimi', input.sessionId)).rejects.toMatchObject({ status: 404 });
    expect(spendCount).toBe(0);
  });

  it('requires a live account pin for reactive renewal and rejects impossible observed generations', async () => {
    const accountId = await enroll(7200);
    await expect(owner().ensureFresh({ accountId, refreshIfGeneration: 1 })).rejects.toMatchObject({
      code: 'kimi_session_required',
    });
    const input = await lease(accountId);
    await expect(owner().ensureFresh({ ...input, refreshIfGeneration: 999 })).rejects.toMatchObject({
      code: 'kimi_generation_conflict',
    });
    expect(spendCount).toBe(0);
  });

  it('renews once on same-generation provider rejection even while the bearer is fresh', async () => {
    const accountId = await enroll(7200);
    const input = await lease(accountId);
    const observed = (await head(accountId))!.generation!;
    const next = await owner().ensureFresh({ ...input, refreshIfGeneration: observed });
    expect(next.canonical_generation).toBeGreaterThan(observed);
    const successor = await owner().ensureFresh({ ...input, refreshIfGeneration: observed });
    expect(successor.canonical_generation).toBe(next.canonical_generation);
    expect(spendCount).toBe(1);
  });

  it('rejects stale host uploads and runtime projections, and clears fencing only after a distinct verified login', async () => {
    const accountId = await enroll();
    await db
      .update(kimiAuthRefreshState)
      .set({ state: 'uncertain', errorCode: 'transport_outcome_unknown' })
      .where(eq(kimiAuthRefreshState.accountId, accountId));
    await expect(
      store.storeCandidate({
        engine: 'kimi',
        accountId,
        auth: auth(),
        sourceHostId: null,
        requireLastRefresh: false,
        logAction: 'test.kimi.login',
      }),
    ).rejects.toMatchObject({ code: 'kimi_login_required' });
    await expect(
      store.storeCandidate({
        engine: 'kimi',
        accountId,
        auth: auth('new-login', 7200),
        sourceHostId: 1,
        baseCanonicalGeneration: 0,
        requireLastRefresh: false,
        logAction: 'test.kimi.login',
      }),
    ).rejects.toMatchObject({ code: 'kimi_generation_conflict' });
    const result = await store.storeCandidate({
      engine: 'kimi',
      accountId,
      auth: auth('new-login', 7200),
      sourceHostId: null,
      requireLastRefresh: false,
      logAction: 'test.kimi.login',
    });
    expect((await refreshState(accountId)).state).toBe('idle');
    expect((await owner().ensureFresh({ accountId })).canonical_generation).toBe(result.canonical_generation);
    await expect(
      store.storeCandidate({
        engine: 'kimi',
        accountId,
        auth: result.auth!,
        sourceHostId: null,
        requireLastRefresh: false,
        logAction: 'test.kimi.projection',
      }),
    ).rejects.toThrow();
    expect(spendCount).toBe(0);
  });

  it('keeps draining accounts usable for their live lease and wipes captured grants after the final lease ends', async () => {
    const accountId = await enroll();
    const input = await lease(accountId);
    await accounts.update(accountId, { state: 'removing' });
    const next = await owner().ensureFresh(input);
    expect(next.canonical_generation).toBeGreaterThan(1);
    await db
      .update(kimiAuthRefreshState)
      .set({ responseEnc: encrypt('fixture-captured-response', keyring) })
      .where(eq(kimiAuthRefreshState.accountId, accountId));
    await accounts.release(1, 'kimi', input.sessionId);
    expect((await accounts.get(accountId)).state).toBe('removed');
    expect(
      await db.select().from(kimiAuthRefreshState).where(eq(kimiAuthRefreshState.accountId, accountId)),
    ).toHaveLength(0);
    expect(
      (await db.select().from(authPayloads).where(eq(authPayloads.accountId, accountId))).every(
        (row) => row.body === null,
      ),
    ).toBe(true);
  });

  it('uses a single-connection pool for the fenced ledger and promotion without pool starvation', async () => {
    const accountId = await enroll();
    const pool = mysql.createPool({ ...readDbConfig()!, connectionLimit: 1 });
    otherPools.push(pool);
    const limited = drizzle(pool, { schema, mode: 'default' }) as Database;
    expect(
      (await owner(limited).ensureFresh({ accountId, deadlineMs: 1500 })).canonical_generation,
    ).toBeGreaterThan(1);
    expect(spendCount).toBe(1);
  });

  it('requires the runner lifetime buffer without repeatedly spending a short-lived successor', async () => {
    const accountId = await enroll();
    renewal = async () => json(replacement('short', 800));
    await expect(owner().ensureFresh({ accountId, minValiditySeconds: 900 })).rejects.toMatchObject({
      code: 'kimi_lifetime_insufficient',
    });
    expect(spendCount).toBe(1);
    expect((await head(accountId))?.verificationState).toBe('verified');
  });
});
