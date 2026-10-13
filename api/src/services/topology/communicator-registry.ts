/**
 * Process-local registry of live communicator control connections.
 *
 * `/host/communicator/connect` used to keep a bare `Map<id, view>`. The topology
 * view needs three more facts about each connection, all of which only the
 * route can observe while it happens:
 *
 *  - a handle that can close that one socket (the admin "disconnect" action),
 *  - which agent sessions authenticated *through* this connection (evidence, see
 *    {@link SessionEvidence}), and
 *  - what became of connections that went away (tombstones), so a disconnect
 *    that is followed by a redial is reported as a reconnect, not a kill.
 *
 * Nothing here is persisted. The connection set is process-local by design (the
 * deployment runs one API instance); a restart empties it and every communicator
 * redials, exactly as `docs/communicator.md` describes.
 */

import { randomUUID } from 'node:crypto';

export interface CommunicatorView {
  /** Server-generated per-socket identity. A reconnect gets a new one. */
  id: string;
  host_id: number;
  username: string;
  version: string;
  connected_at: string;
  sessions: number;
  requests: number;
  synced_at: string | null;
  sync_scopes?: unknown[];
}

/** What the route lends the registry so an admin action can end one socket. */
export interface CommunicatorHandle {
  close(code: number, reason: string): void;
  /** Writes one control frame to the socket; absent when the transport cannot. */
  send?(frame: unknown): void;
  /** Hard-stops a socket whose peer ignores the close handshake. */
  terminate?(): void;
  remoteAddress: string | null;
}

/**
 * Proof, not inference, that an agent session talks through a connection: the
 * communicator carried a request for `/host/agent-sessions/<id>/…` that the API
 * answered below 400, which means the session's bridge token authenticated on
 * this host's key over this socket. Matching host and engine proves nothing —
 * one OS user can run several communicators in separate runtime roots.
 */
export interface SessionEvidence {
  first_seen_ms: number;
  last_seen_ms: number;
  requests: number;
  last_route: string;
}

export type DisconnectReason = 'admin_disconnect' | 'admin_terminate' | 'peer_closed';

/**
 * What an owner said about itself in its one `capabilities` frame. Self-reported,
 * and only sent to a server that announced control, so an owner that never sent
 * one cannot be asked to stop.
 */
export interface OwnerCapabilities {
  terminate: boolean;
  pid: number | null;
  started_at: string | null;
}

export interface TerminateAck {
  accepted: boolean;
  pid: number | null;
  reason: string | null;
}

export type TerminateOutcome =
  /** Owner acknowledged and its connection then closed. */
  | 'terminated'
  /** Owner acknowledged; the connection was still open when the wait ended. */
  | 'acknowledged'
  /** Owner declined (it cannot stop itself). */
  | 'refused'
  /** The frame was sent and nothing answered in time. */
  | 'unacknowledged'
  /** The owner never announced that it can be stopped remotely. */
  | 'unsupported'
  /** Another stop request for this connection is still in flight. */
  | 'in_progress'
  | 'not_connected';

export interface ConnectionTombstone {
  id: string;
  host_id: number;
  username: string;
  version: string;
  connected_at: string;
  ended_at: string;
  reason: DisconnectReason;
  /** Admin who requested the disconnect, when there was one. */
  actor: string | null;
  /** The owner's own account of its process, when it gave one. */
  pid: number | null;
  process_started_at: string | null;
  session_ids: string[];
  /** A later connection from the same host and OS user, once one appears. */
  successor_id: string | null;
}

interface Entry {
  view: CommunicatorView;
  handle: CommunicatorHandle;
  connectedMs: number;
  lastFrameMs: number;
  lastHeartbeatMs: number | null;
  daemonAttached: boolean;
  evidence: Map<string, SessionEvidence>;
  closing: { reason: DisconnectReason; actor: string | null } | null;
  capabilities: OwnerCapabilities;
  terminateRequest: { id: string; resolve: (ack: TerminateAck | null) => void } | null;
}

