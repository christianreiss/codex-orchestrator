import { describe, expect, it } from 'vitest';
import { clientConfigDocuments } from '../../../src/db/schema.js';
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

describe('/admin/model-defaults/:engine', () => {
  it('returns the strict Codex response contract', async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/admin/model-defaults/codex',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({
      status: 'ok',
      engine: 'codex',
      model: 'gpt-5.6-terra',
      reasoning_effort: 'high',
      catalog: expect.arrayContaining([
        {
          model: 'gpt-5.6-terra',
          persistent_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          default_effort: 'high',
        },
      ]),
    });
    await app.close();
  });

  it('stores Claude defaults with a server-side merge and returns the saved state', async () => {
    const { app, db } = await buildApp();
    db.tables.set(clientConfigDocuments, [
      {
        id: 1,
        engine: 'claude',
        sha256: 'b'.repeat(64),
        body: '{}\n',
        settings: {
          model: 'claude-sonnet-4-6',
          effortLevel: 'high',
          env: { PRESERVE_ME: 'yes' },
        },
        sourceHostId: null,
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/model-defaults/claude',
      headers: { 'content-type': 'application/json' },
      payload: {
        model: 'claude-opus-4-7',
        reasoning_effort: 'xhigh',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({
      status: 'ok',
      engine: 'claude',
      model: 'claude-opus-4-7',
      reasoning_effort: 'xhigh',
    });
    const rows = db.tables.get(clientConfigDocuments) ?? [];
    expect(rows.at(-1)?.settings).toMatchObject({
      model: 'claude-opus-4-7',
      effortLevel: 'xhigh',
      env: { PRESERVE_ME: 'yes' },
    });
    await app.close();
  });

  it('returns 422 for invalid engines and invalid model/effort combinations', async () => {
    const { app } = await buildApp();
    const badEngine = await app.inject({
      method: 'GET',
      url: '/admin/model-defaults/openai',
    });
    expect(badEngine.statusCode).toBe(422);
    expect(JSON.parse(badEngine.payload)).toMatchObject({
      status: 'error',
      code: 'validation_failed',
    });

    const badEffort = await app.inject({
      method: 'POST',
      url: '/admin/model-defaults/claude',
      headers: { 'content-type': 'application/json' },
      payload: {
        model: 'claude-haiku-4-5-20251001',
        reasoning_effort: 'high',
      },
    });
    expect(badEffort.statusCode).toBe(422);
    expect(JSON.parse(badEffort.payload)).toMatchObject({
      status: 'error',
      code: 'validation_failed',
    });
    await app.close();
  });
});
