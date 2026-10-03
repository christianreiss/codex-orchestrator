import { describe, expect, it } from 'vitest';
import { logs, openaiApiKeys, versions } from '../../../src/db/schema.js';
import { registerAdminSettingsRoutes } from '../../../src/routes/admin/settings/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

async function buildApp(seed: Map<unknown, Array<Record<string, unknown>>> = new Map()) {
  const app = await buildRouteApp();
  const db = createDbFake(seed);
  await registerAdminSettingsRoutes(app, { db: db as never, env: {} as never, keyring: {} as never } as RouteContext);
  return { app, db };
}

describe('/admin/api/surfaces', () => {
  it('lists every exposed API on its identity backend by default, with active key counts', async () => {
    const { app } = await buildApp(new Map([[openaiApiKeys, [
      { id: 1, engine: 'codex', isActive: 1 },
      { id: 2, engine: 'codex', isActive: 0 },
      { id: 3, engine: 'claude', isActive: 1 },
    ]]]));
    const reply = await app.inject({ method: 'GET', url: '/admin/api/surfaces' });
    expect(reply.statusCode).toBe(200);
    const body = JSON.parse(reply.payload);
    expect(body.surfaces).toEqual([
      { surface: 'openai', label: 'OpenAI-compatible', base_path: '/v1', wire: 'openai', backend: 'codex', identity_backend: 'codex', disabled: false, key_count: 1 },
      { surface: 'anthropic', label: 'Anthropic-compatible', base_path: '/anthropic/v1', wire: 'anthropic', backend: 'claude', identity_backend: 'claude', disabled: false, key_count: 1 },
      { surface: 'grok', label: 'Grok (OpenAI-compatible)', base_path: '/grok/v1', wire: 'openai', backend: 'grok', identity_backend: 'grok', disabled: false, key_count: 0 },
    ]);
    expect(body.backends.map((b: { engine: string }) => b.engine)).toEqual(['codex', 'claude', 'grok']);
    await app.close();
  });

  it('switches a backend and the surface kill switch, with audit events', async () => {
    const { app, db } = await buildApp();
    const reply = await app.inject({ method: 'POST', url: '/admin/api/surfaces/anthropic', payload: { backend: 'codex', disabled: true } });
    expect(reply.statusCode).toBe(200);
    expect(JSON.parse(reply.payload)).toMatchObject({ surface: 'anthropic', backend: 'codex', disabled: true });
    expect(db.tables.get(versions)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'api_surface_backend_anthropic', version: 'codex' }),
      expect.objectContaining({ name: 'claude_api_disabled', version: '1' }),
    ]));
    const actions = db.inserts.filter((i) => i.table === logs).map((i) => (i.values as { action: string; details: string }));
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'admin.api.surface_backend', details: JSON.stringify({ surface: 'anthropic', backend: 'codex', previous: 'claude' }) }),
      expect.objectContaining({ action: 'admin.claude_api.state', details: JSON.stringify({ disabled: true }) }),
    ]));
    await app.close();
  });

  it('rejects unknown surfaces, unknown engines and empty updates', async () => {
    const { app } = await buildApp();
    for (const [url, payload] of [
      ['/admin/api/surfaces/claude', { backend: 'codex' }],
      ['/admin/api/surfaces/openai', { backend: 'gemini' }],
      ['/admin/api/surfaces/openai', { disabled: 'sometimes' }],
      ['/admin/api/surfaces/openai', {}],
    ] as const) {
      const reply = await app.inject({ method: 'POST', url, payload });
      expect(reply.statusCode).toBe(422);
    }
    await app.close();
  });
});
