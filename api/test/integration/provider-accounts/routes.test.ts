import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAdminAccountsRoutes } from '../../../src/routes/admin/accounts/index.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { providerAccounts } from '../../../src/db/schema.js';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllGlobals();
});
async function build(role: string | null) {
  const db = createDbFake();
  const app = Fastify();
  apps.push(app);
  await app.register(envelopePlugin);
  await registerCapabilityStack(app, { role });
  await registerAdminAccountsRoutes(app, {
    db: db as never,
    keyring: testKeyring(),
    env: {
      AUTH_RUNNER_URL: 'https://runner.example/verify',
      AUTH_RUNNER_TIMEOUT: 2,
      STATIC_ROOT: '',
    } as never,
  });
  return { app, db };
}
describe('admin provider account routes', () => {
  it('requires admin authentication and auth.manage for mutations', async () => {
    const anonymous = await build(null);
    expect((await anonymous.app.inject({ method: 'GET', url: '/admin/accounts' })).statusCode).toBe(401);
    const viewer = await build('viewer');
    expect((await viewer.app.inject({ method: 'GET', url: '/admin/accounts' })).statusCode).toBe(200);
    for (const [method, url] of [
      ['POST', '/admin/accounts'],
      ['PATCH', '/admin/accounts/1'],
      ['DELETE', '/admin/accounts/1'],
      ['POST', '/admin/accounts/1/credentials'],
      ['POST', '/admin/accounts/1/verify'],
    ] as const) {
      expect(
        (await viewer.app.inject({ method, url, payload: method === 'DELETE' ? undefined : {} })).statusCode,
      ).toBe(403);
    }
    expect(viewer.db.tables.get(providerAccounts) ?? []).toHaveLength(0);
  });
  it('returns only metadata for validated creation and replacement and checks identities', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok', reachable: true }), { status: 200 })),
    );
    const { app } = await build('owner');
    const token = 'sk-ant-api03-private-provider-account-test';
    const creation = await app.inject({
      method: 'POST',
      url: '/admin/accounts',
      payload: { engine: 'claude', label: 'Work Claude', payload: token },
    });
    expect(creation.statusCode).toBe(200);
    expect(creation.json()).toMatchObject({ account_id: 1, verification_state: 'verified' });
    expect(creation.payload).not.toContain(token);
    const listing = await app.inject({
      method: 'GET',
      url: '/admin/accounts',
      headers: { accept: 'application/json' },
    });
    expect(listing.json().accounts[0]).toMatchObject({
      engine: 'claude',
      label: 'Work Claude',
      state: 'enabled',
    });
    expect(listing.payload).not.toMatch(/api_key|auths|sk-ant-api03|identity_key|fingerprint/);
    const replacement = await app.inject({
      method: 'POST',
      url: '/admin/accounts/1/credentials',
      payload: { payload: token },
    });
    expect(replacement.statusCode).toBe(200);
    expect(replacement.payload).not.toContain(token);
    expect(
      (await app.inject({ method: 'PATCH', url: '/admin/accounts/1', payload: { state: 'unknown' } }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/accounts',
          payload: { engine: 'codex', payload: 'not JSON' },
        })
      ).statusCode,
    ).toBe(422);
  });
});
