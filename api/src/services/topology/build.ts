import type { CommunicatorSnapshot, ConnectionTombstone } from './communicator-registry.js';
import type {
  ActionAvailability,
  AssociationState,
  TopologyAgentNode,
  TopologyAssociation,
  TopologyCommunicatorNode,
  TopologyDisconnect,
  TopologySnapshot,
} from './types.js';

/** A communicator that has not sent any frame for this long is shown as stale. */
export const COMMUNICATOR_STALE_AFTER_MS = 45_000;
/** First cxx release whose owner understands the remote `terminate` control frame. */
export const COMMUNICATOR_TERMINATE_MIN_VERSION: readonly [number, number, number] | null = null;

/** The fields of a portal session projection row this module reads. */
export interface PortalSessionInput {
  id: string;
  engine: string;
  host_id: number;
  host: string;
  username: string;
  cwd: string;
  launch_name: string | null;
  session_name: string | null;
  invocation_kind: string;
  presence: string;
  status: string;
  relay_ready: boolean;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
  close: { requested_at?: string | null; state?: string } | null;
}

export interface DaemonBindingInput {
  session_id: string;
  status: string;
}

export interface TopologyInputs {
  now: number;
  serverLabel: string;
  startedAtMs: number;
  communicatorEnabled: boolean;
  portalEnabled: boolean;
  /** Seconds a session's traffic evidence stays "attributed" (the presence window). */
  evidenceFreshSeconds: number;
  communicators: readonly CommunicatorSnapshot[];
  hostNames: ReadonlyMap<number, string>;
  sessions: readonly PortalSessionInput[];
  addresses: ReadonlyMap<string, { address: string; alias: string | null; binding_generation: number | null }>;
  daemonBySession: ReadonlyMap<string, DaemonBindingInput>;
  tombstones: readonly ConnectionTombstone[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const ageSeconds = (now: number, then: number | null) =>
  then === null || !Number.isFinite(then) ? null : Math.max(0, Math.round((now - then) / 1000));

/** `0.9.74`, `v0.9.74`, `0.9.74-rc1` → `[0, 9, 74]`; anything else → null. */
export function parseReleaseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function communicatorCanTerminate(version: string): boolean {
  const min = COMMUNICATOR_TERMINATE_MIN_VERSION;
  const parsed = parseReleaseVersion(version);
  if (!min || !parsed) return false;
  for (let i = 0; i < 3; i++) {
    if (parsed[i]! !== min[i]!) return parsed[i]! > min[i]!;
  }
  return true;
}

function requestCloseAvailability(session: PortalSessionInput): ActionAvailability {
  if (session.ended_at) return { allowed: false, reason: 'session_ended' };
  if (session.close) return { allowed: false, reason: 'close_already_requested' };
  if (!session.relay_ready) return { allowed: false, reason: 'agent_not_listening' };
  return { allowed: true, reason: null };
}

function stopProcessAvailability(session: PortalSessionInput, daemon: DaemonBindingInput | undefined): ActionAvailability {
  if (session.ended_at) return { allowed: false, reason: 'session_ended' };
  if (!daemon) return { allowed: false, reason: 'not_daemon_managed' };
  if (daemon.status === 'closed') return { allowed: false, reason: 'daemon_session_closed' };
  if (daemon.status === 'stopping') return { allowed: false, reason: 'stop_in_progress' };
  return { allowed: true, reason: null };
}

function endRecordAvailability(session: PortalSessionInput): ActionAvailability {
  return session.ended_at ? { allowed: false, reason: 'session_ended' } : { allowed: true, reason: null };
}

/**
 * Assembles the topology from already-loaded facts. No I/O, no clock reads: every
 * rule about who is whose child lives here so it can be tested exactly.
 *
 * Association is evidence only. A session is the child of a communicator when the
 * API answered one of that session's own requests over that socket; the host key
 * and bridge token make that proof, where "same host and engine" would not be
 * (one user can run several communicators in separate runtime roots, and a
 * session may bypass them entirely over direct HTTPS). Everything else hangs off
 * the server and says so.
 */
export function buildTopology(input: TopologyInputs): TopologySnapshot {
  const { now } = input;
  const freshMs = input.evidenceFreshSeconds * 1000;
  const live = input.sessions.filter((session) => !session.ended_at);

  const bySession = new Map<string, Array<{ comm: CommunicatorSnapshot; lastSeenMs: number }>>();
  for (const comm of input.communicators) {
    for (const [sessionId, evidence] of comm.evidence) {
      const list = bySession.get(sessionId) ?? [];
      list.push({ comm, lastSeenMs: evidence.last_seen_ms });
      bySession.set(sessionId, list);
    }
  }

  const childrenOf = new Map<string, Array<{ id: string; lastSeenMs: number }>>();
  const agents: TopologyAgentNode[] = live.map((session) => {
    const sessionId = session.id.toLowerCase();
    // Host key authentication already pins a session to its host; evidence for
    // a different host would mean a bug, and is not honoured.
    const candidates = (bySession.get(sessionId) ?? [])
      .filter((c) => c.comm.view.host_id === session.host_id)
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs || a.comm.view.id.localeCompare(b.comm.view.id));
    const best = candidates[0];
    let association: TopologyAssociation;
    if (best) {
      const age = now - best.lastSeenMs;
      const state: AssociationState = age <= freshMs ? 'attributed' : 'stale';
      association = {
        state,
        basis: 'session_traffic',
        parent_id: best.comm.view.id,
        last_seen_at: iso(best.lastSeenMs),
        age_s: Math.max(0, Math.round(age / 1000)),
        also_seen_on: candidates
          .slice(1)
          .filter((c) => now - c.lastSeenMs <= freshMs)
          .map((c) => c.comm.view.id),
      };
      const list = childrenOf.get(best.comm.view.id) ?? [];
      list.push({ id: session.id, lastSeenMs: best.lastSeenMs });
      childrenOf.set(best.comm.view.id, list);
    } else {
      association = {
        state: 'unattributed',
        basis: 'none',
        parent_id: 'server',
        last_seen_at: null,
        age_s: null,
        also_seen_on: [],
      };
    }
    const address = input.addresses.get(session.id);
    const daemon = input.daemonBySession.get(session.id);
    const heartbeatMs = Date.parse(session.heartbeat_at);
    return {
      kind: 'agent',
      id: session.id,
      name: session.launch_name || session.session_name || `${session.engine} ${session.id.slice(0, 8)}`,
      engine: session.engine,
      host_id: session.host_id,
      host: session.host,
      username: session.username,
      cwd: session.cwd,
      invocation_kind: session.invocation_kind,
      presence: session.presence,
      status: session.status,
      relay_ready: session.relay_ready,
      started_at: session.started_at,
      heartbeat_at: session.heartbeat_at,
      heartbeat_age_s: ageSeconds(now, Number.isFinite(heartbeatMs) ? heartbeatMs : null),
      address: address?.address ?? null,
      address_alias: address?.alias ?? null,
      binding_generation: address?.binding_generation ?? null,
      close: session.close
        ? { state: session.close.state ?? 'pending', requested_at: session.close.requested_at ?? null }
        : null,
      daemon: daemon ? { session_id: daemon.session_id, status: daemon.status } : null,
      association,
      actions: {
        request_close: requestCloseAvailability(session),
        stop_process: stopProcessAvailability(session, daemon),
        end_record: endRecordAvailability(session),
      },
    };
  });
  agents.sort(
    (a, b) =>
      a.host.localeCompare(b.host) ||
      a.username.localeCompare(b.username) ||
      a.started_at.localeCompare(b.started_at) ||
      a.id.localeCompare(b.id),
  );

  const communicators: TopologyCommunicatorNode[] = input.communicators.map((comm) => {
    const view = comm.view;
    const scopes = Array.isArray(view.sync_scopes) ? (view.sync_scopes as Array<Record<string, unknown>>) : [];
    const errors = scopes.filter((scope) => {
      const auth = scope.auth as { error?: unknown } | undefined;
      return Boolean(scope.content_error) || Boolean(auth?.error);
    }).length;
    const idle = now - comm.last_frame_ms;
    const children = (childrenOf.get(view.id) ?? []).sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    return {
      kind: 'communicator',
      id: view.id,
      host_id: view.host_id,
      host: input.hostNames.get(view.host_id) ?? `host ${view.host_id}`,
      username: view.username,
      version: view.version,
      connected_at: view.connected_at,
      last_frame_at: iso(comm.last_frame_ms),
      last_heartbeat_at: comm.last_heartbeat_ms === null ? null : iso(comm.last_heartbeat_ms),
      health: comm.closing ? 'closing' : idle > COMMUNICATOR_STALE_AFTER_MS ? 'stale' : 'live',
      idle_s: Math.max(0, Math.round(idle / 1000)),
      leases_reported: view.sessions,
      requests: view.requests,
      synced_at: view.synced_at,
      sync_scopes: scopes.length,
      sync_errors: errors,
      remote_address: comm.remote_address,
      daemon_attached: comm.daemon_attached,
      agent_ids: children.map((c) => c.id),
      can_terminate: communicatorCanTerminate(view.version),
    };
  });
  communicators.sort(
    (a, b) =>
      a.host.localeCompare(b.host) ||
      a.username.localeCompare(b.username) ||
      a.connected_at.localeCompare(b.connected_at) ||
      a.id.localeCompare(b.id),
  );

  const recent: TopologyDisconnect[] = input.tombstones.slice(0, 12).map((t) => ({
    id: t.id,
    host_id: t.host_id,
    host: input.hostNames.get(t.host_id) ?? `host ${t.host_id}`,
    username: t.username,
    version: t.version,
    connected_at: t.connected_at,
    ended_at: t.ended_at,
    reason: t.reason,
    actor: t.actor,
    affected_agent_ids: t.session_ids,
    successor_id: t.successor_id,
  }));

  const count = (state: AssociationState) => agents.filter((a) => a.association.state === state).length;
  return {
    generated_at: iso(now),
    server: {
      id: 'server',
      label: input.serverLabel,
      started_at: iso(input.startedAtMs),
      uptime_s: Math.max(0, Math.round((now - input.startedAtMs) / 1000)),
      communicator_enabled: input.communicatorEnabled,
      portal_enabled: input.portalEnabled,
      scope: 'api_process',
    },
    communicators,
    agents,
    recent_disconnects: recent,
    counts: {
      communicators: communicators.length,
      agents: agents.length,
      attributed: count('attributed'),
      stale: count('stale'),
      unattributed: count('unattributed'),
    },
  };
}
