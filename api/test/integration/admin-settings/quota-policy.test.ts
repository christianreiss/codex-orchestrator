import { describe, it, expect } from 'vitest';
import { registerQuotaRoutes } from '../../../src/routes/quota.js';
import { DEFAULT_QUOTA_POLICY } from '../../../src/services/quota-policy.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { providerAccounts } from '../../../src/db/schema.js';

async function build() {
  const app = await buildRouteApp(); const db = createDbFake();
  db.tables.set(providerAccounts, [{ id: 1, engine: 'claude', state: 'enabled', label: 'Account' }]);
  await registerQuotaRoutes(app, { db: db as never, env: {} as never, keyring: {} as never });
  return { app, db };
}
describe('quota policy API', () => {
  it('persists engine defaults, account overrides and explicit reset to inheritance', async () => {
    const { app } = await build();
    try {
      const policy = { ...DEFAULT_QUOTA_POLICY, short_warn_percent: 75, long_auto_resume: true };
      expect((await app.inject({ method: 'PUT', url: '/admin/quota-policy/claude', payload: { policy } })).statusCode).toBe(200);
      const inherited = await app.inject({ method: 'GET', url: '/admin/accounts/1/quota-policy' });
      expect(inherited.json()).toMatchObject({ effective: policy, override: null });
      const unlimited = { ...policy, unlimited: true };
      expect((await app.inject({ method: 'PUT', url: '/admin/accounts/1/quota-policy', payload: { policy: unlimited } })).json()).toMatchObject({ effective: unlimited, override: unlimited });
      expect((await app.inject({ method: 'PUT', url: '/admin/accounts/1/quota-policy', payload: { policy: null } })).json()).toMatchObject({ effective: policy, override: null });
    } finally { await app.close(); }
  });
  it('rejects malformed policy, engine, unknown account and missing session bridge', async () => {
    const { app } = await build();
    try {
      expect((await app.inject({ method: 'PUT', url: '/admin/quota-policy/claude', payload: { policy: { ...DEFAULT_QUOTA_POLICY, short_warn_percent: 0 } } })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await app.inject({ method: 'GET', url: '/admin/quota-policy/unknown' })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await app.inject({ method: 'GET', url: '/admin/accounts/999/quota-policy' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/host/agent-sessions/00000000-0000-4000-a000-000000000001/agent-messaging/quota/get', payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
    } finally { await app.close(); }
  });
});
