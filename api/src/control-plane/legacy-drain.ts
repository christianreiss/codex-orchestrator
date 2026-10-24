import { sha256 } from '../security/hash.js';
import { safeHashEqual } from '../services/agent-messaging/internals.js';
import { activeHostEngines } from '../services/host-engine-policy.js';
import { isTruthyFlagValue } from '../services/settings.js';
import { ConflictError, UnauthorizedError } from '../http/errors.js';
import type { Engine } from '../util/engine.js';
import type { OwnerRuntime } from './state/runtime.js';
import type { OwnerStateSnapshot } from './state/store.js';
import { ownedMessagingHost, ownedEngineState } from './state/messaging.js';
import { receiverState } from '../services/agent-receiver-state.js';

export interface LegacyProtectedGrant {
  id: string;
  identity: string;
  capturedExpiresAt: number;
}
export interface LegacyProtectedCapture {
  /** IDs attested ACTIVE before bootstrap marks them owner_restart uncertain. */
  capturedAt?: number;
  /** Original quiescent security cap, retained across restart (omit only if unbounded). */
  securityDeadlines?: Readonly<Record<string, number>>;
  resourceClaimIds?: readonly string[];
  gitRegistrationIds?: readonly string[];
}
export interface LegacyDrainRecord {
  kind: 'session' | 'relay';
  id: string;
  hostId: number;
  username: string;
  engine: Engine | null;
  tokenHash: string;
  hostFingerprint: string;
  binding: number;
  instanceId: string;
  receiverGeneration: string | null;
  nativeSessionId: string | null;
  transportPolicy: string;
  sessionExpiresAt: string | null;
  nativeObservedAt: number;
  receiverObservedAt: number;
  credentialDeadline: number;
  acceptedClaimIds: readonly string[];
  protectedSecurityDeadline: number;
  resourceClaims: readonly LegacyProtectedGrant[];
  gitRegistrations: readonly LegacyProtectedGrant[];
}
/** Capture once while the old owner's exact durable identities are still known. */
export function captureLegacyDrainManifest(
  snapshot: OwnerStateSnapshot,
  now = Date.now(),
  protectedCapture: LegacyProtectedCapture = {},
): LegacyDrainRecord[] {
  const records: LegacyDrainRecord[] = [];
  const eligibilityAt = protectedCapture.capturedAt ?? now;
  const validCaptureTime = Number.isFinite(eligibilityAt) && eligibilityAt <= now;
  const resourceIds = new Set(protectedCapture.resourceClaimIds ?? []);
  const gitIds = new Set(protectedCapture.gitRegistrationIds ?? []);
  const policy = (host: NonNullable<ReturnType<typeof snapshot.hosts.get>>) =>
    JSON.stringify([
      host.ip4,
      host.ip6,
      host.allowRoamingIps,
      host.reverseDnsMode,
      host.secure,
      host.reverseDnsMode === null ? snapshot.setting('reverse_dns_enabled') : null,
    ]);
  for (const session of snapshot.sessions.all()) {
    const caps = session.adapterCapabilities as { control_state_protocol?: unknown } | null;
    const control = snapshot.table('agentNativeControls').get(session.id);
    if (
      session.endedAt ||
      caps?.control_state_protocol === 1 ||
      !control ||
      control.bindingGeneration !== session.bindingGeneration ||
      control.status === 'exited' ||
      !Number.isFinite(Date.parse(session.bridgeExpiresAt))
    )
      continue;
    const host = snapshot.hosts.get(session.hostId);
    if (!host || host.authFingerprint !== session.hostAuthFingerprint) continue;
    const accepted = snapshot.messages
      .all()
      .filter(
        (m) =>
          m.status === 'accepted' &&
          (m.deliverySessionId === session.id || m.leaseOwner === `session:${session.id}`),
      )
      .flatMap((m) => (m.claimId ? [m.claimId] : []));
    records.push({
      kind: 'session',
      id: session.id,
      hostId: session.hostId,
      username: session.username,
      engine: session.engine as Engine,
      tokenHash: session.bridgeTokenHash,
      hostFingerprint: session.hostAuthFingerprint,
      binding: session.bindingGeneration,
      instanceId: control.instanceId,
      receiverGeneration: receiverState(session.receiver)?.generation ?? null,
      nativeSessionId: receiverState(session.receiver)?.native_session_id ?? session.upstreamSessionId,
      transportPolicy: policy(host),
      sessionExpiresAt: session.expiresAt,
      nativeObservedAt: Date.parse(control.updatedAt),
      receiverObservedAt: Date.parse(receiverState(session.receiver)?.heartbeat_at ?? ''),
      credentialDeadline: Date.parse(session.bridgeExpiresAt),
      acceptedClaimIds: accepted,
      protectedSecurityDeadline: Math.min(
        session.expiresAt ? Date.parse(session.expiresAt) : Infinity,
        host.expiresAt ? Date.parse(host.expiresAt) : Infinity,
        host.secure === 1
          ? Infinity
          : host.insecureEnabledUntil
            ? new Date(host.insecureEnabledUntil).getTime()
            : NaN,
        protectedCapture.securityDeadlines?.[session.id] ?? Infinity,
      ),
      resourceClaims: snapshot.claims
        .all()
        .filter(
          (claim) =>
            validCaptureTime &&
            resourceIds.has(claim.id) &&
            claim.ownershipMode === 'timed' &&
            (claim.state === 'active' ||
              (claim.state === 'uncertain' && claim.uncertaintyReason === 'owner_restart')) &&
            claim.sessionId === session.id &&
            claim.generation === session.bindingGeneration &&
            (!claim.nativeInstanceId || claim.nativeInstanceId === control.instanceId) &&
            Date.parse(claim.expiresAt) > eligibilityAt,
        )
        .map((claim) => ({
          id: claim.id,
          identity: legacyResourceIdentity(claim),
          capturedExpiresAt: Date.parse(claim.expiresAt),
        })),
      gitRegistrations: snapshot
        .table('gitWorktrees')
        .all()
        .filter(
          (row) =>
            validCaptureTime &&
            gitIds.has(row.id) &&
            row.ownershipMode === 'timed' &&
            (row.status === 'active' ||
              (row.status === 'uncertain' && row.uncertaintyReason === 'owner_restart')) &&
            row.agentSessionId === session.id &&
            row.agentBindingGeneration === session.bindingGeneration &&
            row.hostId === session.hostId &&
            row.engine === session.engine &&
            row.username === session.username &&
            !row.releasedAt &&
            (!row.nativeInstanceId || row.nativeInstanceId === control.instanceId) &&
            Date.parse(row.expiresAt) > eligibilityAt,
        )
        .map((row) => ({
          id: row.id,
          identity: legacyGitIdentity(row),
          capturedExpiresAt: Date.parse(row.expiresAt),
        })),
    });
  }
  for (const relay of snapshot.table('agentBusRelays').all()) {
    const caps = relay.capabilities as { control_state_protocol?: unknown } | null;
    const accepted = snapshot.messages
      .all()
      .filter((m) => m.status === 'accepted' && m.leaseOwner === `relay:${relay.id}:${relay.generation}`)
      .flatMap((m) => (m.claimId ? [m.claimId] : []));
    if (
      relay.status !== 'active' ||
      !relay.tokenHash ||
      !relay.tokenExpiresAt ||
      !Number.isFinite(Date.parse(relay.tokenExpiresAt)) ||
      caps?.control_state_protocol === 1 ||
      !accepted.length
    )
      continue;
    const host = snapshot.hosts.get(relay.hostId);
    if (!host) continue;
    records.push({
      kind: 'relay',
      id: relay.id,
      hostId: relay.hostId,
      username: relay.username,
      engine: null,
      tokenHash: relay.tokenHash,
      hostFingerprint: relay.hostAuthFingerprint,
      binding: relay.generation,
      instanceId: relay.instanceId,
      receiverGeneration: null,
      nativeSessionId: null,
      transportPolicy: policy(host),
      sessionExpiresAt: null,
      nativeObservedAt: Date.parse(relay.heartbeatAt),
      receiverObservedAt: 0,
      credentialDeadline: Date.parse(relay.tokenExpiresAt),
      acceptedClaimIds: accepted,
      protectedSecurityDeadline: 0,
      resourceClaims: [],
      gitRegistrations: [],
    });
  }
  return records;
}
export function legacyResourceIdentity(
  row: Readonly<import('./state/catalog.js').StateRow<'agentResourceClaims'>>,
): string {
  return JSON.stringify([
    row.sessionId,
    row.generation,
    row.nativeInstanceId,
    row.ownershipMode,
    row.requestId,
    row.resources,
    row.createdAt,
  ]);
}
export function legacyGitIdentity(
  row: Readonly<import('./state/catalog.js').StateRow<'gitWorktrees'>>,
): string {
  return JSON.stringify([
    row.agentSessionId,
    row.agentBindingGeneration,
    row.nativeInstanceId,
    row.ownershipMode,
    row.hostId,
    row.username,
    row.engine,
    row.cloneId,
    row.worktreePath,
    row.worktreeHash,
    row.registeredAt,
  ]);
}
const runtimes = new WeakMap<OwnerRuntime, LegacyDrainRegistry>();
const snapshots = new WeakMap<OwnerStateSnapshot, LegacyDrainRegistry>();
const key = (kind: LegacyDrainRecord['kind'], id: string) => `${kind}:${id}`;

