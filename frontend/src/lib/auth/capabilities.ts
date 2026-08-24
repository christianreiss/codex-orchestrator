/**
 * The console's view of what the signed-in operator may do.
 *
 * `GET /admin/auth/status` returns the caller's row of the server's
 * role→capability matrix. This module is the only place the console reads it,
 * and it is presentation only: hiding a button stops a mistake, it does not
 * stop a request. Every capability is re-checked server-side on the call
 * itself, so a console running an older bundle — or one an operator has edited
 * in devtools — gains nothing by lying to itself here.
 *
 * The names are mirrored from `api/src/security/capabilities.ts`.
 * `capability-parity.test.ts` reads both files and fails when they drift, so a
 * capability renamed on the server cannot leave a control permanently disabled
 * (or permanently enabled) here.
 */

export const CAPABILITIES = [
  "admin.read",
  "account.self_manage",
  "users.read",
  "users.manage",
  "hosts.read",
  "hosts.manage",
  "hosts.security_transition",
  "hosts.activate_insecure",
  "settings.read",
  "settings.manage",
  "security.manage_authorization",
  "auth.read_metadata",
  "auth.manage",
  "auth.reveal_credential",
  "keys.manage",
  "content.read",
  "content.manage",
  "memory.read",
  "memory.write",
  "projects.read",
  "projects.manage",
  "secrets.read_metadata",
  "secrets.reveal",
  "secrets.manage",
  "agent_portal.read",
  "agent_portal.reveal_link",
  "agent_portal.manage",
  "agent_messaging.read",
  "agent_messaging.reveal_content",
  "agent_messaging.manage",
  "git_director.read",
  "git_director.manage",
  "audit.read",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * How the fleet enforces the matrix.
 *
 * `compatible` reproduces the rules an installation had before the capability
 * layer existed, so upgrading into it changes nothing for anyone; `strict`
 * applies the matrix. Existing installations are migrated into `compatible`
 * and switch when their operator decides to, which is why the console shows
 * the posture rather than assuming one.
 */
export type AuthorizationMode = "compatible" | "strict";

/**
 * Builds a predicate over a capability list.
 *
 * Unknown strings answer `false`. A console talking to a newer API sees a
 * capability it has no name for and simply does not offer the control — the
 * conservative direction, and the one that cannot invent a permission.
 */
export function capabilityChecker(
  granted: readonly string[] | null | undefined,
): (capability: Capability) => boolean {
  const held = new Set(granted ?? []);
  return (capability: Capability) => held.has(capability);
}

/**
 * Why a control is disabled, for the tooltip. Naming the capability is
 * deliberate: "ask an owner for `secrets.reveal`" is an actionable sentence,
 * where a greyed-out button with no explanation is a support ticket.
 */
export function missingCapabilityReason(capability: Capability): string {
  return `Requires the ${capability} capability. Your account's role does not hold it.`;
}
