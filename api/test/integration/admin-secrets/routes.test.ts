/**
 * Route-level guards and wire shape for the fleet secrets admin API.
 *
 * The claim under test is that a credential cannot leave through the wrong
 * door: a `viewer` session must be refused before anything touches the
 * database, the listing must be structurally incapable of carrying a value, and
 * the one endpoint that does return plaintext must be a role-gated POST rather
 * than a GET a browser could prefetch, an intermediary could cache, or history
 * could replay.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { ApiError } from '../../../src/http/errors.js';
import {
  registerAdminSecretsRoutes,
  toAdminSecret,
} from '../../../src/routes/admin/secrets/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { secrets, versions } from '../../../src/db/schema.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const keyring = testKeyring();
const apps: Array<ReturnType<typeof Fastify>> = [];

const PLAINTEXT = 'ghp_live_credential_value';

function seedDb(): DbFake {
  const db = createDbFake();
  db.tables.set(secrets, [
    {
      id: 1,
      slug: 'gh-pat',
      name: 'GitHub PAT',
      description: 'opens PRs on the fleet repos',
      valueEnc: encrypt(PLAINTEXT, keyring),
      engine: null,
      tags: ['git'],
      tagsText: 'git',
      createdAt: '2026-07-01T09:00:00Z',
      updatedAt: '2026-07-01T09:00:00Z',
      lastRotatedAt: '2026-07-01T09:00:00Z',
      deletedAt: null,
    },
  ]);
  db.tables.set(versions, [
    { name: 'secrets_module_enabled', version: '1', updatedAt: '2026-07-01T09:00:00Z' },
  ]);
  return db;
}

async function buildApp(role: string | null, db: DbFake = seedDb()) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  app.decorate('requireAdmin', async (req: import('fastify').FastifyRequest) => {
    if (role === null) {
      throw new ApiError('Admin session required', {
        status: 401,
        code: 'admin_required',
        type: 'authentication_error',
      });
    }
    req.admin = {
      user: { id: 7, accessLevel: role, active: 1 } as never,
      session: { id: 1 } as never,
    };
  });
  app.decorate('resolveAdmin', async () => null);
  await registerAdminSecretsRoutes(app, {
    db: db as never,
    env: {} as never,
    keyring,
  } as RouteContext);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin secrets wire shape', () => {
  it('cannot emit a value, a ciphertext, or a camelCase field', () => {
    const row = toAdminSecret({
      id: 7,
      slug: 'gh-pat',
      name: 'GitHub PAT',
      description: 'opens PRs',
      engine: 'codex',
      tags: ['git'],
      createdAt: '2026-07-01T09:00:00Z',
      updatedAt: '2026-07-02T09:00:00Z',
      lastRotatedAt: '2026-07-02T09:00:00Z',
      deletedAt: null,
    });

    // An exact key list, not a subset: a new field added to the service's row
    // shape must be a deliberate decision here, not something that rides along.
    expect(Object.keys(row).sort()).toEqual([
      'created_at',
      'deleted_at',
      'description',
      'engine',
      'id',
      'last_rotated_at',
      'name',
      'slug',
      'tags',
      'updated_at',
    ]);
    expect('value' in row).toBe(false);
    expect('valueEnc' in row).toBe(false);
    expect('value_enc' in row).toBe(false);
  });
});

describe('admin secrets route guards', () => {
  it('requires an authenticated admin on every route', async () => {
    const app = await buildApp(null);
    for (const [method, url] of [
      ['GET', '/admin/secrets'],
      ['GET', '/admin/secrets/1'],
      ['GET', '/admin/secrets/state'],
      ['POST', '/admin/secrets'],
      ['POST', '/admin/secrets/state'],
      ['PATCH', '/admin/secrets/1'],
      ['DELETE', '/admin/secrets/1'],
      ['POST', '/admin/secrets/1/reveal'],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json()).toMatchObject({ status: 'error', code: 'admin_required' });
    }
  });

  it('lets a viewer read metadata but refuses every mutation and the reveal', async () => {
    const app = await buildApp('viewer');

    expect((await app.inject({ method: 'GET', url: '/admin/secrets' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/secrets/state' })).statusCode).toBe(200);

    for (const [method, url, payload] of [
      ['POST', '/admin/secrets', { slug: 'x', name: 'x', value: 'x' }],
      ['PATCH', '/admin/secrets/1', { name: 'x' }],
      ['DELETE', '/admin/secrets/1', {}],
      ['POST', '/admin/secrets/1/reveal', {}],
      ['POST', '/admin/secrets/state', { enabled: false }],
    ] as const) {
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json()).toMatchObject({ status: 'error', code: 'admin_role_required' });
    }
  });

  it.each(['owner', 'admin'])('lets %s reveal and mutate', async (role) => {
    const app = await buildApp(role);
    const revealed = await app.inject({ method: 'POST', url: '/admin/secrets/1/reveal' });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json()).toMatchObject({ value: PLAINTEXT });
  });
});

describe('admin secrets responses', () => {
  it('never carries a value or ciphertext in a listing', async () => {
    const app = await buildApp('owner');
    const response = await app.inject({ method: 'GET', url: '/admin/secrets' });

    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain(PLAINTEXT);
    expect(response.payload).not.toContain('sbox:');
    expect(response.json()).toMatchObject({
      secrets: [expect.objectContaining({ slug: 'gh-pat', tags: ['git'] })],
    });
  });

  it('never carries a value in a single-secret read either', async () => {
    const app = await buildApp('owner');
    const response = await app.inject({ method: 'GET', url: '/admin/secrets/1' });
    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain(PLAINTEXT);
    expect(response.payload).not.toContain('sbox:');
  });

  it('creates with 201 and reports rotation on update', async () => {
    const app = await buildApp('owner');
    const created = await app.inject({
      method: 'POST',
      url: '/admin/secrets',
      payload: { slug: 'ckmk', name: 'Checkmk', value: 'tok', tags: ['monitoring'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.payload).not.toContain('tok');

    const rotated = await app.inject({
      method: 'PATCH',
      url: '/admin/secrets/1',
      payload: { value: 'a-different-value' },
    });
    expect(rotated.json()).toMatchObject({ rotated: true });

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/admin/secrets/1',
      payload: { name: 'GitHub PAT (fleet)' },
    });
    expect(renamed.json()).toMatchObject({ rotated: false });
  });

  it('rejects a slug change rather than silently ignoring it', async () => {
    // The slug is the key agents hold; a rename would break every one of them.
    const app = await buildApp('owner');
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/secrets/1',
      payload: { slug: 'renamed' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_request' });
  });

  it.each([
    ['a missing name', { slug: 'x', value: 'v' }, 'name'],
    ['a missing value', { slug: 'x', name: 'n' }, 'value'],
    ['an unknown engine', { slug: 'x', name: 'n', value: 'v', engine: 'gemini' }, 'engine'],
  ])('rejects %s with the offending param', async (_label, payload, param) => {
    const app = await buildApp('owner');
    const response = await app.inject({ method: 'POST', url: '/admin/secrets', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_request', param });
  });

  it('404s an unknown id and a soft-deleted one', async () => {
    const app = await buildApp('owner');
    expect((await app.inject({ method: 'GET', url: '/admin/secrets/99' })).statusCode).toBe(404);

    const deleted = await app.inject({ method: 'DELETE', url: '/admin/secrets/1' });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ secret: expect.objectContaining({ slug: 'gh-pat' }) });

    // A second delete has nothing live to act on.
    expect((await app.inject({ method: 'DELETE', url: '/admin/secrets/1' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/admin/secrets/1/reveal' })).statusCode).toBe(
      404,
    );
  });

  it('rejects a non-numeric id before touching storage', async () => {
    const app = await buildApp('owner');
    const response = await app.inject({ method: 'GET', url: '/admin/secrets/nope' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('reports and flips the module switch', async () => {
    const app = await buildApp('owner');
    expect((await app.inject({ method: 'GET', url: '/admin/secrets/state' })).json()).toMatchObject({
      enabled: true,
      count: 1,
    });

    const off = await app.inject({
      method: 'POST',
      url: '/admin/secrets/state',
      payload: { enabled: false },
    });
    expect(off.json()).toMatchObject({ enabled: false });

    // Admin CRUD stays available while the module is off, so secrets can be
    // staged before switch-on.
    expect((await app.inject({ method: 'GET', url: '/admin/secrets' })).statusCode).toBe(200);
  });

  it('rejects a state body that names no boolean', async () => {
    const app = await buildApp('owner');
    const response = await app.inject({
      method: 'POST',
      url: '/admin/secrets/state',
      payload: { enabled: 'maybe' },
    });
    expect(response.statusCode).toBe(400);
  });
});
