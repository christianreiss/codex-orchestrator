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
import { writeAccountPolicy } from '../../../src/services/account-policy.js';
import { AccountSwitchService, SWITCH_STALE_READING_MS } from '../../../src/services/account-switch.js';
import { CLAUDE_READING_HOLD_MS, ClaudeUsageService } from '../../../src/services/claude-usage.js';
import type { RunnerClient } from '../../../src/services/runner-client.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Claude account pool hardening on MySQL', () => {
  const db = handle?.db as NonNullable<typeof handle>['db'];
  const keyring = testKeyring();
  const validation = createRunnerValidationService({ db, keyring });
  const accounts = new ProviderAccountsService(db, keyring);
  const switches = new AccountSwitchService(db, keyring);
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
      expect((await snapshots(a)).map((row) => [row.hostId, row.fiveHourUsedPercent, row.sevenDayUsedPercent])).toEqual([[runs.id, 41, null], [runs.id, 41, 12]]);
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

  describe('usage readings from several sessions', () => {
    const t0 = Date.now();
    const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const file = (accountId: number, minutes: number, reading: { short?: [number, string]; weekly?: [number, string] }) =>
      new ClaudeUsageService(db, accountId).store(
        {
          accountId,
          hostId: 1,
          source: 'test',
          fiveHourUsedPercent: reading.short?.[0] ?? null,
          fiveHourResetsAt: reading.short?.[1] ?? null,
          sevenDayUsedPercent: reading.weekly?.[0] ?? null,
          sevenDayResetsAt: reading.weekly?.[1] ?? null,
        },
        t0 + minutes * 60_000,
      );
    const reading = async (accountId: number) => {
      const row = (await snapshots(accountId)).at(-1)!;
      return [row.fiveHourUsedPercent, row.sevenDayUsedPercent];
    };

    it('does not let an older session lower a window that another session already reported higher', async () => {
      const a = (await put('alice-1')).account_id!;
      const week = at(3 * 24 * 60);
      await file(a, 0, { short: [70, at(180)], weekly: [40, week] });
      // An idle session still shows its last response.
      await file(a, 1, { short: [15, at(180)], weekly: [38, week] });
      expect(await reading(a)).toEqual([70, 40]);
      await file(a, 2, { short: [72, at(180)], weekly: [40, week] });
      expect(await reading(a)).toEqual([72, 40]);
      // A new five-hour window starts low; the weekly one keeps its share.
      await file(a, 40, { short: [3, at(40 + 300)], weekly: [39, week] });
      expect(await reading(a)).toEqual([3, 40]);
    });

    it('keeps a running window that a report says nothing about', async () => {
      const a = (await put('alice-1')).account_id!;
      await file(a, 0, { short: [55, at(120)], weekly: [20, at(24 * 60)] });
      await file(a, 5, { weekly: [21, at(24 * 60)] });
      expect(await reading(a)).toEqual([55, 21]);
      // Once that window ended, there is nothing left to keep.
      await file(a, 130, { weekly: [22, at(24 * 60)] });
      expect(await reading(a)).toEqual([null, 22]);
    });

    it('lets go of a high reading that no session confirms any more', async () => {
      const a = (await put('alice-1')).account_id!;
      const week = at(3 * 24 * 60);
      // One wrong figure for the right window, e.g. from an account that shares the reset time.
      await file(a, 0, { weekly: [95, week] });
      await file(a, 10, { weekly: [12, week] });
      await file(a, 50, { weekly: [12, week] });
      expect(await reading(a)).toEqual([null, 95]);
      await file(a, CLAUDE_READING_HOLD_MS / 60_000 + 1, { weekly: [13, week] });
      expect(await reading(a)).toEqual([null, 13]);
      // A confirmed figure keeps holding past the hour.
      await file(a, 100, { weekly: [60, week] });
      await file(a, 150, { weekly: [60, week] });
      await file(a, 170, { weekly: [20, week] });
      expect(await reading(a)).toEqual([null, 60]);
    });

    it('refuses the previous account\'s reading for as long as the bound account has its own window', async () => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      const runs = await host();
      const session = 'lease-usage-cccccccc';
      await accounts.acquire(runs.id, 'claude', 'scope-usage-cccccccc', session, 95, b);
      // The scope moved to B hours ago; the old 30-minute check would no longer look.
      await db.update(providerAccountSessions).set({ boundAt: at(-240) });
      const weekA = at(2 * 24 * 60);
      const weekB = at(5 * 24 * 60);
      await file(a, 0, { weekly: [91, weekA] });
      await file(b, 0, { weekly: [8, weekB] });
      const target = (weekly: string, minutes: number) =>
        switches.usageReportAccount(runs.id, 'claude', { sessionId: session, short_resets_at: null, weekly_resets_at: weekly }, t0 + minutes * 60_000);

      expect(await target(weekA, 1)).toEqual({ ignored: 'stale_account' });
      expect(await target(weekB, 2)).toEqual({ accountId: b });
      // The same refused reading, still arriving half an hour later, is believed:
      // what is stored may be the wrong half of a crosswise filing.
      expect(await target(weekA, 6)).toEqual({ ignored: 'stale_account' });
      expect(await target(weekA, 16)).toEqual({ ignored: 'stale_account' });
      expect(await target(weekA, 26)).toEqual({ ignored: 'stale_account' });
      expect(await target(weekA, 1 + SWITCH_STALE_READING_MS / 60_000)).toEqual({ accountId: b });
      // A reading that comes back after a pause starts over.
      expect(await target(weekA, 120)).toEqual({ ignored: 'stale_account' });
    });

    it('takes a report it cannot contradict once the switch is long past', async () => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      const runs = await host();
      const session = 'lease-usage-dddddddd';
      await accounts.acquire(runs.id, 'claude', 'scope-usage-dddddddd', session, 95, b);
      const week = at(2 * 24 * 60);
      await file(a, 0, { weekly: [91, week] });
      const target = () => switches.usageReportAccount(runs.id, 'claude', { sessionId: session, short_resets_at: null, weekly_resets_at: week }, t0);
      // B has no reading yet: right after the switch A's reset gives the report away ...
      expect(await target()).toEqual({ ignored: 'stale_account' });
      // ... later two accounts may simply share a reset time.
      await db.update(providerAccountSessions).set({ boundAt: at(-240) });
      expect(await target()).toEqual({ accountId: b });
    });
  });

  describe('a bound account that is no longer usable', () => {
    const unverify = async (id: number) => {
      const account = (await db.select().from(providerAccounts).where(eq(providerAccounts.id, id)))[0]!;
      await db.update(authPayloads).set({ verificationState: 'failed' }).where(eq(authPayloads.id, account.payloadId!));
    };

    it('moves a scope off an account that lost its verification, onto the only usable one', async () => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      await writeAccountPolicy(db, 'claude', { mode: 'auto' });
      const scope = 'scope-leave-aaaaaaaa';
      const session = 'lease-leave-aaaaaaaa';
      await accounts.acquire(1, 'claude', scope, session, 95, a);
      expect(await switches.evaluate('claude')).toBe(0);
      await unverify(a);
      // One usable account is left; before, the policy stopped below two.
      expect(await switches.evaluate('claude')).toBe(1);
      const binding = await switches.sessionBinding(1, 'claude', session);
      expect(binding.account_switch).toMatchObject({ account_id: b, reason: 'policy', bound_account_usable: false });
      // The commit never depended on the old account; the wrapper no longer waits for its confirmation.
      const committed = await switches.commitSwitch({ hostId: 1, engine: 'claude', sessionId: session, scopeId: scope, accountId: b, generation: binding.binding_generation! });
      expect(committed).toMatchObject({ previous_account_id: a, account_id: b });
      // On the only usable account there is nowhere left to go.
      expect(await switches.evaluate('claude')).toBe(0);
    });

    it('moves a scope off a paused account and tells a usable origin apart', async () => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      const scope = 'scope-leave-bbbbbbbb';
      const session = 'lease-leave-bbbbbbbb';
      await accounts.acquire(1, 'claude', scope, session, 95, a);
      const asked = await switches.requestSwitch({ hostId: 1, engine: 'claude', scopeId: scope, target: b, reason: 'admin' });
      expect(asked.account_switch).toMatchObject({ account_id: b, bound_account_usable: true });
      await accounts.update(a, { state: 'paused' });
      expect((await switches.sessionBinding(1, 'claude', session)).account_switch).toMatchObject({ account_id: b, bound_account_usable: false });
    });
  });

  describe('a switch commit that has to be repeated', () => {
    const scope = 'scope-replay-aaaaaaa';
    const session = 'lease-replay-aaaaaaa';
    const pending = async (hostId: number) => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      await accounts.acquire(hostId, 'claude', scope, session, 95, a);
      const asked = await switches.requestSwitch({ hostId, engine: 'claude', scopeId: scope, target: b, reason: 'admin' });
      return { a, b, generation: asked.binding_generation };
    };
    const audits = async (action: string) => (await db.select().from(logs).where(eq(logs.action, action))).length;
    const post = async (key: string, url: string, body: Record<string, unknown>) => {
      const app = await buildHostApiTestApp({ db, env, keyring });
      try {
        const r = await app.inject({ method: 'POST', url, headers: { 'x-api-key': key, 'content-type': 'application/json' }, payload: JSON.stringify({ engine: 'claude', ...body }) });
        return { status: r.statusCode, body: JSON.parse(r.payload) as Record<string, any> };
      } finally {
        await app.close();
      }
    };

    it('answers the same commit again instead of refusing it as stale', async () => {
      const { a, b, generation } = await pending(1);
      const commit = () => switches.commitSwitch({ hostId: 1, engine: 'claude', sessionId: session, scopeId: scope, accountId: b, generation });
      expect(await commit()).toMatchObject({ previous_account_id: a, account_id: b, binding_generation: generation + 1, replayed: false });
      // The wrapper never saw that answer, or died before it wrote the credentials.
      expect(await commit()).toMatchObject({ previous_account_id: null, account_id: b, binding_generation: generation + 1, replayed: true, moved_addresses: [] });
      expect(await commit()).toMatchObject({ replayed: true });
      expect(await audits('provider_account.switched')).toBe(1);
      // Only the commit that produced the current binding can be repeated.
      await switches.requestSwitch({ hostId: 1, engine: 'claude', scopeId: scope, target: a, reason: 'admin' });
      await switches.commitSwitch({ hostId: 1, engine: 'claude', sessionId: session, scopeId: scope, accountId: a, generation: generation + 1 });
      await expect(commit()).rejects.toMatchObject({ status: 409, code: 'account_switch_stale' });
    });

    it('does not move the binding when the target\'s credentials cannot be served', async () => {
      const { a, b, generation } = await pending(1);
      await expect(
        switches.commitSwitch({ hostId: 1, engine: 'claude', sessionId: session, scopeId: scope, accountId: b, generation, credentialsReady: false }),
      ).rejects.toMatchObject({ status: 503, code: 'account_unavailable' });
      const binding = await switches.sessionBinding(1, 'claude', session);
      expect(binding).toMatchObject({ binding_generation: generation, account_switch: { account_id: b } });
      expect((await accounts.session(1, 'claude', session)).accountId).toBe(a);
    });

    it('returns the credentials again over the route and records an unfinished write once', async () => {
      const runs = await host();
      const { b, generation } = await pending(runs.id);
      const body = { session_id: session, scope_id: scope, account_id: b, binding_generation: generation };
      const first = await post(runs.key, '/auth/sessions/switch', body);
      expect(first).toMatchObject({ status: 200, body: { account_id: b, binding_generation: generation + 1, replayed: false } });
      expect(first.body.auth.claudeAiOauth.accessToken).toContain('bob-1');
      const again = await post(runs.key, '/auth/sessions/switch', { ...body, credential_write: 'unfinished' });
      expect(again).toMatchObject({ status: 200, body: { account_id: b, binding_generation: generation + 1, replayed: true } });
      expect(again.body.auth).toEqual(first.body.auth);
      await post(runs.key, '/auth/sessions/switch', { ...body, credential_write: 'unfinished' });
      expect(await audits('provider_account.switch_write_unfinished')).toBe(1);
    });

    it('serves the bound account to a scope that still holds the previous account\'s login', async () => {
      const runs = await host();
      const { a, b, generation } = await pending(runs.id);
      await switches.commitSwitch({ hostId: runs.id, engine: 'claude', sessionId: session, scopeId: scope, accountId: b, generation });
      // The file still holds A (the write never happened), and A was refreshed after B.
      const rotated = await put('alice-2', {}, 30);
      expect(rotated.account_id).toBe(a);
      const head = (await db.select().from(providerAccounts).where(eq(providerAccounts.id, a)))[0]!;
      const local = (await db.select().from(authPayloads).where(eq(authPayloads.id, head.payloadId!)))[0]!;
      const answer = await post(runs.key, '/auth', { command: 'retrieve', session_id: session, account_id: b, digest: local.sha256, last_refresh: local.lastRefresh });
      expect(answer).toMatchObject({ status: 200, body: { status: 'outdated', account_id: b, presented_account_id: a } });
      expect(answer.body.auth.claudeAiOauth.accessToken).toContain('bob-1');
      // A login the server does not know is still asked for, as before.
      const unknown = await post(runs.key, '/auth', { command: 'retrieve', session_id: session, account_id: b, digest: 'f'.repeat(64), last_refresh: '2026-11-25T09:59:00Z' });
      expect(unknown.body).toMatchObject({ status: 'upload_required' });
      expect(unknown.body.presented_account_id).toBeUndefined();
    });
  });

  describe('requests and policy changes leave a trail', () => {
    const scope = 'scope-trail-aaaaaaaa';
    const session = 'lease-trail-aaaaaaaa';
    const rows = async (action: string) =>
      (await db.select().from(logs).where(eq(logs.action, action))).map((row) => JSON.parse(row.details ?? '{}') as Record<string, unknown>);

    it('audits a policy change with its author and skips a write that changes nothing', async () => {
      await writeAccountPolicy(db, 'claude', { mode: 'manual' }, 'op@example.com');
      await writeAccountPolicy(db, 'claude', { mode: 'manual' }, 'op@example.com');
      const audits = await rows('account.policy.updated');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ engine: 'claude', actor: 'op@example.com', before: { mode: 'auto' }, after: { mode: 'manual' } });
    });

    it('audits a request that is taken back', async () => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      await accounts.acquire(1, 'claude', scope, session, 95, a);
      await switches.requestSwitch({ hostId: 1, engine: 'claude', scopeId: scope, target: b, reason: 'admin', actor: 'op@example.com' });
      await switches.requestSwitch({ hostId: 1, engine: 'claude', scopeId: scope, target: a, reason: 'admin', actor: 'op@example.com' });
      expect(await rows('provider_account.switch_withdrawn')).toEqual([
        expect.objectContaining({ from_account_id: a, to_account_id: b, requested_reason: 'admin', withdrawn: 'requested', by: 'admin', actor: 'op@example.com' }),
      ]);
    });

    it('withdraws a request whose target stopped being usable or that waited a day', async () => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      await writeAccountPolicy(db, 'claude', { mode: 'manual' });
      await accounts.acquire(1, 'claude', scope, session, 95, a);
      const pending = async () => (await switches.sessionBinding(1, 'claude', session)).account_switch;

      await switches.requestSwitch({ hostId: 1, engine: 'claude', scopeId: scope, target: b, reason: 'agent' });
      await switches.evaluate('claude');
      expect(await pending()).toMatchObject({ account_id: b });
      // Nobody carried it out for more than a day.
      await db.update(providerAccountSessions).set({ desiredAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
      await switches.evaluate('claude');
      expect(await pending()).toBeNull();

      await switches.requestSwitch({ hostId: 1, engine: 'claude', scopeId: scope, target: b, reason: 'admin' });
      await accounts.update(b, { state: 'paused' });
      await switches.evaluate('claude');
      expect(await pending()).toBeNull();
      expect((await rows('provider_account.switch_withdrawn')).map((row) => [row.requested_reason, row.withdrawn])).toEqual([
        ['agent', 'expired'],
        ['admin', 'target_unavailable'],
      ]);
    });

    it('does not advise a move while the scope is inside its dwell time', async () => {
      const a = (await put('alice-1')).account_id!;
      const b = (await put('bob-1')).account_id!;
      await writeAccountPolicy(db, 'claude', { mode: 'auto', strategy: 'balanced', min_dwell_minutes: 30 });
      const week = new Date(Date.now() + 3 * 86_400_000).toISOString();
      await new ClaudeUsageService(db, a).store({ accountId: a, hostId: 1, source: 'test', sevenDayUsedPercent: 70, sevenDayResetsAt: week });
      await new ClaudeUsageService(db, b).store({ accountId: b, hostId: 1, source: 'test', sevenDayUsedPercent: 5, sevenDayResetsAt: week });
      // Above the warning level (60) and below the limit, where the dwell still applies.
      const long = await switches.poolView('claude', a, 60, new Date(Date.now() - 3_600_000).toISOString());
      const fresh = await switches.poolView('claude', a, 60, new Date().toISOString());
      expect(long.recommendation).toMatchObject({ action: 'switch', account_id: b });
      expect(fresh.recommendation).toMatchObject({ action: 'continue', account_id: null });
    });
  });
});
