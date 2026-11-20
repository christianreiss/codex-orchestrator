/**
 * API-HOST-01: `GET /admin/auto-update` reports the default every other
 * reader uses (`fleetAutoUpdateEnabled`): on while the fleet row is unset,
 * which is what the signed wrapper config always baked.
 */
import { describe, expect, it } from 'vitest';
import { versions } from '../../../src/db/schema.js';
import { registerAdminSettingsRoutes } from '../../../src/routes/admin/settings/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

async function buildApp() {
  const app = await buildRouteApp();
  const db = createDbFake();
  await registerAdminSettingsRoutes(app, { db: db as never, env: {} as never, keyring: {} as never } as RouteContext);
  return { app, db };
}

describe('fleet auto-update admin route', () => {
  it('reports on while the fleet row is unset and stores an explicit off', async () => {
    const { app, db } = await buildApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/admin/auto-update' })).json()).toMatchObject({ enabled: true });
      const off = await app.inject({ method: 'POST', url: '/admin/auto-update', payload: { enabled: false } });
      expect(off.statusCode).toBe(200);
      expect((db.tables.get(versions) ?? []).find((row) => row.name === 'auto_update_enabled')?.version).toBe('0');
      expect((await app.inject({ method: 'GET', url: '/admin/auto-update' })).json()).toMatchObject({ enabled: false });
    } finally {
      await app.close();
    }
  });
});
