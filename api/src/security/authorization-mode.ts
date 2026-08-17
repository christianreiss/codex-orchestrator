/**
 * How strictly the capability matrix is enforced, and the compatibility path
 * that lets an existing installation upgrade without losing access.
 *
 * The matrix in `capabilities.ts` is the authorization model this fleet should
 * have. It is not the model existing installations *have*: before it, six
 * hand-written gates covered 33 of the 225 governed routes, 11 were public,
 * and the remaining 181 were open to any authenticated account. Deployments in
 * the field were built on that. Their
 * operators had no reason to keep roles meaningful, because roles decided
 * almost nothing — so an installation whose entire team sits at `viewer` is
 * not a misconfiguration, it is the predictable result of the model we
 * shipped. Turning the matrix on under those accounts would lock people out of
 * their own orchestrator on a routine upgrade, and this project cannot
 * enumerate its installations to warn them.
 *
 * So enforcement has two modes:
 *
 * - `compatible` reproduces the pre-matrix behavior exactly. `owner` and
 *   `admin` keep everything; every other role is refused exactly the 33 routes
 *   the old gates covered and admitted to the other 181. Upgrading into this
 *   mode is a behavioral no-op, which is a claim
 *   `test/integration/security/authorization-compatibility.test.ts` proves
 *   route by route rather than asserts.
 * - `strict` applies the matrix.
 *
 * Migration `0022` picks the mode per installation: an existing one (the user
 * table has rows when it runs) gets `compatible`, a fresh one gets `strict`.
 * New deployments are therefore secure from the start, and nobody's upgrade
 * breaks. Moving to `strict` is an explicit, reversible operator decision, and
 * while a fleet sits in `compatible` every request that *would* be refused
 * under the matrix is recorded — so "what breaks if I switch" is answered with
 * that installation's own traffic instead of a warning in a changelog.
 *
 * The mode is a posture, not a loophole: see {@link ALWAYS_ENFORCED}.
 */

import { ROLE_ADMIN, ROLE_OWNER } from '../services/admin-auth.js';
import { CAPABILITIES, capabilitiesForRole, type Capability } from './capabilities.js';
import { ROUTE_CAPABILITIES } from './route-capabilities.js';

/** `versions` row holding the mode. */
export const AUTHORIZATION_MODE_FLAG = 'authorization_mode';

export const AUTHORIZATION_MODES = ['compatible', 'strict'] as const;
export type AuthorizationMode = (typeof AUTHORIZATION_MODES)[number];

/**
 * What a database with no row means. Only a pre-`0022` installation can be in
 * that state, since the migration writes the row either way — and defaulting a
 * database we cannot characterize to the stricter of the two is the safe
 * direction for a value that decides authorization.
 */
export const DEFAULT_AUTHORIZATION_MODE: AuthorizationMode = 'strict';

export function isAuthorizationMode(value: string): value is AuthorizationMode {
  return (AUTHORIZATION_MODES as readonly string[]).includes(value);
}

/** Parses a stored flag, falling back to {@link DEFAULT_AUTHORIZATION_MODE}. */
export function parseAuthorizationMode(raw: string | null | undefined): AuthorizationMode {
  return typeof raw === 'string' && isAuthorizationMode(raw) ? raw : DEFAULT_AUTHORIZATION_MODE;
}

/**
 * Every route the six removed gates covered, as they stood at `13b4093f` —
 * keyed the way `route-capabilities.ts` keys routes.
 *
 * This is the definition of `compatible`, so it is pinned rather than derived
 * from the matrix: deriving it would make compatibility agree with the new
 * model by construction, which is the one thing it must not do.
 * `capability-layer-invariants.test.ts` holds its own hand-written copy against
 * this one, so neither can be edited quietly.
 */
export const LEGACY_OWNER_ADMIN_ROUTES: ReadonlySet<string> = new Set([
  'DELETE /admin/agent-portal/users/:id',
  'DELETE /admin/hosts/:id',
  'DELETE /admin/memories/:scope/:recordId',
  'DELETE /admin/secrets/:id',
  'DELETE /admin/users/:id',
  'GET /admin/agent-portal/users/:id/link',
  'PATCH /admin/agent-messaging/addresses/:id',
  'PATCH /admin/memories/:scope/:recordId',
  'PATCH /admin/secrets/:id',
  'POST /admin/agent-messaging/addresses/:id/enabled',
  'POST /admin/agent-messaging/conversations/:id/cancel',
  'POST /admin/agent-messaging/messages/:id/redrive',
  'POST /admin/agent-messaging/messages/:id/reveal',
  'POST /admin/agent-messaging/state',
  'POST /admin/agent-portal/state',
  'POST /admin/agent-portal/users',
  'POST /admin/agent-portal/users/:id',
  'POST /admin/agent-portal/users/:id/enabled',
  'POST /admin/agent-portal/users/:id/rotate',
  'POST /admin/hosts/:id/engines',
  'POST /admin/hosts/:id/secure',
  'POST /admin/hosts/register',
  'POST /admin/memories/:scope',
  'POST /admin/memories/shared/:recordId/append',
  'POST /admin/secrets',
  'POST /admin/secrets/:id/reveal',
  'POST /admin/secrets/state',
  'POST /admin/skill-sources/mattpocock',
  'POST /admin/skill-sources/mattpocock/refresh',
  'POST /admin/users',
  'POST /admin/users/:id',
  'POST /admin/users/wipe',
  'POST /cli/auth/approve',
]);

