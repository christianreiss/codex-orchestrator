import { describe, expect, it } from 'vitest';
import { logs, versions } from '../../../src/db/schema.js';
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
type Model = { engine: string; id: string; default_tier: number; tier: number };
const find = (payload: string, id: string) => (JSON.parse(payload).models as Model[]).find((m) => m.id === id)!;

describe('/admin/model-tiers', () => {
  it('lists the registry tiers, stores only deviations and audits each move', async () => {
    const { app, db } = await buildApp();
    const initial = await app.inject({ method: 'GET', url: '/admin/model-tiers' });
    expect(initial.statusCode).toBe(200);
    const body = JSON.parse(initial.payload);
    expect(body.levels.map((l: { tier: number }) => l.tier)).toEqual([1, 2, 3, 4, 5]);
    expect(body.updated_at).toBeNull();
    expect(find(initial.payload, 'claude-sonnet-5-5')).toMatchObject({ default_tier: 3, tier: 3 });

    // The console sends every model it shows; unchanged ones are dropped server-side.
    const saved = await app.inject({ method: 'POST', url: '/admin/model-tiers', payload: { tiers: { claude: { 'claude-sonnet-5-5': 4, 'claude-opus-5-5': 4 } } } });
    expect(saved.statusCode).toBe(200);
    expect(find(saved.payload, 'claude-sonnet-5-5')).toMatchObject({ default_tier: 3, tier: 4 });
    expect(db.tables.get(versions)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'model_tier_overrides', version: '{"claude":{"claude-sonnet-5-5":4}}' }),
    ]));
    expect(db.inserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: logs, values: expect.objectContaining({
        action: 'admin.model_tiers',
        details: JSON.stringify({ changes: [{ engine: 'claude', model: 'claude-sonnet-5-5', from: 3, to: 4 }] }),
      }) }),
    ]));

    // Back to the defaults: the key is removed and the move back is audited.
    const reset = await app.inject({ method: 'POST', url: '/admin/model-tiers', payload: { tiers: {} } });
    expect(reset.statusCode).toBe(200);
    expect(find(reset.payload, 'claude-sonnet-5-5')).toMatchObject({ tier: 3 });
    expect((db.tables.get(versions) ?? []).some((row) => row['name'] === 'model_tier_overrides')).toBe(false);
    await app.close();
  });

  it('rejects unknown engines, models and tiers without storing anything', async () => {
    const { app, db } = await buildApp();
    for (const tiers of [undefined, [], { mystery: {} }, { claude: { 'claude-nope': 2 } }, { claude: { 'claude-opus-5-5': 0 } }]) {
      const response = await app.inject({ method: 'POST', url: '/admin/model-tiers', payload: { tiers } });
      expect(response.statusCode, JSON.stringify(tiers)).toBe(422);
    }
    expect((db.tables.get(versions) ?? []).some((row) => row['name'] === 'model_tier_overrides')).toBe(false);
    await app.close();
  });
});
