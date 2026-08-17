/**
 * The promise made to every installation in the field: upgrading into
 * `compatible` mode changes nothing about who can do what.
 *
 * That is not a claim to assert in a changelog and hope for. This project
 * cannot enumerate its deployments, cannot warn their operators, and cannot
 * roll a bad upgrade back for them — an installation whose whole team sits at
 * `viewer` is the predictable result of shipping a product where roles decided
 * almost nothing, and `strict` would lock those people out of their own
 * orchestrator. So the claim is proven here exhaustively rather than sampled:
 * every role against every route in the inventory, through the real plugin and
 * the real `onRoute` wiring, with the pre-matrix rules as the oracle.
 *
 * The oracle is deliberately dumb, because the old behavior was: two roles
 * could do everything, one flat list of 33 routes was withheld from everyone
 * else, and the remaining 181 guarded routes were open to any authenticated
 * account.
 *
 * `strict`'s own behavior is pinned by `capability-matrix.test.ts`; what this
 * file adds is that turning it on is a *decision*, not a side effect of
 * upgrading.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';
import { VALID_ACCESS_LEVELS } from '../../../src/services/admin-auth.js';
import { ROUTE_CAPABILITIES } from '../../../src/security/route-capabilities.js';
import {
  ALWAYS_ENFORCED,
  effectiveCapabilities,
  legacyAllows,
  LEGACY_OWNER_ADMIN_ROUTES,
} from '../../../src/security/authorization-mode.js';
import { capabilitiesForRole } from '../../../src/security/capabilities.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Every inventory entry, as a method + Fastify URL pattern. */
const INVENTORY = Object.entries(ROUTE_CAPABILITIES).map(([key, guard]) => {
  const gap = key.indexOf(' ');
  return { key, method: key.slice(0, gap), url: key.slice(gap + 1), guard };
});

/**
 * The capabilities compatibility does not relax, and the routes carrying them.
 * Excluded from the no-op proof because they are the documented exceptions —
 * and each is exercised on its own below rather than skipped quietly.
 */
const ALWAYS_ENFORCED_ROUTES = new Set(
  INVENTORY.filter(
    (route) =>
      route.guard.kind !== 'public' &&
      (ALWAYS_ENFORCED as readonly string[]).includes(route.guard.capability),
  ).map((route) => route.key),
);

/**
 * An app serving the whole inventory, so the capability layer decides against
 * the real route table rather than a handful of representative URLs.
 */
