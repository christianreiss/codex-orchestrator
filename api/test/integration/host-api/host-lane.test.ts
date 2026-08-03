import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { hosts as hostsTable, versions as versionsTable, hostUsers } from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';

const env = {
  INSTALLATION_ID: 'inst',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  PUBLIC_BASE_URL: 'https://orchestrator.example',
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

const apiKey = 'sk-codex-deadbeef-cafe';
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function setupHost(db: ReturnType<typeof createDbFake>): void {
  db.tables.set(hostsTable, [
    {
      id: 1,
      fqdn: 'host.example.com',
      apiKey,
      apiKeyHash: hashApiKey(apiKey),
      apiKeyEnc: null,
      status: 'active',
      secure: 1,
      allowRoamingIps: 0,
      reverseDnsMode: null,
      lastRefresh: null,
      authDigest: null,
      ip4: null,
      ip6: null,
      clientVersion: null,
      clientVersionOverride: null,
      wrapperVersion: null,
      agentsDocumentIdOverride: null,
      apiCalls: 0,
      insecureEnabledUntil: null,
      insecureGraceUntil: null,
      insecureWindowMinutes: null,
      curlInsecure: 0,
      browserosMcpEnabled: 0,
      expiresAt: null,
      vip: 0,
      lanePreference: null,
      modelOverride: null,
      reasoningEffortOverride: null,
      autoUpdateOverride: null,
      lastCronCheck: null,
      scalingExempt: 0,
      engines: 'codex',
      claudeClientVersion: null,
      claudeClientVersionOverride: null,
      claudeWrapperVersion: null,
      claudeAuthDigest: null,
      claudeModelOverride: null,
      claudeReasoningEffortOverride: null,
      claudeLastRefresh: null,
      configVersion: 0,
      wrapperTrack: 'v2',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  db.tables.set(versionsTable, []);
  db.tables.set(hostUsers, []);
}

function makeKeyring(): Keyring {
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

describe('GET /host/lane', () => {
  it('returns lane_preference + effective_lane', async () => {
    const db = createDbFake();
    setupHost(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'GET',
      url: '/host/lane',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('ok');
    expect(body).toMatchObject({
      lane_preference: null,
      effective_lane: 'normal',
      fqdn: 'host.example.com',
      host_id: 1,
    });
    await app.close();
  });

  it('returns 401 without API key', async () => {
    const db = createDbFake();
    setupHost(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({ method: 'GET', url: '/host/lane' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /host/lane', () => {
  it('updates lane_preference and returns effective_lane', async () => {
    const db = createDbFake();
    setupHost(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/host/lane',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ lane: 'spark' }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.lane_preference).toBe('spark');
    expect(body.effective_lane).toBe('spark');
    await app.close();
  });

  it('rejects an unknown lane string', async () => {
    const db = createDbFake();
    setupHost(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/host/lane',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ lane: 'turbo' }),
    });
    expect(r.statusCode).toBe(422);
    await app.close();
  });

  it('clears the lane preference when given null', async () => {
    const db = createDbFake();
    setupHost(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/host/lane',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ lane: null }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).lane_preference).toBeNull();
    await app.close();
  });
});
