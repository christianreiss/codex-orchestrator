import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import {
  authCanonicalHeads,
  authEntries,
  authPayloads,
  chatgptUsageSnapshots,
  hostAuthDigests,
  hostAuthStates,
  hosts as hostsTable,
  installTokens,
  logs as logsTable,
  versions as versionsTable,
} from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { assertContract } from '../../helpers/contract-schema.js';

const baseEnv = {
  INSTALLATION_ID: 'inst',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
  PUBLIC_BASE_URL: 'https://o.example',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

function makeKeyring(): Keyring {
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

function hostRow(apiKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    fqdn: 'host.example',
    apiKey,
    apiKeyHash: hashApiKey(apiKey),
    apiKeyEnc: null,
    status: 'active',
    secure: 1,
    allowRoamingIps: 0,
    reverseDnsMode: null,
    apiCalls: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    engines: 'codex,claude',
    vip: 0,
    scalingExempt: 0,
    curlInsecure: 0,
    browserosMcpEnabled: 0,
    configVersion: 0,
    wrapperTrack: 'v2',
    lastRefresh: null,
    authDigest: null,
    ip4: null,
    ip6: null,
    insecureEnabledUntil: null,
    insecureGraceUntil: null,
    insecureWindowMinutes: null,
    insecureRequestedAt: null,
    lanePreference: null,
    modelOverride: null,
    reasoningEffortOverride: null,
    autoUpdateOverride: 0,
    lastCronCheck: null,
    claudeLastRefresh: null,
    claudeClientVersion: null,
    claudeClientVersionOverride: null,
    claudeWrapperVersion: null,
    claudeAuthDigest: null,
    claudeModelOverride: null,
    claudeReasoningEffortOverride: null,
    clientVersion: null,
    clientVersionOverride: null,
    wrapperVersion: null,
    agentsDocumentIdOverride: null,
    ...overrides,
  };
}

function seedDb(apiKey: string) {
  const db = createDbFake();
  db.tables.set(hostsTable, [hostRow(apiKey)]);
  db.tables.set(versionsTable, []);
  db.tables.set(authPayloads, []);
  db.tables.set(authEntries, []);
  db.tables.set(hostAuthDigests, []);
  db.tables.set(hostAuthStates, []);
  db.tables.set(logsTable, []);
  db.tables.set(chatgptUsageSnapshots, []);
  return db;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /auth command=store', () => {
  it('accepts a valid candidate while an insecure host retrieve window is fully closed', async () => {
    const apiKey = 'sk-store-insecure-closed';
    const db = seedDb(apiKey);
    db.tables.set(hostsTable, [
      hostRow(apiKey, {
        secure: 0,
        insecureEnabledUntil: new Date(Date.now() - 120_000),
        insecureGraceUntil: new Date(Date.now() - 60_000),
      }),
    ]);
    const envWithRunner = {
      ...(baseEnv as Record<string, unknown>),
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
    } as typeof baseEnv;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok', reachable: true }), { status: 200 })),
    );
    const app = await buildHostApiTestApp({
      db: db as any,
      env: envWithRunner,
      keyring: makeKeyring(),
    });

    const r = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        command: 'store',
        engine: 'codex',
        auth: {
          last_refresh: '2026-06-13T06:00:00Z',
          tokens: {
            access_token: 'sk-openai-valid-closed-window-token',
            refresh_token: 'refresh-valid-closed-window-token',
          },
        },
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    assertContract('auth-store.schema.json', body);
    expect(body).toMatchObject({ status: 'updated', engine: 'codex' });
    expect(db.tables.get(authPayloads)).toHaveLength(1);
    await app.close();
  });

  it('rejects payloads with no usable auth tokens', async () => {
    const apiKey = 'sk-store-poem';
    const db = seedDb(apiKey);
    const app = await buildHostApiTestApp({ db: db as any, env: baseEnv, keyring: makeKeyring() });

    const r = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        command: 'store',
        engine: 'claude',
        auth: {
          last_refresh: '2026-06-13T06:00:00Z',
          poem: 'roses are red',
        },
      }),
    });

    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.payload)).toMatchObject({
      status: 'error',
      code: 'validation_failed',
      message: 'payload contains no usable auth tokens',
    });
    expect(db.tables.get(authPayloads)!).toHaveLength(0);
    await app.close();
  });

  it('returns 422 when the runner definitively rejects Claude credentials', async () => {
    const apiKey = 'sk-store-runner-fail';
    const db = seedDb(apiKey);
    const env = {
      ...baseEnv,
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
    } as typeof baseEnv;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'fail', definitive: true, reason: 'bad credentials' }), {
            status: 200,
          }),
      ),
    );
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });

    const r = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        command: 'store',
        engine: 'claude',
        auth: {
          last_refresh: '2026-06-13T06:00:00Z',
          claudeAiOauth: { accessToken: 'sk-ant-oat01-bad-token', refreshToken: 'r' },
        },
      }),
    });

    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.payload)).toMatchObject({
      status: 'error',
      code: 'validation_failed',
      message: 'auth candidate failed live verification: bad credentials',
    });
    expect(db.tables.get(authPayloads)!).toHaveLength(0);
    await app.close();
  });

  it('returns 503 when the runner is unreachable (no credential verdict)', async () => {
    const apiKey = 'sk-store-runner-down';
    const db = seedDb(apiKey);
    const env = {
      ...baseEnv,
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
    } as typeof baseEnv;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });

    const r = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        command: 'store',
        engine: 'claude',
        auth: {
          last_refresh: '2026-06-13T06:00:00Z',
          claudeAiOauth: { accessToken: 'sk-ant-oat01-fresh-token', refreshToken: 'r' },
        },
      }),
    });

    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toMatchObject({
      status: 'error',
      code: 'runner_unreachable',
      message: 'Auth runner unavailable; canonical store is gated',
    });
    expect(db.tables.get(authPayloads)!).toHaveLength(0);
    await app.close();
  });
});

