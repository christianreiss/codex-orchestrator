import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
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
    const db = createDbFake();
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
    const db = createDbFake();
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
    const db = createDbFake();
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

  it('resolves latest codex target before comparing client versions', async () => {
    const db = createDbFake();
    const apiKey = 'sk-codex-cron-test';
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, [
      { name: 'client_version_codex', version: 'latest' },
      { name: 'github_release_codex-cli', version: '{"tag_name":"rust-v0.137.0"}' },
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
        client_version: '0.130.0',
        wrapper_version: '0.6.2',
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({
      action: 'update',
      target_version: '0.137.0',
      tag: '0.137.0',
      enforce_exact: false,
      wrapper: { action: 'no_update' },
    });
    await app.close();
  });

  it('uses the settings codex lock as an exact cron target', async () => {
    const db = createDbFake();
    const apiKey = 'sk-codex-cron-test';
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, [
      { name: 'client_version_codex', version: 'latest' },
      { name: 'client_available', version: '0.137.0' },
      { name: 'client_version_lock', version: '0.130.0' },
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
        client_version: '0.137.0',
        wrapper_version: '0.6.2',
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({
      action: 'update',
      target_version: '0.130.0',
      tag: '0.130.0',
      enforce_exact: true,
      wrapper: { action: 'no_update' },
    });
    await app.close();
  });

  it('returns a platform-specific wrapper URL based on X-Wrapper-Platform', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'codex-auth-wrapper-'));
    const binaryPath = join(dataRoot, 'wrapper', 'v2', 'bin', 'codex', 'linux-amd64', 'v1.0.1', 'cdx');
    await mkdir(dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'test binary');
    await writeFile(
      join(dataRoot, 'wrapper', 'v2', 'bin', 'codex', 'linux-amd64', 'manifest.json'),
      JSON.stringify({
        engine: 'codex',
        os: 'linux',
        arch: 'amd64',
        current: '1.0.1',
        builds: [
          {
            version: '1.0.1',
            sha256: 'b'.repeat(64),
            size_bytes: 11,
            signature: null,
            published_at: '2026-05-18T00:00:00Z',
          },
        ],
      }),
    );
    const db = createDbFake();
    const apiKey = 'sk-codex-cron-test';
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, [
      { name: 'client_version_codex', version: '0.130.0' },
      { name: 'wrapper_version_codex', version: '1.0.1' },
      { name: 'wrapper_sha256_codex', version: 'a'.repeat(64) },
      {
        name: 'wrapper_url_codex',
        version: 'https://orchestrator.example/wrapper/v2/bin/codex/darwin-arm64/v1.0.1/cdx',
      },
      { name: 'auto_update_enabled', version: '1' },
    ]);
    let app: Awaited<ReturnType<typeof buildHostApiTestApp>> | null = null;
    try {
      app = await buildHostApiTestApp({
        db: db as any,
        env: { ...env, DATA_ROOT: dataRoot },
        keyring: makeKeyring(),
      });
      const r = await app.inject({
        method: 'POST',
        url: '/cron/check',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'x-wrapper-platform': 'linux-amd64',
        },
        payload: JSON.stringify({
          engine: 'codex',
          client_version: '0.130.0',
          wrapper_version: '1.0.0',
        }),
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body.wrapper.action).toBe('update');
      expect(body.wrapper.target_version).toBe('1.0.1');
      expect(body.wrapper.url).toBe(
        'https://orchestrator.example/wrapper/v2/bin/codex/linux-amd64/v1.0.1/cdx',
      );
      // SHA must match the requested platform manifest, not the configured URL.
      expect(body.wrapper.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(body.wrapper.sha256).not.toBe('a'.repeat(64));
    } finally {
      await app?.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('returns the legacy transition launcher URL for date-style shell wrappers', async () => {
    const db = createDbFake();
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

describe('POST /cron/check (claude engine)', () => {
  it('resolves latest claude target before comparing client versions', async () => {
    const db = createDbFake();
    const apiKey = 'sk-claude-cron-test';
    db.tables.set(hostsTable, [{ ...hostRow(apiKey), engines: 'claude,codex' }]);
    db.tables.set(versionsTable, [
      { name: 'client_version_claude', version: 'latest' },
      { name: 'github_release_claude-cli', version: '{"version":"2.1.173"}' },
      { name: 'wrapper_version_claude', version: '0.6.2' },
      { name: 'auto_update_enabled', version: '1' },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/cron/check',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'claude',
        client_version: '2.1.168',
        wrapper_version: '0.6.2',
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({
      action: 'update',
      target_version: '2.1.173',
      tag: '2.1.173',
      enforce_exact: false,
      wrapper: { action: 'no_update' },
    });
    await app.close();
  });

  it('uses the settings claude lock as an exact cron target', async () => {
    const db = createDbFake();
    const apiKey = 'sk-claude-cron-test';
    db.tables.set(hostsTable, [{ ...hostRow(apiKey), engines: 'claude,codex' }]);
    db.tables.set(versionsTable, [
      { name: 'client_version_claude', version: 'latest' },
      { name: 'github_release_claude-cli', version: '{"version":"2.1.173"}' },
      { name: 'client_version_lock_claude', version: '2.1.168' },
      { name: 'wrapper_version_claude', version: '0.6.2' },
      { name: 'auto_update_enabled', version: '1' },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/cron/check',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'claude',
        client_version: '2.1.173',
        wrapper_version: '0.6.2',
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({
      action: 'update',
      target_version: '2.1.168',
      tag: '2.1.168',
      enforce_exact: true,
      wrapper: { action: 'no_update' },
    });
    await app.close();
  });

  it('returns no_update when claude client is already at latest', async () => {
    const db = createDbFake();
    const apiKey = 'sk-claude-cron-test';
    db.tables.set(hostsTable, [{ ...hostRow(apiKey), engines: 'claude,codex' }]);
    db.tables.set(versionsTable, [
      { name: 'client_version_claude', version: 'latest' },
      { name: 'github_release_claude-cli', version: '{"version":"2.1.173"}' },
      { name: 'wrapper_version_claude', version: '0.6.2' },
      { name: 'auto_update_enabled', version: '1' },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/cron/check',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'claude',
        client_version: '2.1.173',
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
