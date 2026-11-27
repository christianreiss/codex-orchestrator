import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentSessions,
  authCanonicalHeads,
  authEntries,
  authPayloads,
  claudeUsageSnapshots,
  logs,
  providerAccounts,
  providerAccountSessions,
} from '../../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { createPooledAuthStoreService } from '../../../src/services/pooled-auth-store.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import { setClaudeIdentityFetch } from '../../../src/services/claude-identity.js';
import type { RunnerClient } from '../../../src/services/runner-client.js';

// A fixed date here made every test in this file fail once that day had passed:
// the store refuses to verify a login whose access token has expired.
const TOKEN_EXPIRES_AT = Date.now() + 7 * 86_400_000;

const AUDIT = 'provider_account.identity_unresolved';
const handle = await getTestDb();
describe.skipIf(!handle)('Claude logins nobody could attribute', () => {
  const db = handle?.db as NonNullable<typeof handle>['db'];
  const keyring = testKeyring();
  const validation = createRunnerValidationService({ db, keyring });
  const accounts = new ProviderAccountsService(db, keyring);
  const runner: RunnerClient = {
    isConfigured: () => true,
    verify: async () => ({ ok: true, status: 'ok', reachable: true }),
    verifyClaude: async () => ({ ok: true, status: 'ok', reachable: true }),
  };
  const store = createPooledAuthStoreService({ db, keyring, runnerValidation: validation, runner });
  const profiles: Record<string, string> = { alice: 'acc-alice', bob: 'acc-bob', carol: 'acc-carol' };
  // Token tag "<person>-<n>". `down` lists tags Anthropic fails for (HTTP 503);
  // "anon-*" is refused (401); every other unknown person is refused as well.
  let down = new Set<string>();
  let run = 0;
  const claude = (tag: string, minute = 0) => ({
    last_refresh: `2026-11-25T09:${String(minute).padStart(2, '0')}:00Z`,
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-${tag}-r${run}`,
      refreshToken: `sk-ant-ort01-${tag}-r${run}`,
      expiresAt: TOKEN_EXPIRES_AT,
    },
  });
  const put = (tag: string, extra: Record<string, unknown> = {}, minute = 0) =>
    store.storeCandidate({
      engine: 'claude',
      auth: claude(tag, minute),
      sourceHostId: 1,
      requireLastRefresh: false,
      logAction: 'test.store',
      ...extra,
    });
  const headToken = async (accountId: number) => {
    const row = await validation.resolveCanonicalPayload('claude', accountId);
    const auth = validation.validateCanonicalPayload(row)?.auth as { claudeAiOauth?: { accessToken?: string } } | undefined;
    return auth?.claudeAiOauth?.accessToken ?? null;
  };
  const audits = async () =>
    (await db.select().from(logs).where(eq(logs.action, AUDIT))).map((row) => JSON.parse(row.details ?? '{}') as Record<string, unknown>);
  const cleanup = async () => {
    await db.delete(providerAccountSessions);
    await db.delete(authCanonicalHeads);
    await db.delete(authEntries);
    await db.delete(claudeUsageSnapshots);
    await db.delete(authPayloads);
    await db.delete(providerAccounts);
    await db.delete(agentSessions);
    await db.delete(logs).where(eq(logs.action, AUDIT));
  };
  beforeEach(async () => {
    await cleanup();
    down = new Set();
    run += 1;
    setClaudeIdentityFetch((async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const tag = String(init?.headers?.Authorization ?? '').replace('Bearer sk-ant-oat01-', '').replace(/-r\d+$/, '');
      if (down.has(tag)) return new Response('upstream', { status: 503 });
      const uuid = profiles[tag.split('-')[0]!];
      if (!uuid) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ account: { uuid, email: `${tag.split('-')[0]}@example.com` }, organization: { uuid: `org-${uuid}` } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
  });
  afterEach(() => setClaudeIdentityFetch(null));
  afterAll(async () => {
    await cleanup();
    await handle!.pool.end();
  });

  it('refuses an unidentified rotation from a session bound to another account in a pool', async () => {
    const a = (await put('alice-1')).account_id!;
    const b = (await put('bob-1')).account_id!;
    await accounts.acquire(1, 'claude', 'scope-unresolved-aaaaaa', 'lease-unresolved-aaaaaa', 95, b);
    // A late rotation of A arrives from the scope now bound to B while the profile call fails.
    down.add('alice-2');
    await expect(put('alice-2', { accountId: b }, 9)).rejects.toMatchObject({ status: 503, code: 'account_identity_unavailable' });
    // Neither head moved, and nothing new was enrolled.
    expect(await headToken(b)).toBe(`sk-ant-oat01-bob-1-r${run}`);
    expect(await headToken(a)).toBe(`sk-ant-oat01-alice-1-r${run}`);
    expect(await accounts.list('claude')).toHaveLength(2);
    expect(await audits()).toEqual([
      expect.objectContaining({ engine: 'claude', lookup: 'unavailable', reason: 'http_503', outcome: 'refused', account_id: b, session_bound: true, accounts: 2 }),
    ]);
    // The retry of the same credential is refused again but audited once.
    await expect(put('alice-2', { accountId: b }, 9)).rejects.toMatchObject({ code: 'account_identity_unavailable' });
    expect(await audits()).toHaveLength(1);
    // Once Anthropic answers, the rotation reaches its own account.
    down.clear();
    setClaudeIdentityFetch(null);
    setClaudeIdentityFetch((async () =>
      new Response(JSON.stringify({ account: { uuid: 'acc-alice' }, organization: { uuid: 'org-acc-alice' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch);
    expect((await put('alice-2', { accountId: b }, 9)).account_id).toBe(a);
    expect(await headToken(b)).toBe(`sk-ant-oat01-bob-1-r${run}`);
  });

  it('refuses a token Anthropic rejects in a pool, as a saved-account hint too', async () => {
    await put('alice-1');
    const b = (await put('bob-1')).account_id!;
    await expect(put('anon-1', { accountId: b, accountHint: true }, 4)).rejects.toMatchObject({ status: 503, code: 'account_identity_unavailable' });
    await expect(put('anon-2', {}, 4)).rejects.toMatchObject({ code: 'account_identity_unavailable' });
    expect(await headToken(b)).toBe(`sk-ant-oat01-bob-1-r${run}`);
    expect((await audits()).map((row) => row.lookup)).toEqual(['unidentifiable', 'unidentifiable']);
  });

  it('files the exact stored token under its own account while Anthropic is unreachable', async () => {
    const a = (await put('alice-1')).account_id!;
    const b = (await put('bob-1')).account_id!;
    await accounts.acquire(1, 'claude', 'scope-unresolved-bbbbbb', 'lease-unresolved-bbbbbb', 95, b);
    // A cold identity cache (restart) during an outage: lineage still proves the account.
    setClaudeIdentityFetch(null);
    setClaudeIdentityFetch((async () => new Response('upstream', { status: 502 })) as typeof fetch);
    const again = await put('alice-1', { accountId: b });
    expect(again.account_id).toBe(a);
    expect(await headToken(b)).toBe(`sk-ant-oat01-bob-1-r${run}`);
    expect(await audits()).toEqual([]);
  });

  it('keeps a sole account taking its rotations during an outage and records it', async () => {
    const a = (await put('alice-1')).account_id!;
    down.add('alice-2');
    const rotated = await put('alice-2', {}, 6);
    expect(rotated).toMatchObject({ account_id: a, account_created: false });
    expect(await audits()).toEqual([expect.objectContaining({ outcome: 'legacy_rules', lookup: 'unavailable', accounts: 1 })]);
  });

  it('refuses an enrollment and an operator replacement it cannot check', async () => {
    const a = (await put('alice-1')).account_id!;
    down.add('carol-1');
    await expect(put('carol-1', { enrollAccount: true, sourceHostId: null, sourceKind: 'admin' })).rejects.toMatchObject({
      code: 'account_identity_unavailable',
    });
    await expect(put('carol-1', { accountId: a, sourceHostId: null, sourceKind: 'admin' })).rejects.toMatchObject({
      code: 'account_identity_unavailable',
    });
    expect(await accounts.list('claude')).toHaveLength(1);
    expect(await headToken(a)).toBe(`sk-ant-oat01-alice-1-r${run}`);
  });

  it('does not file a known login under an account whose own identity lookup failed', async () => {
    // Enrolled before identity detection: Anthropic refused the head at the time.
    const legacy = (await put('anon-1')).account_id!;
    expect((await accounts.list('claude'))[0]).toMatchObject({ id: legacy, identity_known: false });
    // The head's lookup now fails instead of being refused: the account is unproven.
    down.add('anon-1');
    setClaudeIdentityFetch(null);
    setClaudeIdentityFetch((async (_url: unknown, init?: { headers?: Record<string, string> }) =>
      String(init?.headers?.Authorization ?? '').includes('anon-1')
        ? new Response('upstream', { status: 500 })
        : new Response(JSON.stringify({ account: { uuid: 'acc-alice' }, organization: { uuid: 'org-acc-alice' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch);
    await expect(put('alice-1', { accountId: legacy }, 5)).rejects.toMatchObject({ code: 'account_identity_unavailable' });
    expect(await accounts.list('claude')).toHaveLength(1);
    expect(await headToken(legacy)).toBe(`sk-ant-oat01-anon-1-r${run}`);
  });
});
