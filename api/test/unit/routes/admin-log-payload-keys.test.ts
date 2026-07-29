/**
 * The two log views read snake_case row keys (`host_id`, `client_ip`,
 * `created_at`, …) while the routes emitted Drizzle's camelCase column keys, so
 * the Host column always read "System", the time column "—", and the host /
 * time-window filters silently misbehaved. Both sides stayed green because the
 * api spec asserted the camelCase key and the frontend spec fed itself
 * snake_case fixtures — neither ever saw the other's payload.
 *
 * So this reads the field names out of `frontend/src/lib/api/types.ts` (rather
 * than restating them, which would drift the same way) and checks them against
 * what the injected routes actually emit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAdminConfigRoutes } from '../../../src/routes/admin/config/index.js';
import { registerAdminOverviewRoutes } from '../../../src/routes/admin/overview/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createMockDb } from '../../helpers/in-memory-db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES_FILE = resolve(HERE, '../../../..', 'frontend/src/lib/api/types.ts');

/**
 * Declared by `McpAccessLogRow` but backed by no `mcp_access_logs` column: the
 * expanded row renders `row.params ?? null`, so there is nothing to emit.
 */
const RENDER_ONLY_FIELDS = new Set(['params']);

/** Field names of `export interface <name>` in frontend/src/lib/api/types.ts. */
function declaredFields(interfaceName: string): string[] {
  const source = readFileSync(TYPES_FILE, 'utf8');
  const start = source.indexOf(`export interface ${interfaceName} {`);
  expect(start, `${interfaceName} not found in ${TYPES_FILE}`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('\n}', start));
  const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
  expect(fields.length, `${interfaceName} declares no fields`).toBeGreaterThan(0);
  return fields;
}

function expectRowMatchesInterface(row: Record<string, unknown>, interfaceName: string): void {
  const declared = declaredFields(interfaceName);
  const keys = Object.keys(row);
  for (const field of declared) {
    if (RENDER_ONLY_FIELDS.has(field)) continue;
    expect(keys, `${interfaceName}.${field} is missing from the payload`).toContain(field);
  }
  // A camelCase key is the exact bug this guards; an undeclared one is the same
  // drift seen from the other side.
  expect(keys.filter((k) => /[A-Z]/.test(k))).toEqual([]);
  expect(keys.filter((k) => !declared.includes(k))).toEqual([]);
}

async function logsOf(url: string): Promise<Array<Record<string, unknown>>> {
  const app = await buildRouteApp();
  const mock = createMockDb();
  const ctx = { db: mock.db, env: {} as never, keyring: {} as never } as RouteContext;
  await registerAdminConfigRoutes(app, ctx);
  await registerAdminOverviewRoutes(app, ctx);
  mock.insertRow('hosts', { id: 4, fqdn: 'crane.alpha-labs.net' });
  mock.insertRow('mcp_access_logs', {
    id: 1,
    host_id: 4,
    client_ip: '10.0.0.5',
    method: 'tools/call',
    name: 'memory_search',
    success: 1,
    error_code: 429,
    error_message: 'rate limited',
    created_at: '2026-07-28T10:00:00.000Z',
    engine: 'codex',
  });
  mock.insertRow('logs', {
    id: 1,
    host_id: 4,
    action: 'admin.host.insecure_disable',
    details: '{"fqdn":"crane.alpha-labs.net"}',
    created_at: '2026-07-28T10:00:00.000Z',
    engine: 'codex',
  });

  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode).toBe(200);
  const logs = JSON.parse(response.payload).logs as Array<Record<string, unknown>>;
  await app.close();
  return logs;
}

describe('admin log payload keys', () => {
  it('GET /admin/mcp/logs emits every McpAccessLogRow field', async () => {
    const [row] = await logsOf('/admin/mcp/logs');

    expect(row).toBeDefined();
    expectRowMatchesInterface(row!, 'McpAccessLogRow');
    expect(row).toMatchObject({
      host_id: 4,
      host_fqdn: 'crane.alpha-labs.net',
      client_ip: '10.0.0.5',
      error_code: 429,
      error_message: 'rate limited',
      created_at: '2026-07-28T10:00:00.000Z',
    });
  });

  it('GET /admin/logs emits every AdminAuditLogRow field', async () => {
    const [row] = await logsOf('/admin/logs');

    expect(row).toBeDefined();
    expectRowMatchesInterface(row!, 'AdminAuditLogRow');
    expect(row).toMatchObject({
      host_id: 4,
      action: 'admin.host.insecure_disable',
      details: '{"fqdn":"crane.alpha-labs.net"}',
      created_at: '2026-07-28T10:00:00.000Z',
    });
  });
});
