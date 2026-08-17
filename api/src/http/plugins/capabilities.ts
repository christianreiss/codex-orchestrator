/**
 * Enforcement for the capability layer.
 *
 * Every route Fastify registers under a governed prefix gets its guard looked
 * up in `security/route-capabilities.ts` at registration time, and the matching
 * preHandler attached. Three properties follow, and each is the reason this is
 * a hook rather than an argument at 225 call sites:
 *
 * - **Nothing is ungated by omission.** A route with no inventory entry is not
 *   quietly session-only; the server refuses to start and names it. Adding a
 *   route now means deciding who may call it.
 * - **The policy is one file.** A reviewer reads the inventory, not 40 route
 *   modules, to answer "who can delete a host".
 * - **The check cannot be forgotten in a later edit.** It is not written down
 *   next to the handler, so it cannot be dropped while moving one.
 *
 * The complaint is collected across the whole tree and raised once at `onReady`
 * rather than at the first offending route, so a fresh route file reports all
 * of its gaps in a single failure instead of one per restart.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../errors.js';
import { capabilitiesForRole, roleHasCapability, type Capability } from '../../security/capabilities.js';
import {
  DEFAULT_AUTHORIZATION_MODE,
  isAlwaysEnforced,
  legacyAllows,
  LEGACY_OWNER_ADMIN_ROUTES,
  type AuthorizationMode,
} from '../../security/authorization-mode.js';
import {
  createAuthorizationModeService,
  type AuthorizationModeService,
} from '../../services/authorization-mode.js';
import {
  guardForRoute,
  isGovernedRoute,
  routeKey,
  type RouteGuard,
} from '../../security/route-capabilities.js';

/**
 * The 403 code a capability denial answers with. Unchanged from the six
 * hand-written role gates this layer replaces: the admin console and the
 * `docs/LOGIN.md` contract both key off it, and a denial is a denial whether it
 * came from a gate or from the matrix.
 */
export const CAPABILITY_DENIED_CODE = 'admin_role_required';

/** Marks a preHandler as this plugin's, so the hook never stacks two. */
const CAPABILITY_TAG = Symbol.for('codex.capabilityGuard');

interface TaggedHandler {
  (req: FastifyRequest): Promise<void>;
  [CAPABILITY_TAG]?: Capability;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * A preHandler requiring `capability`. Routes under a governed prefix get
     * theirs attached automatically from the inventory; this is for the rest of
     * the tree — anywhere an admin session authorizes an action outside
     * `/admin/*`.
     */
    requireCapability(capability: Capability, route?: string): preHandlerHookHandler;
    /**
     * The mode service, or `null` where there is no database to read it from.
     * Routes that report or change the mode read it here.
     */
    authorizationMode: AuthorizationModeService | null;
    /**
     * Checks a capability from inside a handler, for the rare route whose
     * sensitivity depends on the request rather than on the URL — a query
     * parameter that turns a metadata read into a credential read, say. The
     * route still carries its floor capability from the inventory; this raises
     * it for the requests that earn it.
     *
     * Still not an ad-hoc role check: the decision comes from the same matrix,
     * and the caller names a capability, never a role.
     *
     * Restricted to `ALWAYS_ENFORCED` capabilities, since a check with no route
     * key cannot honor compatibility mode. Anything else throws.
     */
    assertCapability(req: FastifyRequest, capability: Capability): Promise<void>;
  }
  interface FastifyRequest {
    /** The capability that admitted this request, for audit and diagnostics. */
    grantedCapability?: Capability;
  }
}

export interface CapabilitiesPluginOptions {
  /**
   * Supplies the fleet's authorization mode. Defaults to a service over
   * `app.db`, and to permanent `strict` where there is no database — which is
   * every narrow plugin test, and the right default for one: a test that has
   * not set a mode is asking about the matrix.
   */
  service?: AuthorizationModeService | null;
}