/** Temporary explicit drain proof. It never enters the WebSocket presence registry. */
export class LegacyDrainRegistry {
  private readonly records = new Map<string, LegacyDrainRecord>();
  private readonly unlisten: () => void;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(record?: LegacyDrainRecord) {
    if (record) {
      const deadlines = [
        record.nativeObservedAt + 45000,
        record.receiverObservedAt + 45000,
        record.credentialDeadline,
        record.protectedSecurityDeadline,
      ].filter((at) => Number.isFinite(at) && at > Date.now());
      const id = 'legacy-presence:' + key(record.kind, record.id);
      this.runtime.deadlines.cancel(id);
      if (deadlines.length)
        this.runtime.deadlines.schedule(id, Math.min(...deadlines), () => this.changed(record));
    }
    for (const listener of this.listeners) listener();
  }
  constructor(
    private readonly runtime: OwnerRuntime,
    manifest: readonly LegacyDrainRecord[],
    private readonly ttl: { session: number; relay: number },
  ) {
    if (runtimes.has(runtime)) throw new Error('Legacy drain registry already bound');
    for (const record of manifest) {
      const copy = structuredClone(record);
      this.records.set(key(record.kind, record.id), copy);
      this.changed(copy);
    }
    runtimes.set(runtime, this);
    snapshots.set(runtime.state.snapshot(), this);
    this.unlisten = runtime.state.subscribe((snapshot) => {
      snapshots.set(snapshot, this);
      for (const [id, record] of this.records) {
        try {
          this.proof(snapshot, record);
        } catch {
          this.records.delete(id);
          this.runtime.deadlines.cancel('legacy-presence:' + id);
          this.changed();
        }
      }
    });
  }
  private proof(snapshot: OwnerStateSnapshot, record: LegacyDrainRecord): number {
    this.runtime.assertOwner();
    if (snapshot.setting('api_disabled') === '1') throw new UnauthorizedError('API disabled');
    const host = ownedMessagingHost(snapshot, record.hostId);
    if (
      !safeHashEqual(host.authFingerprint, record.hostFingerprint) ||
      JSON.stringify([
        host.ip4,
        host.ip6,
        host.allowRoamingIps,
        host.reverseDnsMode,
        host.secure,
        host.reverseDnsMode === null ? snapshot.setting('reverse_dns_enabled') : null,
      ]) !== record.transportPolicy
    )
      throw new UnauthorizedError('Legacy host credential changed');
    if (record.kind === 'session') {
      const session = snapshot.sessions.get(record.id),
        control = snapshot.table('agentNativeControls').get(record.id);
      if (
        !session ||
        session.endedAt ||
        session.hostId !== record.hostId ||
        session.username !== record.username ||
        session.engine !== record.engine ||
        session.bindingGeneration !== record.binding ||
        session.expiresAt !== record.sessionExpiresAt ||
        !safeHashEqual(session.bridgeTokenHash, record.tokenHash) ||
        !safeHashEqual(session.hostAuthFingerprint, record.hostFingerprint) ||
        !control ||
        control.instanceId !== record.instanceId ||
        control.bindingGeneration !== record.binding ||
        control.status === 'exited'
      )
        throw new ConflictError('Legacy lifecycle changed', 'legacy_drain_fenced');
      if (!activeHostEngines(host.engines, ownedEngineState(snapshot)).includes(session.engine as Engine))
        throw new UnauthorizedError('Legacy engine disabled');
      if (
        !isTruthyFlagValue(snapshot.setting('agent_messaging_enabled')) &&
        !isTruthyFlagValue(snapshot.setting('agent_portal_enabled'))
      )
        throw new UnauthorizedError('Legacy session disabled');
    } else {
      const relay = snapshot.table('agentBusRelays').get(record.id);
      if (
        !relay ||
        relay.status !== 'active' ||
        relay.stoppedAt ||
        relay.stopRequestedAt ||
        relay.generation !== record.binding ||
        relay.instanceId !== record.instanceId ||
        !relay.tokenHash ||
        !safeHashEqual(relay.tokenHash, record.tokenHash) ||
        !safeHashEqual(relay.hostAuthFingerprint, record.hostFingerprint) ||
        !isTruthyFlagValue(snapshot.setting('agent_messaging_enabled'))
      )
        throw new ConflictError('Legacy relay changed', 'legacy_drain_fenced');
    }
    const deadline = Math.min(
      host.expiresAt ? Date.parse(host.expiresAt) : Infinity,
      host.secure === 1
        ? Infinity
        : host.insecureEnabledUntil
          ? new Date(host.insecureEnabledUntil).getTime()
          : NaN,
      record.sessionExpiresAt ? Date.parse(record.sessionExpiresAt) : Infinity,
    );
    if (Number.isNaN(deadline) || deadline <= Date.now())
      throw new UnauthorizedError('Legacy security deadline expired');
    return deadline;
  }
  deadline(snapshot: OwnerStateSnapshot, kind: LegacyDrainRecord['kind'], id: string): number | undefined {
    const record = this.records.get(key(kind, id));
    if (!record) return undefined;
    try {
      return Math.min(record.credentialDeadline, this.proof(snapshot, record));
    } catch {
      return undefined;
    }
  }
  /** An ordinary old heartbeat can extend only an unexpired, already captured credential. */
  renew(
    kind: LegacyDrainRecord['kind'],
    id: string,
    token: string,
    identity?: { instanceId?: string; receiverGeneration?: string },
  ): boolean {
    const record = this.records.get(key(kind, id));
    if (!record) return false;
    const securityDeadline = this.proof(this.runtime.state.snapshot(), record);
    if (
      !safeHashEqual(sha256(token), record.tokenHash) ||
      (identity?.instanceId !== undefined && identity.instanceId !== record.instanceId) ||
      (identity?.receiverGeneration !== undefined &&
        identity.receiverGeneration !== record.receiverGeneration)
    )
      throw new UnauthorizedError('Legacy drain proof does not match', 'legacy_drain_fenced');
    if (record.credentialDeadline <= Date.now())
      throw new UnauthorizedError(
        'Legacy credential expired; host-authenticated recovery is required',
        'agent_bridge_expired',
      );
    record.credentialDeadline = Math.min(Date.now() + this.ttl[kind], securityDeadline);
    if (identity?.instanceId) record.nativeObservedAt = Date.now();
    if (identity?.receiverGeneration) record.receiverObservedAt = Date.now();
    this.changed(record);
    return true;
  }
  /** Existing wrapper registration recovery supplies current host auth, never a new lifecycle. */
  recover(
    kind: LegacyDrainRecord['kind'],
    id: string,
    token: string,
    hostId: number,
    username: string,
    authorizeHost: (snapshot: OwnerStateSnapshot) => void,
  ): boolean {
    const record = this.records.get(key(kind, id));
    if (!record) return false;
    const snapshot = this.runtime.state.snapshot();
    authorizeHost(snapshot);
    const securityDeadline = this.proof(snapshot, record);
    if (
      record.hostId !== hostId ||
      record.username !== username ||
      !safeHashEqual(sha256(token), record.tokenHash)
    )
      throw new UnauthorizedError('Legacy recovery identity changed', 'legacy_drain_fenced');
    record.credentialDeadline = Math.min(Date.now() + this.ttl[kind], securityDeadline);
    this.changed(record);
    return true;
  }
  session(id: string, binding: number, instanceId?: string): boolean {
    const record = this.records.get(key('session', id));
    return Boolean(
      record &&
      record.binding === binding &&
      record.nativeObservedAt > Date.now() - 45000 &&
      (instanceId === undefined || record.instanceId === instanceId) &&
      (this.deadline(this.runtime.state.snapshot(), 'session', id) ?? 0) > Date.now(),
    );
  }
  /** Validation only: never renews or creates durable or volatile grant authority. */
  resourceClaim(id: string, sessionId: string, binding: number): boolean {
    const record = this.records.get(key('session', sessionId));
    const grant = record?.resourceClaims.find((grant) => grant.id === id);
    const row = this.runtime.state.snapshot().claims.get(id);
    return Boolean(
      grant &&
      record!.protectedSecurityDeadline > Date.now() &&
      row &&
      this.session(sessionId, binding) &&
      legacyResourceIdentity(row) === grant.identity &&
      (row.state === 'active' ||
        (row.state === 'uncertain' &&
          ['owner_restart', 'disconnected'].includes(row.uncertaintyReason ?? ''))),
    );
  }
  gitRegistration(id: string, sessionId: string, binding: number): boolean {
    const record = this.records.get(key('session', sessionId));
    const grant = record?.gitRegistrations.find((grant) => grant.id === id);
    const row = this.runtime.state.snapshot().table('gitWorktrees').get(id);
    return Boolean(
      grant &&
      record!.protectedSecurityDeadline > Date.now() &&
      row &&
      !row.releasedAt &&
      this.session(sessionId, binding) &&
      legacyGitIdentity(row) === grant.identity &&
      (row.status === 'active' ||
        (row.status === 'uncertain' &&
          ['owner_restart', 'disconnected'].includes(row.uncertaintyReason ?? ''))),
    );
  }
  protectedDeadline(sessionId: string, binding: number): number | null {
    const record = this.records.get(key('session', sessionId));
    if (!record || !this.session(sessionId, binding)) return null;
    if (
      !record.resourceClaims.some((grant) => this.resourceClaim(grant.id, sessionId, binding)) &&
      !record.gitRegistrations.some((grant) => this.gitRegistration(grant.id, sessionId, binding))
    )
      return null;
    // The old heartbeat TTL was checked at quiescence. It is not an authorization
    // deadline after capture: live exact-process proof replaces its renewal writes.
    return Math.min(
      record.protectedSecurityDeadline,
      record.nativeObservedAt + 45000,
      this.deadline(this.runtime.state.snapshot(), 'session', sessionId) ?? 0,
    );
  }
  receiver(id: string, binding: number, generation: string): boolean {
    const record = this.records.get(key('session', id));
    return Boolean(
      record &&
      record.receiverGeneration === generation &&
      record.receiverObservedAt > Date.now() - 45000 &&
      this.session(id, binding),
    );
  }
  receiverRebind(id: string, token: string, generation: string, nativeSessionId: string): boolean {
    const record = this.records.get(key('session', id));
    if (!record) return false;
    const snapshot = this.runtime.state.snapshot();
    this.proof(snapshot, record);
    if (
      !safeHashEqual(sha256(token), record.tokenHash) ||
      record.nativeSessionId !== nativeSessionId ||
      record.credentialDeadline <= Date.now()
    )
      throw new UnauthorizedError('Legacy adapter identity changed', 'legacy_drain_fenced');
    const current = receiverState(snapshot.sessions.get(id)?.receiver);
    if (current?.generation !== generation || current.native_session_id !== nativeSessionId)
      throw new ConflictError('Legacy adapter registration not committed', 'legacy_drain_fenced');
    record.receiverGeneration = generation;
    record.receiverObservedAt = Date.now();
    this.changed(record);
    return true;
  }
  hostActivity(hostId: number): { connected: boolean; lastAt: number | null } {
    const snapshot = this.runtime.state.snapshot();
    let lastAt: number | null = null,
      connected = false;
    for (const record of this.records.values()) {
      if (record.hostId !== hostId) continue;
      const deadline = this.deadline(snapshot, record.kind, record.id);
      if (!deadline || deadline <= Date.now()) continue;
      if (Number.isFinite(record.nativeObservedAt)) lastAt = Math.max(lastAt ?? 0, record.nativeObservedAt);
      if (record.nativeObservedAt + 45000 > Date.now()) connected = true;
    }
    return { connected, lastAt };
  }
  capturedSession(id: string): Readonly<LegacyDrainRecord> | undefined {
    return this.records.get(key('session', id));
  }
  existingClaim(kind: LegacyDrainRecord['kind'], id: string, claimId: string): boolean {
    const record = this.records.get(key(kind, id));
    return Boolean(
      record &&
      record.acceptedClaimIds.includes(claimId) &&
      (this.deadline(this.runtime.state.snapshot(), kind, id) ?? 0) > Date.now(),
    );
  }
  finish(kind: LegacyDrainRecord['kind'], id: string): void {
    this.records.delete(key(kind, id));
    this.runtime.deadlines.cancel('legacy-presence:' + key(kind, id));
    this.changed();
  }
  counts() {
    const snapshot = this.runtime.state.snapshot();
    return {
      legacy_sessions: [...this.records.values()].filter((r) => r.kind === 'session').length,
      legacy_relays: [...this.records.values()].filter((r) => r.kind === 'relay').length,
      legacy_resource_claims: [...this.records.values()].reduce((n, r) => n + r.resourceClaims.length, 0),
      legacy_git_registrations: [...this.records.values()].reduce((n, r) => n + r.gitRegistrations.length, 0),
      legacy_timed_provider: snapshot
        .table('providerAccountSessions')
        .all()
        .filter((r) => r.ownershipMode !== 'connection' && Date.parse(r.expiresAt) > Date.now()).length,
    };
  }
  diagnostics() {
    return [...this.records.values()].map((record) => ({
      kind: record.kind,
      id: record.id,
      binding: record.binding,
      native_instance_id: record.instanceId,
      receiver_generation: record.receiverGeneration,
      accepted_claim_count: record.acceptedClaimIds.length,
      resource_claim_count: record.resourceClaims.length,
      git_registration_count: record.gitRegistrations.length,
      protected_deadline: this.protectedDeadline(record.id, record.binding),
      protected_security_deadline: Number.isFinite(record.protectedSecurityDeadline)
        ? record.protectedSecurityDeadline
        : null,
      authorization_deadline: new Date(
        Math.min(
          record.credentialDeadline,
          this.deadline(this.runtime.state.snapshot(), record.kind, record.id) ?? record.credentialDeadline,
        ),
      ).toISOString(),
    }));
  }
  close() {
    this.unlisten();
    for (const id of this.records.keys()) this.runtime.deadlines.cancel('legacy-presence:' + id);
    this.records.clear();
    this.listeners.clear();
    runtimes.delete(this.runtime);
  }
}
export function legacyDrainFor(runtime: OwnerRuntime): LegacyDrainRegistry | undefined {
  return runtimes.get(runtime);
}
export function legacyDrainDeadline(
  snapshot: OwnerStateSnapshot,
  kind: 'session' | 'relay',
  id: string,
): number | undefined {
  return snapshots.get(snapshot)?.deadline(snapshot, kind, id);
}
