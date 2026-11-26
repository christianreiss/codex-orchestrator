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
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { createPooledAuthStoreService } from '../../../src/services/pooled-auth-store.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';
import { AccountSwitchService } from '../../../src/services/account-switch.js';
import { setClaudeIdentityFetch } from '../../../src/services/claude-identity.js';
import { ClaudeUsageService } from '../../../src/services/claude-usage.js';
import type { RunnerClient } from '../../../src/services/runner-client.js';

const handle = await getTestDb();
describe.skipIf(!handle)('Claude account identity and live switching on MySQL', () => {
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
  // token tag "<person>-<n>" belongs to person; "anon-*" is unknown to Anthropic.
  const profiles: Record<string, { uuid: string; email: string }> = {
    alice: { uuid: 'acc-alice', email: 'alice@example.com' },
    bob: { uuid: 'acc-bob', email: 'bob@example.com' },
    carol: { uuid: 'acc-carol', email: 'carol@example.com' },
  };
  const claude = (tag: string, minute = 0) => ({
    last_refresh: `2026-11-25T09:${String(minute).padStart(2, '0')}:00Z`,
    claudeAiOauth: { accessToken: `sk-ant-oat01-${tag}`, refreshToken: `sk-ant-ort01-${tag}`, expiresAt: Date.parse('2026-11-27T00:00:00Z') },
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
  };
  beforeEach(async () => {
    await cleanup();
    setClaudeIdentityFetch((async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const token = String(init?.headers?.Authorization ?? '').replace('Bearer sk-ant-oat01-', '');
      const person = profiles[token.split('-')[0]!];
      if (!person) return new Response('{}', { status: 401 });
      return new Response(
        JSON.stringify({ account: { uuid: person.uuid, email: person.email }, organization: { uuid: `org-${person.uuid}`, name: 'Org' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch);
  });
  afterEach(() => setClaudeIdentityFetch(null));
  afterAll(async () => {
    await cleanup();
    await handle!.pool.end();
  });

  it('enrolls a second subscription instead of overwriting the sole account', async () => {
    const first = await put('alice-1');
    expect(first.account_created).toBe(true);
    expect(first.account_label).toBe('alice@example.com');
    const second = await put('bob-1');
    expect(second.account_created).toBe(true);
    expect(second.account_id).not.toBe(first.account_id);
    // A rotation of the first subscription returns to it.
    const rotated = await put('alice-2', {}, 5);
    expect(rotated).toMatchObject({ account_id: first.account_id, account_created: false });
    expect((await accounts.list('claude')).map((a) => a.email).sort()).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('routes a late rotation of the previous account to it even when the lease moved', async () => {
    const a = (await put('alice-1')).account_id!;
    const b = (await put('bob-1')).account_id!;
    await accounts.acquire(1, 'claude', 'scope-aaaaaaaaaaaaaaaa', 'lease-aaaaaaaaaaaaaaaa', 95, b);
    // Session bound to B uploads a fresh rotation that belongs to A.
    const late = await put('alice-3', { accountId: b }, 7);
    expect(late.account_id).toBe(a);
    const headB = await validation.resolveCanonicalPayload('claude', b);
    expect(validation.validateCanonicalPayload(headB)?.auth).toMatchObject({ claudeAiOauth: { accessToken: 'sk-ant-oat01-bob-1' } });
  });

  it('refuses implicit enrollment of an unknown identity on insecure hosts', async () => {
    await put('alice-1');
    await expect(put('carol-1', { autoEnroll: false })).rejects.toMatchObject({ code: 'account_enroll_insecure_host' });
    expect(await accounts.list('claude')).toHaveLength(1);
  });

  it('refuses implicit enrollment through /sync/bootstrap on insecure hosts', async () => {
    await put('alice-1');
    const key = `sk-bootstrap-${randomUUID().replaceAll('-', '')}`;
    const at = new Date().toISOString();
    const [row] = await db.insert(hosts).values({ fqdn: `insecure-${randomUUID()}.test`, apiKey: key, apiKeyHash: hashApiKey(key),
      engines: 'claude', secure: 0, vip: 0, insecureEnabledUntil: new Date(Date.now() + 600_000), createdAt: at, updatedAt: at });
    const hostId = Number(row.insertId);
    const env = { INSTALLATION_ID: 'bootstrap-enroll', ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      PUBLIC_BASE_URL: 'https://fleet.test', STATIC_ROOT: '', INSECURE_GRACE_MINUTES: 60 } as Parameters<typeof buildHostApiTestApp>[0]['env'];
    const app = await buildHostApiTestApp({ db, env, keyring });
    try {
      const r = await app.inject({ method: 'POST', url: '/sync/bootstrap', headers: { 'x-api-key': key, 'content-type': 'application/json' },
        payload: JSON.stringify({ engine: 'claude', include_auth: true, auth_candidate: claude('carol-1') }) });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.payload).auth.candidate_credential_rejected).toBe(true);
      expect((await accounts.list('claude')).map((a) => a.email)).toEqual(['alice@example.com']);
    } finally {
      await app.close();
      await db.delete(logs).where(eq(logs.hostId, hostId));
      await db.delete(hosts).where(eq(hosts.id, hostId));
    }
  });

  it('refuses an operator replace with another subscription', async () => {
    const a = (await put('alice-1')).account_id!;
    await expect(
      store.storeCandidate({ engine: 'claude', auth: claude('bob-1'), accountId: a, sourceHostId: null, requireLastRefresh: false, logAction: 'test.replace', sourceKind: 'admin' }),
    ).rejects.toMatchObject({ code: 'account_identity_mismatch' });
  });

  it('keeps the lineage behaviour when Anthropic cannot identify the token', async () => {
    const a = (await put('alice-1')).account_id!;
    const anon = await put('anon-1', {}, 3);
    expect(anon.account_id).toBe(a);
  });

  it('moves a whole scope through request and commit with generation fencing', async () => {
    const a = (await put('alice-1')).account_id!;
    const b = (await put('bob-1')).account_id!;
    const scope = 'scope-bbbbbbbbbbbbbbbb';
    await accounts.acquire(1, 'claude', scope, 'lease-one-bbbbbbbbbbbb', 95, a);
    await accounts.acquire(1, 'claude', scope, 'lease-two-bbbbbbbbbbbb', 95);
    const requested = await switches.requestSwitch({ hostId: 1, engine: 'claude', scopeId: scope, target: b, reason: 'admin' });
    expect(requested.account_switch).toMatchObject({ account_id: b, binding_generation: 1, reason: 'admin' });
    expect((await switches.sessionBinding(1, 'claude', 'lease-two-bbbbbbbbbbbb')).account_switch?.account_id).toBe(b);
    await expect(
      switches.commitSwitch({ hostId: 1, engine: 'claude', sessionId: 'lease-one-bbbbbbbbbbbb', scopeId: scope, accountId: b, generation: 2 }),
    ).rejects.toMatchObject({ code: 'account_switch_stale' });
    const committed = await switches.commitSwitch({ hostId: 1, engine: 'claude', sessionId: 'lease-one-bbbbbbbbbbbb', scopeId: scope, accountId: b, generation: 1 });
    expect(committed).toMatchObject({ previous_account_id: a, account_id: b, binding_generation: 2, moved_addresses: [] });
    for (const id of ['lease-one-bbbbbbbbbbbb', 'lease-two-bbbbbbbbbbbb']) {
      expect((await accounts.session(1, 'claude', id)).accountId).toBe(b);
      expect(await switches.sessionBinding(1, 'claude', id)).toEqual({ binding_generation: 2, account_switch: null });
    }
    // A new launch joining the scope inherits the moved binding.
    const joined = await accounts.acquire(1, 'claude', scope, 'lease-three-bbbbbbbbbb', 95);
    expect(joined.account.id).toBe(b);
    expect((await switches.sessionBinding(1, 'claude', 'lease-three-bbbbbbbbbb')).binding_generation).toBe(2);
  });

  it('rejects switches to unusable accounts and for engines without live switching', async () => {
    const a = (await put('alice-1')).account_id!;
    const b = (await put('bob-1')).account_id!;
    await accounts.acquire(1, 'claude', 'scope-cccccccccccccccc', 'lease-cccccccccccccccc', 95, a);
    await accounts.update(b, { state: 'paused' });
    await expect(
      switches.requestSwitch({ hostId: 1, engine: 'claude', scopeId: 'scope-cccccccccccccccc', target: b, reason: 'host' }),
    ).rejects.toMatchObject({ code: 'account_switch_target_unavailable' });
    await expect(
      switches.requestSwitch({ hostId: 1, engine: 'codex', scopeId: 'scope-cccccccccccccccc', target: b, reason: 'host' }),
    ).rejects.toMatchObject({ code: 'account_switch_unsupported_engine' });
  });

  it('the automatic policy requests a move when the bound account crosses the band', async () => {
    const a = (await put('alice-1')).account_id!;
    const b = (await put('bob-1')).account_id!;
    await accounts.acquire(1, 'claude', 'scope-dddddddddddddddd', 'lease-dddddddddddddddd', 95, a);
    await db.update(providerAccountSessions).set({ boundAt: '2026-11-26T00:00:00Z' });
    const resets = '2099-01-01T00:00:00Z';
    await new ClaudeUsageService(db, a).store({ accountId: a, hostId: 1, source: 'test', fiveHourUsedPercent: 70, fiveHourResetsAt: resets, sevenDayUsedPercent: 40, sevenDayResetsAt: resets });
    await new ClaudeUsageService(db, b).store({ accountId: b, hostId: 1, source: 'test', fiveHourUsedPercent: 10, fiveHourResetsAt: resets, sevenDayUsedPercent: 20, sevenDayResetsAt: resets });
    expect(await switches.evaluate('claude')).toBe(1);
    const binding = await switches.sessionBinding(1, 'claude', 'lease-dddddddddddddddd');
    expect(binding.account_switch).toMatchObject({ account_id: b, reason: 'policy' });
    const view = await switches.poolView('claude', a, 60);
    expect(view.recommendation).toMatchObject({ action: 'switch', account_id: b });
    expect(view).toMatchObject({ bound_account_id: a, headroom: true, launch_account_id: b });
  });
});
