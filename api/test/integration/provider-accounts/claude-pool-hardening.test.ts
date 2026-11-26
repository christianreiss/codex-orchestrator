import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentSessions,
  authCanonicalHeads,
  authEntries,
  authPayloads,
  claudeUsageSnapshots,
  hosts,
  logs,
  providerAccounts,
  providerAccountSessions,
  versions,
} from '../../../src/db/schema.js';
import { eq, inArray, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
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
  const env = { INSTALLATION_ID: 'pool-hardening', ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    PUBLIC_BASE_URL: 'https://fleet.test', STATIC_ROOT: '', INSECURE_GRACE_MINUTES: 60 } as Parameters<typeof buildHostApiTestApp>[0]['env'];
  const created: number[] = [];
  /** A registered Claude host; `until` is the insecure window of a host that is not secure. */
  const host = async (secure = true, until: Date | null = null) => {
    const key = `sk-pool-${randomUUID().replaceAll('-', '')}`;
    const at = new Date().toISOString();
    const [row] = await db.insert(hosts).values({ fqdn: `pool-${randomUUID()}.test`, apiKey: key, apiKeyHash: hashApiKey(key),
      engines: 'claude', secure: secure ? 1 : 0, vip: 0, insecureEnabledUntil: until, createdAt: at, updatedAt: at });
    created.push(Number(row.insertId));
    return { id: Number(row.insertId), key };
  };
  const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const snapshots = (accountId: number) =>
    db.select().from(claudeUsageSnapshots).where(eq(claudeUsageSnapshots.accountId, accountId)).orderBy(claudeUsageSnapshots.id);
  const cleanup = async () => {
    if (created.length) {
      await db.delete(logs).where(inArray(logs.hostId, created));
      await db.delete(hosts).where(inArray(hosts.id, created.splice(0)));
    }
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

  describe('usage reports', () => {
    const report = async (key: string, body: Record<string, unknown>) => {
      const app = await buildHostApiTestApp({ db, env, keyring });
      try {
        const r = await app.inject({ method: 'POST', url: '/claude/usage/report', headers: { 'x-api-key': key, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
        return { status: r.statusCode, body: JSON.parse(r.payload) as Record<string, unknown> };
      } finally {
        await app.close();
      }
    };
    const window = (used: number, minutes = 120) => ({ used_percent: used, resets_at: ahead(minutes) });

    it('files a reading only through a live lease of the reporting host', async () => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      const runs = await host();
      const stranger = await host();
      const session = 'lease-usage-aaaaaaaa';
      await accounts.acquire(runs.id, 'claude', 'scope-usage-aaaaaaaa', session, 95, a);

      // A host that runs nothing on B cannot make B look full.
      expect(await report(stranger.key, { account_id: b, five_hour: window(99) })).toMatchObject({ status: 200, body: { status: 'ignored', reason: 'session_required' } });
      expect(await snapshots(b)).toHaveLength(0);
      // Nor can the host that runs on A.
      expect(await report(runs.key, { account_id: b, five_hour: window(99) })).toMatchObject({ body: { status: 'ignored', reason: 'session_required' } });
      expect(await report(runs.key, { session_id: session, account_id: b, five_hour: window(99) })).toMatchObject({ body: { status: 'ignored', reason: 'stale_account' } });
      expect(await snapshots(b)).toHaveLength(0);

      // The session's own reading is filed under its binding, whatever it claims.
      expect(await report(runs.key, { session_id: session, five_hour: window(41) })).toMatchObject({ status: 200, body: { status: 'ok' } });
      // A statusline outside a wrapper launch names only the account; the host's lease covers it.
      expect(await report(runs.key, { account_id: a, seven_day: window(12, 3 * 24 * 60) })).toMatchObject({ body: { status: 'ok' } });
      expect((await snapshots(a)).map((row) => [row.hostId, row.fiveHourUsedPercent, row.sevenDayUsedPercent])).toEqual([[runs.id, 41, null], [runs.id, null, 12]]);
      // Another host's session id is not a lease of this host.
      expect((await report(stranger.key, { session_id: session, five_hour: window(99) })).status).toBe(404);
    });

    it('still takes an account-only report for the only account (wrappers without leases)', async () => {
      const a = (await put('alice-1')).account_id!;
      const old = await host();
      expect(await report(old.key, { account_id: a, five_hour: window(30) })).toMatchObject({ body: { status: 'ok' } });
      expect(await report(old.key, { account_id: a + 1000, five_hour: window(30) })).toMatchObject({ body: { status: 'ignored', reason: 'session_required' } });
      expect((await snapshots(a)).map((row) => row.fiveHourUsedPercent)).toEqual([30]);
    });

    it('stores only a reading the running window allows', async () => {
      const a = (await put('alice-1')).account_id!;
      await put('bob-1');
      const runs = await host();
      const session = 'lease-usage-bbbbbbbb';
      await accounts.acquire(runs.id, 'claude', 'scope-usage-bbbbbbbb', session, 95, a);
      const send = (body: Record<string, unknown>) => report(runs.key, { session_id: session, ...body });

      for (const five_hour of [
        { used_percent: -5, resets_at: ahead(60) },
        { used_percent: '50', resets_at: ahead(60) },
        { used_percent: 50, resets_at: ahead(-5) }, // the window already ended
        { used_percent: 50, resets_at: ahead(6 * 60) }, // no five-hour window resets in six hours
        { used_percent: 50, resets_at: 'soon' },
        { used_percent: 50, resets_at: 1790000000 },
      ]) {
        expect(await send({ five_hour }), JSON.stringify(five_hour)).toMatchObject({ status: 200, body: { status: 'ignored', reason: 'no_current_window' } });
      }
      expect(await send({ seven_day: { used_percent: 50, resets_at: ahead(8 * 24 * 60) } })).toMatchObject({ body: { status: 'ignored', reason: 'no_current_window' } });
      const empty = await send({});
      expect(empty).toMatchObject({ status: 200, body: { status: 'ignored' } });
      expect(empty.body.reason).toBeUndefined();
      expect(await snapshots(a)).toHaveLength(0);

      // Above 100 is "full"; an ended window next to a running one is left out.
      expect(await send({ five_hour: { used_percent: 250, resets_at: ahead(60) }, seven_day: { used_percent: 60, resets_at: ahead(-60) } })).toMatchObject({ body: { status: 'ok' } });
      expect((await snapshots(a)).map((row) => [row.fiveHourUsedPercent, row.sevenDayUsedPercent, row.sevenDayResetsAt])).toEqual([[100, null, null]]);
    });

    it('refuses a report from an insecure host whose window is closed', async () => {
      const a = (await put('alice-1')).account_id!;
      const closed = await host(false, null);
      const open = await host(false, new Date(Date.now() + 600_000));
      expect(await report(closed.key, { account_id: a, five_hour: window(99) })).toMatchObject({ status: 423, body: { code: 'insecure_pending' } });
      expect(await snapshots(a)).toHaveLength(0);
      expect(await report(open.key, { account_id: a, five_hour: window(20) })).toMatchObject({ status: 200, body: { status: 'ok' } });
    });
  });
});
