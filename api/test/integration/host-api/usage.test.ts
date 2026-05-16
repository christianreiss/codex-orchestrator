import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbShim } from '../../helpers/db-shim.js';
import {
  hosts as hostsTable,
  versions as versionsTable,
  hostUsers,
  tokenUsages,
  tokenUsageIngests,
} from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';

const env = {
  INSTALLATION_ID: 'inst',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
  PUBLIC_BASE_URL: 'https://o.example',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

const apiKey = 'sk-codex-usage-test';
const now = '2026-05-17T00:00:00Z';

function setupHost(db: ReturnType<typeof createDbShim>): void {
  db.tables.set(hostsTable, [
    {
      id: 7,
      fqdn: 'usage.example',
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
      createdAt: now,
      updatedAt: now,
    },
  ]);
  db.tables.set(versionsTable, []);
  db.tables.set(hostUsers, []);
  db.tables.set(tokenUsages, []);
  db.tables.set(tokenUsageIngests, []);
}

function makeKeyring(): Keyring {
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

describe('POST /usage', () => {
  it('records a single-entry usage with line + total', async () => {
    const db = createDbShim();
    setupHost(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/usage',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ line: 'token usage: 100', total: '1,000' }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('ok');
    expect(body.recorded).toBe(1);
    expect(body.total).toBe(1000);
    expect(body.host_id).toBe(7);
    // Verify rows inserted via the shim
    expect(db.tables.get(tokenUsageIngests)!.length).toBe(1);
    expect(db.tables.get(tokenUsages)!.length).toBe(1);
    await app.close();
  });

  it('returns 200 with recorded:false on validation failure (contract)', async () => {
    const db = createDbShim();
    setupHost(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/usage',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ total: 'not-a-number' }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('ok');
    expect(body.recorded).toBe(false);
    expect(body.reason).toMatch(/ingestion failed/);
    await app.close();
  });

  it('records a multi-entry usages array', async () => {
    const db = createDbShim();
    setupHost(db);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/usage',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ usages: [{ total: 100 }, { total: 250, model: 'gpt-5' }] }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.recorded).toBe(2);
    expect(db.tables.get(tokenUsages)!.length).toBe(2);
    await app.close();
  });
});
