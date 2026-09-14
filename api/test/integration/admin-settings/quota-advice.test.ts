import { describe, expect, it } from 'vitest';
import { versions } from '../../../src/db/schema.js';
import { registerAdminSettingsRoutes } from '../../../src/routes/admin/settings/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { DEFAULT_QUOTA_ADVICE } from '../../../src/services/quota-advice.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

async function build() {
  const app = await buildRouteApp();
  const db = createDbFake();
  await registerAdminSettingsRoutes(app, {
    db: db as never,
    env: {} as never,
    keyring: {} as never,
  } as RouteContext);
  return { app, db };
}
describe('/admin/quota-mode advice', () => {
  it('persists advice and preserves it when an older admin omits the new field', async () => {
    const { app } = await build();
    try {
      const initial = await app.inject({ method: 'GET', url: '/admin/quota-mode' });
      expect(initial.json()).toMatchObject({ advice: DEFAULT_QUOTA_ADVICE });
      const advice = { ...DEFAULT_QUOTA_ADVICE, mode: 'hint', max_age_minutes: 10, remember_day: false };
      const saved = await app.inject({
        method: 'POST',
        url: '/admin/quota-mode',
        payload: { hard_fail: false, limit_percent: 95, week_partition: 'off', advice },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ advice, week_partition: 'off' });
      await app.inject({ method: 'POST', url: '/admin/quota-mode', payload: { hard_fail: true } });
      const read = await app.inject({ method: 'GET', url: '/admin/quota-mode' });
      expect(read.json()).toMatchObject({ hard_fail: true, advice });
    } finally {
      await app.close();
    }
  });
  it('rejects malformed advice before changing existing quota enforcement', async () => {
    const { app, db } = await build();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/quota-mode',
        payload: {
          hard_fail: false,
          advice: { ...DEFAULT_QUOTA_ADVICE, min_pressure_gap: -1 },
        },
      });
      expect(res.statusCode).toBe(422);
      expect(db.tables.get(versions) ?? []).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
