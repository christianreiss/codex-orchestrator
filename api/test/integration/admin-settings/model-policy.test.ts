import { describe, it, expect } from 'vitest';
import { registerAdminSettingsRoutes } from '../../../src/routes/admin/settings/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { versions, logs } from '../../../src/db/schema.js';
describe('/admin/model-policy/:engine', () => {
  it('persists independent switches, validates inputs, and records the change', async () => {
    const app = await buildRouteApp();
    const db = createDbFake();
    await registerAdminSettingsRoutes(app, { db, env: {}, keyring: {} } as unknown as RouteContext);
    try {
      for (const engine of ['codex', 'claude', 'grok']) {
        const initial = await app.inject({ url: `/admin/model-policy/${engine}` });
        expect(initial.statusCode).toBe(200);
        expect(initial.json()).toMatchObject({ engine, latest_only: false });
        const saved = await app.inject({ method: 'PUT', url: `/admin/model-policy/${engine}`, payload: { latest_only: true } });
        expect(saved.statusCode).toBe(200);
        expect(saved.json()).toMatchObject({ engine, latest_only: true });
      }
      expect(db.tables.get(versions)?.filter(row => row.name?.toString().endsWith('_models_latest_only'))).toHaveLength(3);
      expect(db.inserts.some(entry => entry.table === logs)).toBe(true);
      const invalid = await app.inject({ method: 'PUT', url: '/admin/model-policy/codex', payload: { latest_only: 'true' } });
      expect(invalid.statusCode).toBe(422);
      const off = await app.inject({ method: 'PUT', url: '/admin/model-policy/codex', payload: { latest_only: false } });
      expect(off.json()).toMatchObject({ latest_only: false });
      const other = await app.inject({ url: '/admin/model-policy/claude' });
      expect(other.json()).toMatchObject({ latest_only: true });
    } finally { await app.close(); }
  });
});
