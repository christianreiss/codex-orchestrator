/**
 * The three seams where the capability layer hands control to something else,
 * and where a wrong assumption fails open rather than closed.
 *
 * **Bootstrap.** Five routes are classified `capability-after-bootstrap`: the
 * setup wizard, its status read, and first-owner creation. Their guard
 * deliberately lets an anonymous caller through, because on a brand-new
 * installation there is no account to authenticate as. What closes that window
 * is not the capability layer — it is each route's own `requireAdminAfterSetup`
 * / `requireAdminOrBootstrap`, which counts users and demands a session once
 * there is one. Delete that preHandler and the inventory still reports the
 * route as guarded while an anonymous request walks straight to the handler.
 *
 * **A read whose sensitivity depends on the request.**
 * `GET /admin/hosts/:id/auth` returns digests and refresh timestamps — until
 * `include_body=1`, which adds the canonical credential the fleet distributes
 * to its hosts. A single capability on the URL cannot express that: the floor
 * has to stay readable, and the body has to be a separate grant. The route
 * therefore raises its own requirement to `auth.reveal_credential` inside the
 * handler, and this pins both halves.
 *
 * **The SPA shell.** Several `/admin/*` URLs are both a Svelte client route and
 * a JSON endpoint, so `adminSpaHtmlPreHandler` sits ahead of the capability
 * guard and answers HTML navigations with the app shell. Short-circuiting a
 * preHandler chain ahead of an authorization check is exactly the shape of an
 * auth bypass; what makes it safe is that the shell carries no data. This pins
 * that: a refused role may receive the shell, but never a JSON body.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';
import { afterEach, describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { makeCapabilitiesPlugin } from '../../../src/http/plugins/capabilities.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';
import { registerAdminSecretsRoutes } from '../../../src/routes/admin/secrets/index.js';
import { registerAdminHostsRoutes } from '../../../src/routes/admin/hosts/index.js';
import { roleHasCapability } from '../../../src/security/capabilities.js';
import { ROUTE_CAPABILITIES } from '../../../src/security/route-capabilities.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { secrets, versions } from '../../../src/db/schema.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const keyring = testKeyring();
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function bootstrapApp(options: {
  /** Whether the route keeps a gate of its own. */
  withOwnGate: boolean;
  /** Whether the installation already has an owner. */
  setUp: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(requestIdPlugin);
  await app.register(
    fp(
      async (instance: FastifyInstance) => {
        instance.decorate('resolveAdmin', async () => null);
        instance.decorate('requireAdmin', async () => {
          throw Object.assign(new Error('Admin session required'), {
            statusCode: 401,
            code: 'admin_required',
          });
        });
      },
      { name: 'auth-admin' },
    ),
  );
  await app.register(makeCapabilitiesPlugin());
  await app.register(envelopePlugin);

  // Stands in for `requireAdminAfterSetup`: free while the user table is
  // empty, session-gated the moment it is not.
  const ownGate = async (): Promise<void> => {
    if (!options.setUp) return;
    throw Object.assign(new Error('Admin session required'), {
      statusCode: 401,
      code: 'admin_required',
    });
  };

  app.post(
    '/admin/setup/wizard',
    options.withOwnGate ? { preHandler: [ownGate] } : {},
    async () => ({ reached: 'handler' }),
  );
  return app;
}

describe('bootstrap-classified routes', () => {
  it('lets an anonymous caller through only while the installation has no owner', async () => {
    const fresh = await bootstrapApp({ withOwnGate: true, setUp: false });
    await fresh.ready();
    const before = await fresh.inject({ method: 'POST', url: '/admin/setup/wizard' });
    expect(before.statusCode, before.body).toBe(200);

    const claimed = await bootstrapApp({ withOwnGate: true, setUp: true });
    await claimed.ready();
    const after = await claimed.inject({ method: 'POST', url: '/admin/setup/wizard' });
    expect(after.statusCode, after.body).toBe(401);
  });

  it('refuses to start if such a route loses the gate that closes the window', async () => {
    const app = await bootstrapApp({ withOwnGate: false, setUp: true });
    await expect(app.ready()).rejects.toThrow(/capability-after-bootstrap but carries no gate/);
  });

  it('classifies only the setup and first-owner surface this way', () => {
    const bootstrapRoutes = Object.entries(ROUTE_CAPABILITIES)
      .filter(([, guard]) => guard.kind === 'capability-after-bootstrap')
      .map(([key]) => key)
      .sort();
    expect(bootstrapRoutes).toEqual([
      'GET /admin/setup/status',
      'GET /admin/setup/wizard',
      'POST /admin/setup/owner',
      'POST /admin/setup/wizard',
      'POST /admin/users',
    ]);
  });
});

