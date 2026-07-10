import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import {
  authEntries,
  authPayloads,
  hostAuthDigests,
  hostAuthStates,
  hosts as hostsTable,
  logs as logsTable,
  versions as versionsTable,
} from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';

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
  return db;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /auth command=store', () => {
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
      vi.fn(async () => new Response(JSON.stringify({ status: 'fail', reason: 'bad credentials' }), { status: 200 })),
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
