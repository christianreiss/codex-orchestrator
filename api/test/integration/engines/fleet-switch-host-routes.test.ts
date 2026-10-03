import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { hosts as hostsTable, versions as versionsTable, hostUsers } from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';

/**
 * Every engine-scoped host route refuses an engine that is switched off
 * fleet-wide with 403 `engine_disabled` + `scope: fleet` — the code deployed
 * wrappers already refuse to launch on — while the lease routes a running
 * session needs (heartbeat, release) and the sibling engine stay open.
 */
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
      engines: 'codex,claude',
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


function suspend(db: ReturnType<typeof createDbFake>, engine: string): void {
  db.tables.set(versionsTable, [{ name: `${engine}_engine_disabled`, version: '1', updatedAt: now }]);
}

const SESSION = '0f1e2d3c-4b5a-4968-8776-655443322110';

const GATED: Array<{ method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }> = [
  { method: 'POST', url: '/auth/sessions', payload: { scope_id: 'scope-1', session_id: SESSION } },
  { method: 'POST', url: '/auth', payload: { command: 'retrieve' } },
  { method: 'POST', url: '/sync/status', payload: {} },
  { method: 'POST', url: '/sync/bootstrap', payload: {} },
  { method: 'POST', url: '/claude/usage/report', payload: {} },
  { method: 'POST', url: '/cron/check', payload: { client_version: '1.0.0' } },
  { method: 'POST', url: '/cron/report', payload: { client_version: '1.0.0' } },
];

describe('fleet engine switch on host routes', () => {
  for (const route of GATED) {
    it(`${route.method} ${route.url} refuses a fleet-disabled engine with scope fleet`, async () => {
      const db = createDbFake();
      setupHost(db);
      suspend(db, 'claude');
      const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
      try {
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: `Bearer ${apiKey}`, 'x-engine': 'claude' },
          payload: route.payload,
        });
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json()).toMatchObject({ code: 'engine_disabled', scope: 'fleet', engine: 'claude' });
      } finally {
        await app.close();
      }
    });
  }

  it('keeps lease heartbeat and release open for a running session', async () => {
    for (const url of ['/auth/sessions/heartbeat', '/auth/sessions/release']) {
      const db = createDbFake();
      setupHost(db);
      suspend(db, 'claude');
      const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
      try {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${apiKey}`, 'x-engine': 'claude' },
          payload: { session_id: SESSION },
        });
        // Whatever the lease lookup says, it is not the fleet gate.
        expect(response.body, url).not.toContain('engine_disabled');
      } finally {
        await app.close();
      }
    }
  });

  it('leaves the sibling engine alone', async () => {
    const db = createDbFake();
    setupHost(db);
    suspend(db, 'claude');
    const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/cron/check',
        headers: { authorization: `Bearer ${apiKey}`, 'x-engine': 'codex' },
        payload: { client_version: '1.0.0' },
      });
      expect(response.body).not.toContain('engine_disabled');
    } finally {
      await app.close();
    }
  });

  it('reports a host-level removal as scope host, even while the fleet switch is off', async () => {
    const db = createDbFake();
    setupHost(db);
    db.tables.get(hostsTable)![0]!['engines'] = 'codex';
    suspend(db, 'claude');
    const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth',
        headers: { authorization: `Bearer ${apiKey}`, 'x-engine': 'claude' },
        payload: { command: 'retrieve' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'engine_disabled', scope: 'host' });
    } finally {
      await app.close();
    }
  });
});
