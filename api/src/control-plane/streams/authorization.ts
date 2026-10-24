import { ownedCredentialDeadline } from '../credentials.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Host } from '../../db/schema.js';
import type { OwnerRuntime } from '../state/runtime.js';
import type { OwnerStateSnapshot } from '../state/store.js';
import type { StateScope } from '../protocol.js';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../../http/errors.js';
import { activeHostEngines } from '../../services/host-engine-policy.js';
import { isTruthyFlagValue } from '../../services/settings.js';
import { isEngine, type Engine } from '../../util/engine.js';
import { receiverState } from '../../services/agent-receiver-state.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function time(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) throw new ForbiddenError('Invalid authorization deadline');
  return result;
}
export function minimumDeadline(...values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.min(...present) : null;
}
export function fleetEngines(snapshot: OwnerStateSnapshot) {
  return {
    codex: !isTruthyFlagValue(snapshot.setting('codex_engine_disabled')),
    claude: !isTruthyFlagValue(snapshot.setting('claude_engine_disabled')),
    grok: !isTruthyFlagValue(snapshot.setting('grok_engine_disabled')),
  };
}
export function assertEngine(
  snapshot: OwnerStateSnapshot,
  host: Pick<Host, 'engines'>,
  engine: string,
  allowSuspended = false,
): asserts engine is Engine {
  if (
    !isEngine(engine) ||
    !activeHostEngines(
      host.engines,
      allowSuspended ? { codex: true, claude: true, grok: true } : fleetEngines(snapshot),
    ).includes(engine)
  )
    throw new ForbiddenError('Engine unavailable', 'state_engine_unavailable');
}
export function transportPolicy(
  host: Pick<Host, 'ip4' | 'ip6' | 'allowRoamingIps' | 'reverseDnsMode'>,
): string {
  return JSON.stringify([host.ip4, host.ip6, host.allowRoamingIps, host.reverseDnsMode]);
}