describe('DELETE /auth uninstall scope', () => {
  it('removes only an explicitly requested engine from a dual-engine host', async () => {
    const apiKey = 'sk-delete-claude-only';
    const db = seedDb(apiKey);
    db.tables.set(hostsTable, [
      hostRow(apiKey, {
        engines: 'codex,claude',
        authDigest: 'codex-digest',
        lastRefresh: '2026-07-17T08:00:00Z',
        claudeAuthDigest: 'claude-digest',
        claudeLastRefresh: '2026-07-17T09:00:00Z',
        claudeClientVersionOverride: '9.9.9',
        claudeModelOverride: 'claude-test',
        claudeReasoningEffortOverride: 'high',
        modelOverride: 'codex-test',
      }),
    ]);
    db.tables.set(installTokens, [
      { id: 7, hostId: 1, engine: 'claude', token: 'pending-claude-installer' },
      { id: 8, hostId: 1, engine: 'codex', token: 'pending-codex-installer' },
    ]);
    db.tables.set(hostAuthDigests, [
      { id: 1, hostId: 1, engine: 'codex', digest: 'codex-digest' },
      { id: 2, hostId: 1, engine: 'claude', digest: 'claude-digest' },
    ]);
    db.tables.set(hostAuthStates, [
      { hostId: 1, engine: 'codex', payloadId: 10, digest: 'codex-digest' },
      { hostId: 1, engine: 'claude', payloadId: 11, digest: 'claude-digest' },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env: baseEnv, keyring: makeKeyring() });

    const r = await app.inject({
      method: 'DELETE',
      url: '/auth?force=1&engine=claude',
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({
      deleted_engine: 'claude',
      remaining_engines: ['codex'],
    });
    expect(db.tables.get(hostsTable)).toHaveLength(1);
    expect(db.tables.get(hostsTable)![0]).toMatchObject({
      engines: 'codex',
      authDigest: 'codex-digest',
      claudeAuthDigest: null,
      claudeLastRefresh: null,
      claudeClientVersionOverride: null,
      claudeModelOverride: null,
      claudeReasoningEffortOverride: null,
      modelOverride: 'codex-test',
    });
    expect(db.tables.get(installTokens)).toEqual([
      expect.objectContaining({ engine: 'codex', token: 'pending-codex-installer' }),
    ]);
    expect(db.tables.get(hostAuthDigests)).toEqual([
      expect.objectContaining({ engine: 'codex', digest: 'codex-digest' }),
    ]);
    expect(db.tables.get(hostAuthStates)).toEqual([
      expect.objectContaining({ engine: 'codex', digest: 'codex-digest' }),
    ]);
    expect(db.tables.get(logsTable)?.some((row) => row.action === 'host.engine.delete')).toBe(true);
    await app.close();
  });

  it('clears Codex-only policy while preserving Claude state on a Codex uninstall', async () => {
    const apiKey = 'sk-delete-codex-only';
    const db = seedDb(apiKey);
    db.tables.set(hostsTable, [
      hostRow(apiKey, {
        engines: 'codex,claude',
        authDigest: 'codex-digest',
        lastRefresh: '2026-07-17T08:00:00Z',
        clientVersionOverride: '9.9.9',
        lanePreference: 'spark',
        modelOverride: 'codex-test',
        reasoningEffortOverride: 'high',
        claudeAuthDigest: 'claude-digest',
        claudeLastRefresh: '2026-07-17T09:00:00Z',
        claudeModelOverride: 'claude-test',
      }),
    ]);
    db.tables.set(installTokens, [{ id: 8, hostId: 1, engine: 'codex', token: 'pending-codex-installer' }]);
    const app = await buildHostApiTestApp({ db: db as any, env: baseEnv, keyring: makeKeyring() });

    const r = await app.inject({
      method: 'DELETE',
      url: '/auth?force=1&engine=codex',
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(r.statusCode).toBe(200);
    expect(db.tables.get(hostsTable)![0]).toMatchObject({
      engines: 'claude',
      authDigest: null,
      lastRefresh: null,
      clientVersionOverride: null,
      lanePreference: null,
      modelOverride: null,
      reasoningEffortOverride: null,
      claudeAuthDigest: 'claude-digest',
      claudeModelOverride: 'claude-test',
    });
    expect(db.tables.get(installTokens)).toHaveLength(0);
    await app.close();
  });

  it('retains legacy whole-host deletion and writes an FK-independent audit row', async () => {
    const apiKey = 'sk-delete-whole-host';
    const db = seedDb(apiKey);
    const app = await buildHostApiTestApp({ db: db as any, env: baseEnv, keyring: makeKeyring() });

    const r = await app.inject({
      method: 'DELETE',
      url: '/auth?force=1',
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(r.statusCode).toBe(200);
    expect(db.tables.get(hostsTable)).toHaveLength(0);
    expect(db.tables.get(logsTable)?.find((row) => row.action === 'host.delete')).toMatchObject({
      hostId: null,
    });
    await app.close();
  });
});

describe('POST /auth command=retrieve quota lane shaping', () => {
  it('keeps a same/newer local generation visible as drift until its store succeeds', async () => {
    const apiKey = 'sk-retrieve-upload-required-drift';
    const db = seedDb(apiKey);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring, tokenMinLength: 8 });
    const canonicalStamp = '2026-07-17T08:00:00Z';
    const canonicalSource = {
      last_refresh: canonicalStamp,
      tokens: { access_token: 'sk-openai-canonical-valid-token' },
    };
    const withFallback = validation.ensureAuthsFallback(canonicalSource, 'codex');
    const canonical = validation.canonicalizeAuthPayload(
      withFallback,
      validation.normalizeAuthEntries(withFallback, 'codex'),
      canonicalStamp,
    );
    const encoded = JSON.stringify(canonical);
    const canonicalDigest = validation.calculateDigest(encoded);
    db.tables.set(authPayloads, [
      {
        id: 41,
        lastRefresh: canonicalStamp,
        sha256: canonicalDigest,
        sourceHostId: null,
        createdAt: canonicalStamp,
        body: encrypt(encoded, keyring),
        verificationState: 'verified',
        verificationCheckedAt: canonicalStamp,
        verificationReason: null,
        engine: 'codex',
      },
    ]);
    const envWithRunner = {
      ...baseEnv,
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
    } as typeof baseEnv;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('runner unavailable');
      }),
    );
    const app = await buildHostApiTestApp({ db: db as any, env: envWithRunner, keyring });
    const localStamp = '2026-07-17T09:00:00Z';
    const localDigest = 'b'.repeat(64);

    const retrieve = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        command: 'retrieve',
        engine: 'codex',
        last_refresh: localStamp,
        digest: localDigest,
      }),
    });
    expect(retrieve.statusCode).toBe(200);
    expect(JSON.parse(retrieve.payload)).toMatchObject({ status: 'upload_required', action: 'store' });
    expect(db.tables.get(hostsTable)![0]).toMatchObject({
      lastRefresh: localStamp,
      authDigest: localDigest,
    });
    expect(db.tables.get(hostAuthStates)).toHaveLength(0);

    const store = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        command: 'store',
        engine: 'codex',
        auth: {
          last_refresh: localStamp,
          tokens: { access_token: 'sk-openai-local-valid-token' },
        },
      }),
    });
    expect(store.statusCode).toBe(503);
    expect(db.tables.get(hostsTable)![0]).toMatchObject({
      lastRefresh: localStamp,
      authDigest: localDigest,
    });
    expect(db.tables.get(authPayloads)).toHaveLength(1);
    await app.close();
  });

  it('reports unavailable telemetry when no snapshot exists', async () => {
    const apiKey = 'sk-retrieve-no-quota';
    const db = seedDb(apiKey);
    const app = await buildHostApiTestApp({ db: db as any, env: baseEnv, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ command: 'retrieve', engine: 'codex' }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    assertContract('auth-retrieve.schema.json', body);
    expect(body.chatgpt).toMatchObject({
      status: 'unavailable',
      active_quota_lane: 'normal',
    });
    await app.close();
  });

  it('reports unavailable telemetry when the snapshot read fails', async () => {
    const apiKey = 'sk-retrieve-quota-read-fail';
    const db = seedDb(apiKey);
    const originalSelect = db.select.bind(db);
    db.select = ((fields?: unknown) => {
      const query = originalSelect(fields) as { from(table: unknown): unknown };
      return {
        from(table: unknown) {
          if (table === chatgptUsageSnapshots) throw new Error('snapshot read failed');
          return query.from(table);
        },
      };
    }) as typeof db.select;
    const app = await buildHostApiTestApp({ db: db as any, env: baseEnv, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ command: 'retrieve', engine: 'codex' }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).chatgpt).toMatchObject({
      status: 'unavailable',
      active_quota_lane: 'normal',
    });
    await app.close();
  });

  it('reports the requesting host Spark preference as the active quota lane', async () => {
    const apiKey = 'sk-retrieve-spark-lane';
    const db = seedDb(apiKey);
    db.tables.set(hostsTable, [hostRow(apiKey, { lanePreference: 'spark' })]);
    db.tables.set(chatgptUsageSnapshots, [
      {
        id: 1,
        hostId: null,
        status: 'ok',
        planType: 'pro',
        rateAllowed: 1,
        rateLimitReached: 0,
        primaryUsedPercent: 10,
        primaryLimitSeconds: 18_000,
        primaryResetAfterSeconds: 9_000,
        sparkRateAllowed: 1,
        sparkRateLimitReached: 0,
        sparkPrimaryUsedPercent: 20,
        sparkPrimaryLimitSeconds: 18_000,
        sparkPrimaryResetAfterSeconds: 8_000,
        fetchedAt: '2026-07-15T12:00:00Z',
        nextEligibleAt: '2026-07-15T12:05:00Z',
        createdAt: '2026-07-15T12:00:00Z',
      },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env: baseEnv, keyring: makeKeyring() });

    const r = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ command: 'retrieve', engine: 'codex' }),
    });

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).chatgpt.active_quota_lane).toBe('spark');
    await app.close();
  });

  it('keeps the retrieve contract when the fallback reports failed-canonical credential identity', async () => {
    const apiKey = 'sk-retrieve-failed-canonical-identity';
    const db = seedDb(apiKey);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const stamp = '2026-07-10T09:00:00Z';
    const source = {
      last_refresh: stamp,
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-failed-head-access-token',
        refreshToken: 'failed-head-refresh-token',
      },
    };
    const withFallback = validation.ensureAuthsFallback(source, 'claude');
    const canonical = validation.canonicalizeAuthPayload(
      withFallback,
      validation.normalizeAuthEntries(withFallback, 'claude'),
      stamp,
    );
    const encoded = JSON.stringify(canonical);
    db.tables.set(authPayloads, [
      {
        id: 40,
        lastRefresh: stamp,
        sha256: validation.calculateDigest(encoded),
        sourceHostId: null,
        createdAt: stamp,
        body: encrypt(encoded, keyring),
        verificationState: 'failed',
        verificationCheckedAt: stamp,
        verificationReason: 'provider rejected token',
        engine: 'claude',
        generation: 4,
      },
    ]);
    db.tables.set(authCanonicalHeads, [
      { engine: 'claude', payloadId: 40, generation: 4, updatedAt: stamp },
    ]);
    const envWithRunner = {
      ...(baseEnv as Record<string, unknown>),
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
    } as typeof baseEnv;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const app = await buildHostApiTestApp({ db: db as any, env: envWithRunner, keyring });

    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'claude',
        include_auth: true,
        auth_candidate: {
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-distinct-local-access-token',
            refreshToken: 'distinct-local-refresh-token',
          },
        },
      }),
    });

    expect(r.statusCode).toBe(200);
    const auth = JSON.parse(r.payload).auth;
    expect(auth.candidate_matches_failed_canonical).toBe(false);
    // Bootstrap nests the /auth retrieve body under `auth`; re-apply the
    // envelope the standalone route adds so the same contract judges it.
    assertContract('auth-retrieve.schema.json', { status: auth.status, data: auth });
    await app.close();
  });
});
