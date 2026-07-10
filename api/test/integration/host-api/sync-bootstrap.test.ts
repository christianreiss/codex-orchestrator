import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { createHash } from 'node:crypto';
import {
  authEntries,
  authPayloads,
  hosts as hostsTable,
  versions as versionsTable,
  agentsDocuments,
  clientConfigDocuments,
} from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';

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

describe('POST /sync/bootstrap inlines agents + config', () => {
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
    const app = await buildHostApiTestApp({ db: db as any, env: envWithRunner, keyring });
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
    // The stale blob must NOT ride along — that is the clobber payload.
    expect(body.auth.auth).toBeUndefined();
    // Nothing was stored either (runner gated).
    expect(db.tables.get(authPayloads)!).toHaveLength(1);
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

  it('includes a sessions block with now/today/month numeric counts', async () => {
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
