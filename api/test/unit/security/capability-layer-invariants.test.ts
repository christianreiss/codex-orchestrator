/**
 * Two things this suite has to keep true about the capability layer, neither of
 * which the coverage gate can see.
 *
 * **Nothing widened.** Before the layer existed, six hand-written preHandlers
 * were the only authorization in the tree, and each admitted `owner` and
 * `admin` alone. Replacing them with a matrix is an opportunity to quietly hand
 * one of those 33 routes to `fleet_operator` — the change would typecheck,
 * every route test would still pass, and the regression would read as
 * intentional. So the pinned list below is held against the shipped matrix:
 * each of those routes must still resolve to a capability that no role beyond
 * owner and admin holds.
 *
 * **No gate grows back.** The layer is only single-source while nothing else
 * compares a role. A `if (role !== ROLE_ADMIN)` added to a route file would not
 * fail any other test — it would just quietly become a second, invisible
 * authorization system, which is the state this all replaced. So the route tree
 * is scanned for role comparisons, and there must be none.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles, stripComments } from '../routes/registered-routes.js';
import { VALID_ACCESS_LEVELS } from '../../../src/services/admin-auth.js';
import { roleHasCapability, type Capability } from '../../../src/security/capabilities.js';
import { guardForRoute } from '../../../src/security/route-capabilities.js';
import { LEGACY_OWNER_ADMIN_ROUTES } from '../../../src/security/authorization-mode.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(HERE, '../../../src');
const ROUTES_DIR = join(API_SRC, 'routes');

/**
 * Every route the six removed gates covered, as they stood at `13b4093f`. This
 * is the no-widening oracle, so it is pinned rather than derived: deriving it
 * from the matrix would make it agree with the matrix by construction.
 */
const PREVIOUSLY_OWNER_ADMIN_ONLY: Array<[string, string]> = [
  ['DELETE', '/admin/agent-portal/users/:id'],
  ['DELETE', '/admin/hosts/:id'],
  ['DELETE', '/admin/memories/:scope/:recordId'],
  ['DELETE', '/admin/secrets/:id'],
  ['DELETE', '/admin/users/:id'],
  // Reads the permanent portal link back out of storage: a GET, but bearer
  // material, so it carries the same gate as the mutations.
  ['GET', '/admin/agent-portal/users/:id/link'],
  ['PATCH', '/admin/agent-messaging/addresses/:id'],
  ['PATCH', '/admin/memories/:scope/:recordId'],
  ['PATCH', '/admin/secrets/:id'],
  ['POST', '/admin/agent-messaging/addresses/:id/enabled'],
  ['POST', '/admin/agent-messaging/conversations/:id/cancel'],
  ['POST', '/admin/agent-messaging/messages/:id/redrive'],
  ['POST', '/admin/agent-messaging/messages/:id/reveal'],
  ['POST', '/admin/agent-messaging/state'],
  ['POST', '/admin/agent-portal/state'],
  ['POST', '/admin/agent-portal/users'],
  ['POST', '/admin/agent-portal/users/:id'],
  ['POST', '/admin/agent-portal/users/:id/enabled'],
  ['POST', '/admin/agent-portal/users/:id/rotate'],
  ['POST', '/admin/hosts/:id/engines'],
  ['POST', '/admin/hosts/:id/secure'],
  ['POST', '/admin/hosts/register'],
  ['POST', '/admin/memories/:scope'],
  ['POST', '/admin/memories/shared/:recordId/append'],
  ['POST', '/admin/secrets'],
  ['POST', '/admin/secrets/:id/reveal'],
  ['POST', '/admin/secrets/state'],
  ['POST', '/admin/skill-sources/mattpocock'],
  ['POST', '/admin/skill-sources/mattpocock/refresh'],
  ['POST', '/admin/users'],
  ['POST', '/admin/users/:id'],
  ['POST', '/admin/users/wipe'],
  ['POST', '/cli/auth/approve'],
];

const PRIVILEGED_ROLES = ['owner', 'admin'];
const UNPRIVILEGED_ROLES = VALID_ACCESS_LEVELS.filter(
  (role) => !PRIVILEGED_ROLES.includes(role),
);

/**
 * A role name compared against something. Catches `role === ROLE_ADMIN`,
 * `level !== 'owner'`, `[ROLE_OWNER, ROLE_ADMIN].includes(...)` and the
 * `accessLevel` reads that lead to them.
 */
