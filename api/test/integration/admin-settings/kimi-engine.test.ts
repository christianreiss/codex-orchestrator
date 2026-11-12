import { afterEach, describe, expect, it } from 'vitest';
import { registerAdminKimiRoutes } from '../../../src/routes/admin/kimi/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { clientConfigDocuments, openaiApiKeys, versions } from '../../../src/db/schema.js';
import { createKimiModelsService } from '../../../src/services/kimi-models.js';
import type { Database } from '../../../src/db/client.js';
import type { FastifyInstance } from 'fastify';

const openApps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});
async function buildApp() {
  const app = await buildRouteApp();
  openApps.push(app);
  const db = createDbFake();
  await registerAdminKimiRoutes(app, {
    db: db as unknown as Database,
    keyring: testKeyring(),
    env: {} as never,
  } as RouteContext);
  return { app, db };
}

describe('Kimi engine administration', () => {
  it('issues only Kimi keys and exposes their safe metadata as the established array contract', async () => {
    const { app, db } = await buildApp();
    db.tables.set(openaiApiKeys, [
      { id: 99, engine: 'codex', keyEnc: 'other-secret', keyHash: 'other-hash', isActive: 1 },
    ]);
    const created = await app.inject({
      method: 'POST',
      url: '/admin/kimi/keys',
      payload: { name: 'Kimi integration' },
    });
    expect(created.statusCode).toBe(200);
    const { key, record } = created.json();
    expect(key).toMatch(/^sk-ckx-[a-f0-9]{64}$/);
    expect(record).toMatchObject({ name: 'Kimi integration', engine: 'kimi', is_active: true });
    const listed = (await app.inject({ method: 'GET', url: '/admin/kimi/keys' })).json().data;
    expect(listed).toEqual([expect.objectContaining({ id: record.id, engine: 'kimi' })]);
    expect(JSON.stringify(listed)).not.toMatch(/keyEnc|keyHash|other-secret/);
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/admin/kimi/keys/${record.id}/toggle`,
          payload: { active: false },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/kimi/keys' })).json().data[0].is_active).toBe(
      false,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/admin/kimi/keys/99/toggle', payload: { active: false } }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/admin/kimi/keys/99' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/admin/kimi/keys/${record.id}` })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: 'GET', url: '/admin/kimi/keys' })).json().data).toEqual([]);
    expect(db.tables.get(openaiApiKeys)?.[0]).toMatchObject({ id: 99, engine: 'codex', isActive: 1 });
  });

  it('validates Kimi key mutations without accepting malformed identifiers', async () => {
    const { app } = await buildApp();
    for (const payload of [{}, { name: ' ' }])
      expect((await app.inject({ method: 'POST', url: '/admin/kimi/keys', payload })).statusCode).toBe(422);
    expect((await app.inject({ method: 'DELETE', url: '/admin/kimi/keys/no-id' })).statusCode).toBe(422);
    expect(
      (await app.inject({ method: 'POST', url: '/admin/kimi/keys/1/toggle', payload: {} })).statusCode,
    ).toBe(422);
  });

  it('keeps the Kimi switch and model defaults separate from the other engines', async () => {
    const { app, db } = await buildApp();
    db.tables.set(versions, [
      { name: 'openai_api_disabled', version: '0' },
      { name: 'claude_api_disabled', version: '0' },
    ]);
    expect((await app.inject({ method: 'GET', url: '/admin/kimi/state' })).json().data).toEqual({
      disabled: true,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/admin/kimi/state', payload: { disabled: true } })).json()
        .data,
    ).toEqual({ disabled: true });
    expect((await app.inject({ method: 'GET', url: '/admin/kimi/settings' })).json().data).toEqual({
      default_model: 'k3.1-pro',
      disabled: true,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/kimi/settings',
          payload: { default_model: 'k3-256k', disabled: false },
        })
      ).json().data,
    ).toEqual({ default_model: 'k3-256k', disabled: false });
    expect(await createKimiModelsService(db as unknown as Database).resolveRequestedModel(undefined)).toBe(
      'k3-256k',
    );
    expect(
      db.tables
        .get(versions)
        ?.filter((row) => row.name === 'openai_api_disabled' || row.name === 'claude_api_disabled'),
    ).toEqual([
      { name: 'openai_api_disabled', version: '0' },
      { name: 'claude_api_disabled', version: '0' },
    ]);
    expect(
      (await app.inject({ method: 'POST', url: '/admin/kimi/settings', payload: { max_tokens: 100 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/kimi/settings',
          payload: { default_model: 'kimi-4-latest' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: 'POST', url: '/admin/kimi/settings', payload: { disabled: 'invalid' } }))
        .statusCode,
    ).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/admin/kimi/state', payload: {} })).statusCode).toBe(
      422,
    );
  });

  it('lists native models and enforces catalog switches when resolving gateway requests', async () => {
    const { app, db } = await buildApp();
    const service = createKimiModelsService(db as unknown as Database);
    expect(service.supportedModels()).toEqual([
      'k3.1-pro',
      'k3.1-pro-highspeed',
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    expect((await app.inject({ method: 'GET', url: '/admin/kimi/models' })).json().data).toEqual({
      models: [
        { id: 'k3.1-pro', enabled: true, ownedBy: 'moonshotai' },
        { id: 'k3.1-pro-highspeed', enabled: true, ownedBy: 'moonshotai' },
        { id: 'k3', enabled: true, ownedBy: 'moonshotai' },
        { id: 'k3-256k', enabled: true, ownedBy: 'moonshotai' },
        { id: 'kimi-for-coding', enabled: true, ownedBy: 'moonshotai' },
        { id: 'kimi-for-coding-highspeed', enabled: true, ownedBy: 'moonshotai' },
      ],
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/kimi/models/k3-256k/toggle',
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    await expect(service.resolveRequestedModel('k3-256k')).rejects.toMatchObject({ code: 'model_disabled' });
    expect((await service.modelsResponse()).data.map((model) => model.id)).toEqual([
      'k3.1-pro',
      'k3.1-pro-highspeed',
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    await expect(service.resolveRequestedModel('kimi-api-model')).rejects.toMatchObject({
      code: 'model_not_found',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/kimi/models/kimi-api-model/toggle',
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: 'POST', url: '/admin/kimi/models/k3/toggle', payload: {} })).statusCode,
    ).toBe(422);
    // The in-memory fake does not enforce MySQL upsert uniqueness; inspect the
    // real enabled path's write and retain a single persisted setting row.
    await service.setEnabled('k3-256k', true);
    expect(db.inserts.at(-1)?.values).toMatchObject({ name: 'kimi_models_disabled', version: '' });
  });

  it('renders and persists Kimi TOML independently and returns it through both read surfaces', async () => {
    const { app, db } = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/admin/kimi/config' })).json()).toMatchObject({
      status: 'missing',
    });
    const rendered = (
      await app.inject({
        method: 'POST',
        url: '/admin/kimi/config/render',
        payload: { settings: { model: 'k3-256k', reasoning_effort: 'low' } },
      })
    ).json();
    expect(rendered.content).toContain('default_model = "kimi-code/k3-256k"');
    const stored = await app.inject({
      method: 'POST',
      url: '/admin/kimi/config/store',
      payload: { settings: { model: 'k3-256k', reasoning_effort: 'low' }, sha256: rendered.sha256 },
    });
    expect(stored.statusCode).toBe(200);
    expect(db.tables.get(clientConfigDocuments)?.[0]).toMatchObject({ engine: 'kimi' });
    for (const url of ['/admin/kimi/config', '/admin/kimi/config/retrieve'])
      expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({
        status: 'ok',
        sha256: rendered.sha256,
        content: rendered.content,
      });
  });
});
