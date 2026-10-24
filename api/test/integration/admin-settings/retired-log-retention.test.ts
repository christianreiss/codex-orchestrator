import { describe, it, expect } from 'vitest';
import { registerAdminSettingsRoutes } from '../../../src/routes/admin/settings/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { versions } from '../../../src/db/schema.js';

describe('retired log retention compatibility', () => {
  it('ignores old durations and never persists a fake enabled policy', async () => {
    const app = await buildRouteApp();
    const db = createDbFake();
    db.tables.set(versions, [{ name: 'log_retention_enabled', version: '1' }]);
    await registerAdminSettingsRoutes(app, { db: db as never, env: {} as never, keyring: {} as never });
    try {
      for (const method of ['GET', 'POST'] as const) {
        const reply = await app.inject({ method, url: '/admin/log-retention',
          ...(method === 'POST' ? { payload: { enabled: true, days_logs: 1, days_mcp: 1 } } : {}) });
        expect(reply.statusCode).toBe(200);
        expect(reply.json()).toMatchObject({ data: { enabled: false, supported: false, reason: 'retired_no_worker' } });
      }
      expect(db.inserts).toEqual([]);
      expect(db.updates).toEqual([]);
      expect(db.deletes).toEqual([]);
    } finally { await app.close(); }
  });
});