/** Admission already proved the key/IP/DNS; live revalidation reads owner RAM only. */
export class StreamAuthorization {
  private readonly fingerprint: string;
  private readonly policy: string;
  private readonly reverseDnsDefault: string | null | undefined;
  constructor(
    readonly runtime: OwnerRuntime,
    readonly hostId: number,
    admitted: Host,
  ) {
    const host = runtime.state.snapshot().hosts.get(hostId);
    if (!host) throw new UnauthorizedError('Host unavailable');
    this.fingerprint = host.authFingerprint;
    this.policy = transportPolicy(admitted);
    this.reverseDnsDefault = runtime.state.snapshot().setting('reverse_dns_enabled');
  }
  host(snapshot = this.runtime.state.snapshot()) {
    this.runtime.assertOwner();
    const host = snapshot.hosts.get(this.hostId);
    if (
      !host ||
      host.status !== 'active' ||
      snapshot.setting('api_disabled') === '1' ||
      !sameHash(host.authFingerprint, this.fingerprint) ||
      transportPolicy(host) !== this.policy ||
      (host.reverseDnsMode === null && snapshot.setting('reverse_dns_enabled') !== this.reverseDnsDefault)
    )
      throw new UnauthorizedError('Communicator authorization changed', 'state_host_revoked');
    const deadline = minimumDeadline(
      time(host.expiresAt),
      host.secure === 1 ? null : time(host.insecureEnabledUntil),
    );
    if ((host.secure !== 1 && !host.insecureEnabledUntil) || (deadline !== null && deadline <= Date.now()))
      throw new ForbiddenError('Host authorization expired', 'state_host_expired');
    return { host, deadline };
  }
  session(scope: StateScope, token: string | undefined, snapshot = this.runtime.state.snapshot()) {
    const { host, deadline } = this.host(snapshot);
    const session = scope.session_id ? snapshot.sessions.get(scope.session_id) : undefined;
    if (!session || session.hostId !== host.id || !sameHash(session.bridgeTokenHash, sha256(token ?? '')))
      throw new UnauthorizedError('Invalid session attachment', 'state_session_unauthorized');
    assertEngine(snapshot, host, session.engine);
    if (session.endedAt || !sameHash(session.hostAuthFingerprint, host.authFingerprint))
      throw new ForbiddenError('Session ended or revoked', 'state_session_revoked');
    if (scope.binding_generation !== undefined && scope.binding_generation !== session.bindingGeneration)
      throw new ConflictError('Session generation changed', 'state_generation_changed');
    if (session.agentBusAddressId) {
      const address = snapshot.addresses.get(session.agentBusAddressId);
      if (
        !address ||
        !address.enabled ||
        address.archivedAt ||
        address.currentSessionId !== session.id ||
        address.bindingGeneration !== session.bindingGeneration
      )
        throw new ConflictError('Session binding changed', 'state_binding_changed');
    }
    const expires = minimumDeadline(
      deadline,
      ownedCredentialDeadline(snapshot, 'session', session.id),
      time(session.expiresAt),
    );
    if (expires !== null && expires <= Date.now())
      throw new UnauthorizedError('Session authorization expired', 'state_session_expired');
    if (scope.topic === 'receiver') {
      const receiver = receiverState(session.receiver);
      if (!receiver || receiver.failure || receiver.generation !== scope.receiver_generation)
        throw new ConflictError('Receiver generation changed', 'state_receiver_changed');
    }
    if (scope.native_instance_id) {
      const control = snapshot.table('agentNativeControls').get(session.id);
      if (
        !control ||
        control.instanceId !== scope.native_instance_id ||
        control.bindingGeneration !== session.bindingGeneration
      )
        throw new ConflictError('Native process changed', 'state_native_changed');
    }
    if (
      snapshot.setting('agent_messaging_enabled') !== '1' &&
      snapshot.setting('agent_portal_enabled') !== '1'
    )
      throw new ForbiddenError('Agent sessions disabled', 'state_sessions_disabled');
    return { session, host, deadline: expires };
  }
  relay(
    scope: StateScope,
    token: string | undefined,
    username: string,
    snapshot = this.runtime.state.snapshot(),
  ) {
    const { host, deadline } = this.host(snapshot);
    const relay = scope.relay_id ? snapshot.table('agentBusRelays').get(scope.relay_id) : undefined;
    if (
      !relay ||
      relay.hostId !== host.id ||
      relayCommunicatorUsername(relay) !== username ||
      relay.status !== 'active' ||
      relay.stoppedAt ||
      relay.stopRequestedAt ||
      !sameHash(relay.tokenHash ?? '', sha256(token ?? '')) ||
      !sameHash(relay.hostAuthFingerprint, host.authFingerprint)
    )
      throw new UnauthorizedError('Relay attachment revoked', 'state_relay_revoked');
    if (scope.native_instance_id !== relay.instanceId || scope.binding_generation !== relay.generation)
      throw new ConflictError('Relay instance changed', 'state_relay_generation_changed');
    if (snapshot.setting('agent_messaging_enabled') !== '1')
      throw new ForbiddenError('Agent messaging disabled');
    const expires = minimumDeadline(deadline, ownedCredentialDeadline(snapshot, 'relay', relay.id));
    if (expires !== null && expires <= Date.now()) throw new UnauthorizedError('Relay credential expired');
    return { relay, host, deadline: expires };
  }
  provider(scope: StateScope, snapshot = this.runtime.state.snapshot()) {
    const { host, deadline } = this.host(snapshot);
    const lease = scope.provider_session_id
      ? snapshot.table('providerAccountSessions').get(scope.provider_session_id)
      : undefined;
    if (
      !lease ||
      lease.hostId !== host.id ||
      lease.engine !== scope.engine ||
      lease.ownershipMode !== 'connection'
    )
      throw new UnauthorizedError(
        'Provider grant does not support connection ownership',
        'state_provider_grant_invalid',
      );
    assertEngine(snapshot, host, lease.engine, true);
    const account = snapshot.accounts.get(lease.accountId);
    if (!account || account.engine !== lease.engine || account.state === 'removed')
      throw new ForbiddenError('Provider account unavailable');
    return { lease, account, host, deadline };
  }
  daemon(scope: StateScope, username: string, snapshot = this.runtime.state.snapshot()) {
    const { host, deadline } = this.host(snapshot);
    const daemon = snapshot.daemons.get(host.id);
    if (
      !daemon ||
      !daemon.runtime?.connected ||
      daemon.runtime.instance_id !== scope.native_instance_id ||
      daemon.runtime.username !== username ||
      daemon.settings.username !== username
    )
      throw new ForbiddenError('Daemon attachment changed', 'state_daemon_changed');
    return { daemon, host, deadline: minimumDeadline(deadline, time(daemon.settings.expires_at)) };
  }
}

export function relayCommunicatorUsername(relay: { username: string; capabilities: unknown }): string {
  const caps = relay.capabilities;
  return caps && typeof caps === 'object' && 'host_daemon' in caps && caps.host_daemon === true
    ? relay.username.replace(/:daemon$/, '')
    : relay.username;
}
