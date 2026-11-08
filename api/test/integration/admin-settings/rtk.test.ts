import { describe, expect, it } from 'vitest';
import { hosts, logs, versions } from '../../../src/db/schema.js';
import { registerRtkRoutes } from '../../../src/routes/rtk.js';
import { validateRtkReport, resolveRtkPolicy } from '../../../src/services/rtk.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
async function build() {
  const app = await buildRouteApp();
  app.decorate('requireHost', async () => {});
  const db = createDbFake();
  db.tables.set(hosts, [
    { id: 32, engines: 'codex,claude,grok' },
    { id: 33, engines: 'codex' },
  ]);
  await registerRtkRoutes(app, { db, env: {}, keyring: {} } as unknown as RouteContext);
  return { app, db };
}
describe('RTK policy routes', () => {
  it('defaults off, resolves each engine independently, clears overrides and audits changes', async () => {
    const { app, db } = await build();
    try {
      const fleet = (await app.inject({ method: 'GET', url: '/admin/rtk' })).json();
      for (const engine of ['codex', 'claude', 'grok'])
        expect(fleet.engines[engine]).toMatchObject({
          enabled: false,
          fleet: false,
          override: null,
          source: 'fleet',
        });
      expect(
        (await app.inject({ method: 'POST', url: '/admin/rtk/grok', payload: { enabled: true } })).json(),
      ).toMatchObject({ enabled: true, source: 'fleet' });
      const host = (await app.inject({ method: 'GET', url: '/admin/hosts/32/rtk' })).json();
      expect(host.engines.grok).toMatchObject({ enabled: true, assigned: true, observation: null });
      expect(host.engines.codex.enabled).toBe(false);
      const disabled = await app.inject({
        method: 'POST',
        url: '/admin/hosts/32/rtk/grok',
        payload: { enabled: false },
      });
      expect(disabled.json()).toMatchObject({ enabled: false, override: false, source: 'host', fleet: true });
      const reset = await app.inject({
        method: 'POST',
        url: '/admin/hosts/32/rtk/grok',
        payload: { enabled: null },
      });
      expect(reset.json()).toMatchObject({ enabled: true, override: null, source: 'fleet' });
      expect(
        db.tables.get(versions)?.some((row) => row.name === 'rtk_grok_host_32' && row.version === ''),
      ).toBe(true);
      expect(db.inserts.filter((row) => row.table === logs)).toHaveLength(3);
    } finally {
      await app.close();
    }
  });
  it('rejects invalid hosts, engines, assignments and policy bodies', async () => {
    const { app } = await build();
    try {
      for (const payload of [
        {},
        { enabled: null },
        { enabled: 'true' },
        { enabled: true, command: 'secret' },
      ])
        expect((await app.inject({ method: 'POST', url: '/admin/rtk/codex', payload })).statusCode).toBe(422);
      expect(
        (await app.inject({ method: 'POST', url: '/admin/rtk/bad', payload: { enabled: true } })).statusCode,
      ).toBe(422);
      expect((await app.inject({ method: 'GET', url: '/admin/hosts/999/rtk' })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: 'POST', url: '/admin/hosts/33/rtk/grok', payload: { enabled: true } }))
          .statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it('changes revision for a same-value override and accepts metadata without command content', () => {
    expect(resolveRtkPolicy('true', null, 'now', null).policy_revision).not.toBe(
      resolveRtkPolicy('true', 'true', 'now', 'now').policy_revision,
    );
    const report = {
      engine: 'grok',
      adapter_mode: 'instructions',
      ready: true,
      wrapper_version: '0.9.169',
      native_version: '1.0.77',
      rtk_version: '1.2.0',
      policy_revision: 'a'.repeat(64),
    };
    expect(validateRtkReport(report, 'now')).toMatchObject({ ...report, observed_at: 'now' });
    for (const invalid of [
      { ...report, output: 'secret' },
      { ...report, adapter_mode: 'hook' },
      { ...report, native_version: '/tmp/key' },
      { ...report, error_code: 'secret text' },
      { ...report, policy_revision: 'token' },
    ])
      expect(() => validateRtkReport(invalid, 'now')).toThrow();
  });
});
