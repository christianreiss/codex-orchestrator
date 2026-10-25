import { ConflictError, ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import { activeHostEngines } from '../services/host-engine-policy.js';
import { messagingHostEligibleAt } from '../services/agent-messaging/eligibility.js';
import { safeHashEqual } from '../services/agent-messaging/internals.js';
import { isTruthyFlagValue } from '../services/settings.js';
import { ENGINES, type Engine } from '../util/engine.js';
import type { ConnectionPresence, LiveAttachment } from './presence.js';
import { mutateOwnerState, type OwnerRuntime } from './state/runtime.js';
import { stageUpdate } from './state/rows.js';
import { ownerSnapshotScope, type OwnerStateSnapshot } from './state/store.js';
import { legacyDrainDeadline } from './legacy-drain.js';

type Kind = 'session' | 'relay';
interface Proof {
  hash: string;
  identity: string;
  hostId: number;
  username: string;
  deadline: number;
}
interface Grant {
  kind: Kind;
  id: string;
  identity: string;
  hash: string;
  deadline: number;
  attachments: Set<string>;
}
const snapshots = new WeakMap<object, ConnectionCredentials>();
const runtimes = new WeakMap<OwnerRuntime, ConnectionCredentials>();
function key(kind: Kind, id: string): string {
  return `${kind}:${id}`;
}
function date(value: string | Date | null): number {
  if (value === null) return Infinity;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) throw new ForbiddenError('Invalid credential deadline');
  return time;
}
function proof(snapshot: OwnerStateSnapshot, kind: Kind, id: string): Proof {
  const row = kind === 'session' ? snapshot.sessions.get(id) : snapshot.table('agentBusRelays').get(id);
  if (!row) throw new UnauthorizedError('Credential identity unavailable');
  const host = snapshot.hosts.get(row.hostId);
  if (
    !host ||
    !messagingHostEligibleAt(host, Date.now()) ||
    snapshot.setting('api_disabled') === '1' ||
    !safeHashEqual(row.hostAuthFingerprint, host.authFingerprint)
  )
    throw new UnauthorizedError('Credential host authority changed');
  const deadline = Math.min(
    date(host.expiresAt),
    host.secure === 1 ? Infinity : date(host.insecureEnabledUntil),
  );
  if (deadline <= Date.now()) throw new ForbiddenError('Credential host expired');
  let hash: string, binding: unknown;
  if (kind === 'session') {
    const session = snapshot.sessions.get(id)!;
    if (session.endedAt) throw new ConflictError('Agent session is finished', 'agent_session_finished');
    const fleet = Object.fromEntries(
      ENGINES.map((engine) => [engine, !isTruthyFlagValue(snapshot.setting(`${engine}_engine_disabled`))]),
    ) as Record<Engine, boolean>;
    if (!activeHostEngines(host.engines, fleet).includes(session.engine as Engine))
      throw new ForbiddenError('Engine disabled', 'engine_disabled');
    if (
      snapshot.setting('agent_messaging_enabled') !== '1' &&
      snapshot.setting('agent_portal_enabled') !== '1'
    )
      throw new ForbiddenError('Agent sessions disabled');
    const address = session.agentBusAddressId ? snapshot.addresses.get(session.agentBusAddressId) : undefined;
    if (
      session.agentBusAddressId &&
      (!address ||
        !address.enabled ||
        address.archivedAt ||
        address.currentSessionId !== id ||
        address.bindingGeneration !== session.bindingGeneration)
    )
      throw new ConflictError('Session binding changed', 'agent_binding_changed');
    hash = session.bridgeTokenHash;
    binding = [session.bindingGeneration, session.agentBusAddressId, session.engine];
    if (date(session.expiresAt) <= Date.now()) throw new ForbiddenError('Session expired');
    return {
      hash,
      hostId: host.id,
      username: session.username,
      deadline: Math.min(deadline, date(session.expiresAt)),
      identity: JSON.stringify([
        hash,
        binding,
        host.authFingerprint,
        host.secure,
        host.ip4,
        host.ip6,
        host.allowRoamingIps,
        host.reverseDnsMode,
      ]),
    };
  }
  const relay = snapshot.table('agentBusRelays').get(id)!;
  if (
    relay.status !== 'active' ||
    !relay.tokenHash ||
    relay.stopRequestedAt ||
    relay.stoppedAt ||
    snapshot.setting('agent_messaging_enabled') !== '1'
  )
    throw new UnauthorizedError('Relay credential revoked');
  hash = relay.tokenHash;
  binding = [relay.generation, relay.instanceId];
  return {
    hash,
    hostId: host.id,
    username: relay.username,
    deadline,
    identity: JSON.stringify([
      hash,
      binding,
      host.authFingerprint,
      host.secure,
      host.ip4,
      host.ip6,
      host.allowRoamingIps,
      host.reverseDnsMode,
    ]),
  };
}

