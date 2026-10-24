import { UnauthorizedError } from '../../http/errors.js';
import { hashApiKey } from '../../util/api-key-helpers.js';
import type { AdminSession, AdminUser, Host } from '../../db/schema.js';
import { ownerRuntimeFor, requireOwnerRuntime, setOwnerRequestPrincipal } from './runtime.js';
import type { StateRow } from './catalog.js';

export interface OwnerAdminContext {
  user: Omit<AdminUser, 'passwordHash'>;
  session: AdminSession;
}
export function resolveOwnerAdmin(
  handle: object,
  tokenHash: string,
  nowMs = Date.now(),
): OwnerAdminContext | null {
  const owner = requireOwnerRuntime(handle);
  const snapshot = owner.state.snapshot();
  const session = snapshot.adminSessions.by('tokenHash', tokenHash)[0];
  if (!session || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= nowMs)
    return null;
  const user = snapshot.table('adminUsers').get(session.userId);
  if (!user?.active) return null;
  return { user, session };
}

/** Request-local credential projection; plaintext credentials never enter state. */
export function requestHost(row: Readonly<StateRow<'hosts'>>, presentedKey: string): Host {
  return { ...row, apiKey: presentedKey, apiKeyEnc: null };
}
export function resolveOwnerHost(handle: object, keyHash: string, presentedKey: string): Host | null {
  const owner = requireOwnerRuntime(handle);
  const row = owner.state.snapshot().hosts.by('credentialLookupHash', keyHash)[0];
  return row ? requestHost(row, presentedKey) : null;
}
export { ownerRuntimeFor };

/** Bind a request's admission proof to subsequent queued durable commands. */
export function bindOwnerHostPrincipal(
  handle: object,
  authenticated: Host,
  requireInsecureWindow = false,
): void {
  const owner = requireOwnerRuntime(handle);
  const keyHash = hashApiKey(authenticated.apiKey);
  const policy = (
    host: Pick<
      Host,
      | 'secure'
      | 'allowRoamingIps'
      | 'reverseDnsMode'
      | 'ip4'
      | 'ip6'
      | 'insecureEnabledUntil'
      | 'insecureGraceUntil'
    >,
  ) =>
    JSON.stringify([
      host.secure,
      host.allowRoamingIps,
      host.reverseDnsMode,
      host.ip4,
      host.ip6,
      host.insecureEnabledUntil,
      host.insecureGraceUntil,
    ]);
  const expectedPolicy = policy(authenticated);
  const check = (snapshot: ReturnType<typeof owner.state.snapshot>) => {
    const current = snapshot.hosts.get(authenticated.id);
    if (
      !current ||
      current.credentialLookupHash !== keyHash ||
      current.status !== 'active' ||
      (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) ||
      policy(current) !== expectedPolicy ||
      current.engines !== authenticated.engines ||
      (requireInsecureWindow &&
        current.secure !== 1 &&
        (!current.insecureEnabledUntil || current.insecureEnabledUntil.getTime() <= Date.now()))
    )
      throw new UnauthorizedError('Host authority changed', 'invalid_api_key');
  };
  check(owner.state.snapshot());
  setOwnerRequestPrincipal({ principal: `host:${authenticated.id}`, revalidate: check });
}
