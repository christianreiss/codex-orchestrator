/**
 * The fleet's authorization vocabulary.
 *
 * Before this module the API had authentication but no authorization: every
 * route in the admin tree hung off `requireAdmin`, which resolves the session
 * cookie and checks that the user row is active — it never reads the role. Six
 * hand-written gates scattered through the route files were the only thing
 * standing between a `viewer` account and, say, rotating a host key. Everything
 * else — global settings, canonical credential upload, host deletion, provider
 * API keys — was open to any authenticated, active user.
 *
 * The fix has three parts and this file is the first: a closed vocabulary of
 * capabilities, and one matrix mapping each role onto the capabilities it
 * holds. {@link ../security/route-capabilities.ts} is the second — the explicit
 * inventory that assigns a capability to every route in the admin tree. The
 * third is `http/plugins/capabilities.ts`, which enforces the pair and refuses
 * to start when a route is missing from the inventory.
 *
 * The matrix is the *only* place a role name is compared against anything. No
 * route, service, or component re-derives policy from `accessLevel`.
 */

import {
  ROLE_ADMIN,
  ROLE_FLEET,
  ROLE_OWNER,
  ROLE_TRUSTED,
  ROLE_USER,
  ROLE_VIEWER,
  type AccessLevel,
} from '../services/admin-auth.js';

/**
 * Every capability the fleet knows about. Adding one here without also placing
 * it in {@link ROLE_CAPABILITIES} is a type error, and adding it to neither
 * while referencing it from the route inventory is a type error there.
 */
export const CAPABILITIES = [
  // Console-wide reads that carry no fleet state of their own: the overview
  // tiles, the manual, the websocket descriptor, engine usage counters.
  'admin.read',

  // Acting on your *own* account — logout, password change, your own passkeys.
  // Held by every role including `viewer`: an account you cannot sign out of or
  // re-secure is worse than no account.
  'account.self_manage',

  'users.read',
  'users.manage',

  'hosts.read',
  'hosts.manage',
  // Deleting a host, registering one, switching its engines, and moving it
  // between the secure and insecure lanes. Split from `hosts.manage` because
  // each of these can atomically revoke or generation-fence live work, and
  // because the pre-existing gate on exactly these four routes allowed only
  // owner and admin. Widening them would have been a regression dressed as a
  // refactor.
  'hosts.security_transition',
  // Opening an insecure window, extending one, and ruling on the approval
  // requests and domain allowances that ride on it.
  'hosts.activate_insecure',

  'settings.read',
  'settings.manage',
  // Switching the fleet between `compatible` and `strict` authorization.
  // Split from `settings.manage` because it is the one setting that decides
  // how every other capability is enforced, and because `compatible` mode
  // hands `settings.manage` to every role — a posture switch every account
  // could flip, in either direction, would protect nothing. Enforced under
  // both modes; see `ALWAYS_ENFORCED` in `authorization-mode.ts`.
  'security.manage_authorization',

  // Reading *metadata* about stored fleet credentials — never their values.
  'auth.read_metadata',
  // Uploading canonical credentials, minting seed commands, and driving the
  // runner's verification path.
  'auth.manage',
  // Reading a stored canonical credential *body* back out — the live token the
  // fleet distributes to hosts. Separate from `auth.manage`, and stricter:
  // uploading a new credential and reading the current one back are different
  // risks, and the second is the one that walks out the door.
  'auth.reveal_credential',

  // Provider API keys (OpenAI, Anthropic). Separate from `settings.manage`
  // because these are billable bearer credentials, not preferences.
  'keys.manage',

  // Authored fleet content: agent documents, skills, Claude-native collections,
  // the config builder, agent policy profiles.
  'content.read',
  'content.manage',

  'memory.read',
  'memory.write',

  'projects.read',
  'projects.manage',

  'secrets.read_metadata',
  'secrets.reveal',
  'secrets.manage',

  'agent_portal.read',
  // A permanent portal link is reusable bearer material, so reading one is its
  // own capability rather than part of `agent_portal.read`.
  'agent_portal.reveal_link',
  // Session transcripts -- the `user_message` / `assistant_message` bodies in a
  // session timeline. Split from `agent_portal.read` on the same grounds as
  // every other reveal here: the listing is metadata about who is running and
  // whether they are stuck, while the timeline is the content of the work
  // itself. A viewer who may see that the fleet is busy has not thereby been
  // granted every conversation it is having.
  'agent_portal.reveal_transcript',
  'agent_portal.manage',

  'agent_messaging.read',
  // Message bodies. Listings expose metadata only.
  'agent_messaging.reveal_content',
  'agent_messaging.manage',

  'git_director.read',
  // Forcing a verdict overrides an arbiter other agents are relying on, and the
  // module switch turns the registry off fleet-wide, so both sit behind manage.
  'git_director.manage',

  'audit.read',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);

