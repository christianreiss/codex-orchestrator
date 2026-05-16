/**
 * Service-level integration tests for the admin-hosts services. They wire the
 * real Drizzle ORM against the hand-rolled in-memory store from
 * test/helpers/in-memory-db.ts to verify the actual SQL the services issue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockDb } from '../../helpers/in-memory-db.js';
import {
  HostManagementService,
} from '../../../src/services/host-management.js';
import { InsecureWindowAdminService } from '../../../src/services/insecure-window-admin.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { Keyring } from '../../../src/security/keyring.js';
import { decrypt as sboxDecrypt } from '../../../src/security/secret-box.js';
import type { Env } from '../../../src/env.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

function buildEnv(): Env {
  return {
    NODE_ENV: 'test',
    APP_ENV: 'test',
    LISTEN_HOST: '0.0.0.0',
    LISTEN_PORT: 8080,
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    STATIC_ROOT: '/tmp',
    DB_HOST: 'mysql',
    DB_PORT: 3306,
    DB_DATABASE: 'test',
    DB_USERNAME: 'test',
    DB_PASSWORD: 'test',
    DB_CHARSET: 'utf8mb4',
    DB_POOL_SIZE: 10,
    ADMIN_ACCESS_MODE: 'cookie',
    ADMIN_SESSION_COOKIE: 'codex_admin_session',
    ADMIN_SESSION_TTL_MINUTES: 720,
    ADMIN_WS_ENABLED: false,
    ADMIN_WS_HEARTBEAT_SECONDS: 30,
    ADMIN_WS_BACKLOG_LIMIT: 200,
    ADMIN_WEBAUTHN_RP_NAME: 'test',
    PUBLIC_BASE_URL: 'https://orch.example.com',
    PUBLIC_BASE_URL_REQUIRED: true,
    TRUST_X_FORWARDED: false,
    TRUSTED_PROXY_CIDRS: '',
    STRICT_HOST_VALIDATION: true,
    MCP_ALLOW_REQUEST_HOST_ORIGIN: false,
    INSECURE_GRACE_MINUTES: 60,
    RUN_MIGRATIONS_ON_BOOT: false,
    RUN_BACKFILLS_ON_BOOT: false,
    DEFAULT_HOST_ENGINES: 'codex',
    PRICING_CURRENCY: 'USD',
    CHATGPT_USAGE_CRON_INTERVAL: 3600,
    AUTH_RUNNER_IP_BYPASS: false,
    AUTH_RUNNER_BYPASS_SUBNETS: '',
    AUTH_RUNNER_PREFLIGHT_SECONDS: 28800,
    AUTH_SEED_TOKEN_TTL_SECONDS: 900,
    AUTH_RUNNER_TIMEOUT: 8,
    SMTP_SECURE: false,
  } as Env;
}

async function buildKeyring(): Promise<Keyring> {
  await sodium.ready;
  const raw = sodium.randombytes_buf(32);
  const b64 = sodium.to_base64(raw, sodium.base64_variants.ORIGINAL);
  const env = {
    ENCRYPTION_KEYS: `main:${b64}`,
    ENCRYPTION_ACTIVE_KID: 'main',
  } as unknown as Env;
  return Keyring.fromEnv(env);
}

describe('HostManagementService.register', () => {
  it('creates a new host with hashed + encrypted api_key on first call', async () => {
    const mock = createMockDb();
    const env = buildEnv();
    const keyring = await buildKeyring();
    const events = makeAdminEventsWriter(mock.db);
    const svc = new HostManagementService({ db: mock.db, env, keyring, events });

    const out = await svc.register({ fqdn: 'a.example.com', secure: true });
    expect(out.host.id).toBeGreaterThan(0);
    expect(out.apiKeyPlain).toMatch(/^sk-codex-[0-9a-f]{64}$/);
    expect(out.installer.token).toMatch(/^[0-9a-f]{32}$/);

    const stored = mock.rows('hosts');
    expect(stored).toHaveLength(1);
    const h = stored[0]!;
    // Hash matches sha256(apiKeyPlain)
    const expectedHash = (await import('node:crypto'))
      .createHash('sha256')
      .update(out.apiKeyPlain)
      .digest('hex');
    expect(h.api_key_hash).toBe(expectedHash);
    expect(h.api_key).toBe(expectedHash); // legacy column also stores hash
    // Encrypted envelope decrypts back to the plaintext
    expect(typeof h.api_key_enc).toBe('string');
    const decoded = sboxDecrypt(h.api_key_enc as string, keyring);
    expect(decoded).toBe(out.apiKeyPlain);
  });

  it('rotates the api_key on re-register and keeps a single install token', async () => {
    const mock = createMockDb();
    const env = buildEnv();
    const keyring = await buildKeyring();
    const events = makeAdminEventsWriter(mock.db);
    const svc = new HostManagementService({ db: mock.db, env, keyring, events });

    const first = await svc.register({ fqdn: 'rotate.example.com', secure: true });
    const second = await svc.register({ fqdn: 'rotate.example.com', secure: true });

    expect(first.apiKeyPlain).not.toBe(second.apiKeyPlain);
    expect(mock.rows('hosts')).toHaveLength(1);
    // Token table contains only the latest token
    expect(mock.rows('install_tokens')).toHaveLength(1);
  });

  it('opens a provisioning window when secure=false', async () => {
    const mock = createMockDb();
    const env = buildEnv();
    const keyring = await buildKeyring();
    const events = makeAdminEventsWriter(mock.db);
    const svc = new HostManagementService({ db: mock.db, env, keyring, events });

    const out = await svc.register({ fqdn: 'open.example.com', secure: false });
    const h = mock.rows('hosts').find((r) => r.id === out.host.id)!;
    expect(h.secure).toBe(0);
    expect(h.insecure_enabled_until).toBeInstanceOf(Date);
    expect(h.insecure_window_minutes).toBeGreaterThan(0);
  });

  it('publishes a host.created event with the correct payload', async () => {
    const mock = createMockDb();
    const env = buildEnv();
    const keyring = await buildKeyring();
    const events = makeAdminEventsWriter(mock.db);
    const svc = new HostManagementService({ db: mock.db, env, keyring, events });

    await svc.register({ fqdn: 'pub.example.com', secure: true });
    const evt = mock.rows('admin_events');
    expect(evt.some((e) => e.type === 'host.created')).toBe(true);
  });
});

describe('HostManagementService.setSecure', () => {
  it('clears insecureEnabledUntil and writes a grace window when re-securing', async () => {
    const mock = createMockDb();
    const env = { ...buildEnv(), INSECURE_GRACE_MINUTES: 30 };
    const keyring = await buildKeyring();
    const events = makeAdminEventsWriter(mock.db);
    const svc = new HostManagementService({ db: mock.db, env, keyring, events });

    // Seed an insecure host with a live insecure window
    const future = new Date(Date.now() + 30 * 60_000);
    mock.insertRow('hosts', {
      fqdn: 'x.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      insecure_enabled_until: future,
      insecure_window_minutes: 30,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });

    const host = await svc.setSecure(1, true);
    expect(host.secure).toBe(1);
    expect(host.insecureEnabledUntil).toBeNull();
    // Grace was set
    expect(host.insecureGraceUntil).toBeInstanceOf(Date);
    const graceDelta = (host.insecureGraceUntil as Date).getTime() - Date.now();
    expect(graceDelta).toBeGreaterThan(25 * 60_000);
    expect(graceDelta).toBeLessThan(35 * 60_000);
  });

  it('clears both windows when re-securing a host with no open window', async () => {
    const mock = createMockDb();
    const env = buildEnv();
    const keyring = await buildKeyring();
    const events = makeAdminEventsWriter(mock.db);
    const svc = new HostManagementService({ db: mock.db, env, keyring, events });

    mock.insertRow('hosts', {
      fqdn: 'y.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      insecure_enabled_until: null,
      insecure_grace_until: null,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });

    const host = await svc.setSecure(1, true);
    expect(host.insecureEnabledUntil).toBeNull();
    expect(host.insecureGraceUntil).toBeNull();
  });
});

describe('HostManagementService version overrides', () => {
  it('rejects non-semver codex selections', async () => {
    const mock = createMockDb();
    const env = buildEnv();
    const keyring = await buildKeyring();
    const events = makeAdminEventsWriter(mock.db);
    const svc = new HostManagementService({ db: mock.db, env, keyring, events });
    mock.insertRow('hosts', {
      fqdn: 'z.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 1,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    await expect(svc.setCodexVersionOverride(1, 'latest')).rejects.toThrow(/semantic version/);
    await expect(svc.setClaudeVersionOverride(1, 'latest')).rejects.toThrow(/semantic version/);
  });

  it('accepts a normalized v-prefixed semver', async () => {
    const mock = createMockDb();
    const env = buildEnv();
    const keyring = await buildKeyring();
    const events = makeAdminEventsWriter(mock.db);
    const svc = new HostManagementService({ db: mock.db, env, keyring, events });
    mock.insertRow('hosts', {
      fqdn: 'z.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 1,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    const host = await svc.setCodexVersionOverride(1, 'v0.125.0');
    expect(host.clientVersionOverride).toBe('0.125.0');
  });
});

describe('InsecureWindowAdminService', () => {
  async function setup() {
    const mock = createMockDb();
    const env = buildEnv();
    const keyring = await buildKeyring();
    const events = makeAdminEventsWriter(mock.db);
    const svc = new InsecureWindowAdminService({ db: mock.db, env, events });
    return { mock, svc };
  }

  it('enable opens a window and writes insecure.requested', async () => {
    const { mock, svc } = await setup();
    mock.insertRow('hosts', {
      fqdn: 'enable.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    const host = await svc.enable(1, 45);
    expect(host.insecureEnabledUntil).toBeInstanceOf(Date);
    expect(host.insecureWindowMinutes).toBe(45);
    const events = mock.rows('admin_events');
    expect(events.some((e) => e.type === 'insecure.requested')).toBe(true);
  });

  it('disable clears windows', async () => {
    const { mock, svc } = await setup();
    mock.insertRow('hosts', {
      fqdn: 'd.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      insecure_enabled_until: new Date(Date.now() + 60_000),
      insecure_grace_until: new Date(Date.now() + 90_000),
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    const host = await svc.disable(1);
    expect(host.insecureEnabledUntil).toBeNull();
    expect(host.insecureGraceUntil).toBeNull();
  });

  it('enable refuses to open a window on a secure host', async () => {
    const { mock, svc } = await setup();
    mock.insertRow('hosts', {
      fqdn: 'sec.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 1,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    await expect(svc.enable(1, 30)).rejects.toThrow(/secure/);
  });

  it('enable extends an existing window from its enabledUntil baseline', async () => {
    const { mock, svc } = await setup();
    const enabled = new Date(Date.now() + 30 * 60_000);
    mock.insertRow('hosts', {
      fqdn: 'ext.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      insecure_enabled_until: enabled,
      insecure_window_minutes: 30,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    const host = await svc.enable(1, 30);
    const newUntil = host.insecureEnabledUntil as Date;
    expect(newUntil.getTime() - enabled.getTime()).toBe(30 * 60_000);
  });

  it('approve flow approves the request, opens a window, publishes events', async () => {
    const { mock, svc } = await setup();
    mock.insertRow('hosts', {
      fqdn: 'app.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    mock.insertRow('insecure_auth_requests', {
      host_id: 1,
      status: 'pending',
      requested_at: '2024-01-01',
      updated_at: '2024-01-01',
      engine: 'codex',
    });

    const result = await svc.approve(1, 30);
    expect(result.requestId).toBe(1);
    expect(result.host.insecureEnabledUntil).toBeInstanceOf(Date);
    expect(result.host.insecureWindowMinutes).toBe(30);
    expect(mock.rows('insecure_auth_requests')[0]!.status).toBe('approved');
    expect(mock.rows('admin_events').some((e) => e.type === 'insecure.approved')).toBe(true);
  });

  it('approve rejects an already-resolved request', async () => {
    const { mock, svc } = await setup();
    mock.insertRow('hosts', {
      fqdn: 'app2.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    mock.insertRow('insecure_auth_requests', {
      host_id: 1,
      status: 'denied',
      requested_at: '2024-01-01',
      updated_at: '2024-01-01',
      engine: 'codex',
    });
    await expect(svc.approve(1, null)).rejects.toThrow(/resolved/);
  });

  it('deny flow marks the request denied + publishes', async () => {
    const { mock, svc } = await setup();
    mock.insertRow('hosts', {
      fqdn: 'deny.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    mock.insertRow('insecure_auth_requests', {
      host_id: 1,
      status: 'pending',
      requested_at: '2024-01-01',
      updated_at: '2024-01-01',
      engine: 'codex',
    });
    await svc.deny(1);
    expect(mock.rows('insecure_auth_requests')[0]!.status).toBe('denied');
    expect(mock.rows('admin_events').some((e) => e.type === 'insecure.denied')).toBe(true);
  });

  it('allowDomain upserts a domain row, opens a window, approves the request', async () => {
    const { mock, svc } = await setup();
    mock.insertRow('hosts', {
      fqdn: 'cluster1.example.com',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    mock.insertRow('insecure_auth_requests', {
      host_id: 1,
      status: 'pending',
      requested_at: '2024-01-01',
      updated_at: '2024-01-01',
      engine: 'codex',
    });
    const out = await svc.allowDomain(1, 'example.com', 45);
    expect(out.domain.domain).toBe('example.com');
    expect(out.domain.window_minutes).toBe(45);
    expect(out.host.insecureEnabledUntil).toBeInstanceOf(Date);
    expect(mock.rows('insecure_domain_allows')).toHaveLength(1);
    expect(mock.rows('insecure_auth_requests')[0]!.status).toBe('approved');
    expect(
      mock.rows('admin_events').some((e) => e.type === 'insecure.domain.allowed'),
    ).toBe(true);
  });

  it('allowDomain rejects when the domain is not a parent of the host FQDN', async () => {
    const { mock, svc } = await setup();
    mock.insertRow('hosts', {
      fqdn: 'somewhere.else.org',
      api_key: 'h',
      api_key_hash: 'h',
      status: 'active',
      secure: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    mock.insertRow('insecure_auth_requests', {
      host_id: 1,
      status: 'pending',
      requested_at: '2024-01-01',
      updated_at: '2024-01-01',
      engine: 'codex',
    });
    await expect(svc.allowDomain(1, 'unrelated.com', 30)).rejects.toThrow(/parent/);
  });

  it('revokeDomain sets revoked_at and publishes', async () => {
    const { mock, svc } = await setup();
    mock.insertRow('insecure_domain_allows', {
      domain: 'one.example.com',
      window_minutes: 30,
      enabled_until: '2024-01-01T01:00:00Z',
      revoked_at: null,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });
    const allow = await svc.revokeDomain(1);
    expect(allow.revoked_at).toBeTruthy();
    expect(mock.rows('insecure_domain_allows')[0]!.revoked_at).toBeTruthy();
    expect(
      mock.rows('admin_events').some((e) => e.type === 'insecure.domain.revoked'),
    ).toBe(true);
  });
});
