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

describe('/admin/api-keys-in-chat', () => {
  it('defaults off, persists a toggle, and records the audit event', async () => {
    const { app, db } = await buildApp();

    const initial = await app.inject({ method: 'GET', url: '/admin/api-keys-in-chat' });
    expect(initial.statusCode).toBe(200);
    expect(JSON.parse(initial.payload)).toMatchObject({ status: 'ok', enabled: false });

    const saved = await app.inject({
      method: 'POST',
      url: '/admin/api-keys-in-chat',
      payload: { enabled: true },
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(saved.payload)).toMatchObject({ status: 'ok', enabled: true });
    expect(db.tables.get(versions)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'api_keys_in_chat_allowed', version: '1' }),
    ]));
    expect(db.inserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: logs,
        values: expect.objectContaining({
          action: 'admin.api_keys_in_chat',
          details: JSON.stringify({ enabled: true }),
        }),
      }),
    ]));

    const current = await app.inject({ method: 'GET', url: '/admin/api-keys-in-chat' });
    expect(JSON.parse(current.payload)).toMatchObject({ status: 'ok', enabled: true });
    await app.close();
  });

  it('rejects a missing or invalid enabled value', async () => {
    const { app } = await buildApp();
    for (const payload of [{}, { enabled: 'sometimes' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/api-keys-in-chat',
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
});