/**
 * The capabilities `compatible` does not relax.
 *
 * Compatibility is a promise about *workflows an installation already had*, so
 * it is worth being precise about what these two are not: neither has ever had
 * a caller to preserve.
 *
 * - `auth.reveal_credential` guards `?include_body=1` on the host auth read,
 *   which returns the canonical credential the fleet distributes to its hosts.
 *   It was reachable by any signed-in account, and nothing calls it — not the
 *   console, not the wrappers, not the runner; `public/admin/manual` says the
 *   host detail page does not use it. Preserving it would preserve a
 *   straight privilege escalation for the benefit of no existing user.
 * - `security.manage_authorization` guards the mode itself. If compatible mode
 *   relaxed it, every account could switch the fleet's posture — including
 *   switching it back — and the mode would protect nothing.
 *
 * Enforced under both modes, and `assertCapability` refuses anything else.
 */
export const ALWAYS_ENFORCED: readonly Capability[] = [
  'auth.reveal_credential',
  'security.manage_authorization',
];

export function isAlwaysEnforced(capability: Capability): boolean {
  return ALWAYS_ENFORCED.includes(capability);
}

/**
 * Whether the pre-matrix installation would have admitted `role` to `routeKey`.
 *
 * The whole of `compatible`, in four lines, because that is genuinely all the
 * old behavior was: two roles that could do everything, and one flat list of
 * routes withheld from everyone else.
 */
export function legacyAllows(role: string, routeKey: string): boolean {
  if (role === ROLE_OWNER || role === ROLE_ADMIN) return true;
  return !LEGACY_OWNER_ADMIN_ROUTES.has(routeKey);
}

/**
 * The capabilities `compatible` leaves reachable for a role the matrix would
 * refuse: every capability with at least one route the old gates did not cover.
 *
 * A capability whose routes are *all* in the legacy set — `secrets.manage`,
 * `memory.write`, `agent_portal.manage` — is genuinely unreachable, so it is
 * absent and the console hides those controls exactly as it does under
 * `strict`.
 */
const COMPATIBLE_CAPABILITIES: readonly Capability[] = (() => {
  const reachable = new Set<Capability>();
  for (const [key, guard] of Object.entries(ROUTE_CAPABILITIES)) {
    if (guard.kind === 'public') continue;
    // A bootstrap route is reachable only while the installation has no owner,
    // which is to say only when nobody is signed in to be told about it.
    // Counting it would grant `users.manage` to every role on the strength of
    // `POST /admin/setup/owner` — and the console would start offering user
    // management to a `viewer` who never saw it before, on an installation
    // where that route has been closed since the day it was set up.
    if (guard.kind === 'capability-after-bootstrap') continue;
    if (LEGACY_OWNER_ADMIN_ROUTES.has(key)) continue;
    reachable.add(guard.capability);
  }
  for (const capability of ALWAYS_ENFORCED) reachable.delete(capability);
  return CAPABILITIES.filter((capability) => reachable.has(capability));
})();

/**
 * What to tell the console this session may do.
 *
 * Under `strict` this is the role's row of the matrix. Under `compatible` it is
 * that row widened by what compatibility still allows — because the console
 * uses this to *hide* controls, and hiding one that the server would have
 * served is precisely the upgrade breakage this mode exists to prevent. Where
 * the two disagree the answer errs toward showing the control: a button that
 * 403s is the behavior these installations already have, and a button that
 * vanished is the one an operator files a bug about.
 *
 * Presentation only, as ever. The server re-decides on the request itself.
 */
export function effectiveCapabilities(
  role: string,
  mode: AuthorizationMode,
): readonly Capability[] {
  if (mode === 'strict') return capabilitiesForRole(role);
  if (role === ROLE_OWNER || role === ROLE_ADMIN) return CAPABILITIES;
  const held = new Set<Capability>([...capabilitiesForRole(role), ...COMPATIBLE_CAPABILITIES]);
  return CAPABILITIES.filter((capability) => held.has(capability));
}
