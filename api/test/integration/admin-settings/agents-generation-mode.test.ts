import { describe, expect, it } from 'vitest';
import { logs, versions } from '../../../src/db/schema.js';
import { registerAdminSettingsRoutes } from '../../../src/routes/admin/settings/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

async function buildApp() {
  const app = await buildRouteApp();
  const db = createDbFake();
  await registerAdminSettingsRoutes(app, {
    db: db as never,
    env: {} as never,
    keyring: {} as never,
  } as RouteContext);
  return { app, db };
}

describe('/admin/agents-generation-mode', () => {
  it('defaults to managed, persists a mode, and records the audit event', async () => {
    const { app, db } = await buildApp();

    const initial = await app.inject({ method: 'GET', url: '/admin/agents-generation-mode' });
    expect(initial.statusCode).toBe(200);
    expect(JSON.parse(initial.payload)).toMatchObject({
      status: 'ok',
      mode: 'managed',
      modes: ['managed', 'manual', 'off'],
    });

    const saved = await app.inject({
      method: 'POST',
      url: '/admin/agents-generation-mode',
      payload: { mode: 'off' },
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(saved.payload)).toMatchObject({ status: 'ok', mode: 'off' });
    expect(db.tables.get(versions)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'agents_generation_mode', version: 'off' }),
    ]));
    expect(db.inserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: logs,
        values: expect.objectContaining({
          action: 'admin.agents_generation_mode',
          details: JSON.stringify({ mode: 'off' }),
        }),
      }),
    ]));

    const current = await app.inject({ method: 'GET', url: '/admin/agents-generation-mode' });
    expect(JSON.parse(current.payload)).toMatchObject({ status: 'ok', mode: 'off' });
    await app.close();
  });

  // Strict on the way in: a typo that fell through to the default would reset
  // the fleet to `managed` without saying so.
  it('rejects a missing or unknown mode', async () => {
    const { app } = await buildApp();
    for (const payload of [{}, { mode: 'disabled' }, { mode: true }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/agents-generation-mode',
        payload,
      });
      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.payload)).toMatchObject({
        status: 'error',
        code: 'validation_failed',
      });
    }
    await app.close();
  });

  // Lenient on the way out: a row this build does not recognise must read as
  // today's behaviour, not as "stop generating" for every host at once.
  it('reads an unrecognised stored value as managed', async () => {
    const { app, db } = await buildApp();
    db.tables.set(versions, [{ id: 1, name: 'agents_generation_mode', version: 'a-later-mode' }]);

    const response = await app.inject({ method: 'GET', url: '/admin/agents-generation-mode' });

    expect(JSON.parse(response.payload)).toMatchObject({ status: 'ok', mode: 'managed' });
    await app.close();
  });
});