export function makeCapabilitiesPlugin(options: CapabilitiesPluginOptions = {}) {
  return fp(
    async function capabilitiesPlugin(app: FastifyInstance) {
      const service =
        options.service !== undefined
          ? options.service
          : app.hasDecorator('db') && app.db
            ? createAuthorizationModeService(app.db)
            : null;

      if (!app.hasDecorator('authorizationMode')) {
        app.decorate('authorizationMode', service);
      }

      const currentMode = async (): Promise<AuthorizationMode> =>
        service ? await service.getMode() : DEFAULT_AUTHORIZATION_MODE;

      /**
       * Resolves the session if an earlier preHandler has not already, then
       * decides. Idempotent on `req.admin` so stacking this behind the existing
       * `requireAdmin` costs no second session lookup.
       *
       * `route` is the inventory key this guard was attached for, and is what
       * lets `compatible` answer the only question it asks: would the
       * pre-matrix installation have allowed this? A check raised from inside a
       * handler has no route key and is always strict — see `assertCapability`.
       */
      const enforce = async (
        req: FastifyRequest,
        capability: Capability,
        route: string | null,
      ): Promise<void> => {
        if (!req.admin) {
          const ctx = await app.resolveAdmin(req);
          if (!ctx) throw new UnauthorizedError('Admin session required', 'admin_required');
          if (!ctx.user.active) throw new ForbiddenError('Account disabled', 'admin_disabled');
          req.admin = ctx;
        }

        const role = req.admin.user.accessLevel;
        const holdsCapability = roleHasCapability(role, capability);
        const refuse = (): never => {
          throw new ForbiddenError('Insufficient access level', CAPABILITY_DENIED_CODE, {
            required_capability: capability,
          });
        };

        // Two things force the matrix regardless of posture: a capability that
        // compatibility never relaxes, and a check with no route key — which
        // has no pre-matrix answer to reproduce. Both leave `route` unused
        // below, so the narrowing here is the invariant, not a convenience.
        if (route === null || isAlwaysEnforced(capability) || (await currentMode()) === 'strict') {
          if (!holdsCapability) refuse();
          req.grantedCapability = capability;
          return;
        }

        // `compatible`: the pre-matrix installation is the authority. Refuse
        // exactly what the six old gates refused, and nothing else.
        if (!legacyAllows(role, route)) refuse();
        if (!holdsCapability) {
          // Allowed here, refused under the matrix. This is the sample that
          // turns "switch to strict and find out" into a list an operator can
          // read before deciding.
          void service?.recordWouldDeny({ role, capability, route });
        }
        req.grantedCapability = capability;
      };

      const guardFor = (capability: Capability, route: string): TaggedHandler => {
        const handler: TaggedHandler = async function requireCapability(req) {
          await enforce(req, capability, route);
        };
        handler[CAPABILITY_TAG] = capability;
        return handler;
      };

      const strictGuardFor = (capability: Capability): TaggedHandler => {
        const handler: TaggedHandler = async function requireCapabilityStrictly(req) {
          await enforce(req, capability, null);
        };
        handler[CAPABILITY_TAG] = capability;
        return handler;
      };

      /**
       * The bootstrap variant. Before an installation has its first owner these
       * routes run unauthenticated — the handler's own gate lets them through
       * only while the user table is empty. Once a session exists, the
       * capability applies exactly as everywhere else, so the window closes on
       * the same request that opens an account.
       *
       * The anonymous branch passes because a route classified this way carries
       * its own gate — `requireAdminAfterSetup`, `requireAdminOrBootstrap` —
       * which counts users and demands a session once there is one. That is a
       * load-bearing assumption held in another file, so the `onRoute` hook
       * below refuses to start such a route if it carries no other preHandler.
       */
      const bootstrapGuardFor = (capability: Capability, route: string): TaggedHandler => {
        const handler: TaggedHandler = async function requireCapabilityAfterBootstrap(req) {
          const ctx = req.admin ?? (await app.resolveAdmin(req));
          if (!ctx) return;
          req.admin = ctx;
          await enforce(req, capability, route);
        };
        handler[CAPABILITY_TAG] = capability;
        return handler;
      };

      app.decorate(
        'requireCapability',
        (capability: Capability, route?: string): preHandlerHookHandler => {
          // No route key means no pre-matrix behavior to reproduce: this is for
          // routes outside the governed prefixes, which the old gates never
          // covered and which therefore have no compatibility claim to honor.
          return (
            route === undefined ? strictGuardFor(capability) : guardFor(capability, route)
          ) as unknown as preHandlerHookHandler;
        },
      );

      app.decorate('assertCapability', async (req: FastifyRequest, capability: Capability) => {
        if (!isAlwaysEnforced(capability)) {
          // A mid-handler check cannot consult `compatible` — it exists
          // precisely because the URL does not describe the sensitivity, so
          // there is no route key whose pre-matrix answer would mean anything.
          // Rather than silently enforcing something compatible mode was
          // supposed to relax, refuse to be used that way at all.
          throw new Error(
            `assertCapability(${capability}) is not permitted: a capability checked from ` +
              `inside a handler bypasses compatibility mode, so it must be listed in ` +
              `ALWAYS_ENFORCED in src/security/authorization-mode.ts`,
          );
        }
        await enforce(req, capability, null);
      });

      /** Reasons the tree cannot be served, collected across every route. */
      const complaints: string[] = [];

      app.addHook('onRoute', (route) => {
        if (!isGovernedRoute(route.url)) return;

        // A route's methods are registered together and share one preHandler
        // chain, so they must resolve to one guard. `HEAD` folds onto `GET`.
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        const guards = new Set<RouteGuard | undefined>(
          methods.map((method) => guardForRoute(method, route.url)),
        );

        if (guards.has(undefined) || guards.size !== 1) {
          for (const method of methods) {
            if (guardForRoute(method, route.url) === undefined) {
              complaints.push(
                `${routeKey(method, route.url)} has no entry in src/security/route-capabilities.ts`,
              );
            }
          }
          if (guards.size > 1) {
            complaints.push(`${route.url} — its methods disagree on their capability`);
          }
          return;
        }

        const guard = [...guards][0]!;
        if (guard.kind === 'public') return;

        const existing = Array.isArray(route.preHandler)
          ? route.preHandler
          : route.preHandler
            ? [route.preHandler]
            : [];
        if (existing.some((h) => (h as TaggedHandler)[CAPABILITY_TAG] !== undefined)) return;

        if (guard.kind === 'capability-after-bootstrap' && existing.length === 0) {
          // The one classification whose anonymous path is open by design, and
          // therefore the one that must never be the *only* thing on the route.
          complaints.push(
            `${route.url} is classified capability-after-bootstrap but carries no gate of ` +
              `its own — an anonymous caller would reach the handler on a set-up installation`,
          );
          return;
        }

        // Appended, never prepended: routes that serve the admin SPA's HTML
        // shell put that preHandler first on purpose, so a browser navigating
        // to /admin/secrets gets the app instead of a 401 JSON body. It replies
        // and short-circuits the chain before this ever runs; an XHR asking for
        // JSON falls through to it.
        // One key for the whole chain, so the methods must also agree on
        // whether the pre-matrix installation gated them. They agreed on a
        // capability above, which makes disagreement here very unlikely — and
        // exactly the kind of unlikely that should stop the server rather than
        // be resolved by taking the first method's answer.
        const keys = [...new Set(methods.map((method) => routeKey(method, route.url)))];
        const legacyStates = new Set(keys.map((key) => LEGACY_OWNER_ADMIN_ROUTES.has(key)));
        if (legacyStates.size > 1) {
          complaints.push(
            `${route.url} — its methods share a capability but disagree on whether the ` +
              `pre-matrix installation gated them, so compatibility mode cannot answer for ` +
              `them as one route`,
          );
          return;
        }
        const key = keys[0]!;
        const handler =
          guard.kind === 'capability-after-bootstrap'
            ? bootstrapGuardFor(guard.capability, key)
            : guardFor(guard.capability, key);
        route.preHandler = [...existing, handler as unknown as preHandlerHookHandler];
      });

      app.addHook('onReady', async () => {
        if (complaints.length === 0) return;
        const list = [...new Set(complaints)].sort().join('\n  ');
        throw new Error(
          `${complaints.length} route(s) under a governed prefix cannot be served as ` +
            `configured. Assign each one a capability in ` +
            `src/security/route-capabilities.ts (or an explicit public entry with the ` +
            `reason it must be reachable unauthenticated):\n  ${list}`,
        );
      });
    },
    { name: 'capabilities', dependencies: ['auth-admin'] },
  );
}

/** The capabilities to report to a signed-in console. */
export function effectiveCapabilities(role: string): readonly Capability[] {
  return capabilitiesForRole(role);
}
