import { ownerPresence } from '../presence.js';
import { ownedCredentialDeadline } from '../credentials.js';
import type { OwnerRuntime } from './runtime.js';
import type { OwnerStateSnapshot } from './store.js';

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
/**
 * A connected session's persisted `heartbeatAt` is restamped once it is this
 * old, so last-seen survives an API restart. In-memory attachment times die
 * with the owner epoch; without the stamp a laptop that slept across a deploy
 * would look like it vanished at its launch time.
 */
export const LAST_SEEN_STAMP_MS = 10 * 60_000;

interface Tracker {
  readonly bootAt: number;
  readonly lastAttached: Map<string, number>;
  readonly stop: () => void;
}
const trackers = new WeakMap<OwnerRuntime, Tracker>();

/**
 * Records when each session was last attached. Timestamps only: a presence
 * listener must never stage a mutation (presence.close() detaches everything
 * during teardown). Started at boot next to trackHostActivity; the lazy start
 * in tracker() only serves owners built without bootstrap (tests).
 */
export function trackSessionActivity(owner: OwnerRuntime): void {
  if (trackers.has(owner)) return;
  const lastAttached = new Map<string, number>();
  const presence = ownerPresence(owner);
  for (const attachment of presence.all())
    if (attachment.scope.session_id) lastAttached.set(attachment.scope.session_id, Date.now());
  const stopPresence = presence.subscribe((change) => {
    const id = change.attachment.scope.session_id;
    if (id) lastAttached.set(id, Date.now());
  });
  const stopState = owner.state.subscribe((snapshot) => {
    for (const id of lastAttached.keys()) if (!snapshot.sessions.has(id)) lastAttached.delete(id);
  });
  trackers.set(owner, {
    bootAt: Date.now(),
    lastAttached,
    stop: () => {
      stopPresence();
      stopState();
      lastAttached.clear();
      trackers.delete(owner);
    },
  });
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

/** Last moment the session was known to be connected; null while it is connected. */
export function sessionLastSeen(owner: OwnerRuntime, snapshot: OwnerStateSnapshot, sessionId: string): number | null {
  const session = snapshot.sessions.get(sessionId);
  if (!session) return -Infinity;
  if (!session.endedAt && sessionAttached(owner, snapshot, sessionId)) return null;
  return Math.max(tracker(owner).lastAttached.get(sessionId) ?? -Infinity, time(session.heartbeatAt));
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
  const capabilities = session.adapterCapabilities as Record<string, unknown> | null;
  const grace =
    capabilities?.suspend_recovery_version === 1 && session.invocationKind === 'interactive'
      ? SUSPEND_RECOVERY_GRACE_MS
      : bridgeTtlMs;
  return Math.max(
    seen + grace,
    tracker(owner).bootAt + bridgeTtlMs,
    ownedCredentialDeadline(snapshot, 'session', sessionId),
  );
}

/** Attached sessions whose persisted last-seen is due for a restamp, and detached ones not yet stamped. */
export function lastSeenStamps(owner: OwnerRuntime, snapshot: OwnerStateSnapshot, now: number): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const session of snapshot.sessions.all()) {
    if (session.endedAt) continue;
    const stored = time(session.heartbeatAt);
    if (sessionAttached(owner, snapshot, session.id)) {
      if (now - stored >= LAST_SEEN_STAMP_MS) out.push([session.id, now]);
      continue;
    }
    const tracked = tracker(owner).lastAttached.get(session.id);
    if (tracked !== undefined && tracked > stored + 1000) out.push([session.id, tracked]);
  }
  return out;
}

const RELEASE_STATES = ['disconnected', 'owner_restart'];
/**
 * Earliest moment the liveness reconciliation has work: a claim or Git
 * registration to release, a session to finalize, or a last-seen to stamp.
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
    if (sessionAttached(owner, snapshot, session.id)) due = Math.min(due, time(session.heartbeatAt) + LAST_SEEN_STAMP_MS);
  }
  return Number.isFinite(due) ? due : null;
}
