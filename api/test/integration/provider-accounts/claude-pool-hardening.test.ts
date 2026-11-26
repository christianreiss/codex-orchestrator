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
  versions,
} from '../../../src/db/schema.js';
import { eq, like } from 'drizzle-orm';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { createPooledAuthStoreService } from '../../../src/services/pooled-auth-store.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import { setClaudeIdentityFetch } from '../../../src/services/claude-identity.js';
import type { RunnerClient } from '../../../src/services/runner-client.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Claude account pool hardening on MySQL', () => {
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
  const people = ['alice', 'bob', 'carol'];
  let run = 0;
  const claude = (tag: string, minute = 0) => ({
    last_refresh: `2026-11-25T09:${String(minute).padStart(2, '0')}:00Z`,
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-${tag}-h${run}`,
      refreshToken: `sk-ant-ort01-${tag}-h${run}`,
      expiresAt: Date.parse('2026-11-27T00:00:00Z'),
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
  const cleanup = async () => {
    await db.delete(providerAccountSessions);
    await db.delete(authCanonicalHeads);
    await db.delete(authEntries);
    await db.delete(claudeUsageSnapshots);
    await db.delete(authPayloads);
    await db.delete(providerAccounts);
    await db.delete(agentSessions);
    await db.delete(versions).where(eq(versions.name, 'account_policy_claude'));
    await db.delete(logs).where(like(logs.action, 'provider_account.%'));
    await db.delete(logs).where(like(logs.action, 'account.%'));
  };
  beforeEach(async () => {
    await cleanup();
    run += 1;
    setClaudeIdentityFetch((async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const person = String(init?.headers?.Authorization ?? '').replace('Bearer sk-ant-oat01-', '').split('-')[0]!;
      if (!people.includes(person)) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ account: { uuid: `acc-${person}`, email: `${person}@example.com` }, organization: { uuid: `org-${person}` } }), {
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

  describe('removed accounts', () => {
    const remove = async (id: number) => {
      await accounts.update(id, { state: 'removing' });
      expect((await db.select().from(providerAccounts).where(eq(providerAccounts.id, id)))[0]).toMatchObject({ state: 'removed' });
    };

    it('does not re-enroll a removed identity from a host that still holds its login', async () => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      await remove(a);
      // Secure host, implicit sync upload: before, this silently created the account again.
      await expect(put('alice-2', {}, 5)).rejects.toMatchObject({ status: 409, code: 'account_removed' });
      await expect(put('alice-2', { accountId: b }, 5)).rejects.toMatchObject({ code: 'account_removed' });
      await expect(put('alice-2', { accountId: b, accountHint: true }, 5)).rejects.toMatchObject({ code: 'account_removed' });
      expect((await accounts.list('claude')).map((row) => row.id)).toEqual([b]);
      // The tombstone still names the identity.
      expect((await db.select().from(providerAccounts).where(eq(providerAccounts.id, a)))[0]!.identityKey).not.toBeNull();
    });

    it('enrolls a removed identity again only on an explicit enrollment', async () => {
      const a = (await put('alice-1')).account_id!;
      await put('bob-1');
      await remove(a);
      const enrolled = await put('alice-2', { enrollAccount: true }, 5);
      expect(enrolled.account_created).toBe(true);
      expect(enrolled.account_id).not.toBe(a);
      expect((await accounts.list('claude')).map((row) => row.email).sort()).toEqual(['alice@example.com', 'bob@example.com']);
      // The new account now owns the identity: its rotations sync implicitly again.
      expect((await put('alice-3', {}, 8)).account_id).toBe(enrolled.account_id);
    });

    it('lets the admin console enroll a removed identity', async () => {
      const a = (await put('alice-1')).account_id!;
      await remove(a);
      const enrolled = await put('alice-2', { enrollAccount: true, sourceHostId: null, sourceKind: 'admin' }, 5);
      expect(enrolled).toMatchObject({ account_created: true });
      expect(enrolled.account_id).not.toBe(a);
    });
  });
});
