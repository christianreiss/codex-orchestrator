import { ownerPresence } from '../presence.js';
import { ownedCredentialDeadline } from '../credentials.js';
import { legacyDrainFor } from '../legacy-drain.js';
import { mutateOwnerState, withOwnerBackgroundScope, type OwnerRuntime } from './runtime.js';
import { stageUpdate } from './rows.js';
import type { AgentSession } from '../../db/schema.js';
import type { OwnerStateSnapshot } from './store.js';
import { ConflictError } from '../../http/errors.js';

/**
 * How long a holder may stay disconnected before its resource claims, Git
 * registration and merge lease are released. It covers an API restart (every
 * connection drops at once and reattaches within seconds) and a network blip.
 * It is measured from the last moment the session was seen attached and is
 * never renewed: an offline agent holds nothing past it.
 */
export const OWNER_RECONNECT_GRACE_MS = 5 * 60_000;
/**
 * An interactive wrapper that advertises suspend recovery may sleep with an
 * intact process and resume its native session. Its claims still follow the
 * reconnect grace; only the session itself is finalized after this long.
 */
export const SUSPEND_RECOVERY_GRACE_MS = 24 * 3600_000;
type SuspendFacts = Pick<AgentSession, 'invocationKind' | 'adapterCapabilities'>;
export function supportsSuspend(session: SuspendFacts): boolean {
  return session.invocationKind === 'interactive' &&
    (session.adapterCapabilities as Record<string, unknown> | null)?.suspend_recovery_version === 1;
}

interface Tracker {
  readonly bootAt: number;
  readonly lastAttached: Map<string, { generation: number; at: number; connected: boolean }>;
  readonly transitions: Map<string, Promise<unknown>>;
  /** Relay id -> last moment any of its attachments connected or detached. */
  readonly lastRelayAttached: Map<string, number>;
  readonly stop: () => void;
}
const trackers = new WeakMap<OwnerRuntime, Tracker>();

/** Only an admitted suspend-capable session opens a marker. A final disconnect records its observed time. */
function persistAttachment(owner: OwnerRuntime, id: string, gen: number, connected: boolean, at: number) {
  return withOwnerBackgroundScope(() => mutateOwnerState(owner, {
    kind: connected ? 'session.attachment.open' : 'session.attachment.close',
    payload: { id, generation: gen },
    prepare(ctx) {
      const row = ctx.snapshot.sessions.get(id);
      if (!row || row.endedAt || row.bindingGeneration !== gen) return null;
      if (connected) {
        if (row.status !== 'reboot_wait' && !row.closeRequestedAt && supportsSuspend(row))
          stageUpdate(ctx, 'agentSessions', id, { suspendAttachmentGeneration: gen, suspendRecoveryUntil: null });
      } else if (at > time(row.heartbeatAt) || row.suspendAttachmentGeneration !== null || row.suspendRecoveryUntil !== null) {
        stageUpdate(ctx, 'agentSessions', id, {
          heartbeatAt: new Date(Math.max(at, time(row.heartbeatAt))).toISOString(),
          suspendAttachmentGeneration: null,
          suspendRecoveryUntil: null,
        });
      }
      return null;
    },
  }));
}

