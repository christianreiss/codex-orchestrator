import { afterEach, describe, expect, it } from 'vitest';
import { registerAdminGrokRoutes } from '../../../src/routes/admin/grok/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { clientConfigDocuments, openaiApiKeys, versions } from '../../../src/db/schema.js';
import { createGrokModelsService } from '../../../src/services/grok-models.js';
import type { Database } from '../../../src/db/client.js';
import type { FastifyInstance } from 'fastify';

const openApps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(openApps.splice(0).map(app => app.close())); });
async function buildApp() {
  const app = await buildRouteApp();
  openApps.push(app);
  const db = createDbFake();
  await registerAdminGrokRoutes(app, { db: db as unknown as Database, keyring: testKeyring(), env: {} as never } as RouteContext);
  return { app, db };
}

describe('Grok engine administration', () => {
  it('issues only Grok keys and exposes their safe metadata as the established array contract', async () => {
    const { app, db } = await buildApp();
    db.tables.set(openaiApiKeys, [{ id: 99, engine: 'codex', keyEnc: 'other-secret', keyHash: 'other-hash', isActive: 1 }]);
    const created = await app.inject({ method: 'POST', url: '/admin/grok/keys', payload: { name: 'Grok integration' } });
    expect(created.statusCode).toBe(200);
    const { key, record } = created.json();
    expect(key).toMatch(/^sk-cgx-[a-f0-9]{64}$/);
    expect(record).toMatchObject({ name: 'Grok integration', engine: 'grok', is_active: true });
    const listed = (await app.inject({ method: 'GET', url: '/admin/grok/keys' })).json().data;
    expect(listed).toEqual([expect.objectContaining({ id: record.id, engine: 'grok' })]);
    expect(JSON.stringify(listed)).not.toMatch(/keyEnc|keyHash|other-secret/);
    expect(JSON.stringify(listed)).not.toContain(key);
    expect((await app.inject({ method: 'POST', url: `/admin/grok/keys/${record.id}/toggle`, payload: { active: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/grok/keys' })).json().data[0].is_active).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/admin/grok/keys/99/toggle', payload: { active: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/admin/grok/keys/99' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/admin/grok/keys/${record.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/grok/keys' })).json().data).toEqual([]);
    expect(db.tables.get(openaiApiKeys)?.[0]).toMatchObject({ id: 99, engine: 'codex', isActive: 1 });
  });

  it('validates Grok key mutations without accepting malformed identifiers', async () => {
    const { app } = await buildApp();
    for (const payload of [{}, { name: ' ' }]) expect((await app.inject({ method: 'POST', url: '/admin/grok/keys', payload })).statusCode).toBe(422);
    expect((await app.inject({ method: 'DELETE', url: '/admin/grok/keys/no-id' })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/admin/grok/keys/1/toggle', payload: {} })).statusCode).toBe(422);
  });

  it('keeps the Grok switch and model defaults separate from the other engines', async () => {
    const { app, db } = await buildApp();
    db.tables.set(versions, [{ name: 'openai_api_disabled', version: '0' }, { name: 'claude_api_disabled', version: '0' }]);
    expect((await app.inject({ method: 'GET', url: '/admin/grok/state' })).json().data).toEqual({ disabled: false });
    expect((await app.inject({ method: 'POST', url: '/admin/grok/state', payload: { disabled: true } })).json().data).toEqual({ disabled: true });
    expect((await app.inject({ method: 'GET', url: '/admin/grok/settings' })).json().data).toEqual({ default_model: 'grok-4.6', disabled: true });
    expect((await app.inject({ method: 'POST', url: '/admin/grok/settings', payload: { default_model: 'grok-4.5', disabled: false } })).json().data).toEqual({ default_model: 'grok-4.5', disabled: false });
    expect(await createGrokModelsService(db as unknown as Database).resolveRequestedModel(undefined)).toBe('grok-4.5');
    expect(db.tables.get(versions)?.filter(row => row.name === 'openai_api_disabled' || row.name === 'claude_api_disabled')).toEqual([{ name: 'openai_api_disabled', version: '0' }, { name: 'claude_api_disabled', version: '0' }]);
    expect((await app.inject({ method: 'POST', url: '/admin/grok/settings', payload: { max_tokens: 100 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/grok/settings', payload: { default_model: 'grok-4-latest' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/admin/grok/settings', payload: { disabled: 'invalid' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/admin/grok/state', payload: {} })).statusCode).toBe(422);
  });

  it('lists native models and enforces catalog switches when resolving gateway requests', async () => {
    const { app, db } = await buildApp();
    const service = createGrokModelsService(db as unknown as Database);
    expect(service.supportedModels()).toEqual(['grok-4.6', 'grok-4.5']);
    expect((await app.inject({ method: 'GET', url: '/admin/grok/models' })).json().data).toEqual({ models: [{ id: 'grok-4.6', enabled: true, ownedBy: 'xai' }, { id: 'grok-4.5', enabled: true, ownedBy: 'xai' }] });
    expect((await app.inject({ method: 'POST', url: '/admin/grok/models/grok-4.5/toggle', payload: { enabled: false } })).statusCode).toBe(200);
    await expect(service.resolveRequestedModel('grok-4.5')).rejects.toMatchObject({ code: 'model_disabled' });
    expect((await service.modelsResponse()).data.map(model => model.id)).toEqual(['grok-4.6']);
    await expect(service.resolveRequestedModel('grok-api-model')).rejects.toMatchObject({ code: 'model_not_found' });
    expect((await app.inject({ method: 'POST', url: '/admin/grok/models/grok-api-model/toggle', payload: { enabled: true } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/admin/grok/models/grok-4.6/toggle', payload: {} })).statusCode).toBe(422);
    // The in-memory fake does not enforce MySQL upsert uniqueness; inspect the
    // real enabled path's write and retain a single persisted setting row.
    await service.setEnabled('grok-4.5', true);
    expect(db.inserts.at(-1)?.values).toMatchObject({ name: 'grok_models_disabled', version: '' });
  });

  it('renders and persists Grok TOML independently and returns it through both read surfaces', async () => {
    const { app, db } = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/admin/grok/config' })).json()).toMatchObject({ status: 'missing' });
    const rendered = (await app.inject({ method: 'POST', url: '/admin/grok/config/render', payload: { settings: { model: 'grok-4.5', reasoning_effort: 'low' } } })).json();
    expect(rendered.content).toContain('[models]\ndefault = "grok-4.5"\ndefault_reasoning_effort = "low"');
    const stored = await app.inject({ method: 'POST', url: '/admin/grok/config/store', payload: { settings: { model: 'grok-4.5', reasoning_effort: 'low' }, sha256: rendered.sha256 } });
    expect(stored.statusCode).toBe(200);
    expect(db.tables.get(clientConfigDocuments)?.[0]).toMatchObject({ engine: 'grok' });
    for (const url of ['/admin/grok/config', '/admin/grok/config/retrieve']) expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({ status: 'ok', sha256: rendered.sha256, content: rendered.content });
  });
});
