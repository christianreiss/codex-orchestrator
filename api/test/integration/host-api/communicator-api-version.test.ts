import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import {
  authCanonicalHeads,
  authEntries,
  authPayloads,
  chatgptUsageSnapshots,
  hostAuthDigests,
  hostAuthStates,
  hosts as hostsTable,
  logs as logsTable,
  versions as versionsTable,
} from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { apiLevelTracker } from '../../../src/services/communicator-api-version.js';

const env = {
  INSTALLATION_ID: 'inst-test',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  PUBLIC_BASE_URL: 'https://orchestrator.example',
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

const API_KEY = 'sk-api-level-test';
const HOST_ID = 11;

beforeEach(() => apiLevelTracker.clear());
afterEach(() => apiLevelTracker.clear());

describe('communicator API level on GET /versions', () => {
  it.each(['codex', 'claude', 'grok'] as const)('serves integer api_version and min_api for %s', async (engine) => {
    const db = createDbFake();
    const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
    try {
      const r = await app.inject({ method: 'GET', url: `/versions?engine=${engine}` });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body).toMatchObject({ engine, api_version: 1, min_api: 1 });
      expect(Number.isInteger(body.api_version) && Number.isInteger(body.min_api)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it.each(['9', '0', '-3', 'abc', '2.5', ''])(
    'never lets a stored override %j push min_api above api_version',
    async (stored) => {
      const db = createDbFake();
      db.tables.set(versionsTable, [{ name: 'communicator_min_api', version: stored }]);
      const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
      try {
        const body = (await app.inject({ method: 'GET', url: '/versions' })).json();
        expect(body.api_version).toBe(1);
        expect(body.min_api).toBe(1);
        expect(body.min_api).toBeLessThanOrEqual(body.api_version);
      } finally {
        await app.close();
      }
    },
  );
});

describe('X-Cxx-Api observation on authenticated host requests', () => {
  async function check(headers: Record<string, string>) {
    const db = createDbFake();
    db.tables.set(hostsTable, [hostRow(API_KEY)]);
    db.tables.set(versionsTable, [{ name: 'auto_update_enabled', version: '1' }]);
    const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/cron/check',
        headers: { authorization: `Bearer ${API_KEY}`, ...headers },
        payload: {},
      });
      return r;
    } finally {
      await app.close();
    }
  }

  it('records the level a host states, and never changes the response for it', async () => {
    const without = await check({});
    expect(without.statusCode).toBe(200);
    expect(apiLevelTracker.levelOf(HOST_ID)).toBeNull();
    expect(apiLevelTracker.entries()).toEqual([expect.objectContaining({ host_id: HOST_ID, api_version: null })]);
    apiLevelTracker.clear();

    const stated = await check({ 'x-cxx-api': '1' });
    expect(stated.statusCode).toBe(200);
    expect(stated.json()).toEqual(without.json());
    expect(apiLevelTracker.levelOf(HOST_ID)).toBe(1);
  });

  it.each(['abc', '0', '-1', '1.5', '99999999999', ''])('treats header %j as unstated and still serves the request', async (value) => {
    const r = await check({ 'x-cxx-api': value });
    expect(r.statusCode).toBe(200);
    expect(apiLevelTracker.levelOf(HOST_ID)).toBeNull();
  });

  it('does not observe a request that fails authentication', async () => {
    const db = createDbFake();
    db.tables.set(hostsTable, [hostRow(API_KEY)]);
    const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/cron/check',
        headers: { authorization: 'Bearer sk-wrong', 'x-cxx-api': '1' },
        payload: {},
      });
      expect(r.statusCode).toBe(401);
      expect(apiLevelTracker.entries()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('observes through the /auth host-auth service as well', async () => {
    const db = createDbFake();
    db.tables.set(hostsTable, [hostRow(API_KEY)]);
    db.tables.set(versionsTable, [{ name: 'client_version_codex', version: '0.130.0' }]);
    for (const table of [authPayloads, authCanonicalHeads, authEntries, hostAuthDigests, hostAuthStates, logsTable, chatgptUsageSnapshots]) {
      db.tables.set(table, []);
    }
    const app = await buildHostApiTestApp({ db: db as never, env, keyring: makeKeyring() });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/auth',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', 'x-cxx-api': '1' },
        payload: JSON.stringify({ command: 'retrieve', engine: 'codex' }),
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().versions).toMatchObject({ api_version: 1, min_api: 1 });
      expect(apiLevelTracker.levelOf(HOST_ID)).toBe(1);
    } finally {
      await app.close();
    }
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
    wrapperTrack: 'v2', wrapperCanary: 0, internalRole: null,
    createdAt: '2026-05-18T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
  };
}
