import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/db/schema.js';
import { authCanonicalHeads, authEntries, authPayloads, grokAuthRefreshState, providerAccounts, providerAccountSessions, logs } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import { getTestDb, readDbConfig } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { createPooledAuthStoreService } from '../../../src/services/pooled-auth-store.js';
import { createGrokAuthOwner } from '../../../src/services/grok-auth-owner.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import { GROK_AUTH_SCOPE, GROK_OIDC_CLIENT_ID, GROK_OIDC_ISSUER, selectGrokCredential } from '../../../src/services/grok-auth.js';
import { decrypt, encrypt } from '../../../src/security/secret-box.js';
import type { RunnerClient, RunnerVerifyResult } from '../../../src/services/runner-client.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Grok fenced OAuth owner on MySQL', () => {
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
    verifyGrok: async ({ authJson }) => {
      verificationCount++;
      expect(JSON.stringify(authJson)).not.toContain('refresh_token');
      expect(selectGrokCredential(authJson, true)?.native.auth_mode).toBe('external');
      return verdict;
    },
  };
  const store = createPooledAuthStoreService({ db, keyring, runnerValidation: validation, runner });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const replacement = (tag = 'rotated', lifetime = 7200, includeRefresh = true) => ({ access_token: `fixture-${tag}-access-token-123456789`, expires_in: lifetime, ...(includeRefresh && { refresh_token: `fixture-${tag}-refresh-token-123456789` }) });
  const request: typeof fetch = async (url, init) => {
    expect(init?.redirect).toBe('error');
    if (String(url).endsWith('/.well-known/openid-configuration')) return json({ issuer: GROK_OIDC_ISSUER, token_endpoint: `${GROK_OIDC_ISSUER}/oauth/token` });
    expect(String(url)).toBe(`${GROK_OIDC_ISSUER}/oauth/token`);
    expect(init?.method).toBe('POST');
    const form = init?.body as URLSearchParams;
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('client_id')).toBe(GROK_OIDC_CLIENT_ID);
    expect(form.get('refresh_token')).toMatch(/^fixture-/);
    spendCount++;
    return renewal();
  };
  const owner = (connection: Database = db) => createGrokAuthOwner({ db: connection, keyring, runner, fetchImpl: request });
  const auth = (tag = 'original', lifetime = 500) => ({
    [GROK_AUTH_SCOPE]: {
      auth_mode: 'oidc', key: `fixture-${tag}-access-token-123456789`, refresh_token: `fixture-${tag}-refresh-token-123456789`,
      create_time: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + lifetime * 1000).toISOString(),
      oidc_issuer: GROK_OIDC_ISSUER, oidc_client_id: GROK_OIDC_CLIENT_ID, user_id: 'fixture-user-one', email: 'fixture@example.invalid',
      team_metadata: { future_field: 'retained' },
    },
    'other-scope': { auth_mode: 'api_key', key: 'fixture-unselected-api-key', refresh_token: 'fixture-unselected-refresh', future_field: 7 },
  });
  const enroll = async (lifetime = 500) => {
    const result = await store.storeCandidate({ engine: 'grok', auth: auth('original', lifetime), sourceHostId: null, requireLastRefresh: false, logAction: 'test.grok.login', enrollAccount: true });
    expect(JSON.stringify(result.auth)).not.toContain('refresh_token');
    return result.account_id!;
  };
  const lease = async (accountId: number) => {
    await accounts.acquire(1, 'grok', 'fixture-scope', 'fixture-session', 95, accountId);
    return { accountId, sourceHostId: 1, sessionId: 'fixture-session' };
  };
  const refreshState = async (accountId: number) => (await db.select().from(grokAuthRefreshState).where(eq(grokAuthRefreshState.accountId, accountId)))[0]!;
  const head = (accountId: number) => validation.resolveCanonicalPayload('grok', accountId);
  const cleanup = async () => {
    await db.delete(grokAuthRefreshState);
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
    await Promise.all(otherPools.map(pool => pool.end()));
    await handle!.pool.end();
  });

  it('serializes two API pools and returns one successor for the same observed generation', async () => {
    const accountId = await enroll();
    const input = await lease(accountId);
    const base = (await head(accountId))!;
    const pool = mysql.createPool(readDbConfig()!);
    otherPools.push(pool);
    const secondDb = drizzle(pool, { schema, mode: 'default' }) as Database;
    renewal = async () => { await new Promise(resolve => setTimeout(resolve, 80)); return json(replacement()); };
    const results = await Promise.all([owner().ensureFresh({ ...input, refreshIfGeneration: base.generation! }), owner(secondDb).ensureFresh({ ...input, refreshIfGeneration: base.generation! })]);
    expect(spendCount).toBe(1);
    expect(results[0].canonical_generation).toBe(base.generation! + 1);
    expect(results[1].canonical_generation).toBe(results[0].canonical_generation);
    expect(results[1].access_token_digest).toBe(results[0].access_token_digest);
    expect(JSON.stringify(results.map(result => result.auth))).not.toMatch(/refresh_token|fixture-unselected-api-key/);
    const canonical = validation.validateCanonicalPayload(await head(accountId))!.auth;
    expect(selectGrokCredential(canonical)?.refresh).toBe(replacement().refresh_token);
    expect(selectGrokCredential(canonical)?.native.team_metadata).toEqual({ future_field: 'retained' });
    expect((canonical.grok_auth as Record<string, unknown>)['other-scope']).toEqual(auth()['other-scope']);
  });

  it('captures rotation and the ledger before verification, then retries only the static probe', async () => {
    const accountId = await enroll();
    const base = (await head(accountId))!;
    verdict = { ok: false, status: 'fail', reachable: false, definitive: false };
    await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({ code: 'grok_refresh_pending' });
    const pendingState = await refreshState(accountId);
    expect(pendingState.state).toBe('pending_verification');
    expect(pendingState.responseEnc).toMatch(/^sbox:v1/);
    expect(JSON.parse(decrypt(pendingState.responseEnc!, keyring)).body).toContain(replacement().refresh_token);
    const pending = (await db.select().from(authPayloads).where(eq(authPayloads.id, pendingState.pendingPayloadId!)))[0]!;
    expect(pending).toMatchObject({ sourceKind: 'grok_refresh', parentPayloadId: base.id, verificationState: 'pending' });
    expect(selectGrokCredential(validation.validateCanonicalPayload(pending)!.auth)?.refresh).toBe(replacement().refresh_token);
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
    await db.insert(grokAuthRefreshState).values({ accountId, state: 'refreshing', attemptId: 'lost-owner', basePayloadId: base.id, baseGeneration: base.generation, startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }).onDuplicateKeyUpdate({ set: { state: 'refreshing', attemptId: 'lost-owner', responseEnc: null } });
    for (let attempt = 0; attempt < 2; attempt++) await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({ code: 'grok_refresh_uncertain' });
    expect(spendCount).toBe(0);
    expect(await refreshState(accountId)).toMatchObject({ state: 'uncertain', errorCode: 'owner_lost_after_intent' });
  });

  it('recovers a durable successful response without spending the old grant again', async () => {
    const accountId = await enroll();
    const base = (await head(accountId))!;
    const received = new Date().toISOString();
    await db.update(grokAuthRefreshState).set({ state: 'refreshing', attemptId: 'captured-owner', basePayloadId: base.id, baseGeneration: base.generation, responseEnc: encrypt(JSON.stringify({ received_at: received, body: JSON.stringify(replacement('captured')) }), keyring) }).where(eq(grokAuthRefreshState.accountId, accountId));
    const result = await owner().ensureFresh({ accountId });
    expect(result.canonical_generation).toBe(base.generation! + 1);
    expect(selectGrokCredential(result.auth, true)?.access).toBe(replacement('captured').access_token);
    expect(spendCount).toBe(0);
  });

  it.each(['transport', 'ambiguous_status', 'invalid_success'] as const)('keeps %s outcomes fenced through subsequent owner calls', async kind => {
    const accountId = await enroll();
    renewal = async () => {
      if (kind === 'transport') throw new TypeError('network connection lost');
      if (kind === 'ambiguous_status') return new Response('<html>upstream failure</html>', { status: 503 });
      return json({ access_token: 'fixture-missing-expiry-and-refresh' });
    };
    await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({ code: 'grok_refresh_uncertain' });
    await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({ code: 'grok_refresh_uncertain' });
    expect(spendCount).toBe(1);
    expect((await refreshState(accountId)).state).toBe('uncertain');
  });

  it.each(['invalid_grant', 'invalid_client'])('requires a new login after %s without automatic retries', async error => {
    const accountId = await enroll();
    renewal = async () => json({ error }, 400);
    for (let attempt = 0; attempt < 2; attempt++) await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({ code: 'grok_login_required' });
    expect(spendCount).toBe(1);
    expect(await refreshState(accountId)).toMatchObject({ state: 'login_required', errorCode: error });
  });

  it('backs off an explicit transient OAuth rejection without fencing the grant permanently', async () => {
    const accountId = await enroll();
    renewal = async () => json({ error: 'temporarily_unavailable' }, 503, { 'retry-after': '10' });
    for (let attempt = 0; attempt < 2; attempt++) await expect(owner().ensureFresh({ accountId })).rejects.toMatchObject({ code: 'grok_refresh_transient' });
    expect(spendCount).toBe(1);
    expect(await refreshState(accountId)).toMatchObject({ state: 'idle', errorCode: 'temporarily_unavailable' });
  });

  it('retains the old refresh token when a valid response omits a replacement', async () => {
    const accountId = await enroll();
    renewal = async () => json(replacement('access-only-response', 7200, false));
    await owner().ensureFresh({ accountId });
    const canonical = validation.validateCanonicalPayload(await head(accountId))!.auth;
    expect(selectGrokCredential(canonical)?.refresh).toBe(auth()[GROK_AUTH_SCOPE].refresh_token);
    expect(spendCount).toBe(1);
  });

  it('rejects expired or foreign sessions before reactive renewal and never revives an expired lease', async () => {
    const accountId = await enroll();
    const input = await lease(accountId);
    const generation = (await head(accountId))!.generation!;
    await expect(owner().ensureFresh({ ...input, sourceHostId: 2, refreshIfGeneration: generation })).rejects.toMatchObject({ status: 404 });
    await db.update(providerAccountSessions).set({ expiresAt: new Date(Date.now() - 1).toISOString() }).where(eq(providerAccountSessions.id, input.sessionId));
    await expect(owner().ensureFresh({ ...input, refreshIfGeneration: generation })).rejects.toMatchObject({ status: 404 });
    await expect(accounts.heartbeat(1, 'grok', input.sessionId)).rejects.toMatchObject({ status: 404 });
    expect(spendCount).toBe(0);
  });

  it('requires a live account pin for reactive renewal and rejects impossible observed generations', async () => {
    const accountId = await enroll(7200);
    await expect(owner().ensureFresh({ accountId, refreshIfGeneration: 1 })).rejects.toMatchObject({ code: 'grok_session_required' });
    const input = await lease(accountId);
    await expect(owner().ensureFresh({ ...input, refreshIfGeneration: 999 })).rejects.toMatchObject({ code: 'grok_generation_conflict' });
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
    await db.update(grokAuthRefreshState).set({ state: 'uncertain', errorCode: 'transport_outcome_unknown' }).where(eq(grokAuthRefreshState.accountId, accountId));
    await expect(store.storeCandidate({ engine: 'grok', accountId, auth: auth(), sourceHostId: null, requireLastRefresh: false, logAction: 'test.grok.login' })).rejects.toMatchObject({ code: 'grok_login_required' });
    await expect(store.storeCandidate({ engine: 'grok', accountId, auth: auth('new-login', 7200), sourceHostId: 1, baseCanonicalGeneration: 0, requireLastRefresh: false, logAction: 'test.grok.login' })).rejects.toMatchObject({ code: 'grok_generation_conflict' });
    const result = await store.storeCandidate({ engine: 'grok', accountId, auth: auth('new-login', 7200), sourceHostId: null, requireLastRefresh: false, logAction: 'test.grok.login' });
    expect((await refreshState(accountId)).state).toBe('idle');
    expect((await owner().ensureFresh({ accountId })).canonical_generation).toBe(result.canonical_generation);
    await expect(store.storeCandidate({ engine: 'grok', accountId, auth: result.auth!, sourceHostId: null, requireLastRefresh: false, logAction: 'test.grok.projection' })).rejects.toThrow();
    expect(spendCount).toBe(0);
  });

  it('keeps draining accounts usable for their live lease and wipes captured grants after the final lease ends', async () => {
    const accountId = await enroll();
    const input = await lease(accountId);
    await accounts.update(accountId, { state: 'removing' });
    const next = await owner().ensureFresh(input);
    expect(next.canonical_generation).toBeGreaterThan(1);
    await db.update(grokAuthRefreshState).set({ responseEnc: encrypt('fixture-captured-response', keyring) }).where(eq(grokAuthRefreshState.accountId, accountId));
    await accounts.release(1, 'grok', input.sessionId);
    expect((await accounts.get(accountId)).state).toBe('removed');
    expect(await db.select().from(grokAuthRefreshState).where(eq(grokAuthRefreshState.accountId, accountId))).toHaveLength(0);
    expect((await db.select().from(authPayloads).where(eq(authPayloads.accountId, accountId))).every(row => row.body === null)).toBe(true);
  });

  it('uses a single-connection pool for the fenced ledger and promotion without pool starvation', async () => {
    const accountId = await enroll();
    const pool = mysql.createPool({ ...readDbConfig()!, connectionLimit: 1 });
    otherPools.push(pool);
    const limited = drizzle(pool, { schema, mode: 'default' }) as Database;
    expect((await owner(limited).ensureFresh({ accountId, deadlineMs: 1500 })).canonical_generation).toBeGreaterThan(1);
    expect(spendCount).toBe(1);
  });

  it('requires the runner lifetime buffer without repeatedly spending a short-lived successor', async () => {
    const accountId = await enroll();
    renewal = async () => json(replacement('short', 800));
    await expect(owner().ensureFresh({ accountId, minValiditySeconds: 900 })).rejects.toMatchObject({ code: 'grok_lifetime_insufficient' });
    expect(spendCount).toBe(1);
    expect((await head(accountId))?.verificationState).toBe('verified');
  });
});
