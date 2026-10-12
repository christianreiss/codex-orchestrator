import { describe, expect, it } from 'vitest';
import { registerAdminConfigRoutes } from '../../../src/routes/admin/config/index.js';
import { registerAdminGrokRoutes } from '../../../src/routes/admin/grok/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

describe('admin config revision HTTP contract', () => {
  it.each(['/admin/config', '/admin/claude/config', '/admin/grok/config'])('%s exposes revisions and returns actionable 409 conflicts', async base => {
    const app = await buildRouteApp();
    const context = { db: createDbFake(), env: {}, keyring: {} } as unknown as RouteContext;
    await registerAdminConfigRoutes(app, context);
    await registerAdminGrokRoutes(app, context);
    try {
      const missing = await app.inject({ method: 'GET', url: base });
      expect(missing.json()).toMatchObject({ status: 'missing', revision: null });
      const saved = await app.inject({ method: 'POST', url: `${base}/store`, payload: { settings: {}, expected_revision: null } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ revision: '1', change: 'created' });
      const conflict = await app.inject({ method: 'POST', url: `${base}/store`, payload: { settings: {}, expected_revision: null } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: 'config_revision_conflict', current_revision: '1', expected_revision: null });
      expect(conflict.json().message).toContain('reload');
      const unchanged = await app.inject({ method: 'POST', url: `${base}/store`, payload: { settings: {}, expected_revision: '1' } });
      expect(unchanged.statusCode).toBe(200);
      expect(unchanged.json()).toMatchObject({ revision: '1', change: 'unchanged' });
    } finally {
      await app.close();
    }
  });
});
