import { afterEach, describe, expect, it, vi } from 'vitest';
import { hosts, logs, versions } from '../../../src/db/schema.js';
import { registerAdminEngineRoutes } from '../../../src/routes/admin/engines/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { readFleetEngineState } from '../../../src/services/engine-switch.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

const host = (id: number, engines: string, status = 'active') => ({ id, fqdn: `h${id}.example`, engines, status, configVersion: 0 });

async function buildApp(seed: Map<unknown, Array<Record<string, unknown>>> = new Map()) {
  const app = await buildRouteApp();
  // The real admin plugin decorates req.admin; name the actor the same way.
  app.addHook('onRequest', async (req) => {
    (req as unknown as { admin: unknown }).admin = { user: { username: 'ops' } };
  });
  const db = createDbFake(seed);
  if (!db.tables.has(versions)) db.tables.set(versions, []);
  if (!db.tables.has(hosts)) db.tables.set(hosts, []);
  await registerAdminEngineRoutes(app, { db: db as never, env: {} as never, keyring: {} as never } as RouteContext);
  return { app, db };
}

afterEach(() => vi.restoreAllMocks());

describe('/admin/engines', () => {
  it('reports every engine enabled by default, with active hosts carrying each', async () => {
    const { app } = await buildApp(new Map([[hosts, [host(1, 'codex,claude'), host(2, 'claude'), host(3, 'grok', 'inactive')]]]));
    const reply = await app.inject({ method: 'GET', url: '/admin/engines/state' });
    expect(reply.statusCode).toBe(200);
    const { engines } = JSON.parse(reply.payload);
    expect(engines).toEqual([
      { engine: 'codex', label: 'Codex', enabled: true, updated_at: null, updated_by: null, assigned_hosts: 1 },
      { engine: 'claude', label: 'Claude', enabled: true, updated_at: null, updated_by: null, assigned_hosts: 2 },
      { engine: 'grok', label: 'Grok', enabled: true, updated_at: null, updated_by: null, assigned_hosts: 0 },
    ]);
    await app.close();
  });

  it('switches an engine off: flag row, config bump on every host, audit row, events', async () => {
    const publish = vi.spyOn(wsPublisher, 'publish');
    const { app, db } = await buildApp(new Map([[hosts, [host(1, 'codex,claude'), host(2, 'codex')]]]));
    const reply = await app.inject({ method: 'POST', url: '/admin/engines/claude/state', payload: { enabled: false } });
    expect(reply.statusCode).toBe(200);
    expect(JSON.parse(reply.payload)).toMatchObject({ engine: 'claude', enabled: false, previous: true, hosts_suspended: 1, updated_by: 'ops' });

    expect(db.tables.get(versions)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'claude_engine_disabled', version: '1' }),
    ]));
    // One unconditional configVersion bump: every host re-bakes its signed config.
    const bumps = db.updates.filter((u) => u.table === hosts && u.where === undefined && 'configVersion' in u.set);
    expect(bumps).toHaveLength(1);
    const audit = db.inserts.filter((i) => i.table === logs).map((i) => i.values as { action: string; details: string });
    expect(audit).toEqual([expect.objectContaining({ action: 'admin.engine.state' })]);
    expect(JSON.parse(audit[0]!.details)).toEqual({ engine: 'claude', enabled: false, previous: true, actor: 'ops', hosts_suspended: 1 });
    expect(publish).toHaveBeenCalledWith('engine.state.changed', { engine: 'claude', enabled: false });
    expect(publish).toHaveBeenCalledWith('settings.changed', { key: 'claude_engine_disabled' });

    // The cache was invalidated by the write: readers see it at once.
    expect((await readFleetEngineState(db as never)).claude).toBe(false);
    await app.close();
  });

  it('is idempotent: repeating a state neither re-bakes hosts nor publishes', async () => {
    const publish = vi.spyOn(wsPublisher, 'publish');
    const { app, db } = await buildApp(new Map<unknown, Array<Record<string, unknown>>>([
      [hosts, [host(1, 'grok')]],
      [versions, [{ name: 'grok_engine_disabled', version: '1', updatedAt: '2026-10-01T00:00:00Z' }]],
    ]));
    const reply = await app.inject({ method: 'POST', url: '/admin/engines/grok/state', payload: { enabled: false } });
    expect(reply.statusCode).toBe(200);
    expect(JSON.parse(reply.payload)).toMatchObject({ engine: 'grok', enabled: false, previous: false, hosts_suspended: 0 });
    expect(db.updates.filter((u) => u.table === hosts)).toHaveLength(0);
    expect(publish).not.toHaveBeenCalledWith('engine.state.changed', expect.anything());
    await app.close();
  });

  it('switches an engine back on without suspending anything', async () => {
    const { app } = await buildApp(new Map<unknown, Array<Record<string, unknown>>>([
      [hosts, [host(1, 'codex')]],
      [versions, [{ name: 'codex_engine_disabled', version: '1', updatedAt: '2026-10-01T00:00:00Z' }]],
    ]));
    const reply = await app.inject({ method: 'POST', url: '/admin/engines/codex/state', payload: { enabled: true } });
    expect(JSON.parse(reply.payload)).toMatchObject({ engine: 'codex', enabled: true, previous: false, hosts_suspended: 0 });
    await app.close();
  });

  it('rejects unknown engines and non-boolean states', async () => {
    const { app } = await buildApp();
    for (const [url, payload] of [
      ['/admin/engines/gemini/state', { enabled: false }],
      ['/admin/engines/codex/state', { enabled: 'off' }],
      ['/admin/engines/codex/state', {}],
    ] as const) {
      const reply = await app.inject({ method: 'POST', url, payload });
      expect(reply.statusCode).toBe(422);
    }
    await app.close();
  });
});