export interface CommunicatorSnapshot {
  view: CommunicatorView;
  remote_address: string | null;
  connected_ms: number;
  last_frame_ms: number;
  last_heartbeat_ms: number | null;
  daemon_attached: boolean;
  closing: boolean;
  capabilities: OwnerCapabilities;
  evidence: ReadonlyMap<string, SessionEvidence>;
}

const MAX_EVIDENCE_PER_CONNECTION = 2048;
/** Evidence older than this proves nothing about the present and is dropped. */
const EVIDENCE_RETENTION_MS = 10 * 60_000;
const MAX_TOMBSTONES = 64;
const SUCCESSOR_WINDOW_MS = 2 * 60_000;
const TOMBSTONE_RETENTION_MS = 15 * 60_000;
const SESSION_PATH = /^\/host\/agent-sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/;

/** The agent session a `/host/agent-sessions/<uuid>/…` pathname names, if any. */
export function sessionIdFromPath(pathname: string): string | null {
  const match = SESSION_PATH.exec(pathname);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * The session id a successful `POST /host/agent-sessions` registration returned.
 * Registration is the one session request whose id is not in the path.
 */
export function sessionIdFromRegistration(body: unknown): string | null {
  const candidate = (body as { data?: unknown } | null)?.data ?? body;
  const id = (candidate as { session_id?: unknown } | null)?.session_id;
  return typeof id === 'string' && /^[0-9a-fA-F-]{36}$/.test(id) ? id.toLowerCase() : null;
}

export class CommunicatorRegistry {
  /** The admin-visible views. Mutated in place by the route (heartbeats, counters). */
  readonly views = new Map<string, CommunicatorView>();
  private readonly entries = new Map<string, Entry>();
  private readonly closed = new Map<string, Array<() => void>>();
  private tombstoneList: ConnectionTombstone[] = [];

  register(view: CommunicatorView, handle: CommunicatorHandle, now = Date.now()): void {
    this.views.set(view.id, view);
    this.entries.set(view.id, {
      view,
      handle,
      connectedMs: now,
      lastFrameMs: now,
      lastHeartbeatMs: null,
      daemonAttached: false,
      evidence: new Map(),
      closing: null,
      capabilities: { terminate: false, pid: null, started_at: null },
      terminateRequest: null,
    });
    // A connection from the same host and OS user soon after one ended is that
    // communicator coming back. Claim at most one unclaimed tombstone.
    const predecessor = this.tombstoneList.find(
      (t) =>
        t.successor_id === null &&
        t.host_id === view.host_id &&
        t.username === view.username &&
        now - Date.parse(t.ended_at) <= SUCCESSOR_WINDOW_MS,
    );
    if (predecessor) predecessor.successor_id = view.id;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  touch(id: string, now = Date.now()): void {
    const entry = this.entries.get(id);
    if (entry) entry.lastFrameMs = now;
  }

  heartbeat(id: string, now = Date.now()): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.lastFrameMs = now;
    entry.lastHeartbeatMs = now;
  }

  setCapabilities(id: string, capabilities: OwnerCapabilities): void {
    const entry = this.entries.get(id);
    if (entry) entry.capabilities = capabilities;
  }

  /** The owner's `terminate_ack`. Ignored unless it answers the request in flight. */
  acknowledgeTerminate(id: string, requestId: string, ack: TerminateAck): void {
    const entry = this.entries.get(id);
    if (entry?.terminateRequest?.id === requestId) entry.terminateRequest.resolve(ack);
  }

  setDaemonAttached(id: string, attached: boolean): void {
    const entry = this.entries.get(id);
    if (entry) entry.daemonAttached = attached;
  }

  /** Record that `sessionId` authenticated through connection `id`. */
  observeSession(id: string, sessionId: string, route: string, now = Date.now()): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const key = sessionId.toLowerCase();
    const current = entry.evidence.get(key);
    if (current) {
      current.last_seen_ms = now;
      current.requests += 1;
      current.last_route = route;
      return;
    }
    if (entry.evidence.size >= MAX_EVIDENCE_PER_CONNECTION) this.evictOldest(entry);
    entry.evidence.set(key, { first_seen_ms: now, last_seen_ms: now, requests: 1, last_route: route });
  }

  /**
   * Called with every dispatched request's outcome. Only a success counts: a
   * 4xx means the bridge token did not authenticate, so nothing was proved.
   */
  observeDispatch(id: string, method: string, pathname: string, status: number, body?: Buffer | string): void {
    if (status >= 400 || !this.entries.has(id)) return;
    const named = sessionIdFromPath(pathname);
    if (named) {
      this.observeSession(id, named, `${method} ${pathname.replace(named, ':id')}`);
      return;
    }
    if (method === 'POST' && pathname === '/host/agent-sessions' && body) {
      try {
        const registered = sessionIdFromRegistration(JSON.parse(typeof body === 'string' ? body : body.toString('utf8')));
        if (registered) this.observeSession(id, registered, 'POST /host/agent-sessions');
      } catch {
        /* A non-JSON body names no session. */
      }
    }
  }

  /** The route's socket 'close' handler. Idempotent. */
  unregister(id: string, now = Date.now()): ConnectionTombstone | null {
    const entry = this.entries.get(id);
    this.views.delete(id);
    this.entries.delete(id);
    let tombstone: ConnectionTombstone | null = null;
    if (entry) {
      tombstone = {
        id,
        host_id: entry.view.host_id,
        username: entry.view.username,
        version: entry.view.version,
        connected_at: entry.view.connected_at,
        ended_at: new Date(now).toISOString(),
        reason: entry.closing?.reason ?? 'peer_closed',
        actor: entry.closing?.actor ?? null,
        pid: entry.capabilities.pid,
        process_started_at: entry.capabilities.started_at,
        session_ids: [...entry.evidence.keys()].slice(0, 256),
        successor_id: null,
      };
      this.tombstoneList.unshift(tombstone);
      this.pruneTombstones(now);
    }
    const waiters = this.closed.get(id);
    this.closed.delete(id);
    for (const resolve of waiters ?? []) resolve();
    return tombstone;
  }

  /**
   * Ends one socket on an administrator's behalf and reports what is known:
   * `closed` once the route's close handler ran, otherwise `requested`. The
   * peer is expected to redial; this never disables a communicator.
   */
  async disconnect(
    id: string,
    actor: string,
    options: { timeoutMs?: number; graceMs?: number } = {},
  ): Promise<{ outcome: 'closed' | 'requested' | 'not_connected' }> {
    const entry = this.entries.get(id);
    if (!entry) return { outcome: 'not_connected' };
    const timeoutMs = options.timeoutMs ?? 4000;
    const graceMs = Math.min(options.graceMs ?? 1000, timeoutMs);
    entry.closing = { reason: 'admin_disconnect', actor };
    const done = new Promise<void>((resolve) => {
      const list = this.closed.get(id) ?? [];
      list.push(resolve);
      this.closed.set(id, list);
    });
    try {
      entry.handle.close(4001, 'Closed by administrator');
    } catch {
      /* Already closing: the wait below decides the outcome. */
    }
    const wait = (ms: number) =>
      Promise.race([done.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref())]);
    if (await wait(graceMs)) return { outcome: 'closed' };
    // The peer ignored the close handshake; drop the transport.
    try {
      entry.handle.terminate?.();
    } catch {
      /* Reported through the outcome. */
    }
    return { outcome: (await wait(Math.max(0, timeoutMs - graceMs))) ? 'closed' : 'requested' };
  }

  /**
   * Asks the owner process behind one connection to stop, and reports only what
   * was observed: the owner's own acknowledgement, then whether its connection
   * closed. A frame that was sent, or a socket that dropped, proves neither.
   * Native sessions are not signalled; a surviving client starts a new owner.
   */
  async terminate(
    id: string,
    actor: string,
    options: { ackMs?: number; closeMs?: number } = {},
  ): Promise<{ outcome: TerminateOutcome; pid: number | null; started_at: string | null; reason: string | null }> {
    const entry = this.entries.get(id);
    if (!entry) return { outcome: 'not_connected', pid: null, started_at: null, reason: null };
    const { pid, started_at } = entry.capabilities;
    if (!entry.capabilities.terminate || !entry.handle.send) return { outcome: 'unsupported', pid, started_at, reason: null };
    if (entry.terminateRequest) return { outcome: 'in_progress', pid, started_at, reason: null };

    const requestId = randomUUID();
    const answered = new Promise<TerminateAck | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), options.ackMs ?? 5000);
      timer.unref();
      entry.terminateRequest = { id: requestId, resolve: (ack) => (clearTimeout(timer), resolve(ack)) };
    });
    const closed = new Promise<void>((resolve) => {
      const list = this.closed.get(id) ?? [];
      list.push(resolve);
      this.closed.set(id, list);
    });
    try {
      entry.handle.send({ type: 'terminate', request_id: requestId, reason: 'admin' });
    } catch {
      entry.terminateRequest = null;
      return { outcome: 'unacknowledged', pid, started_at, reason: 'send_failed' };
    }
    const ack = await answered;
    entry.terminateRequest = null;
    if (!ack) return { outcome: 'unacknowledged', pid, started_at, reason: null };
    if (!ack.accepted) return { outcome: 'refused', pid: ack.pid ?? pid, started_at, reason: ack.reason };
    // From here the owner has said it is going: the eventual close is its doing.
    entry.closing = { reason: 'admin_terminate', actor };
    const didClose = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), options.closeMs ?? 10_000).unref()),
    ]);
    return { outcome: didClose ? 'terminated' : 'acknowledged', pid: ack.pid ?? pid, started_at, reason: null };
  }

  snapshot(now = Date.now()): CommunicatorSnapshot[] {
    return [...this.entries.values()].map((entry) => {
      for (const [sessionId, evidence] of entry.evidence) {
        if (now - evidence.last_seen_ms > EVIDENCE_RETENTION_MS) entry.evidence.delete(sessionId);
      }
      return {
        view: entry.view,
        remote_address: entry.handle.remoteAddress,
        connected_ms: entry.connectedMs,
        last_frame_ms: entry.lastFrameMs,
        last_heartbeat_ms: entry.lastHeartbeatMs,
        daemon_attached: entry.daemonAttached,
        closing: entry.closing !== null,
        capabilities: entry.capabilities,
        evidence: entry.evidence,
      };
    });
  }

  get(id: string, now = Date.now()): CommunicatorSnapshot | null {
    return this.snapshot(now).find((entry) => entry.view.id === id) ?? null;
  }

  tombstones(now = Date.now()): ConnectionTombstone[] {
    this.pruneTombstones(now);
    return this.tombstoneList.map((t) => ({ ...t }));
  }

  /** Test seam: the registry is a singleton because the route table is. */
  reset(): void {
    this.views.clear();
    this.entries.clear();
    this.closed.clear();
    this.tombstoneList = [];
  }

  private evictOldest(entry: Entry): void {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, value] of entry.evidence) {
      if (value.last_seen_ms < oldest) {
        oldest = value.last_seen_ms;
        oldestKey = key;
      }
    }
    if (oldestKey) entry.evidence.delete(oldestKey);
  }

  private pruneTombstones(now: number): void {
    this.tombstoneList = this.tombstoneList
      .filter((t) => now - Date.parse(t.ended_at) <= TOMBSTONE_RETENTION_MS)
      .slice(0, MAX_TOMBSTONES);
  }
}

export const communicatorRegistry = new CommunicatorRegistry();
/** The admin-visible connection views, shared with the communicator route. */
export const connections = communicatorRegistry.views;