export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

/**
 * What every authenticated role may read, plus the self-service actions on
 * one's own account. `viewer` and the legacy `user` role hold exactly this and
 * nothing else.
 *
 * Note what is *not* here: `secrets.reveal`, `auth.reveal_credential`,
 * `agent_portal.reveal_link`, `agent_portal.reveal_transcript` and
 * `agent_messaging.reveal_content`. Each returns bearer material or private
 * content, so each is a grant of its own even though all five read.
 */
const READ_ONLY: readonly Capability[] = [
  'admin.read',
  'account.self_manage',
  'users.read',
  'hosts.read',
  'settings.read',
  'auth.read_metadata',
  'content.read',
  'memory.read',
  'projects.read',
  'secrets.read_metadata',
  'agent_portal.read',
  'agent_messaging.read',
  'git_director.read',
  'audit.read',
];

/**
 * Fleet operations: everything about running hosts and keeping the fleet's own
 * credentials current. Deliberately excludes account management, the
 * authored-content and memory surfaces, the four host security transitions, and
 * every reveal — a fleet operator may replace the fleet's canonical credential
 * but never read the live one back out. Keeping the fleet running is not the
 * same authority as deciding who else may.
 */
const FLEET_OPERATOR: readonly Capability[] = [
  ...READ_ONLY,
  'hosts.manage',
  'hosts.activate_insecure',
  'settings.manage',
  'auth.manage',
  // Arbitrating merges between running agents is fleet operation, not content
  // authorship: it sits with the role that already keeps the fleet running.
  'git_director.manage',
];

/**
 * The role→capability matrix. This is the source of truth: the docs table in
 * `docs/ADMIN.md` is checked against it by
 * `test/unit/security/capability-docs.test.ts`, and the admin console receives
 * the caller's row of it in the session status payload.
 */
export const ROLE_CAPABILITIES: Readonly<Record<AccessLevel, readonly Capability[]>> = {
  // Owner holds every capability. Ownership itself — the last-owner and
  // self-demotion invariants — is enforced in the user service, not here,
  // because it is a property of the *target* row rather than of the caller.
  [ROLE_OWNER]: CAPABILITIES,
  // Admin also holds every capability. The two roles differ only in the
  // owner-only invariants above, which no capability can express.
  [ROLE_ADMIN]: CAPABILITIES,
  [ROLE_FLEET]: FLEET_OPERATOR,
  // Exactly what the role name claims: the insecure-window activations, plus
  // the reads needed to find the host it is opening a window for.
  [ROLE_TRUSTED]: [...READ_ONLY, 'hosts.activate_insecure'],
  [ROLE_VIEWER]: READ_ONLY,
  [ROLE_USER]: READ_ONLY,
};

const ROLE_CAPABILITY_SETS: Readonly<Record<AccessLevel, ReadonlySet<Capability>>> = {
  [ROLE_OWNER]: new Set(ROLE_CAPABILITIES[ROLE_OWNER]),
  [ROLE_ADMIN]: new Set(ROLE_CAPABILITIES[ROLE_ADMIN]),
  [ROLE_FLEET]: new Set(ROLE_CAPABILITIES[ROLE_FLEET]),
  [ROLE_TRUSTED]: new Set(ROLE_CAPABILITIES[ROLE_TRUSTED]),
  [ROLE_VIEWER]: new Set(ROLE_CAPABILITIES[ROLE_VIEWER]),
  [ROLE_USER]: new Set(ROLE_CAPABILITIES[ROLE_USER]),
};

/**
 * The capabilities held by a stored role value.
 *
 * Takes `string` rather than `AccessLevel` because it reads a database column.
 * A role this build does not know about — a row written by a newer version, or
 * corrupted — holds nothing. Failing closed on an unrecognized role is the
 * whole point of a default-deny layer.
 */
export function capabilitiesForRole(role: string): readonly Capability[] {
  return ROLE_CAPABILITIES[role as AccessLevel] ?? [];
}

export function roleHasCapability(role: string, capability: Capability): boolean {
  return ROLE_CAPABILITY_SETS[role as AccessLevel]?.has(capability) ?? false;
}
