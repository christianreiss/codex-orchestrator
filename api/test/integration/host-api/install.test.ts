import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbShim } from '../../helpers/db-shim.js';
import {
  hosts as hostsTable,
  installTokens,
  authSeedTokens,
  authPayloads,
  authEntries,
} from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';

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

const futureExpiry = new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const pastExpiry = '2020-01-01T00:00:00Z';
const installToken = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const seedToken = '11111111-2222-3333-4444-555555555555';

describe('GET /install/:token', () => {
  it('emits a text/x-shellscript installer for a valid token', async () => {
    const db = createDbShim();
    db.tables.set(hostsTable, [{ id: 9, fqdn: 'install.example', apiKey: 'sk-x', apiKeyEnc: null, status: 'active', secure: 1, allowRoamingIps: 0, reverseDnsMode: null, apiCalls: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', engines: 'codex', vip: 0, scalingExempt: 0, curlInsecure: 0, configVersion: 0, wrapperTrack: 'v2', apiKeyHash: null, lastRefresh: null, authDigest: null, ip4: null, ip6: null, clientVersion: null, clientVersionOverride: null, wrapperVersion: null, agentsDocumentIdOverride: null, insecureEnabledUntil: null, insecureGraceUntil: null, insecureWindowMinutes: null, expiresAt: null, lanePreference: null, modelOverride: null, reasoningEffortOverride: null, autoUpdateOverride: null, lastCronCheck: null, claudeClientVersion: null, claudeClientVersionOverride: null, claudeWrapperVersion: null, claudeAuthDigest: null, claudeModelOverride: null, claudeReasoningEffortOverride: null, claudeLastRefresh: null, configBakedAt: null }]);
    db.tables.set(installTokens, [
      {
        id: 1,
        token: installToken,
        tokenEnc: null,
        hostId: 9,
        fqdn: 'install.example',
        apiKey: 'sk-install-foo',
        apiKeyEnc: null,
        baseUrl: 'https://o.example',
        expiresAt: futureExpiry,
        usedAt: null,
        createdAt: '2026-05-01T00:00:00Z',
        engine: 'codex',
      },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({ method: 'GET', url: `/install/${installToken}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/x-shellscript');
    expect(r.payload).toContain('#!/bin/sh');
    expect(r.payload).toContain('install.example');
    expect(r.payload).toContain('sk-install-foo');
    // Token marked used
    const updated = db.tables.get(installTokens)![0]!;
    expect(updated.usedAt).toBeTruthy();
    await app.close();
  });

  it('returns shell error 404 for unknown token', async () => {
    const db = createDbShim();
    db.tables.set(installTokens, []);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'GET',
      url: '/install/00000000-0000-0000-0000-000000000000',
    });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toContain('text/x-shellscript');
    expect(r.payload).toContain('Installer not found');
    await app.close();
  });

  it('returns shell error 410 for expired token', async () => {
    const db = createDbShim();
    db.tables.set(hostsTable, [{ id: 9, fqdn: 'install.example', apiKey: 'k', status: 'active', secure: 1, allowRoamingIps: 0, apiCalls: 0, createdAt: 'x', updatedAt: 'x', engines: 'codex', vip: 0, scalingExempt: 0, curlInsecure: 0, configVersion: 0, wrapperTrack: 'v2', apiKeyHash: null, apiKeyEnc: null }]);
    db.tables.set(installTokens, [
      {
        id: 1,
        token: installToken,
        hostId: 9,
        fqdn: 'install.example',
        apiKey: 'sk',
        apiKeyEnc: null,
        baseUrl: 'https://o.example',
        expiresAt: pastExpiry,
        usedAt: null,
        createdAt: '2026-05-01T00:00:00Z',
        engine: 'codex',
      },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({ method: 'GET', url: `/install/${installToken}` });
    expect(r.statusCode).toBe(410);
    expect(r.payload).toContain('Installer expired');
    await app.close();
  });
});

describe('POST /seed/auth/:token', () => {
  it('persists a canonical auth payload and marks the seed token used', async () => {
    const db = createDbShim();
    db.tables.set(authSeedTokens, [
      {
        id: 5,
        token: seedToken,
        tokenEnc: null,
        baseUrl: 'https://o.example',
        engine: 'codex',
        expiresAt: futureExpiry,
        usedAt: null,
        createdAt: '2026-05-01T00:00:00Z',
      },
    ]);
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: `/seed/auth/${seedToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        last_refresh: '2026-05-17T00:00:00Z',
        auths: { 'api.openai.com': { token: 'sk-abc', token_type: 'bearer' } },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    // The standard envelope spreads our object atop {status:'ok'}; since our
    // body already carries status:'updated', that wins. Both are valid.
    expect(['ok', 'updated']).toContain(body.status);
    expect(body.canonical_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(db.tables.get(authPayloads)!.length).toBe(1);
    expect(db.tables.get(authEntries)!.length).toBe(1);
    expect(db.tables.get(authSeedTokens)![0]!.usedAt).toBeTruthy();
    await app.close();
  });

  it('rejects a non-object body', async () => {
    const db = createDbShim();
    db.tables.set(authSeedTokens, [
      {
        id: 5,
        token: seedToken,
        baseUrl: null,
        engine: 'codex',
        expiresAt: futureExpiry,
        usedAt: null,
        createdAt: '2026-05-01T00:00:00Z',
      },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: `/seed/auth/${seedToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(null),
    });
    expect(r.statusCode).toBe(422);
    await app.close();
  });
});
