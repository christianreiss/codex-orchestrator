import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logs, versions } from '../../../src/db/schema.js';
import { registerAdminSettingsRoutes } from '../../../src/routes/admin/settings/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { apiLevelTracker } from '../../../src/services/communicator-api-version.js';
import { communicatorRegistry } from '../../../src/services/topology/communicator-registry.js';
import { ROUTE_CAPABILITIES } from '../../../src/security/route-capabilities.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

const URL = '/admin/communicator/api-version';

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

const stored = (db: ReturnType<typeof createDbFake>) =>
  (db.tables.get(versions) ?? []).find((row) => row.name === 'communicator_min_api');

beforeEach(() => apiLevelTracker.clear());
afterEach(() => apiLevelTracker.clear());

describe('communicator API level admin routes', () => {
  it('is capability-gated like the sibling version routes', () => {
    expect(ROUTE_CAPABILITIES[`GET ${URL}`]).toMatchObject({ capability: 'settings.read' });
    expect(ROUTE_CAPABILITIES[`POST ${URL}`]).toMatchObject({ capability: 'settings.manage' });
  });

  it('reports the defaults with no override and empty client tallies', async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: 'GET', url: URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      api_version: 1,
      min_api: 1,
      default_min_api: 1,
      override_min_api: null,
      override_updated_at: null,
      clients: {
        hosts: { observed: 0, below_min: 0, below_current: 0, at_current: 0, unreported: 0 },
        communicators: { observed: 0, below_min: 0, below_current: 0, at_current: 0, unreported: 0 },
      },
    });
    await app.close();
  });

  it('stores a valid minimum, audit-logs it and reports it', async () => {
    const { app, db } = await buildApp();
    const response = await app.inject({ method: 'POST', url: URL, payload: { min_api: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ api_version: 1, min_api: 1, override_min_api: 1 });
    expect(stored(db)?.version).toBe('1');
    const audit = (db.tables.get(logs) ?? []).find((row) => row.action === 'admin.communicator_min_api');
    expect(audit).toBeDefined();
    expect(JSON.parse(String(audit?.details))).toMatchObject({ min_api: 1, previous: 1, override_min_api: 1 });
    expect((await app.inject({ method: 'GET', url: URL })).json()).toMatchObject({ override_min_api: 1 });
    await app.close();
  });

  it('clears the override with null', async () => {
    const { app, db } = await buildApp();
    await app.inject({ method: 'POST', url: URL, payload: { min_api: 1 } });
    expect(stored(db)).toBeDefined();
    const response = await app.inject({ method: 'POST', url: URL, payload: { min_api: null } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ min_api: 1, override_min_api: null });
    expect(stored(db)).toBeUndefined();
    await app.close();
  });

  it.each([
    ['above the current API version', { min_api: 2 }],
    ['zero', { min_api: 0 }],
    ['negative', { min_api: -1 }],
    ['fractional', { min_api: 1.5 }],
    ['a non-number', { min_api: 'high' }],
    ['a boolean', { min_api: true }],
    ['missing', {}],
  ])('rejects a minimum that is %s and stores nothing', async (_name, payload) => {
    const { app, db } = await buildApp();
    const response = await app.inject({ method: 'POST', url: URL, payload });
    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).toContain('min_api');
    expect(stored(db)).toBeUndefined();
    expect((db.tables.get(logs) ?? []).some((row) => row.action === 'admin.communicator_min_api')).toBe(false);
    await app.close();
  });

  it('never serves a minimum above the current level even if the row was written by hand', async () => {
    const { app, db } = await buildApp();
    db.tables.set(versions, [{ name: 'communicator_min_api', version: '9' }]);
    const body = (await app.inject({ method: 'GET', url: URL })).json();
    expect(body).toMatchObject({ api_version: 1, min_api: 1, override_min_api: 9 });
    await app.close();
  });

  it('tallies hosts that stated a level and live communicator connections', async () => {
    const { app } = await buildApp();
    apiLevelTracker.observe(1, 1);
    apiLevelTracker.observe(2, null);
    const base = { username: 'u', version: '0.9.145', connected_at: new Date().toISOString(), sessions: 0, requests: 0, synced_at: null };
    const noop = { close() {}, remoteAddress: null };
    communicatorRegistry.register({ ...base, id: 'conn-api-1', host_id: 1, api_version: 1 }, noop);
    communicatorRegistry.register({ ...base, id: 'conn-api-2', host_id: 2 }, noop);
    try {
      const body = (await app.inject({ method: 'GET', url: URL })).json();
      expect(body.clients.hosts).toEqual({ observed: 2, below_min: 0, below_current: 0, at_current: 1, unreported: 1 });
      expect(body.clients.communicators.observed).toBeGreaterThanOrEqual(2);
      expect(body.clients.communicators.at_current).toBeGreaterThanOrEqual(1);
      expect(body.clients.communicators.unreported).toBeGreaterThanOrEqual(1);
    } finally {
      communicatorRegistry.unregister('conn-api-1');
      communicatorRegistry.unregister('conn-api-2');
      await app.close();
    }
  });
});