async function inventoryApp(options: {
  role: string;
  mode: 'compatible' | 'strict';
  onWouldDeny?: (record: { role: string; capability: string; route: string }) => void;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(requestIdPlugin);
  await registerCapabilityStack(app, {
    role: options.role,
    mode: options.mode,
    onWouldDeny: options.onWouldDeny,
  });
  await app.register(envelopePlugin);

  for (const route of INVENTORY) {
    // A bootstrap-classified route must carry a gate of its own or the plugin
    // refuses to start. On a set-up installation that gate demands a session,
    // and every caller here has one, so it passes through to the capability
    // decision — which is what this file measures.
    const preHandler =
      route.guard.kind === 'capability-after-bootstrap' ? [async (): Promise<void> => {}] : [];
    app.route({
      method: route.method as 'GET',
      url: route.url,
      preHandler,
      handler: async () => ({ reached: 'handler' }),
    });
  }
  await app.ready();
  return app;
}

/** What the pre-matrix installation would have answered. */
function legacyStatus(role: string, key: string): 200 | 403 {
  if (role === 'owner' || role === 'admin') return 200;
  return LEGACY_OWNER_ADMIN_ROUTES.has(key) ? 403 : 200;
}

describe('compatible mode reproduces the pre-matrix installation', () => {
  for (const role of VALID_ACCESS_LEVELS) {
    it(`answers every route exactly as it did before the matrix, for ${role}`, async () => {
      const app = await inventoryApp({ role, mode: 'compatible' });

      const wrong: string[] = [];
      let probed = 0;
      for (const route of INVENTORY) {
        if (route.guard.kind === 'public') continue;
        if (ALWAYS_ENFORCED_ROUTES.has(route.key)) continue;
        probed += 1;

        const response = await app.inject({
          method: route.method as 'GET',
          url: route.url.replace(/:[A-Za-z0-9_]+/g, '1'),
        });
        const expected = legacyStatus(role, route.key);
        const actual = response.statusCode === 403 ? 403 : 200;
        if (actual !== expected) {
          wrong.push(`${route.key}: expected ${expected}, got ${response.statusCode}`);
        }
      }

      expect(wrong, `${role} would see behavior change on upgrade`).toEqual([]);
      // A proof by exhaustion is only a proof if the loop ran. Pinning the
      // count keeps a filter bug from turning this into a green no-op, and
      // makes the coverage visible: every guarded route bar the two the
      // exceptions cover, checked for every role.
      expect(probed).toBe(
        INVENTORY.filter((route) => route.guard.kind !== 'public').length -
          ALWAYS_ENFORCED_ROUTES.size,
      );
      expect(probed).toBeGreaterThan(200);
    });
  }

  it('withholds exactly the 33 routes the old gates covered, and no more', () => {
    // Guards the oracle itself: if someone adds a route to the legacy set to
    // make a test pass, the count moves and this fails.
    expect(LEGACY_OWNER_ADMIN_ROUTES.size).toBe(33);
    const unknown = [...LEGACY_OWNER_ADMIN_ROUTES].filter(
      (key) => !(key in ROUTE_CAPABILITIES),
    );
    expect(unknown, 'a legacy route that no longer exists in the inventory').toEqual([]);
  });

  it('leaves owner and admin able to reach everything, as before', async () => {
    for (const role of ['owner', 'admin']) {
      const app = await inventoryApp({ role, mode: 'compatible' });
      for (const route of INVENTORY) {
        if (route.guard.kind === 'public') continue;
        const response = await app.inject({
          method: route.method as 'GET',
          url: route.url.replace(/:[A-Za-z0-9_]+/g, '1'),
        });
        expect(response.statusCode, `${role} ${route.key}`).not.toBe(403);
      }
    }
  });
});

describe('what the console is told it may do', () => {
  /**
   * Enforcement and the console's capability list are two independent
   * derivations: the guard consults `legacyAllows` per route, while
   * `effectiveCapabilities` scans the inventory for capabilities that still
   * have a reachable route. Nothing forces them to agree, and disagreement in
   * one direction is silent — a control that vanishes for a role the server
   * would happily have served produces no 403, no log line, and no failing
   * request. It just looks like the feature was removed, which is exactly the
   * upgrade experience compatible mode exists to prevent.
   *
   * Only the under-grant direction is checked. Over-granting is deliberate and
   * documented: a button that 403s is the behavior these installations already
   * have, and hiding one is the regression.
   */
  for (const role of VALID_ACCESS_LEVELS) {
    it(`never hides a control compatible mode would serve, for ${role}`, () => {
      const granted = new Set(effectiveCapabilities(role, 'compatible'));
      const hidden: string[] = [];

      for (const route of INVENTORY) {
        if (route.guard.kind === 'public') continue;
        if (ALWAYS_ENFORCED_ROUTES.has(route.key)) continue;
        // Bootstrap routes are open only before the first owner exists — i.e.
        // when there is no session to show a control to. They are not a
        // control the console can hide, and counting them would demand
        // `users.manage` be offered to every role on the strength of
        // `POST /admin/setup/owner`.
        if (route.guard.kind === 'capability-after-bootstrap') continue;
        if (!legacyAllows(role, route.key)) continue;
        if (!granted.has(route.guard.capability)) {
          hidden.push(`${route.key} needs ${route.guard.capability}`);
        }
      }

      expect(hidden, `${role} would lose a control the server still serves`).toEqual([]);
    });
  }

  it('still hides what compatibility genuinely cannot reach', () => {
    // The other half: capabilities whose every route is in the legacy set are
    // unreachable for a viewer, so the console must not offer them. Without
    // this, "never hide anything" would be satisfiable by granting everything.
    const granted = new Set(effectiveCapabilities('viewer', 'compatible'));

    // The five surfaces the old console hand-gated on `owner|admin`. A viewer
    // never saw these controls, so compatibility must not start showing them.
    expect(granted.has('users.manage')).toBe(false);
    expect(granted.has('secrets.manage')).toBe(false);
    expect(granted.has('secrets.reveal')).toBe(false);
    expect(granted.has('agent_portal.manage')).toBe(false);
    expect(granted.has('agent_messaging.manage')).toBe(false);
    // And the posture switch, and the transitions the old gate covered.
    expect(granted.has('security.manage_authorization')).toBe(false);
    expect(granted.has('hosts.security_transition')).toBe(false);

    // What a viewer plainly could do before, it is still offered.
    expect(granted.has('settings.manage')).toBe(true);
    expect(granted.has('hosts.manage')).toBe(true);
    expect(granted.has('content.manage')).toBe(true);
    expect(granted.has('keys.manage')).toBe(true);

    // `memory.write` is granted, and that is not an oversight. The six old
    // gates covered `/admin/memories/*` and never covered
    // `DELETE /admin/shared-memories/:slug` or `DELETE /admin/mcp/memories/:id`,
    // which carry the same capability — so a signed-in viewer really could
    // delete shared and MCP memories, and compatibility reproduces that
    // faithfully rather than quietly fixing it. `strict` is where it closes.
    expect(granted.has('memory.write')).toBe(true);
    expect(capabilitiesForRole('viewer')).not.toContain('memory.write');
  });

  it('reports the matrix unchanged under strict', () => {
    expect([...effectiveCapabilities('viewer', 'strict')]).toEqual([
      ...capabilitiesForRole('viewer'),
    ]);
  });
});

describe('the exceptions are exceptions, not holes', () => {
  it('enforces the always-enforced capabilities even under compatible', async () => {
    const app = await inventoryApp({ role: 'viewer', mode: 'compatible' });
    for (const key of ALWAYS_ENFORCED_ROUTES) {
      const route = INVENTORY.find((candidate) => candidate.key === key)!;
      const response = await app.inject({
        method: route.method as 'GET',
        url: route.url.replace(/:[A-Za-z0-9_]+/g, '1'),
      });
      expect(response.statusCode, `${key} must not be relaxed by compatible mode`).toBe(403);
    }
  });

  it('covers the posture switch itself, so no account can relax its own fleet', () => {
    // The failure this prevents: `security.manage_authorization` folded into
    // `settings.manage`, which compatible mode grants to everyone — leaving a
    // viewer able to flip the fleet to compatible and back.
    expect([...ALWAYS_ENFORCED_ROUTES].sort()).toEqual([
      'GET /admin/authorization',
      'POST /admin/authorization',
    ]);
  });
});

describe('the dry-run record', () => {
  it('names what strict would refuse, without refusing it', async () => {
    const seen: Array<{ role: string; capability: string; route: string }> = [];
    const app = await inventoryApp({ role: 'viewer', mode: 'compatible', onWouldDeny: (r) => seen.push(r) });

    // Open before the matrix, refused by it: a viewer holds `settings.read`
    // but not `settings.manage`.
    const response = await app.inject({ method: 'POST', url: '/admin/auto-update' });
    expect(response.statusCode).not.toBe(403);
    expect(seen).toContainEqual({
      role: 'viewer',
      capability: 'settings.manage',
      route: 'POST /admin/auto-update',
    });
  });

  it('stays quiet for a request the matrix would have allowed anyway', async () => {
    const seen: Array<{ role: string; capability: string; route: string }> = [];
    const app = await inventoryApp({ role: 'viewer', mode: 'compatible', onWouldDeny: (r) => seen.push(r) });

    const response = await app.inject({ method: 'GET', url: '/admin/auto-update' });
    expect(response.statusCode).not.toBe(403);
    expect(seen).toEqual([]);
  });

  it('records nothing at all under strict, where denials are real', async () => {
    const seen: Array<{ role: string; capability: string; route: string }> = [];
    const app = await inventoryApp({ role: 'viewer', mode: 'strict', onWouldDeny: (r) => seen.push(r) });

    const response = await app.inject({ method: 'POST', url: '/admin/auto-update' });
    expect(response.statusCode).toBe(403);
    expect(seen).toEqual([]);
  });
});
