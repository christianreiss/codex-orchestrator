import { describe, expect, it } from 'vitest';
import { registerAdminKimiRoutes } from '../../../src/routes/admin/kimi/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';

describe('Kimi native settings HTTP contract', () => {
  it('validates render/store, preserves supported JSON and enforces revisions through edits and removal', async () => {
    const app = await buildRouteApp();
    const db = createDbFake();
    await registerAdminKimiRoutes(app, { db, env: {}, keyring: {} } as unknown as RouteContext);
    try {
      for (const native of [{ default_plan_mode: 'yes' }, { thinking: { enabled: 'yes' } },
        { loop_control: { max_attempts_per_step: -1 } }, { hooks: [{ event: 'NotReal', command: 'echo ok', timeout: 0 }] },
        { secondary_model: { force: true } }, { model_catalog: { unknown: true } },
      ]) for (const action of ['render', 'store']) {
        const response = await app.inject({ method: 'POST', url: `/admin/kimi/config/${action}`, payload: { settings: { native_settings: native }, expected_revision: null } });
        expect(response.statusCode).toBe(422);
        expect(response.body).toContain('native_settings');
      }
      expect((await app.inject({ method: 'GET', url: '/admin/kimi/config' })).json().status).toBe('missing');
      const native = { model_catalog: { refresh_on_start: false }, providers: { 'my.provider': { type: 'openai', custom_headers: { 'X.Literal': 'yes' } } } };
      const saved = await app.inject({ method: 'POST', url: '/admin/kimi/config/store', payload: { settings: { native_settings: native }, expected_revision: null } });
      expect(saved.statusCode).toBe(200);
      const revision = saved.json().revision;
      // The lightweight fake ignores ORDER BY; emulate the route's latest-id query.
      const latestFirst = () => db.tables.get(clientConfigDocuments)?.sort((a, b) => Number(b.id) - Number(a.id));
      const fetched = (await app.inject({ method: 'GET', url: '/admin/kimi/config' })).json();
      expect(fetched.settings.native_settings).toEqual(native);
      expect(fetched.sha256).toBe(saved.json().sha256);
      const changed = await app.inject({ method: 'POST', url: '/admin/kimi/config/store', payload: { settings: { native_settings: { model_catalog: { refresh_on_start: true } } }, expected_revision: revision } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().revision).not.toBe(revision);
      latestFirst();
      expect((await app.inject({ method: 'POST', url: '/admin/kimi/config/store', payload: { settings: {}, expected_revision: revision } })).statusCode).toBe(409);
      const removed = await app.inject({ method: 'POST', url: '/admin/kimi/config/store', payload: { settings: {}, expected_revision: changed.json().revision } });
      expect(removed.statusCode).toBe(200);
      latestFirst();
      expect((await app.inject({ method: 'GET', url: '/admin/kimi/config' })).json().settings.native_settings).toBeUndefined();
    } finally { await app.close(); }
  });
  it('heals known stored keys without changing historical body/hash and returns unknown data for correction', async () => {
    const app = await buildRouteApp();
    const db = createDbFake();
    await registerAdminKimiRoutes(app, { db, env: {}, keyring: {} } as unknown as RouteContext);
    try {
      const row = { id: 1, engine: 'kimi', settings: { native_settings: { loop_control: { max_retries_per_step: 3 }, secondary_model: { force: true } } }, body: 'historical TOML', sha256: 'historical SHA', updatedAt: '2026-11-17T00:00:00Z' };
      db.tables.set(clientConfigDocuments, [row]);
      const healed = (await app.inject({ method: 'GET', url: '/admin/kimi/config' })).json();
      expect(healed).toMatchObject({ content: row.body, sha256: row.sha256, settings: { native_settings: { loop_control: { max_attempts_per_step: 3 }, secondary_model: {} } } });
      expect(row.settings.native_settings.loop_control).toEqual({ max_retries_per_step: 3 });
      row.settings = { native_settings: { unknown: 'preserve me' } } as never;
      const invalid = (await app.inject({ method: 'GET', url: '/admin/kimi/config' })).json();
      expect(invalid).toMatchObject({ content: row.body, sha256: row.sha256, validation_error: { code: 'validation_failed' }, settings: row.settings });
    } finally { await app.close(); }
  });
});