const ROLE_COMPARISON = /\bROLE_(?:OWNER|ADMIN|VIEWER|FLEET|TRUSTED|USER)\b|\baccessLevel\s*[!=]==/;

const ROUTE_SOURCES = sourceFiles(ROUTES_DIR, ['.ts']).map((file) => ({
  file,
  source: stripComments(readFileSync(join(ROUTES_DIR, file), 'utf8')),
}));

describe('the compatibility oracle', () => {
  it('matches the list compatibility mode actually enforces', () => {
    // `LEGACY_OWNER_ADMIN_ROUTES` decides what `compatible` refuses, so it is
    // runtime policy, not test data — but this file's copy stays hand-written
    // and independent. Sharing one list would make the no-widening check above
    // agree with compatibility by construction, and editing either alone is
    // exactly the mistake worth catching.
    expect([...LEGACY_OWNER_ADMIN_ROUTES].sort()).toEqual(
      PREVIOUSLY_OWNER_ADMIN_ONLY.map(([method, url]) => `${method} ${url}`).sort(),
    );
  });
});

describe('capability layer invariants', () => {
  it('reads the route tree and the roles it holds it against', () => {
    // A scan that matched nothing would pass every assertion below.
    expect(ROUTE_SOURCES.length).toBeGreaterThan(20);
    expect(ROUTE_SOURCES.some(({ source }) => source.includes('app.requireAdmin'))).toBe(true);
    expect(UNPRIVILEGED_ROLES.length).toBeGreaterThanOrEqual(3);
    expect(UNPRIVILEGED_ROLES).toContain('fleet_operator');
    expect(ROLE_COMPARISON.test("if (role !== ROLE_ADMIN) throw x;")).toBe(true);
  });

  it('still admits only owner and admin to every route the removed gates covered', () => {
    const widened: string[] = [];
    for (const [method, url] of PREVIOUSLY_OWNER_ADMIN_ONLY) {
      const guard = guardForRoute(method, url);
      if (!guard || guard.kind === 'public') {
        widened.push(`${method} ${url} lost its gate entirely`);
        continue;
      }
      const capability: Capability = guard.capability;
      for (const role of UNPRIVILEGED_ROLES) {
        if (roleHasCapability(role, capability)) {
          widened.push(`${method} ${url} (${capability}) is now open to ${role}`);
        }
      }
      for (const role of PRIVILEGED_ROLES) {
        if (!roleHasCapability(role, capability)) {
          widened.push(`${method} ${url} (${capability}) no longer admits ${role}`);
        }
      }
    }
    expect(
      widened,
      'the capability layer replaced these gates; it must not relax one of them',
    ).toEqual([]);
  });

  it('leaves no role comparison anywhere in the route tree', () => {
    const strays = ROUTE_SOURCES.flatMap(({ file, source }) =>
      source
        .split('\n')
        .map((text, index) => ({ text, line: index + 1 }))
        .filter(({ text }) => ROLE_COMPARISON.test(text))
        .map(({ line, text }) => `routes/${file}:${line} ${text.trim()}`),
    );
    expect(
      strays,
      'authorization belongs in src/security/route-capabilities.ts, not in a route file',
    ).toEqual([]);
  });

  it('routes every governed mutation through a manage-shaped capability', () => {
    // A `.read` capability on a mutation would be a typo the coverage gate
    // cannot see: the route is mapped, so it passes, but every viewer can call
    // it. Reads are allowed on POST — preview and render endpoints take a body
    // — so the rule runs the other way: no mutating verb may carry `.read`.
    const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    /** POSTs that only project a preview, and are reads on purpose. */
    const PREVIEW_POSTS = new Set([
      'POST /admin/agents/render',
      'POST /admin/agents/compose',
      'POST /admin/config/render',
      'POST /admin/claude/config/render',
    ]);
    const suspicious: string[] = [];
    for (const [method, url] of PREVIOUSLY_OWNER_ADMIN_ONLY) {
      if (!MUTATING.has(method)) continue;
      const guard = guardForRoute(method, url);
      if (guard?.kind !== 'capability') continue;
      if (guard.capability.endsWith('.read') && !PREVIEW_POSTS.has(`${method} ${url}`)) {
        suspicious.push(`${method} ${url} mutates behind ${guard.capability}`);
      }
    }
    expect(suspicious).toEqual([]);
  });
});
