/**
 * GET /admin/mcp/logs must carry the joined host fqdn: the admin log view
 * filters on `host_fqdn` and renders it as the Host column.
 */
import { describe, expect, it } from 'vitest';
import { registerAdminConfigRoutes } from '../../../src/routes/admin/config/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createMockDb } from '../../helpers/in-memory-db.js';

async function buildApp() {
  const app = await buildRouteApp();
  const mock = createMockDb();
  await registerAdminConfigRoutes(app, {
    db: mock.db,
    env: {} as never,
    keyring: {} as never,
  } as RouteContext);
  return { app, mock };
}

function logRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    client_ip: '10.0.0.5',
    method: 'tools/call',
    name: 'memory_search',
    success: 1,
    error_code: null,
    error_message: null,
    created_at: '2026-07-28T10:00:00.000Z',
    engine: 'codex',
    ...overrides,
  };
}

describe('GET /admin/mcp/logs', () => {
  it('resolves host_fqdn for rows bound to a host and leaves unmatched rows null', async () => {
    const { app, mock } = await buildApp();
    mock.insertRow('hosts', { id: 4, fqdn: 'crane.alpha-labs.net' });
    mock.insertRow('mcp_access_logs', logRow({ id: 1, host_id: 4 }));
    mock.insertRow('mcp_access_logs', logRow({ id: 2, host_id: null }));
    // Host row deleted since the log was written.
    mock.insertRow('mcp_access_logs', logRow({ id: 3, host_id: 99 }));

    const response = await app.inject({ method: 'GET', url: '/admin/mcp/logs' });

    expect(response.statusCode).toBe(200);
    const logs = JSON.parse(response.payload).logs as Array<Record<string, unknown>>;
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ id: 1, hostId: 4, host_fqdn: 'crane.alpha-labs.net' });
    expect(logs[1]).toMatchObject({ id: 2, hostId: null, host_fqdn: null });
    expect(logs[2]).toMatchObject({ id: 3, hostId: 99, host_fqdn: null });
    await app.close();
  });

  it('clamps the limit to 1..500', async () => {
    const { app, mock } = await buildApp();
    for (let id = 1; id <= 3; id++) {
      mock.insertRow('mcp_access_logs', logRow({ id, host_id: null }));
    }

    const clamped = await app.inject({ method: 'GET', url: '/admin/mcp/logs?limit=0' });
    expect(JSON.parse(clamped.payload).logs).toHaveLength(1);

    const capped = await app.inject({ method: 'GET', url: '/admin/mcp/logs?limit=9000' });
    expect(JSON.parse(capped.payload).logs).toHaveLength(3);
    await app.close();
  });
});
