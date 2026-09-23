import { afterAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAdminOverviewRoutes } from '../../../src/routes/admin/overview/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createMockDb } from '../../helpers/in-memory-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

describe('GET /admin/hosts', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    await app?.close?.();
  });

  it('returns the parsed engine list alongside the storage string', async () => {
    const mock = createMockDb();
    mock.insertRow('hosts', {
      id: 1,
      fqdn: 'both.example.test',
      status: 'active',
      engines: 'codex,claude',
      secure: 1,
      vip: 0,
      allow_roaming_ips: 0,
      scaling_exempt: 0,
      curl_insecure: 0,
      browseros_mcp_enabled: 0,
      agent_messaging_enabled: 0,
      api_calls: 0,
      config_version: 0,
    });

    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(requestIdPlugin);
    await app.register(envelopePlugin);
    app.decorate('requireAdmin', async () => undefined);
    app.decorate('resolveAdmin', async () => null);
    const ctx: RouteContext = {
      db: mock.db,
      env: { ...loadTestEnv(), ADMIN_WS_ENABLED: false },
      keyring: testKeyring(),
    };
    await registerAdminOverviewRoutes(app, ctx);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/hosts',
      headers: { accept: 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: { hosts: Array<{ engines: string; engines_list: string[] }> };
    };
    expect(body.data.hosts[0]).toMatchObject({
      engines: 'codex,claude',
      engines_list: ['codex', 'claude'],
      installer_used_at: null,
      installer_expires_at: null,
    });
  });

  it('reports the latest installer token state per host from one read', async () => {
    const mock = createMockDb();
    for (const [id, fqdn] of [[1, 'a.example.test'], [2, 'b.example.test']] as const) {
      mock.insertRow('hosts', {
        id,
        fqdn,
        status: 'active',
        engines: 'codex',
        secure: 1,
        vip: 0,
        allow_roaming_ips: 0,
        scaling_exempt: 0,
        curl_insecure: 0,
        browseros_mcp_enabled: 0,
        agent_messaging_enabled: 0,
        api_calls: 0,
        config_version: 0,
      });
    }
    mock.insertRow('install_tokens', {
      id: 1, host_id: 1, used_at: null, expires_at: '2026-09-23T00:30:00Z',
    });
    mock.insertRow('install_tokens', {
      id: 2, host_id: 1, used_at: '2026-09-23T01:05:00Z', expires_at: '2026-09-23T01:30:00Z',
    });

    const local = Fastify({ logger: false });
    await local.register(cookie);
    await local.register(requestIdPlugin);
    await local.register(envelopePlugin);
    local.decorate('requireAdmin', async () => undefined);
    local.decorate('resolveAdmin', async () => null);
    await registerAdminOverviewRoutes(local, {
      db: mock.db,
      env: { ...loadTestEnv(), ADMIN_WS_ENABLED: false },
      keyring: testKeyring(),
    });
    await local.ready();

    const response = await local.inject({
      method: 'GET',
      url: '/admin/hosts',
      headers: { accept: 'application/json' },
    });
    const hosts = (response.json() as { data: { hosts: Array<Record<string, unknown>> } }).data.hosts;
    expect(hosts.find((h) => h.id === 1)).toMatchObject({
      installer_used_at: '2026-09-23T01:05:00Z',
      installer_expires_at: '2026-09-23T01:30:00Z',
    });
    expect(hosts.find((h) => h.id === 2)).toMatchObject({
      installer_used_at: null,
      installer_expires_at: null,
    });
    await local.close();
  });
});
