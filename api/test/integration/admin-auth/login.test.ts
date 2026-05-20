import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { buildAdminTestApp } from '../../helpers/build-admin-app.js';
import { hash as argonHash } from '../../../src/security/password.js';
import { sha256 } from '../../../src/security/hash.js';

describe('POST /admin/auth/login', () => {
  it('rejects unknown usernames with 401', async () => {
    const { app } = await buildAdminTestApp();
    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'nobody', password: 'irrelevant' },
    });
    expect(r.statusCode).toBe(401);
    const body = JSON.parse(r.payload) as { status: string; code?: string };
    expect(body.status).toBe('error');
    expect(body.code).toBe('invalid_credentials');
    await app.close();
  });

  it('rejects empty passwords with 401', async () => {
    const { app } = await buildAdminTestApp();
    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'user', password: '' },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('logs the user in with an argon2 hash + sets HttpOnly cookie', async () => {
    const { app, store, env } = await buildAdminTestApp();
    const passwordHash = await argonHash('password-long-enough');
    store.users.push({
      id: store.nextId++,
      name: 'Owner',
      username: 'owner',
      email: 'owner@example.test',
      passwordHash,
      accessLevel: 'owner',
      active: 1,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'owner', password: 'password-long-enough' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { status: string; user: { username: string } };
    expect(body.status).toBe('ok');
    expect(body.user.username).toBe('owner');
    const setCookie = r.headers['set-cookie'];
    expect(String(setCookie)).toContain(env.ADMIN_SESSION_COOKIE);
    expect(String(setCookie).toLowerCase()).toContain('httponly');
    expect(store.sessions.length).toBe(1);
    await app.close();
  });

  it('logs the user in with a legacy bcrypt hash and rehashes to argon2', async () => {
    const { app, store } = await buildAdminTestApp();
    const password = 'password-long-enough';
    const passwordHash = bcrypt.hashSync(password, 8);
    store.users.push({
      id: store.nextId++,
      name: 'Owner',
      username: 'owner',
      email: 'owner@example.test',
      passwordHash,
      accessLevel: 'owner',
      active: 1,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { username: 'owner', password },
    });
    expect(r.statusCode).toBe(200);
    // The stored hash should have been rotated to argon2id.
    expect(store.users[0]?.passwordHash.startsWith('$argon2id$')).toBe(true);
    await app.close();
  });
});

describe('POST /admin/auth/login/method', () => {
  it('returns "password" when the user has no passkeys registered', async () => {
    const { app, store } = await buildAdminTestApp();
    store.users.push({
      id: store.nextId++,
      name: 'Owner',
      username: 'owner',
      email: 'owner@example.test',
      passwordHash: 'h',
      accessLevel: 'owner',
      active: 1,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/login/method',
      payload: { username: 'owner' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { method: string };
    expect(body.method).toBe('password');
    await app.close();
  });

  it('returns "password" when the username is unknown (no info leak)', async () => {
    const { app } = await buildAdminTestApp();
    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/login/method',
      payload: { username: 'unknown' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { method: string };
    expect(body.method).toBe('password');
    await app.close();
  });
});

describe('POST /admin/auth/passkey/login/options', () => {
  it('starts passkey login without a username when exactly one active user has a passkey', async () => {
    const { app, store } = await buildAdminTestApp();
    const now = new Date().toISOString();
    store.users.push({
      id: store.nextId++,
      name: 'Owner',
      username: 'owner',
      email: 'owner@example.test',
      passwordHash: 'h',
      accessLevel: 'owner',
      active: 1,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const credentialId = 'USCDv4btSHSqCk6MySxr7g';
    store.passkeys.push({
      id: store.nextId++,
      userId: 1,
      credentialId,
      credentialIdHash: sha256(Buffer.from(credentialId, 'base64url')),
      publicKeyPem: 'cose:test',
      coseAlg: -7,
      signCount: 0,
      name: 'Test passkey',
      transports: 'internal',
      aaguid: null,
      createdAt: now,
      lastUsedAt: null,
    });

    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/passkey/login/options',
      payload: {},
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { challenge?: string; allowCredentials?: Array<{ id: string }> };
    expect(body.challenge).toBeTruthy();
    expect(body.allowCredentials?.[0]?.id).toBe(credentialId);
    expect(store.challenges[0]?.userId).toBe(1);
    await app.close();
  });

  it('keeps the username requirement when more than one active user exists', async () => {
    const { app, store } = await buildAdminTestApp();
    const now = new Date().toISOString();
    for (const username of ['owner', 'second']) {
      store.users.push({
        id: store.nextId++,
        name: username,
        username,
        email: `${username}@example.test`,
        passwordHash: 'h',
        accessLevel: 'owner',
        active: 1,
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/passkey/login/options',
      payload: {},
    });

    expect(r.statusCode).toBe(422);
    const body = JSON.parse(r.payload) as { code?: string };
    expect(body.code).toBe('validation_failed');
    expect(store.challenges).toHaveLength(0);
    await app.close();
  });
});

describe('POST /admin/auth/logout', () => {
  it('requires an authenticated session', async () => {
    const { app } = await buildAdminTestApp();
    const r = await app.inject({ method: 'POST', url: '/admin/auth/logout' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('clears the session row + cookie when a valid session is present', async () => {
    const { app, store, sessionToken } = await buildAdminTestApp();
    store.users.push({
      id: 1,
      name: 'Owner',
      username: 'owner',
      email: 'owner@example.test',
      passwordHash: 'h',
      accessLevel: 'owner',
      active: 1,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const { cookie } = sessionToken(1);
    expect(store.sessions.length).toBe(1);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/auth/logout',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(store.sessions.length).toBe(0);
    await app.close();
  });
});

describe('GET /admin/auth/status', () => {
  it('reports has_users=false on an empty database', async () => {
    const { app } = await buildAdminTestApp();
    const r = await app.inject({ method: 'GET', url: '/admin/auth/status' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { status: string; has_users: boolean; authenticated: boolean };
    expect(body.status).toBe('ok');
    expect(body.has_users).toBe(false);
    expect(body.authenticated).toBe(false);
    await app.close();
  });
});
