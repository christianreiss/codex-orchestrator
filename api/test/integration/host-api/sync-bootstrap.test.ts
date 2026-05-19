import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbShim } from '../../helpers/db-shim.js';
import { createHash } from 'node:crypto';
import {
  hosts as hostsTable,
  versions as versionsTable,
  agentsDocuments,
  clientConfigDocuments,
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

function makeKeyring(): Keyring {
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

function hostRow(apiKey: string): Record<string, unknown> {
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
    engines: 'codex',
    vip: 0,
    scalingExempt: 0,
    curlInsecure: 0,
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
  };
}

describe('POST /sync/bootstrap inlines agents + config', () => {
  it('returns content envelopes when local digests differ', async () => {
    const apiKey = 'sk-bootstrap-test';
    const agentsBody = '# AGENTS.md\n';
    const configBody = 'model = "gpt-5.5"\n';
    const agentsSha = createHash('sha256').update(agentsBody).digest('hex');
    const configSha = createHash('sha256').update(configBody).digest('hex');

    const db = createDbShim();
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, [
      { name: 'client_version_codex', version: '0.130.0' },
      { name: 'wrapper_version_codex', version: '0.6.5' },
    ]);
    db.tables.set(agentsDocuments, [
      {
        id: 7,
        engine: 'codex',
        slug: 'main',
        body: agentsBody,
        sha256: agentsSha,
        size: agentsBody.length,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);
    db.tables.set(clientConfigDocuments, [
      {
        id: 9,
        engine: 'codex',
        slug: 'main',
        body: configBody,
        sha256: configSha,
        size: configBody.length,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        include_auth: false,
        agents: 'stale-digest',
        config: 'stale-digest',
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.agents).toMatchObject({ status: 'updated', content: agentsBody, sha256: agentsSha });
    expect(body.config).toMatchObject({ status: 'updated', content: configBody, sha256: configSha });
    await app.close();
  });

  it('omits content when digests match', async () => {
    const apiKey = 'sk-bootstrap-unchanged';
    const agentsBody = '# AGENTS.md\n';
    const configBody = 'model = "gpt-5.5"\n';
    const agentsSha = createHash('sha256').update(agentsBody).digest('hex');
    const configSha = createHash('sha256').update(configBody).digest('hex');

    const db = createDbShim();
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, [
      {
        id: 7,
        engine: 'codex',
        slug: 'main',
        body: agentsBody,
        sha256: agentsSha,
        size: agentsBody.length,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);
    db.tables.set(clientConfigDocuments, [
      {
        id: 9,
        engine: 'codex',
        slug: 'main',
        body: configBody,
        sha256: configSha,
        size: configBody.length,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        engine: 'codex',
        include_auth: false,
        agents: agentsSha,
        config: configSha,
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.agents.status).toBe('unchanged');
    expect(body.agents.content).toBeUndefined();
    expect(body.config.status).toBe('unchanged');
    expect(body.config.content).toBeUndefined();
    await app.close();
  });

  it('includes a sessions block with now/today/month numeric counts', async () => {
    const apiKey = 'sk-bootstrap-sessions';
    const db = createDbShim();
    db.tables.set(hostsTable, [hostRow(apiKey)]);
    db.tables.set(versionsTable, []);
    db.tables.set(agentsDocuments, []);
    db.tables.set(clientConfigDocuments, []);

    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/sync/bootstrap',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ engine: 'codex', include_auth: false }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.sessions).toBeDefined();
    expect(typeof body.sessions.now).toBe('number');
    expect(typeof body.sessions.today).toBe('number');
    expect(typeof body.sessions.month).toBe('number');
    expect(body.sessions.now).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});
