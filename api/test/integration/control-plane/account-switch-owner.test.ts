import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import * as schema from '../../../src/db/schema.js';
import { getTestDb, readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { createPooledAuthStoreService } from '../../../src/services/pooled-auth-store.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import { AccountSwitchService } from '../../../src/services/account-switch.js';
import { setClaudeIdentityFetch } from '../../../src/services/claude-identity.js';
import type { RunnerClient } from '../../../src/services/runner-client.js';

const handle = await getTestDb();
describe.skipIf(!handle)('live Claude account switching under the owner runtime', () => {
// A fixed date here made every test in this file fail once that day had passed:
// the store refuses to verify a login whose access token has expired.
const TOKEN_EXPIRES_AT = Date.now() + 7 * 86_400_000;

  afterAll(async () => {
    setClaudeIdentityFetch(null);
    await handle?.pool.end();
  });

  it('requests, commits and inherits a scope switch through owner state and SQL', { timeout: 90_000 }, async () => {
    const seedDb = handle!.db;
    const keyring = testKeyring();
    const suffix = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const scope = `scope-owner-${suffix}`;
    const leaseIds = [`lease-a-${suffix}-xx`, `lease-b-${suffix}-xx`, `lease-c-${suffix}-xx`];
    const agentSessionId = randomUUID();
    const accountIds: number[] = [];
    let hostId = 0;
    let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
    const ownerDb = drizzle(handle!.pool, { schema, mode: 'default' });
    setClaudeIdentityFetch((async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const who = String(init?.headers?.Authorization ?? '').split('-').at(-1);
      return new Response(
        JSON.stringify({ account: { uuid: `acc-${who}-${suffix}`, email: `${who}-${suffix}@example.com` }, organization: { uuid: `org-${who}-${suffix}` } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch);
    try {
      const [host] = await seedDb.insert(schema.hosts).values({
        fqdn: `switch-${suffix}.test`,
        apiKey: `key-${suffix}`,
        apiKeyHash: `hash-${suffix}`,
        secure: 1,
        status: 'active',
        engines: 'claude',
        createdAt: now,
        updatedAt: now,
      });
      hostId = Number(host.insertId);
      // Seed two verified subscriptions through the real store (SQL path, before the owner starts).
      const runner: RunnerClient = {
        isConfigured: () => true,
        verify: async () => ({ ok: true, status: 'ok', reachable: true }),
        verifyClaude: async () => ({ ok: true, status: 'ok', reachable: true }),
      };
      const store = createPooledAuthStoreService({ db: seedDb, keyring, runnerValidation: createRunnerValidationService({ db: seedDb, keyring }), runner });
      for (const who of ['alpha', 'beta']) {
        const result = await store.storeCandidate({
          engine: 'claude',
          auth: {
            last_refresh: '2026-11-25T09:00:00Z',
            claudeAiOauth: { accessToken: `sk-ant-oat01-${suffix}-${who}`, refreshToken: `sk-ant-ort01-${suffix}-${who}`, expiresAt: TOKEN_EXPIRES_AT },
          },
          sourceHostId: hostId,
          requireLastRefresh: false,
          logAction: 'test.store',
        });
        expect(result.account_created).toBe(true);
        accountIds.push(result.account_id!);
      }
      const [a, b] = accountIds as [number, number];
      await seedDb.insert(schema.agentSessions).values({
        id: agentSessionId,
        hostId,
        engine: 'claude',
        username: 'tester',
        cwd: '/tmp',
        providerAccountId: a,
        invocationKind: 'interactive',
        status: 'active',
        hostAuthFingerprint: 'f'.repeat(64),
        bridgeTokenHash: 'b'.repeat(64),
        bridgeExpiresAt: '2099-01-01T00:00:00Z',
        startedAt: now,
        heartbeatAt: now,
        createdAt: now,
        updatedAt: now,
      });

      owner = await createOwnedControlPlane({
        pool: handle!.pool,
        handle: ownerDb,
        env: { ...loadTestEnv(), DB_DATABASE: String(readDbConfig()!.database) },
        keyring,
        error: (error) => {
          throw error;
        },
      });
      const accounts = new ProviderAccountsService(ownerDb, keyring);
      const switches = new AccountSwitchService(ownerDb, keyring);
      await accounts.acquire(hostId, 'claude', scope, leaseIds[0]!, 95, a, 'connection');
      await accounts.acquire(hostId, 'claude', scope, leaseIds[1]!, 95, undefined, 'connection');
      const rows = () =>
        owner!.runtime.state
          .snapshot()
          .table('providerAccountSessions')
          .all()
          .filter((r) => r.scopeId === scope);
      expect(rows().map((r) => r.accountId)).toEqual([a, a]);

      const requested = await switches.requestSwitch({ hostId, engine: 'claude', scopeId: scope, target: b, reason: 'admin' });
      // A new scope starts at an opaque generation; only the steps are fixed.
      const g = requested.binding_generation;
      expect(requested.account_switch).toMatchObject({ account_id: b, binding_generation: g });
      expect(rows().every((r) => r.desiredAccountId === b)).toBe(true);

      await expect(
        switches.commitSwitch({ hostId, engine: 'claude', sessionId: leaseIds[1]!, scopeId: scope, accountId: b, generation: g + 1 }),
      ).rejects.toMatchObject({ code: 'account_switch_stale' });
      const committed = await switches.commitSwitch({ hostId, engine: 'claude', sessionId: leaseIds[1]!, scopeId: scope, accountId: b, generation: g });
      expect(committed).toMatchObject({ previous_account_id: a, account_id: b, binding_generation: g + 1, moved_addresses: [] });
      expect(rows().every((r) => r.accountId === b && r.bindingGeneration === g + 1 && r.desiredAccountId === null)).toBe(true);
      const durable = await seedDb
        .select()
        .from(schema.providerAccountSessions)
        .where(inArray(schema.providerAccountSessions.id, leaseIds.slice(0, 2)));
      expect(durable.map((r) => [r.accountId, r.bindingGeneration, r.desiredAccountId])).toEqual([
        [b, g + 1, null],
        [b, g + 1, null],
      ]);

      const joined = await accounts.acquire(hostId, 'claude', scope, leaseIds[2]!, 95, undefined, 'connection');
      expect(joined.account.id).toBe(b);
      expect((await switches.sessionBinding(hostId, 'claude', leaseIds[2]!)).binding_generation).toBe(g + 1);
      expect(owner.runtime.state.snapshot().table('agentSessions').get(agentSessionId)?.providerAccountId).toBe(b);
      const [agent] = await seedDb.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, agentSessionId));
      expect(agent?.providerAccountId).toBe(b);
      expect((await switches.scopes('claude')).find((s) => s.scope_id === scope)).toMatchObject({ account_id: b, sessions: 3 });
    } finally {
      await owner?.close();
      await seedDb.delete(schema.agentSessions).where(eq(schema.agentSessions.id, agentSessionId));
      await seedDb.delete(schema.providerAccountSessions).where(eq(schema.providerAccountSessions.scopeId, scope));
      if (accountIds.length) {
        const payloads = (
          await seedDb.select({ id: schema.authPayloads.id }).from(schema.authPayloads).where(inArray(schema.authPayloads.accountId, accountIds))
        ).map((p) => p.id);
        if (payloads.length) {
          await seedDb.delete(schema.authCanonicalHeads).where(inArray(schema.authCanonicalHeads.payloadId, payloads));
          await seedDb.delete(schema.authEntries).where(inArray(schema.authEntries.payloadId, payloads));
          await seedDb.delete(schema.authPayloads).where(inArray(schema.authPayloads.id, payloads));
        }
        await seedDb.delete(schema.providerAccounts).where(inArray(schema.providerAccounts.id, accountIds));
      }
      if (hostId) await seedDb.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
    }
  });
});
