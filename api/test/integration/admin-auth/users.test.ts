import { describe, it, expect } from 'vitest';
import { buildAdminTestApp } from '../../helpers/build-admin-app.js';
import { hash as argonHash } from '../../../src/security/password.js';

async function seedOwner(
  store: Awaited<ReturnType<typeof buildAdminTestApp>>['store'],
  patch: Partial<{ username: string; active: 1 | 0; accessLevel: string }> = {},
): Promise<number> {
  const id = store.nextId++;
  store.users.push({
    id,
    name: 'Owner',
    username: patch.username ?? 'owner',
    email: `${patch.username ?? 'owner'}@example.test`,
    passwordHash: await argonHash('password-long-enough'),
    accessLevel: patch.accessLevel ?? 'owner',
    active: patch.active ?? 1,
    lastLoginAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

describe('GET /admin/users', () => {
  it('returns 401 without a session', async () => {
    const { app } = await buildAdminTestApp();
    const r = await app.inject({ method: 'GET', url: '/admin/users' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('returns the user list when authenticated', async () => {
    const { app, store, sessionToken } = await buildAdminTestApp();
    const ownerId = await seedOwner(store);
    const { cookie } = sessionToken(ownerId);
    const r = await app.inject({ method: 'GET', url: '/admin/users', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { users: Array<{ username: string }> };
    expect(body.users.length).toBe(1);
    expect(body.users[0]?.username).toBe('owner');
    await app.close();
  });
});

describe('POST /admin/users', () => {
  it('allows creating the first user without a session (bootstrap)', async () => {
    const { app, store } = await buildAdminTestApp();
    const r = await app.inject({
      method: 'POST',
      url: '/admin/users',
      payload: {
        name: 'Owner',
        username: 'owner',
        email: 'owner@example.test',
        password: 'password-long-enough',
        access_level: 'owner',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(store.users.length).toBe(1);
    await app.close();
  });

  it('rejects an unauthenticated create once a user exists', async () => {
    const { app, store } = await buildAdminTestApp();
    await seedOwner(store);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/users',
      payload: {
        name: 'Second',
        username: 'second',
        email: 'second@example.test',
        password: 'password-long-enough',
        access_level: 'viewer',
      },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('returns 422 when validation fails (short password)', async () => {
    const { app, store, sessionToken } = await buildAdminTestApp();
    const ownerId = await seedOwner(store);
    const { cookie } = sessionToken(ownerId);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie },
      payload: {
        name: 'Second',
        username: 'second',
        email: 'second@example.test',
        password: 'short',
        access_level: 'viewer',
      },
    });
    expect(r.statusCode).toBe(422);
    await app.close();
  });
});

describe('POST /admin/users/wipe', () => {
  it('requires a confirm:WIPE marker', async () => {
    const { app, store, sessionToken } = await buildAdminTestApp();
    const ownerId = await seedOwner(store);
    const { cookie } = sessionToken(ownerId);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/users/wipe',
      headers: { cookie },
      payload: { confirm: 'nope' },
    });
    expect(r.statusCode).toBe(422);
    await app.close();
  });

  it('preserves the actor and removes everyone else', async () => {
    const { app, store, sessionToken } = await buildAdminTestApp();
    const ownerId = await seedOwner(store);
    await seedOwner(store, { username: 'other', accessLevel: 'viewer' });
    expect(store.users.length).toBe(2);
    const { cookie } = sessionToken(ownerId);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/users/wipe',
      headers: { cookie },
      payload: { confirm: 'WIPE' },
    });
    expect(r.statusCode).toBe(200);
    expect(store.users.length).toBe(1);
    expect(store.users[0]?.username).toBe('owner');
    await app.close();
  });
});

describe('DELETE /admin/users/:id', () => {
  it('refuses to delete the last admin', async () => {
    const { app, store, sessionToken } = await buildAdminTestApp();
    const ownerId = await seedOwner(store);
    const { cookie } = sessionToken(ownerId);
    const r = await app.inject({
      method: 'DELETE',
      url: `/admin/users/${ownerId}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(422);
    await app.close();
  });
});

describe('POST /admin/auth/password/change', () => {
  it('rejects mismatched confirmation', async () => {
    const { app, store, sessionToken } = await buildAdminTestApp();
    const ownerId = await seedOwner(store);
    const { cookie } = sessionToken(ownerId);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/password/change',
      headers: { cookie },
      payload: {
        current_password: 'password-long-enough',
        new_password: 'new-password-too',
        confirm_password: 'mismatched',
      },
    });
    expect(r.statusCode).toBe(422);
    await app.close();
  });

  it('changes the password and clears sibling sessions', async () => {
    const { app, store, sessionToken } = await buildAdminTestApp();
    const ownerId = await seedOwner(store);
    const { token, cookie } = sessionToken(ownerId);
    // Second active session that should be cleared.
    sessionToken(ownerId);
    expect(store.sessions.length).toBe(2);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/password/change',
      headers: { cookie },
      payload: {
        current_password: 'password-long-enough',
        new_password: 'brand-new-password-12',
        confirm_password: 'brand-new-password-12',
      },
    });
    expect(r.statusCode).toBe(200);
    // The current session (matching the request cookie) must survive; the
    // other one is gone.
    expect(store.sessions.length).toBe(1);
    void token;
    await app.close();
  });
});