/** Volatile authority derives only from authenticated attachments and dies with this epoch. */
export class ConnectionCredentials {
  private readonly grants = new Map<string, Grant>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly detach: Array<() => void>;
  constructor(
    private readonly runtime: OwnerRuntime,
    private readonly presence: ConnectionPresence,
    private readonly ttl: { session: number; relay: number },
  ) {
    if (ttl.session < 1000 || ttl.relay < 1000) throw new Error('Credential TTL must be at least one second');
    if (runtimes.has(runtime)) throw new Error('Connection credentials already bound');
    runtimes.set(runtime, this);
    snapshots.set(ownerSnapshotScope(runtime.state.snapshot()), this);
    const inputs = (snapshot: OwnerStateSnapshot): unknown[] => [
      snapshot.table('hosts'),
      snapshot.table('agentSessions'),
      snapshot.table('agentBusAddresses'),
      snapshot.table('agentBusRelays'),
      ...[
        'api_disabled',
        'agent_messaging_enabled',
        'agent_portal_enabled',
        'codex_engine_disabled',
        'claude_engine_disabled',
        'grok_engine_disabled',
      ].map((key) => snapshot.setting(key)),
    ];
    let previous = inputs(runtime.state.snapshot());
    this.detach = [
      runtime.state.subscribe((snapshot) => {
        snapshots.set(ownerSnapshotScope(snapshot), this);
        const next = inputs(snapshot);
        if (next.every((value, index) => value === previous[index])) return;
        previous = next;
        this.revalidate(snapshot);
      }),
      presence.subscribe((change) => {
        if (change.connected) this.attach(change.attachment);
        else this.remove(change.attachment.id);
      }),
    ];
    for (const attachment of presence.all()) this.attach(attachment);
  }
  subscribe(kind: Kind, id: string, listener: () => void): () => void {
    const mapKey = key(kind, id),
      listeners = this.listeners.get(mapKey) ?? new Set<() => void>();
    this.listeners.set(mapKey, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(mapKey) === listeners) this.listeners.delete(mapKey);
    };
  }
  effective(snapshot: OwnerStateSnapshot, kind: Kind, id: string): number {
    const stored =
      kind === 'session'
        ? snapshot.sessions.get(id)?.bridgeExpiresAt
        : snapshot.table('agentBusRelays').get(id)?.tokenExpiresAt;
    const persisted = stored ? date(stored) : -Infinity;
    const grant = this.grants.get(key(kind, id));
    if (!grant || !grant.attachments.size) return persisted;
    try {
      if (proof(snapshot, kind, id).identity !== grant.identity) return persisted;
    } catch {
      return persisted;
    }
    return Math.max(persisted, grant.deadline);
  }
  async renewBootstrap(input: {
    kind: Kind;
    id: string;
    token: string;
    hostId: number;
    username: string;
    bindingGeneration?: number;
    authorizeHost(snapshot: OwnerStateSnapshot): void;
  }): Promise<void> {
    const authorize = (snapshot: OwnerStateSnapshot) => {
      input.authorizeHost(snapshot);
      const current = proof(snapshot, input.kind, input.id);
      if (
        current.hostId !== input.hostId ||
        current.username !== input.username ||
        !safeHashEqual(current.hash, sha256(input.token))
      )
        throw new UnauthorizedError('Credential renewal identity mismatch');
      if (
        input.kind === 'session' &&
        snapshot.sessions.get(input.id)!.bindingGeneration !== input.bindingGeneration
      )
        throw new ConflictError('Session generation changed', 'agent_binding_changed');
      return current;
    };
    const initial = this.runtime.state.snapshot();
    authorize(initial);
    if (this.effective(initial, input.kind, input.id) > Date.now() + 1000) return;
    await mutateOwnerState(this.runtime, {
      kind: `credentials.${input.kind}.reconnect`,
      principal: `host:${input.hostId}`,
      payload: { id: input.id, generation: input.bindingGeneration ?? null },
      authorize,
      prepare: (context) => {
        const current = authorize(context.snapshot);
        const expires = new Date(Math.min(Date.now() + this.ttl[input.kind], current.deadline)).toISOString();
        if (input.kind === 'session')
          stageUpdate(context, 'agentSessions', input.id, { bridgeExpiresAt: expires });
        else stageUpdate(context, 'agentBusRelays', input.id, { tokenExpiresAt: expires });
        return null;
      },
    });
  }
  close(): void {
    for (const cancel of this.detach) cancel();
    for (const id of this.grants.keys()) this.runtime.deadlines.cancel(`credentials:${id}`);
    this.grants.clear();
    this.listeners.clear();
    runtimes.delete(this.runtime);
  }
  private attach(attachment: LiveAttachment): void {
    const scope = attachment.scope;
    const kind =
      scope.topic === 'relay'
        ? 'relay'
        : scope.topic === 'session' || scope.topic === 'receiver'
          ? 'session'
          : null;
    const id = kind === 'session' ? scope.session_id : scope.relay_id;
    if (!kind || !id) return;
    const snapshot = this.runtime.state.snapshot();
    let current: Proof;
    try {
      current = proof(snapshot, kind, id);
    } catch {
      return;
    }
    if (
      current.hostId !== attachment.hostId ||
      current.username !== attachment.username ||
      (kind === 'session' && snapshot.sessions.get(id)!.bindingGeneration !== scope.binding_generation)
    )
      return;
    const mapKey = key(kind, id);
    let grant = this.grants.get(mapKey);
    if (grant && grant.identity !== current.identity) {
      this.drop(mapKey);
      grant = undefined;
    }
    if (!grant) {
      // Presence is registered only after token authentication, but a stale
      // persisted token still cannot mint a fresh grant through this hook.
      if (this.effective(snapshot, kind, id) <= Date.now()) return;
      grant = {
        kind,
        id,
        identity: current.identity,
        hash: current.hash,
        deadline: 0,
        attachments: new Set(),
      };
      this.grants.set(mapKey, grant);
    }
    grant.attachments.add(attachment.id);
    this.renew(grant, current);
  }
  private renew(grant: Grant, current: Proof): void {
    grant.deadline = Math.min(Date.now() + this.ttl[grant.kind], current.deadline);
    if (grant.deadline <= Date.now()) {
      this.drop(key(grant.kind, grant.id));
      return;
    }
    const at = Math.min(Date.now() + this.ttl[grant.kind] / 2, grant.deadline);
    this.runtime.deadlines.schedule(`credentials:${key(grant.kind, grant.id)}`, at, () => {
      try {
        this.runtime.assertOwner();
        const latest = proof(this.runtime.state.snapshot(), grant.kind, grant.id);
        if (latest.identity !== grant.identity || !grant.attachments.size || grant.deadline <= Date.now())
          this.drop(key(grant.kind, grant.id));
        else this.renew(grant, latest);
      } catch {
        this.drop(key(grant.kind, grant.id));
      }
    });
    for (const listener of this.listeners.get(key(grant.kind, grant.id)) ?? []) listener();
  }
  private remove(attachmentId: string): void {
    for (const [id, grant] of this.grants) {
      if (grant.attachments.delete(attachmentId) && !grant.attachments.size) this.drop(id);
    }
  }
  private drop(id: string): void {
    this.runtime.deadlines.cancel(`credentials:${id}`);
    if (!this.grants.delete(id)) return;
    for (const listener of this.listeners.get(id) ?? []) listener();
  }
  private revalidate(snapshot: OwnerStateSnapshot): void {
    for (const [id, grant] of this.grants) {
      try {
        if (proof(snapshot, grant.kind, grant.id).identity !== grant.identity) this.drop(id);
      } catch {
        this.drop(id);
      }
    }
  }
}

export function ownedCredentialDeadline(snapshot: OwnerStateSnapshot, kind: Kind, id: string): number {
  const bound = snapshots.get(ownerSnapshotScope(snapshot));
  const stored =
    kind === 'session'
      ? snapshot.sessions.get(id)?.bridgeExpiresAt
      : snapshot.table('agentBusRelays').get(id)?.tokenExpiresAt;
  return Math.max(
    bound ? bound.effective(snapshot, kind, id) : stored ? date(stored) : -Infinity,
    legacyDrainDeadline(snapshot, kind, id) ?? -Infinity,
  );
}
export function ownerCredentials(runtime: OwnerRuntime): ConnectionCredentials {
  runtime.assertOwner();
  const bound = runtimes.get(runtime);
  if (!bound) throw new Error('Connection credentials are not bound');
  return bound;
}
