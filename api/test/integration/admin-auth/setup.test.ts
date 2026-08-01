import { describe, expect, it } from 'vitest';
import { hash as argonHash } from '../../../src/security/password.js';
import { buildAdminTestApp } from '../../helpers/build-admin-app.js';

async function seedOwner(
  store: Awaited<ReturnType<typeof buildAdminTestApp>>['store'],
): Promise<number> {
  const id = store.nextId++;
  const now = new Date().toISOString();
  store.users.push({
    id,
    name: 'Owner',
    username: 'owner',
    email: 'owner@example.test',
    passwordHash: await argonHash('password-long-enough'),
    accessLevel: 'owner',
    active: 1,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('admin setup bootstrap', () => {
  it('publishes a secret-free setup status only while unclaimed', async () => {
    const secret = 'runner-secret-must-not-leak';
    const { app, store, sessionToken } = await buildAdminTestApp({
      AUTH_RUNNER_URL: 'http://127.0.0.1:1/verify',
      AUTH_RUNNER_SHARED_SECRET: secret,
      PUBLIC_BASE_URL: 'https://orchestrator.example.test',
    });

    const open = await app.inject({ method: 'GET', url: '/admin/setup/status' });
    expect(open.statusCode).toBe(200);
    expect(open.payload).not.toContain(secret);
    expect(open.json()).toMatchObject({
      status: 'ok',
      data: {
        owner_created: false,
        setup_complete: false,
        canonical_auth: { codex: false, claude: false },
      },
    });

    const ownerId = await seedOwner(store);
    const denied = await app.inject({ method: 'GET', url: '/admin/setup/status' });
    expect(denied.statusCode).toBe(401);

    const { cookie } = sessionToken(ownerId);
    const authenticated = await app.inject({
      method: 'GET',
      url: '/admin/setup/status',
      headers: { cookie },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({
      status: 'ok',
      data: { owner_created: true },
    });
    await app.close();
  });

  it('creates the fixed first owner and signs it in', async () => {
    const { app, store } = await buildAdminTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/setup/owner',
      payload: {
        name: 'First Owner',
        username: 'first-owner',
        email: 'owner@example.test',
        password: 'password-long-enough',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('codex_admin_session=');
    expect(store.users).toHaveLength(1);
    expect(store.users[0]).toMatchObject({ accessLevel: 'owner', active: 1 });
    expect(store.sessions).toHaveLength(1);
    await app.close();
  });
});
