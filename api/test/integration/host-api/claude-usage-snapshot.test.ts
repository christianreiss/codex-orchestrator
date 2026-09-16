import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeUsageSnapshots, hosts, versions } from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { ClaudeUsageService } from '../../../src/services/claude-usage.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { assertContract, compileContract } from '../../helpers/contract-schema.js';

const apiKey = 'sk-local-usage-snapshot-test';
const stamp = '2026-09-07T12:00:00Z';
const env = {
  INSTALLATION_ID: 'inst-test',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  PUBLIC_BASE_URL: 'https://orchestrator.example',
  STATIC_ROOT: '',
  AUTH_RUNNER_URL: 'https://runner.example/verify',
  AUTH_RUNNER_TIMEOUT: 2,
} as Parameters<typeof buildHostApiTestApp>[0]['env'];

function seedDb(snapshot: Record<string, unknown> | null = {}) {
  const db = createDbFake();
  db.tables.set(hosts, [{
    id: 1, fqdn: 'host.example', apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyEnc: null,
    engines: 'codex,claude', status: 'active', secure: 1, apiCalls: 0,
    allowRoamingIps: 0, reverseDnsMode: null, ip4: null, ip6: null,
    autoUpdateOverride: 0, createdAt: stamp, updatedAt: stamp,
  }]);
  db.tables.set(versions, []);
  db.tables.set(claudeUsageSnapshots, snapshot === null ? [] : [{
    id: 7, hostId: 2, source: 'statusline',
    fiveHourUsedPercent: 0, fiveHourResetsAt: '2026-09-07T17:00:00Z',
    sevenDayUsedPercent: null, sevenDayResetsAt: null,
    fetchedAt: stamp, createdAt: stamp, ...snapshot,
  }]);
  return db;
}

async function build(db: ReturnType<typeof seedDb>) {
  return buildHostApiTestApp({ db: db as never, env, keyring: Keyring.fromEnv(env) });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Claude usage in authentication and startup responses', () => {
  it.each(['/auth', '/sync/status', '/sync/bootstrap'])('%s serves reported Claude usage without provider calls or invented readings', async (url) => {
    const db = seedDb();
    const fetch = vi.fn(() => { throw new Error('unexpected outbound request'); });
    vi.stubGlobal('fetch', fetch);
    const app = await build(db);
    try {
      const response = await app.inject({
        method: 'POST', url, headers: { authorization: `Bearer ${apiKey}` },
        payload: { engine: 'claude' },
      });
      expect(response.statusCode).toBe(200);
      const schema = url === '/auth' ? 'auth-retrieve.schema.json' : url === '/sync/status' ? 'sync-status.schema.json' : 'sync-bootstrap.schema.json';
      if (url === '/auth') {
        assertContract('auth-retrieve.schema.json', response.json());
      } else if (url === '/sync/status') {
        assertContract('sync-status.schema.json', response.json());
      } else {
        assertContract('sync-bootstrap.schema.json', response.json());
      }
      const auth = url === '/auth' ? response.json() : response.json().auth;
      expect(auth.claude_usage).toMatchObject({
        status: 'ok', source: 'statusline', host_id: 2, fetched_at: stamp,
        five_hour_window: { used_percent: 0, resets_at: '2026-09-07T17:00:00Z' },
        seven_day_window: { used_percent: null, resets_at: null },
      });
      expect(auth).not.toHaveProperty('chatgpt');
      expect(auth.quota_advice).toMatchObject({
        settings: { mode: 'ask', high_usage_percent: 85, max_age_minutes: 30 },
        codex: { available: true, status: 'unavailable' },
        claude: { available: true, fetched_at: stamp, windows: [
          { used_percent: 0, limit_seconds: 18000, reset_at: '2026-09-07T17:00:00Z' },
          { used_percent: null, limit_seconds: 604800, reset_at: null },
        ] },
      });
      expect(fetch).not.toHaveBeenCalled();
      const invalidAdvice = response.json();
      const invalidAuth = url === '/auth' ? invalidAdvice.data : invalidAdvice.data.auth;
      invalidAuth.quota_advice.settings.mode = 'automatic';
      expect(compileContract(schema)(invalidAdvice)).toBe(false);
      for (const invalid of [
        { fetched_at: 'not-a-timestamp' },
        { five_hour_used_percent: 101 },
        { five_hour_window: { used_percent: '0', resets_at: null } },
      ]) {
        const malformed = response.json();
        const inner = url === '/auth' ? malformed.data : malformed.data.auth;
        Object.assign(inner.claude_usage, invalid);
        expect(compileContract(schema)(malformed)).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  it('retains the original timestamp and percentages of stale observations', async () => {
    const old = '2020-01-01T00:00:00Z';
    const db = seedDb({ fetchedAt: old, fiveHourUsedPercent: 97 });
    const app = await build(db);
    try {
      const response = await app.inject({ method: 'POST', url: '/auth', headers: { authorization: `Bearer ${apiKey}` }, payload: { engine: 'claude' } });
      expect(response.statusCode).toBe(200);
      assertContract('auth-retrieve.schema.json', response.json());
      expect(response.json().claude_usage).toMatchObject({ fetched_at: old, five_hour_window: { used_percent: 97 } });
      expect(db.tables.get(claudeUsageSnapshots)?.[0]?.fetchedAt).toBe(old);
    } finally {
      await app.close();
    }
  });

  it.each(['missing', 'read failure'])('reports unavailable on %s without failing credential retrieval', async (scenario) => {
    const db = seedDb(null);
    if (scenario === 'read failure') vi.spyOn(ClaudeUsageService.prototype, 'latest').mockRejectedValue(new Error('snapshot read unavailable'));
    const app = await build(db);
    try {
      const response = await app.inject({ method: 'POST', url: '/auth', headers: { authorization: `Bearer ${apiKey}` }, payload: { engine: 'claude' } });
      expect(response.statusCode).toBe(200);
      assertContract('auth-retrieve.schema.json', response.json());
      expect(response.json().claude_usage).toEqual({ status: 'unavailable' });
    } finally {
      await app.close();
    }
  });

  it('keeps Claude account usage out of Codex responses', async () => {
    const app = await build(seedDb());
    try {
      const response = await app.inject({ method: 'POST', url: '/auth', headers: { authorization: `Bearer ${apiKey}` }, payload: { engine: 'codex' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).not.toHaveProperty('claude_usage');
      expect(response.json()).toHaveProperty('chatgpt');
    } finally {
      await app.close();
    }
  });

  it('includes the same stored snapshot after an accepted Claude credential upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', reachable: true }), { status: 200 })));
    const app = await build(seedDb({ sevenDayUsedPercent: 63 }));
    try {
      const response = await app.inject({
        method: 'POST', url: '/auth', headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          engine: 'claude', command: 'store',
          auth: { last_refresh: stamp, api_key: 'sk-ant-api03-local-test-valid-credential' },
        },
      });
      expect(response.statusCode).toBe(200);
      assertContract('auth-store.schema.json', response.json());
      expect(response.json().claude_usage).toMatchObject({ status: 'ok', seven_day_window: { used_percent: 63 } });
      const malformed = response.json();
      malformed.data.claude_usage.seven_day_window.used_percent = -1;
      expect(compileContract('auth-store.schema.json')(malformed)).toBe(false);
      expect(response.json()).not.toHaveProperty('chatgpt');
    } finally {
      await app.close();
    }
  });
});