/** Queue observed edges in transport order. The system callback is enabled only on a bootstrapped owner. */
export function trackSessionActivity(owner: OwnerRuntime, onPersistenceFailure?: (error: unknown) => void): void {
  if (trackers.has(owner)) return;
  const lastAttached: Tracker['lastAttached'] = new Map(),
    transitions: Tracker['transitions'] = new Map(),
    lastRelayAttached = new Map<string, number>();
  const presence = ownerPresence(owner);
  const observe = (scope: { topic: string; session_id?: string; binding_generation?: number; relay_id?: string }) => {
    if (scope.topic === 'relay' && scope.relay_id) lastRelayAttached.set(scope.relay_id, Date.now());
    if (scope.topic !== 'session' && scope.topic !== 'receiver') return;
    const id = scope.session_id, gen = scope.binding_generation;
    if (!id || gen === undefined) return;
    const session = owner.state.snapshot().sessions.get(id);
    if (!session || session.bindingGeneration !== gen || session.endedAt) return;
    const connected = presence.session(id, gen).length > 0;
    const prior = lastAttached.get(id);
    if (prior?.generation === gen && prior.connected === connected) return;
    const at = Date.now();
    lastAttached.set(id, { generation: gen, at, connected });
    if (!onPersistenceFailure || (connected && !supportsSuspend(session))) return;
    const task = persistAttachment(owner, id, gen, connected, at);
    transitions.set(id, task);
    void task.catch(onPersistenceFailure).finally(() => {
      if (transitions.get(id) === task) transitions.delete(id);
    });
  };
  for (const attachment of presence.all()) observe(attachment.scope);
  const stopPresence = presence.subscribe(({ attachment }) => observe(attachment.scope));
  const stopState = owner.state.subscribe((snapshot) => {
    for (const id of lastAttached.keys()) if (!snapshot.sessions.has(id)) lastAttached.delete(id);
    const relays = snapshot.table('agentBusRelays');
    for (const id of lastRelayAttached.keys()) if (!relays.get(id)) lastRelayAttached.delete(id);
  });
  trackers.set(owner, {
    bootAt: Date.now(),
    lastAttached,
    transitions,
    lastRelayAttached,
    stop: () => {
      stopPresence();
      stopState();
      lastAttached.clear();
      lastRelayAttached.clear();
      trackers.delete(owner);
    },
  });
}
/** The first snapshot waits for the first proven attachment to commit. */
export function sessionAttachmentTransition(owner: OwnerRuntime, id: string): Promise<unknown> | undefined {
  return trackers.get(owner)?.transitions.get(id);
}
export function stopSessionActivity(owner: OwnerRuntime): void {
  trackers.get(owner)?.stop();
}
function tracker(owner: OwnerRuntime): Tracker {
  trackSessionActivity(owner);
  return trackers.get(owner)!;
}
function time(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

/** Any live attachment (session or receiver topic) of the session's current binding. */
export function sessionAttached(owner: OwnerRuntime, snapshot: OwnerStateSnapshot, sessionId: string): boolean {
  const session = snapshot.sessions.get(sessionId);
  return Boolean(session && ownerPresence(owner).session(sessionId, session.bindingGeneration).length > 0);
}

/**
 * A same-host session holding an address that a newer launch has proven to own
 * by reporting its native transcript, while the holder itself is not attached
 * (a crashed or closed terminal, a finished headless relay turn) and no planned
 * reboot waits for it. The newer launch may take the address over: the
 * operator resumed that conversation, and the detached holder cannot receive
 * for it. Its held work settles through owner maintenance.
 */
export function detachedHolderReplaceable(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  holderId: string,
  hostId: number,
): boolean {
  const holder = snapshot.sessions.get(holderId);
  if (!holder) return true;
  if (holder.hostId !== hostId || holder.status === 'reboot_wait') return false;
  if (
    snapshot
      .table('agentRebootHandoffs')
      .all()
      .some((row) => row.oldSessionId === holderId && ['prepared', 'armed'].includes(row.status))
  )
    return false;
  if (holder.endedAt !== null) return true;
  // A blip, a communicator restart or an owner restart detaches a live holder
  // for seconds; only a holder that stayed away past the grace is taken over.
  const lastSeen = sessionLastSeen(owner, snapshot, holderId);
  if (lastSeen === null) return false;
  return Date.now() >= Math.max(lastSeen, tracker(owner).bootAt) + HOLDER_TAKEOVER_GRACE_MS;
}
/**
 * Facts a refused launch needs to decide whether to wait: a headless delivery
 * turn ends by itself, and a detached holder becomes replaceable after the grace.
 */
export function holderKind(owner: OwnerRuntime | undefined, snapshot: OwnerStateSnapshot, holderId: string) {
  const holder = snapshot.sessions.get(holderId);
  return {
    holder_invocation_kind: holder?.invocationKind ?? null,
    holder_detached: Boolean(owner && holder && !holder.endedAt && !sessionAttached(owner, snapshot, holderId)),
  };
}
/**
 * The server closed this lifecycle as abandoned (its connection lapsed past the
 * abandon grace), yet its own process re-registers with the exact launch
 * credential: that is a resume of a living process, which gets its lifecycle,
 * address and name back. Sessions the wrapper or an operator ended, headless
 * delivery turns (their delivery already settled) and old sessions of a reboot
 * handoff stay finished.
 */
export function abandonedSessionRevivable(
  snapshot: OwnerStateSnapshot,
  session: { id: string; status: string; endedAt: string | null; closeRequestedAt: string | null; invocationKind: string },
): boolean {
  return (
    session.endedAt !== null &&
    session.status === 'failed' &&
    !session.closeRequestedAt &&
    ['interactive', 'execute'].includes(session.invocationKind) &&
    !snapshot.table('agentRebootHandoffs').by('oldSessionId', session.id).length
  );
}
/** The one owned refusal for an ended lifecycle; a revivable one tells the wrapper to re-register. */
export function ownedSessionFinishedError(
  snapshot: OwnerStateSnapshot,
  session: Parameters<typeof abandonedSessionRevivable>[1],
): ConflictError {
  return abandonedSessionRevivable(snapshot, session)
    ? new ConflictError(
        'Agent session was closed as abandoned while disconnected; its own process re-registers to resume it.',
        'agent_session_finished',
        { ended_reason: 'abandoned', recovery: 'reregister' },
      )
    : new ConflictError(
        'Agent session is finished. Resume the same native conversation in a new managed launch.',
        'agent_session_finished',
        { ended_reason: 'finished', recovery: 'resume_native_conversation' },
      );
}
/** How long a detached address holder keeps its address against a newer launch. */
export const HOLDER_TAKEOVER_GRACE_MS = 60_000;

/** Last moment the session was known to be connected; null while it is connected. */
export function sessionLastSeen(owner: OwnerRuntime, snapshot: OwnerStateSnapshot, sessionId: string): number | null {
  const session = snapshot.sessions.get(sessionId);
  if (!session) return -Infinity;
  if (!session.endedAt && sessionAttached(owner, snapshot, sessionId)) return null;
  const last = tracker(owner).lastAttached.get(sessionId);
  return Math.max(last?.generation === session.bindingGeneration ? last.at : -Infinity, time(session.heartbeatAt));
}

/**
 * When a holder stops counting as present: at once for an ended or vanished
 * session, otherwise once it has been offline for the reconnect grace and the
 * owner has been up for at least as long (bootstrap marks every live claim and
 * registration `owner_restart` before anyone could reattach). Null while attached.
 */
export function holderGoneAt(owner: OwnerRuntime, snapshot: OwnerStateSnapshot, sessionId: string): number | null {
  const session = snapshot.sessions.get(sessionId);
  if (!session || session.endedAt) return -Infinity;
  const seen = sessionLastSeen(owner, snapshot, sessionId);
  if (seen === null) return null;
  return Math.max(seen, tracker(owner).bootAt) + OWNER_RECONNECT_GRACE_MS;
}

/**
 * When work held by relay lease `relay:<id>:<generation>` stops having an owner
 * that could ever report it: at once when that relay row, generation or
 * instance no longer exists, otherwise once the exact relay incarnation has
 * been detached for the reconnect grace and the owner has been up at least as
 * long. Null while that incarnation is attached. Only the same process (same
 * per-process instance id) can reattach; a new worker process never can.
 */
export function relayHolderGoneAt(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  leaseOwner: string,
  ownerInstanceId: string | null,
  claimId: string | null = null,
): number | null {
  const [kind, id, generation] = leaseOwner.split(':');
  if (kind !== 'relay' || !id) return null;
  // A captured pre-cutover relay process reports over the explicit legacy
  // drain, never over presence. Its accepted claims stay protected while the
  // drain proof for that exact claim is live.
  if (claimId && legacyDrainFor(owner)?.existingClaim('relay', id, claimId)) return null;
  const relay = snapshot.table('agentBusRelays').get(id);
  if (
    !relay ||
    relay.status !== 'active' ||
    String(relay.generation) !== generation ||
    (ownerInstanceId !== null && ownerInstanceId !== relay.instanceId)
  )
    return -Infinity;
  const attached = ownerPresence(owner)
    .all()
    .some(
      (a) =>
        a.scope.topic === 'relay' &&
        a.scope.relay_id === relay.id &&
        a.scope.binding_generation === relay.generation &&
        a.scope.native_instance_id === relay.instanceId,
    );
  if (attached) return null;
  const state = tracker(owner);
  return Math.max(state.lastRelayAttached.get(id) ?? -Infinity, state.bootAt) + OWNER_RECONNECT_GRACE_MS;
}

/**
 * A successor resumed from the same native transcript may still continue the
 * holder's claims and registration. It counts while it is present, judged by
 * presence and grace, not by `endedAt`: a crashed successor is never ended.
 */
function liveSuccessor(owner: OwnerRuntime, snapshot: OwnerStateSnapshot, sessionId: string, now: number): boolean {
  const session = snapshot.sessions.get(sessionId);
  if (!session?.agentBusAddressId || !session.upstreamSessionId) return false;
  return snapshot.sessions.by('agentBusAddressId', session.agentBusAddressId).some((next) => {
    if (next.id === session.id || next.endedAt || next.upstreamSessionId !== session.upstreamSessionId) return false;
    const gone = holderGoneAt(owner, snapshot, next.id);
    return gone === null || gone > now;
  });
}

/**
 * The holder, or a successor resumed from the same native transcript, is
 * attached right now. Unlike {@link holderReleasable} there is no grace: a
 * holder that is merely still inside its reconnect grace is not attached.
 */
export function holderAttached(owner: OwnerRuntime, snapshot: OwnerStateSnapshot, sessionId: string | null): boolean {
  if (!sessionId) return false;
  const session = snapshot.sessions.get(sessionId);
  if (!session) return false;
  if (!session.endedAt && sessionAttached(owner, snapshot, sessionId)) return true;
  if (!session.agentBusAddressId || !session.upstreamSessionId) return false;
  return snapshot.sessions.by('agentBusAddressId', session.agentBusAddressId).some((next) =>
    next.id !== session.id && !next.endedAt && next.upstreamSessionId === session.upstreamSessionId &&
    sessionAttached(owner, snapshot, next.id));
}

/** The holder session is gone and nobody can continue its work: release what it holds. */
export function holderReleasable(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  sessionId: string | null,
  now: number,
): boolean {
  if (!sessionId) return now >= tracker(owner).bootAt + OWNER_RECONNECT_GRACE_MS;
  const gone = holderGoneAt(owner, snapshot, sessionId);
  return gone !== null && gone <= now && !liveSuccessor(owner, snapshot, sessionId, now);
}

/**
 * When an unended session that is no longer attached is finalized as abandoned
 * (the owner-mode twin of the legacy expireAbandonedSessions sweep). Null while
 * attached, ended, or held by a planned reboot.
 */
export function sessionAbandonDueAt(
  owner: OwnerRuntime,
  snapshot: OwnerStateSnapshot,
  sessionId: string,
  bridgeTtlMs: number,
): number | null {
  const session = snapshot.sessions.get(sessionId);
  if (!session || session.endedAt || session.status === 'reboot_wait') return null;
  if (
    !session.closeRequestedAt &&
    snapshot
      .table('agentRebootHandoffs')
      .all()
      .some((row) => row.oldSessionId === sessionId && row.status === 'armed')
  )
    return null;
  const seen = sessionLastSeen(owner, snapshot, sessionId);
  if (seen === null) return null;
  const suspend = supportsSuspend(session);
  const recovery = suspend && !session.closeRequestedAt && session.suspendAttachmentGeneration === session.bindingGeneration
    ? time(session.suspendRecoveryUntil) : -Infinity;
  return Math.max(
    seen + (suspend ? SUSPEND_RECOVERY_GRACE_MS : bridgeTtlMs),
    Number.isFinite(recovery) ? recovery : tracker(owner).bootAt + bridgeTtlMs,
    ownedCredentialDeadline(snapshot, 'session', sessionId),
  );
}

const RELEASE_STATES = ['disconnected', 'owner_restart'];
/**
 * Earliest moment the liveness reconciliation has work: a claim or Git
 * registration to release, or a session to finalize.
 * Presence and state changes already wake the tick; this covers time alone.
 */
export function livenessDueAt(owner: OwnerRuntime, snapshot: OwnerStateSnapshot, bridgeTtlMs: number): number | null {
  let due = Infinity;
  const holder = (sessionId: string | null) => {
    const at = sessionId ? holderGoneAt(owner, snapshot, sessionId) : tracker(owner).bootAt + OWNER_RECONNECT_GRACE_MS;
    if (at !== null) due = Math.min(due, at);
  };
  for (const claim of snapshot.claims.all())
    if (claim.state === 'waiting' || (claim.state === 'uncertain' && RELEASE_STATES.includes(claim.uncertaintyReason ?? '')))
      holder(claim.sessionId);
  for (const row of snapshot.table('gitWorktrees').by('status', 'uncertain'))
    if (RELEASE_STATES.includes(row.uncertaintyReason ?? '')) holder(row.agentSessionId);
  for (const session of snapshot.sessions.all()) {
    if (session.endedAt) continue;
    const abandon = sessionAbandonDueAt(owner, snapshot, session.id, bridgeTtlMs);
    if (abandon !== null) due = Math.min(due, abandon);
  }
  return Number.isFinite(due) ? due : null;
}
