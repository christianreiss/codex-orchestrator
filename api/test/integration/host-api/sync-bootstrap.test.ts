import { describe, expect, it, vi } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { createHash } from 'node:crypto';
import {
  authEntries,
  authPayloads,
  chatgptUsageSnapshots,
  hosts as hostsTable,
  versions as versionsTable,
  agentsDocuments,
  clientConfigDocuments,
} from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { assertContract } from '../../helpers/contract-schema.js';

const env = {
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
    engines: 'codex',
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

function seedVerifiedCodexCanonical(
  db: ReturnType<typeof createDbFake>,
  keyring: Keyring,
  stamp = '2026-06-08T15:26:33Z',
): void {
  const validation = createRunnerValidationService({ db: db as never, keyring });
  const auths = { 'api.openai.com': { token: 'verified-token', token_type: 'bearer' } };
  const canonical = validation.canonicalizeAuthPayload(
    { auths },
    validation.normalizeAuthEntries({ auths }, 'codex'),
    stamp,
  );
  const encoded = JSON.stringify(canonical);
  db.tables.set(authPayloads, [
    {
      id: 71,
      lastRefresh: stamp,
      sha256: createHash('sha256').update(encoded).digest('hex'),
      sourceHostId: null,
      createdAt: stamp,
      body: encrypt(encoded, keyring),
      verificationState: 'verified',
      verificationCheckedAt: stamp,
      verificationReason: null,
      engine: 'codex',
    },
  ]);
}

describe('POST /sync/bootstrap inlines agents + config', () => {
  it('defaults an inherited host to the normal active quota lane in bundled auth', async () => {
    const apiKey = 'sk-bootstrap-normal-lane';
    const db = createDbFake();
    db.tables.set(hostsTable, [hostRow(apiKey, { lanePreference: null })]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    db.tables.set(chatgptUsageSnapshots, [
      {
        id: 1,
        hostId: null,
        status: 'ok',
        planType: 'pro',
        rateAllowed: 1,
        rateLimitReached: 0,
        primaryUsedPercent: 5,
        primaryLimitSeconds: 604_800,
        primaryResetAfterSeconds: 400_000,
        fetchedAt: '2026-07-15T12:00:00Z',
        nextEligibleAt: '2026-07-15T12:05:00Z',
        createdAt: '2026-07-15T12:00:00Z',
      },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });

    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ engine: 'codex', include_auth: true }),
    });

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).auth.chatgpt.active_quota_lane).toBe('normal');
    await app.close();
  });

  it('returns content envelopes when local digests differ', async () => {
    const apiKey = 'sk-bootstrap-test';
    const agentsBody = '# AGENTS.md\n';
    const configBody = 'model = "gpt-5.5"\n';
    const agentsSha = createHash('sha256').update(agentsBody).digest('hex');
    const configSha = createHash('sha256').update(configBody).digest('hex');

    const db = createDbFake();
    db.tables.set(hostsTable, [hostRow(apiKey, { engines: 'codex,claude' })]);
    db.tables.set(versionsTable, [
      { name: 'client_version_codex', version: '0.130.0' },
      { name: 'wrapper_version_codex', version: '0.6.5' },
    ]);
    db.tables.set(agentsDocuments, [
      {
        id: 7,
        engine: 'codex',
        slug: 'main',
        body: agentsBody,
        sha256: agentsSha,
        size: agentsBody.length,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);
    db.tables.set(clientConfigDocuments, [
      {
        id: 9,
        engine: 'codex',
        slug: 'main',
        body: configBody,
        sha256: configSha,
        size: configBody.length,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        include_auth: false,
        agents: 'stale-digest',
        config: 'stale-digest',
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.agents).toMatchObject({ status: 'updated', content: agentsBody, sha256: agentsSha });
    expect(body.config).toMatchObject({ status: 'updated', content: configBody, sha256: configSha });
    await app.close();
  });

  it('stores a Claude auth_candidate inline when canonical auth is missing', async () => {
    const apiKey = 'sk-bootstrap-auth-store';
    const db = createDbFake();
    db.tables.set(hostsTable, [hostRow(apiKey, { engines: 'codex,claude' })]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);

    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'claude',
        include_auth: true,
        auth_candidate: { claudeAiOauth: { accessToken: 'sk-ant-oat01-bootstrap', refreshToken: 'r' } },
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.auth.status).toBe('updated');
    expect(body.reasons).toContain('auth_stored');
    expect(body.auth.auth.claudeAiOauth.accessToken).toBe('sk-ant-oat01-bootstrap');
    expect(db.tables.get(authPayloads)!).toHaveLength(1);
    expect(db.tables.get(authEntries)!).toHaveLength(1);
    await app.close();
  });

  it('treats stripped Claude credentials as valid when they canonicalize to server auth', async () => {
    const apiKey = 'sk-bootstrap-auth-valid';
    const db = createDbFake();
    const keyring = makeKeyring();
    db.tables.set(hostsTable, [hostRow(apiKey, { engines: 'codex,claude' })]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);
    db.tables.set(authEntries, []);

    const runnerValidation = createRunnerValidationService({ db: db as never, keyring });
    const canonical = runnerValidation.canonicalizeAuthPayload(
      {
        claudeAiOauth: { accessToken: 'sk-ant-oat01-same', refreshToken: 'r' },
        auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-same', token_type: 'bearer' } },
      },
      runnerValidation.normalizeAuthEntries(
        { auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-same', token_type: 'bearer' } } },
        'claude',
      ),
      '2026-05-20T09:00:00Z',
    );
    const encoded = JSON.stringify(canonical);
    const digest = createHash('sha256').update(encoded).digest('hex');
    db.tables.set(authPayloads, [
      {
        id: 3,
        lastRefresh: '2026-05-20T09:00:00Z',
        sha256: digest,
        sourceHostId: null,
        createdAt: '2026-05-20T09:00:00Z',
        body: encrypt(encoded, keyring),
        verificationState: 'verified',
        verificationCheckedAt: '2026-05-20T09:00:00Z',
        verificationReason: null,
        engine: 'claude',
      },
    ]);

    const app = await buildHostApiTestApp({ db: db as any, env, keyring });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'claude',
        include_auth: true,
        auth_digest: '0'.repeat(64),
        auth_candidate: { claudeAiOauth: { accessToken: 'sk-ant-oat01-same', refreshToken: 'r' } },
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.auth.status).toBe('valid');
    expect(body.auth.auth).toBeUndefined();
    expect(db.tables.get(authPayloads)!).toHaveLength(1);
    await app.close();
  });

  it('never serves a stale canonical to a host presenting fresher credentials when the store is gated', async () => {
    // Regression for the login-clobber chain: `codex login` → /sync/bootstrap
    // with a FRESHER auth_candidate → runner outage gates storeCandidate →
    // the catch-fallback used to retrieve WITHOUT the candidate's freshness,
    // answer `outdated`, and hand back the OLDER canonical blob — which the
    // wrapper then wrote over the fresh local login.
    const apiKey = 'sk-bootstrap-anti-clobber';
    const db = createDbFake();
    const keyring = makeKeyring();
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);
    db.tables.set(authEntries, []);

    const runnerValidation = createRunnerValidationService({ db: db as never, keyring });
    const staleStamp = '2026-06-08T15:26:33Z';
    const staleAuths = { 'api.openai.com': { token: 'stale-token', token_type: 'bearer' } };
    const canonical = runnerValidation.canonicalizeAuthPayload(
      { auths: staleAuths },
      runnerValidation.normalizeAuthEntries({ auths: staleAuths }, 'codex'),
      staleStamp,
    );
    const encoded = JSON.stringify(canonical);
    db.tables.set(authPayloads, [
      {
        id: 7,
        lastRefresh: staleStamp,
        sha256: createHash('sha256').update(encoded).digest('hex'),
        sourceHostId: null,
        createdAt: staleStamp,
        body: encrypt(encoded, keyring),
        verificationState: 'verified',
        verificationCheckedAt: staleStamp,
        verificationReason: null,
        engine: 'codex',
      },
    ]);

    // Runner configured but down: the fresher candidate cannot be stored.
    const envWithRunner = {
      ...(env as Record<string, unknown>),
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
    } as typeof env;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );

    const freshStamp = new Date(Date.now() - 60_000).toISOString();
    const app = await buildHostApiTestApp({ db: db as never, env: envWithRunner, keyring });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        include_auth: true,
        auth_digest: '1'.repeat(64),
        auth_candidate: {
          last_refresh: freshStamp,
          tokens: { access_token: 'fresh-token', refresh_token: 'r' },
          auths: { 'api.openai.com': { token: 'fresh-token', token_type: 'bearer' } },
        },
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.auth.status).toBe('upload_required');
    expect(body.auth.candidate_rejected_definitive).toBeUndefined();
    // The stale blob must NOT ride along — that is the clobber payload.
    expect(body.auth.auth).toBeUndefined();
    // Nothing was stored either (runner gated).
    expect(db.tables.get(authPayloads)!).toHaveLength(1);
    await app.close();
    vi.unstubAllGlobals();
  });

  it('serves the verified canonical when the runner definitively rejects the candidate', async () => {
    // Regression for the dead-credentials loop: a host whose local
    // .credentials.json is CLI-native (claudeAiOauth only, no last_refresh)
    // and whose token lineage was rotated away presents that dead candidate
    // on bootstrap. The runner probe definitively rejects it (401). The
    // catch-fallback used to stamp the dead candidate "fresh as now", answer
    // `upload_required`, and send the wrapper into a doomed re-upload → 422 →
    // interactive re-login prompt — while a verified canonical sat on the
    // server. The definitive rejection must instead serve the canonical blob
    // so the host overwrites its dead credentials and heals unattended.
    const apiKey = 'sk-bootstrap-dead-candidate';
    const db = createDbFake();
    const keyring = makeKeyring();
    db.tables.set(hostsTable, [hostRow(apiKey, { engines: 'codex,claude' })]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);
    db.tables.set(authEntries, []);

    const runnerValidation = createRunnerValidationService({ db: db as never, keyring });
    const canonicalStamp = '2026-07-10T09:00:00Z';
    const canonicalOauth = { accessToken: 'sk-ant-oat01-live', refreshToken: 'live-refresh' };
    const withFallback = runnerValidation.ensureAuthsFallback({ claudeAiOauth: canonicalOauth }, 'claude');
    const canonical = runnerValidation.canonicalizeAuthPayload(
      withFallback,
      runnerValidation.normalizeAuthEntries(withFallback, 'claude'),
      canonicalStamp,
    );
    const encoded = JSON.stringify(canonical);
    db.tables.set(authPayloads, [
      {
        id: 11,
        lastRefresh: canonicalStamp,
        sha256: createHash('sha256').update(encoded).digest('hex'),
        sourceHostId: null,
        createdAt: canonicalStamp,
        body: encrypt(encoded, keyring),
        verificationState: 'verified',
        verificationCheckedAt: canonicalStamp,
        verificationReason: null,
        engine: 'claude',
      },
    ]);

    // Runner reachable and definitive: HTTP 200 {status:'fail'} — the probe
    // genuinely ran against the provider and the candidate did not work.
    const envWithRunner = {
      ...(env as Record<string, unknown>),
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
    } as typeof env;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'fail',
            reachable: true,
            definitive: true,
            reason:
              'Failed to authenticate. API Error: 401 Invalid authentication credentials',
          }),
      })),
    );

    const app = await buildHostApiTestApp({ db: db as any, env: envWithRunner, keyring });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'claude',
        include_auth: true,
        auth_digest: '2'.repeat(64),
        auth_candidate: {
          claudeAiOauth: { accessToken: 'sk-ant-oat01-dead', refreshToken: 'dead-refresh' },
        },
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    assertContract('sync-bootstrap.schema.json', body);
    expect(body.auth.status).toBe('outdated');
    expect(body.auth.candidate_rejected_definitive).toBe(true);
    // The verified canonical blob rides along so the host can heal.
    expect(body.auth.auth).toBeDefined();
    expect(body.auth.auth.claudeAiOauth.accessToken).toBe('sk-ant-oat01-live');
    // The dead candidate was not stored.
    expect(db.tables.get(authPayloads)!).toHaveLength(1);
    await app.close();
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: 'has no usable auth token',
      candidate: () => ({ last_refresh: new Date(Date.now() - 60_000).toISOString(), note: 'not auth' }),
    },
    {
      name: 'has an invalid last_refresh',
      candidate: () => ({
        last_refresh: 'not-an-rfc3339-timestamp',
        tokens: { access_token: 'syntactically-present' },
      }),
    },
  ])('marks a deterministic candidate rejection when it $name', async ({ candidate }) => {
    const apiKey = 'sk-bootstrap-malformed-candidate';
    const db = createDbFake();
    const keyring = makeKeyring();
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);
    db.tables.set(authEntries, []);
    seedVerifiedCodexCanonical(db, keyring);

    // No network request is needed for a syntactically invalid candidate, but
    // a configured runner lets retrieve preserve the stored verified verdict.
    const envWithRunner = {
      ...(env as Record<string, unknown>),
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
    } as typeof env;
    const app = await buildHostApiTestApp({ db: db as never, env: envWithRunner, keyring });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        include_auth: true,
        auth_digest: '3'.repeat(64),
        auth_candidate: candidate(),
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.auth).toMatchObject({
      status: 'outdated',
      verification_state: 'verified',
      candidate_rejected_definitive: true,
    });
    expect(body.auth.auth.auths['api.openai.com'].token).toBe('verified-token');
    expect(db.tables.get(authPayloads)!).toHaveLength(1);
    await app.close();
  });

  it('does not mark a deterministic rejection when no verified canonical is served', async () => {
    const apiKey = 'sk-bootstrap-malformed-no-canonical';
    const db = createDbFake();
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);

    const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        include_auth: true,
        auth_candidate: { last_refresh: 'not-an-rfc3339-timestamp', note: 'not auth' },
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.auth.status).toBe('missing');
    expect(body.auth.auth).toBeUndefined();
    expect(body.auth.candidate_rejected_definitive).toBeUndefined();
    await app.close();
  });

  it('lets an older valid client repair the selected failed canonical', async () => {
    const apiKey = 'sk-bootstrap-repair-failed';
    const db = createDbFake();
    const keyring = makeKeyring();
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);
    db.tables.set(authEntries, []);

    const validation = createRunnerValidationService({ db: db as never, keyring });
    const failedStamp = '2026-07-17T09:00:00Z';
    const failedSource = {
      last_refresh: failedStamp,
      tokens: { access_token: 'failed-token', refresh_token: 'failed-r' },
    };
    const failedWithAuths = validation.ensureAuthsFallback(failedSource, 'codex');
    const failedCanonical = validation.canonicalizeAuthPayload(
      failedWithAuths,
      validation.normalizeAuthEntries(failedWithAuths, 'codex'),
      failedStamp,
    );
    const failedBody = JSON.stringify(failedCanonical);
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: failedStamp,
        sha256: createHash('sha256').update(failedBody).digest('hex'),
        sourceHostId: null,
        createdAt: failedStamp,
        body: encrypt(failedBody, keyring),
        verificationState: 'failed',
        verificationCheckedAt: failedStamp,
        verificationReason: 'expired',
        engine: 'codex',
      },
    ]);
    const envWithRunner = {
      ...(env as Record<string, unknown>),
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
    } as typeof env;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok', reachable: true }), { status: 200 })),
    );
    const app = await buildHostApiTestApp({ db: db as any, env: envWithRunner, keyring });

    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        include_auth: true,
        auth_candidate: {
          last_refresh: '2026-07-17T08:00:00Z',
          tokens: { access_token: 'working-token', refresh_token: 'working-r' },
        },
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.auth.status).toBe('updated');
    expect(body.auth.verification_state).toBe('verified');
    expect(body.auth.auth.tokens.access_token).toBe('working-token');
    expect(Date.parse(body.auth.canonical_last_refresh)).toBeGreaterThan(Date.parse(failedStamp));
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(2);
    await app.close();
    vi.unstubAllGlobals();
  });

  it('omits content when digests match', async () => {
    const apiKey = 'sk-bootstrap-unchanged';
    const agentsBody = '# AGENTS.md\n';
    const configBody = 'model = "gpt-5.5"\n';
    const agentsSha = createHash('sha256').update(agentsBody).digest('hex');
    const configSha = createHash('sha256').update(configBody).digest('hex');

    const db = createDbFake();
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, [
      {
        id: 7,
        engine: 'codex',
        slug: 'main',
        body: agentsBody,
        sha256: agentsSha,
        size: agentsBody.length,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);
    db.tables.set(clientConfigDocuments, [
      {
        id: 9,
        engine: 'codex',
        slug: 'main',
        body: configBody,
        sha256: configSha,
        size: configBody.length,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        include_auth: false,
        agents: agentsSha,
        config: configSha,
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.agents.status).toBe('unchanged');
    expect(body.agents.content).toBeUndefined();
    expect(body.config.status).toBe('unchanged');
    expect(body.config.content).toBeUndefined();
    await app.close();
  });

  it('includes the compatible sessions block with sync-activity counts', async () => {
    const apiKey = 'sk-bootstrap-sessions';
    const db = createDbFake();
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);

    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ engine: 'codex', include_auth: false }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.sessions).toBeDefined();
    expect(typeof body.sessions.now).toBe('number');
    expect(typeof body.sessions.today).toBe('number');
    expect(typeof body.sessions.month).toBe('number');
    expect(body.sessions.now).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});