describe('the SPA shell never carries data past a denial', () => {
  async function secretsApp(role: string): Promise<FastifyInstance> {
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
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(cookie);
    await app.register(requestIdPlugin);
    await registerCapabilityStack(app, { role });
    await app.register(envelopePlugin);
    // No STATIC_ROOT: `adminSpaHtmlPreHandler` finds no index.html and falls
    // through, which is the configuration every other suite runs under. The
    // Accept-header matrix below is what this test is actually about.
    await registerAdminSecretsRoutes(app, {
      db: db as never,
      env: {} as never,
      keyring,
    } as RouteContext);
    await app.ready();
    return app;
  }

  const ACCEPTS = [
    '*/*',
    'application/json',
    'text/html',
    'text/html,application/json',
    'application/json,text/html',
    'text/html;q=0.9,application/json;q=0.8',
  ];

  it('never answers a refused role with a secret value, whatever it says it accepts', async () => {
    const app = await secretsApp('viewer');
    for (const accept of ACCEPTS) {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/secrets/1/reveal',
        headers: { accept },
      });
      expect(response.statusCode, `Accept: ${accept}`).toBe(403);
      expect(response.body).not.toContain('ghp_live_credential_value');
    }
  });

  it('never leaks the listing to a role without the capability', async () => {
    // `secrets.read_metadata` is held by every role, so the listing is the
    // wrong probe for a denial — the reveal above is. What this pins is the
    // other half: the listing that every role *can* read still cannot carry a
    // value, so the shell short-circuit has nothing to leak either way.
    const app = await secretsApp('viewer');
    for (const accept of ACCEPTS) {
      const response = await app.inject({ method: 'GET', url: '/admin/secrets', headers: { accept } });
      expect(response.statusCode, `Accept: ${accept}`).toBe(200);
      expect(response.body).not.toContain('ghp_live_credential_value');
    }
  });
});

describe("a read that turns into a credential read", () => {
  async function hostsApp(role: string): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(cookie);
    await app.register(requestIdPlugin);
    await registerCapabilityStack(app, { role });
    await app.register(envelopePlugin);
    await registerAdminHostsRoutes(app, { db: createDbFake() as never, env: {} as never, keyring } as RouteContext, {
      hostService: {
        requireById: async (id: number) => ({ id, name: "web01" }),
      } as never,
      authView: async (_host: unknown, _engine: unknown, includeBody: boolean) => ({
        canonical_last_refresh: "2026-08-17T00:00:00Z",
        canonical_digest: "sha256:abc",
        recent_digests: [],
        auth: includeBody ? { access_token: "oauth-live-fleet-token" } : null,
      }),
    } as never);
    await app.ready();
    return app;
  }

  const READERS = ["viewer", "user", "trusted_user", "fleet_operator"];

  it("serves the metadata to every role", async () => {
    for (const role of [...READERS, "owner", "admin"]) {
      const app = await hostsApp(role);
      const response = await app.inject({ method: "GET", url: "/admin/hosts/1/auth" });
      expect(response.statusCode, `${role}: ${response.body}`).toBe(200);
      expect(response.body).toContain("canonical_digest");
      expect(response.body).not.toContain("oauth-live-fleet-token");
    }
  });

  it("refuses the credential body to every role without auth.reveal_credential", async () => {
    for (const role of READERS) {
      const app = await hostsApp(role);
      const response = await app.inject({
        method: "GET",
        url: "/admin/hosts/1/auth?include_body=1",
      });
      expect(response.statusCode, `${role}: ${response.body}`).toBe(403);
      expect(response.json()).toMatchObject({
        code: "admin_role_required",
        required_capability: "auth.reveal_credential",
      });
      expect(response.body).not.toContain("oauth-live-fleet-token");
    }
  });

  it("serves the body to owner and admin", async () => {
    for (const role of ["owner", "admin"]) {
      const app = await hostsApp(role);
      const response = await app.inject({
        method: "GET",
        url: "/admin/hosts/1/auth?include_body=1",
      });
      expect(response.statusCode, `${role}: ${response.body}`).toBe(200);
      expect(response.body).toContain("oauth-live-fleet-token");
    }
  });

  it("keeps the reveal out of fleet_operator's grant on purpose", () => {
    // `auth.manage` lets a fleet operator replace the fleet's credential.
    // Reading the live one back out is the strictly more dangerous half.
    expect(roleHasCapability("fleet_operator", "auth.manage")).toBe(true);
    expect(roleHasCapability("fleet_operator", "auth.reveal_credential")).toBe(false);
  });
});
