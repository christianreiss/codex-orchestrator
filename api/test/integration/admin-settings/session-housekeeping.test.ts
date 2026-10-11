import { describe, expect, it } from 'vitest';
import { hosts, agentBusAddresses, agentSessions, agentWatchdogs, sessionHousekeepingReservations, versions } from '../../../src/db/schema.js';
import { registerHousekeepingRoutes } from '../../../src/routes/session-housekeeping.js';
import { reserveHousekeeping, releaseHousekeeping, assertHousekeepingAvailable, validateHousekeeping } from '../../../src/services/session-housekeeping.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

async function build() {
  const app = await buildRouteApp();
  const db = createDbFake();
  db.tables.set(hosts, [{ id: 32 }]);
  await registerHousekeepingRoutes(app, { db, env: {}, keyring: {} } as unknown as RouteContext);
  return { app, db };
}
const rule = { enabled: true, retention_days: 30, min_age_days: 7, max_bytes: 5 * 1024 ** 3 };
describe('session housekeeping', () => {
  it('defaults equally across all engines and resolves/reset host overrides', async () => {
    const { app, db } = await build();
    const fleet = (await app.inject({ method: 'GET', url: '/admin/session-housekeeping' })).json();
    for (const engine of ['codex', 'claude', 'grok']) expect(fleet[engine]).toMatchObject({ ...rule, source: 'fleet' });
    const set = await app.inject({ method: 'POST', url: '/admin/hosts/32/session-housekeeping/grok', payload: { ...rule, retention_days: 60 } });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ retention_days: 60, source: 'host' });
    const reset = await app.inject({ method: 'POST', url: '/admin/hosts/32/session-housekeeping/grok', payload: { inherit: true } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ retention_days: 30, source: 'fleet' });
    expect(db.tables.get(versions)?.some(row => row.name === 'session_housekeeping_grok_host_32')).toBe(true);
    await app.close();
  });
  it('validates engine, duration relationships, budget and host existence', async () => {
    const { app } = await build();
    for (const payload of [{}, { ...rule, min_age_days: 31 }, { ...rule, max_bytes: 0 }, { ...rule, enabled: 'yes' }, { ...rule, retention_days: 1.5 }]) {
      expect((await app.inject({ method: 'POST', url: '/admin/session-housekeeping/codex', payload })).statusCode).toBe(422);
    }
    expect((await app.inject({ method: 'POST', url: '/admin/session-housekeeping/bad', payload: rule })).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/admin/hosts/999/session-housekeeping' })).statusCode).toBe(404);
    await app.close();
  });
  it('fences registrations, preserves all resumable bindings, and recovers only the same journal token', async () => {
    const { app, db } = await build();
    db.tables.set(agentBusAddresses, [{ id:'address-codex', hostId: 32, engine: 'codex', lastUpstreamSessionId: 'paused-wake' }, { id:'address-grok', hostId: 32, engine: 'grok', lastUpstreamSessionId: 'other-engine' }]);
    db.tables.set(agentSessions, [{ hostId: 32, engine: 'codex', upstreamSessionId: 'live', endedAt: null }]);
    db.tables.set(agentWatchdogs, [{targetAddressId:'address-codex',nativeSessionId:'earlier-recovery',status:'recovering'}]);
    const token = '11111111-1111-4111-8111-111111111111';
    const database = db as unknown as RouteContext['db'];
    const result = await reserveHousekeeping(database, 32, 'codex', token);
    expect(result.protected_ids).toEqual(['paused-wake', 'live','earlier-recovery']);
    expect(db.tables.get(sessionHousekeepingReservations)).toHaveLength(1);
    await expect(assertHousekeepingAvailable(database, 32, 'codex')).rejects.toMatchObject({ code: 'session_housekeeping_busy' });
    await expect(reserveHousekeeping(database, 32, 'codex', 'other-token')).rejects.toMatchObject({ code: 'session_housekeeping_busy' });
    await reserveHousekeeping(database, 32, 'codex', token);
    await releaseHousekeeping(database, 32, 'codex', 'other-token');
    expect(db.tables.get(sessionHousekeepingReservations)).toHaveLength(1);
    await releaseHousekeeping(database, 32, 'codex', token);
    await expect(assertHousekeepingAvailable(database, 32, 'codex')).resolves.toBeUndefined();
    await app.close();
  });
  it('accepts boundary values without coercing invalid policies', () => {
    expect(validateHousekeeping({ ...rule, max_bytes: 1024 ** 2, retention_days: 1, min_age_days: 1 })).toMatchObject({ min_age_days: 1 });
    expect(() => validateHousekeeping(null)).toThrow();
  });
});
