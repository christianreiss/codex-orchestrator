import { describe, expect, it } from 'vitest';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import { createDbShim } from '../../helpers/db-shim.js';
import { cliAuthRequests, hosts as hostsTable, adminEvents, logs as logsTable } from '../../../src/db/schema.js';
import { Keyring } from '../../../src/security/keyring.js';

const env = {
  INSTALLATION_ID: 'inst',
  ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  INSECURE_GRACE_MINUTES: 60,
  STATIC_ROOT: '',
  ADMIN_ACCESS_MODE: 'open',
  PUBLIC_BASE_URL: 'https://o.example',
} as unknown as Parameters<typeof buildHostApiTestApp>[0]['env'];

function makeKeyring(): Keyring {
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

describe('POST /cli/auth/start', () => {
  it('issues a request_id + user_code and inserts a pending row', async () => {
    const db = createDbShim();
    db.tables.set(cliAuthRequests, []);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/cli/auth/start',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ fqdn: 'wrapper.example', secure: true }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('ok');
    expect(body.request_id).toMatch(/^[a-f0-9]{64}$/);
    expect(body.user_code).toMatch(/^[A-Z]{4}-[2-9]{4}$/);
    expect(body.poll_interval).toBe(5);
    expect(body.verify_url).toContain('/cli/auth/verify');
    expect(db.tables.get(cliAuthRequests)!.length).toBe(1);
    await app.close();
  });

  it('rejects empty fqdn', async () => {
    const db = createDbShim();
    db.tables.set(cliAuthRequests, []);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/cli/auth/start',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ fqdn: '   ' }),
    });
    expect(r.statusCode).toBe(422);
    await app.close();
  });
});

describe('POST /cli/auth/poll/:id', () => {
  it('returns 404 for unknown id', async () => {
    const db = createDbShim();
    db.tables.set(cliAuthRequests, []);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const id = 'a'.repeat(64);
    const r = await app.inject({ method: 'POST', url: `/cli/auth/poll/${id}` });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it('returns pending for a freshly inserted row', async () => {
    const db = createDbShim();
    const id = 'b'.repeat(64);
    const futureExp = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.tables.set(cliAuthRequests, [
      {
        id: 1,
        requestId: id,
        requestIdEnc: null,
        userCode: 'AAAA-2222',
        userCodeHash: 'h',
        fqdn: 'wrapper.example',
        secure: 1,
        status: 'pending',
        approvedByUserId: null,
        hostId: null,
        apiKeyEnc: null,
        ip: null,
        userAgent: null,
        expiresAt: futureExp,
        createdAt: new Date().toISOString(),
        approvedAt: null,
        consumedAt: null,
        engine: 'codex',
      },
    ]);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({ method: 'POST', url: `/cli/auth/poll/${id}` });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.status).toBe('pending');
    await app.close();
  });
});

describe('POST /cli/auth/approve', () => {
  it('requires an admin session', async () => {
    const db = createDbShim();
    db.tables.set(cliAuthRequests, []);
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/cli/auth/approve',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ user_code: 'AAAA-2222' }),
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('approves a pending request when admin session is present', async () => {
    const db = createDbShim();
    const futureExp = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.tables.set(cliAuthRequests, [
      {
        id: 4,
        requestId: 'r'.repeat(64),
        requestIdEnc: null,
        userCode: 'BBBB-3333',
        // Real sha256 of "BBBB-3333" — recomputed below by the cli-auth service
        userCodeHash: 'will-be-recomputed',
        fqdn: 'approve.example',
        secure: 1,
        status: 'pending',
        expiresAt: futureExp,
        createdAt: new Date().toISOString(),
        engine: 'codex',
      },
    ]);
    db.tables.set(hostsTable, []);
    db.tables.set(adminEvents, []);
    db.tables.set(logsTable, []);
    // Patch the userCodeHash so the route matches via sha256("BBBB-3333")
    const { sha256 } = await import('../../../src/security/hash.js');
    (db.tables.get(cliAuthRequests)![0] as any).userCodeHash = sha256('BBBB-3333');
    const app = await buildHostApiTestApp({ db: db as any, env, keyring: makeKeyring() });
    const r = await app.inject({
      method: 'POST',
      url: '/cli/auth/approve',
      headers: {
        'content-type': 'application/json',
        'x-test-admin-id': '1',
      },
      payload: JSON.stringify({ user_code: 'BBBB-3333' }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.fqdn).toBe('approve.example');
    expect(typeof body.host_id).toBe('number');
    // Host row created
    expect(db.tables.get(hostsTable)!.length).toBe(1);
    await app.close();
  });
});
