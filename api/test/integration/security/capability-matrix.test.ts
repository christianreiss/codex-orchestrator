/**
 * The role→route matrix, exercised over HTTP.
 *
 * The unit suite proves the matrix says the right thing. That is not the same
 * claim as "the server answers 403". Between the two sit the plugin's onRoute
 * hook, the order it appends its preHandler in, and whether the route's own
 * handler ever gets a chance to run — and each of those has failed silently in
 * this codebase's history. So this mounts the real plugin and the real route
 * modules, acts as every role in `VALID_ACCESS_LEVELS`, calls a representative
 * route from every capability family, and asserts the status code.
 *
 * The session itself is stubbed at the `auth-admin` boundary — cookie parsing
 * and session expiry are the auth-admin suite's subject, and a `db-fake` cannot
 * serve the join `resolveAdmin` runs. What is real here is everything from the
 * role onward.
 *
 * Denials must land *before* the handler. A 403 that arrives after the row was
 * already deleted is not authorization, so every mutation here is aimed at a
 * seeded record and the store is checked for damage afterwards.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';
import { registerAdminSecretsRoutes } from '../../../src/routes/admin/secrets/index.js';
import { registerAdminMemoriesRoutes } from '../../../src/routes/admin/memories/index.js';
import { registerAgentPortalAdminHostRoutes } from '../../../src/routes/agent-portal/admin-host.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { secrets, versions } from '../../../src/db/schema.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { VALID_ACCESS_LEVELS } from '../../../src/services/admin-auth.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const keyring = testKeyring();
const apps: FastifyInstance[] = [];

const ENV = {} as unknown as RouteContext['env'];

function seedDb(): DbFake {
  const db = createDbFake();
  db.tables.set(secrets, [
    {
      id: 1,
      slug: 'gh-pat',
      name: 'GitHub PAT',
      description: null,
      valueEnc: encrypt('ghp_live_credential_value', keyring),
      engine: null,
      tags: [],
      tagsText: '',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      lastRotatedAt: null,
      deletedAt: null,
    },
  ]);
  db.tables.set(versions, [
    { name: 'secrets_module_enabled', version: '1', updatedAt: '2026-01-01T00:00:00Z' },
  ]);
  return db;
}

async function buildApp(role: string | null): Promise<{ app: FastifyInstance; db: DbFake }> {
  const db = seedDb();
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await registerCapabilityStack(app, { role });
  await app.register(envelopePlugin);

  const ctx = { db: db as never, env: ENV, keyring } as RouteContext;
  await registerAdminSecretsRoutes(app, ctx);
  await registerAdminMemoriesRoutes(app, ctx);
  await registerAgentPortalAdminHostRoutes(app, ctx);
  await app.ready();
  return { app, db };
}

interface Probe {
  what: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  payload?: unknown;
  /** Roles that must be admitted past the guard. Everyone else gets 403. */
  allowed: string[];
}

const PROBES: Probe[] = [
  {
    what: 'secrets metadata listing (secrets.read_metadata)',
    method: 'GET',
    url: '/admin/secrets',
    allowed: [...VALID_ACCESS_LEVELS],
  },
  {
    what: 'secret value reveal (secrets.reveal)',
    method: 'POST',
    url: '/admin/secrets/1/reveal',
    allowed: ['owner', 'admin'],
  },
  {
    what: 'secret update (secrets.manage)',
    method: 'PATCH',
    url: '/admin/secrets/1',
    payload: { name: 'renamed by an unauthorized caller' },
    allowed: ['owner', 'admin'],
  },
  {
    what: 'secret soft-delete (secrets.manage)',
    method: 'DELETE',
    url: '/admin/secrets/1',
    allowed: ['owner', 'admin'],
  },
  {
    what: 'memory graph (memory.read)',
    method: 'GET',
    url: '/admin/memories/graph',
    allowed: [...VALID_ACCESS_LEVELS],
  },
  {
    what: 'memory write (memory.write)',
    method: 'POST',
    url: '/admin/memories/host',
    payload: { id: 'note', host_id: 1, content: 'body' },
    allowed: ['owner', 'admin'],
  },
  {
    what: 'portal state read (agent_portal.read)',
    method: 'GET',
    url: '/admin/agent-portal/state',
    allowed: [...VALID_ACCESS_LEVELS],
  },
  {
    what: 'permanent portal link (agent_portal.reveal_link)',
    method: 'GET',
    url: '/admin/agent-portal/users/1/link',
    allowed: ['owner', 'admin'],
  },
  {
    what: 'portal module switch (agent_portal.manage)',
    method: 'POST',
    url: '/admin/agent-portal/state',
    payload: { enabled: false },
    allowed: ['owner', 'admin'],
  },
];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('capability matrix over HTTP', () => {
  it('rejects an anonymous caller on every probe', async () => {
    const { app } = await buildApp(null);
    for (const probe of PROBES) {
      const response = await app.inject({
        method: probe.method,
        url: probe.url,
        payload: probe.payload as never,
      });
      expect(response.statusCode, `${probe.what} without a cookie`).toBe(401);
      expect(response.json()).toMatchObject({ code: 'admin_required' });
    }
  });

  for (const role of VALID_ACCESS_LEVELS) {
    describe(`as ${role}`, () => {
      for (const probe of PROBES) {
        const permitted = probe.allowed.includes(role);
        it(`${permitted ? 'admits' : 'refuses'} ${probe.what}`, async () => {
          const { app, db } = await buildApp(role);
          const response = await app.inject({
            method: probe.method,
            url: probe.url,
            payload: probe.payload as never,
          });
          if (permitted) {
            expect(response.statusCode, response.body).not.toBe(403);
            return;
          }
          expect(response.statusCode, response.body).toBe(403);
          expect(response.json()).toMatchObject({ code: 'admin_role_required' });
          // Refused before the handler: nothing reached storage.
          expect(db.inserts, `${probe.what} wrote a row before refusing`).toEqual([]);
          expect(db.updates, `${probe.what} updated a row before refusing`).toEqual([]);
          expect(db.deletes, `${probe.what} deleted a row before refusing`).toEqual([]);
        });
      }
    });
  }
});

describe('capability matrix guardrails', () => {
  let roles: readonly string[];
  beforeEach(() => {
    roles = VALID_ACCESS_LEVELS;
  });

  it('covers every role the API accepts', () => {
    expect(roles).toContain('owner');
    expect(roles).toContain('viewer');
    expect(roles).toContain('fleet_operator');
    expect(roles).toContain('trusted_user');
    expect(roles).toContain('user');
    // Every probe must discriminate, or it proves nothing.
    for (const probe of PROBES) {
      expect(probe.allowed.length, `${probe.what} allows nobody`).toBeGreaterThan(0);
    }
    expect(
      PROBES.some((probe) => probe.allowed.length < roles.length),
      'no probe distinguishes roles',
    ).toBe(true);
  });
});
