import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbShim } from '../../helpers/db-shim.js';
import { hosts as hostsTable, versions as versionsTable } from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';

const env = {
  INSTALLATION_ID: 'inst-test',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32 bytes b64
  INSECURE_GRACE_MINUTES: 60,
  PUBLIC_BASE_URL: 'https://orchestrator.example',
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

describe('GET /versions', () => {
  it('returns the version snapshot when api_disabled is off', async () => {
    const db = createDbShim();
    db.tables.set(versionsTable, [
      { name: 'client_version_codex', version: '0.42.0' },
      { name: 'wrapper_version_codex', version: '1.0.0' },
      { name: 'auto_update_enabled', version: '1' },
    ]);
    const keyring = makeKeyring();
    const app = await buildHostApiTestApp({ db: db as any, env, keyring });
    const r = await app.inject({ method: 'GET', url: '/versions' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('ok');
    expect(body.client_version).toBe('0.42.0');
    expect(body.wrapper_version).toBe('1.0.0');
    expect(body.auto_update_enabled).toBe(true);
    expect(body.installation_id).toBe('inst-test');
    await app.close();
  });

  it('returns 503 when api_disabled is on', async () => {
    const db = createDbShim();
    db.tables.set(versionsTable, [{ name: 'api_disabled', version: '1' }]);
    const keyring = makeKeyring();
    const app = await buildHostApiTestApp({ db: db as any, env, keyring });
    const r = await app.inject({ method: 'GET', url: '/versions' });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toMatchObject({ status: 'error', code: 'api_disabled' });
    await app.close();
  });
});

describe('POST /cron/check', () => {
  it('normalizes labeled codex-cli versions before deciding client updates', async () => {
    const db = createDbShim();
    const apiKey = 'sk-codex-cron-test';
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, [
      { name: 'client_version_codex', version: '0.130.0' },
      { name: 'wrapper_version_codex', version: '0.6.2' },
      { name: 'auto_update_enabled', version: '1' },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/cron/check',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        client_version: 'codex-cli 0.130.0',
        wrapper_version: '0.6.2',
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({
      action: 'no_update',
      wrapper: { action: 'no_update' },
    });
    await app.close();
  });

  it('returns the legacy transition shim URL for date-style shell wrappers', async () => {
    const db = createDbShim();
    const apiKey = 'sk-codex-cron-test';
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, [
      { name: 'client_version_codex', version: '0.130.0' },
      { name: 'wrapper_version_codex', version: '0.6.0' },
      { name: 'wrapper_sha256_codex', version: 'a'.repeat(64) },
      {
        name: 'wrapper_url_codex',
        version: 'https://orchestrator.example/wrapper/v2/bin/codex/linux-amd64/v0.6.0/cdx',
      },
      { name: 'auto_update_enabled', version: '1' },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/cron/check',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        client_version: '0.130.0',
        wrapper_version: '2026.05.11-01',
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.wrapper).toMatchObject({
      action: 'update',
      target_version: '0.6.0',
      sha256: null,
      url: '/wrapper/download?engine=codex',
    });
    await app.close();
  });
});

function makeKeyring(): Keyring {
  process.env.ENCRYPTION_ACTIVE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    AUTH_ENCRYPTION_KEY: undefined,
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

function hostRow(apiKey: string) {
  return {
    id: 11,
    fqdn: 'cron.example',
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
    configBakedAt: null,
    wrapperTrack: 'v2',
    createdAt: '2026-05-18T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
  };
}
