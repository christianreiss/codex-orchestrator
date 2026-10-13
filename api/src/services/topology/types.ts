/**
 * Wire shape of `GET /admin/topology`. The console mirrors it in
 * `frontend/src/lib/api/topology.ts`; `docs/interface-api.md` documents it.
 */

export type CommunicatorHealth = 'live' | 'stale' | 'closing';

export interface TopologyServerNode {
  id: 'server';
  label: string;
  started_at: string;
  uptime_s: number;
  /** Whether `/host/communicator/connect` accepts connections at all. */
  communicator_enabled: boolean;
  /** Whether agent sessions are being recorded (the Agent Portal module). */
  portal_enabled: boolean;
  /** The connection set is held in this process; there is no cross-instance view. */
  scope: 'api_process';
}

export interface TopologyCommunicatorNode {
  kind: 'communicator';
  /** Server-generated per-socket UUID. A reconnect is a new node. */
  id: string;
  host_id: number;
  host: string;
  username: string;
  version: string;
  connected_at: string;
  last_frame_at: string;
  last_heartbeat_at: string | null;
  health: CommunicatorHealth;
  /** Seconds since the last frame of any kind on this socket. */
  idle_s: number;
  /** Local streaming leases the owner reported in its last heartbeat. */
  leases_reported: number;
  requests: number;
  synced_at: string | null;
  sync_scopes: number;
  sync_errors: number;
  remote_address: string | null;
  /** The multiplexed host-daemon channel is attached to this socket. */
  daemon_attached: boolean;
  /** Agent sessions whose requests were last seen on this socket, newest first. */
  agent_ids: string[];
  /**
   * The owner process's own account of itself (pid, start time), sent once to a
   * server that announced control. Null for an owner that never sent one.
   */
  process: { pid: number; started_at: string | null } | null;
  /** True only when that owner said it can be stopped remotely. */
  can_terminate: boolean;
}

export type AssociationState = 'attributed' | 'stale' | 'unattributed';

export interface TopologyAssociation {
  state: AssociationState;
  /**
   * `session_traffic`: the API answered a request for this session that
   * arrived over the parent's socket. `none`: no communicator carried one.
   */
  basis: 'session_traffic' | 'none';
  parent_id: string;
  last_seen_at: string | null;
  age_s: number | null;
  /** Other sockets that also carried this session recently (overlap during a redial). */
  also_seen_on: string[];
}

export interface ActionAvailability {
  allowed: boolean;
  /** Machine-readable reason when `allowed` is false. */
  reason: string | null;
}

export interface TopologyAgentNode {
  kind: 'agent';
  id: string;
  name: string;
  engine: string;
  host_id: number;
  host: string;
  username: string;
  cwd: string;
  invocation_kind: string;
  presence: string;
  status: string;
  relay_ready: boolean;
  started_at: string;
  heartbeat_at: string;
  heartbeat_age_s: number | null;
  address: string | null;
  address_alias: string | null;
  binding_generation: number | null;
  close: { state: string; requested_at: string | null } | null;
  /** Present when the host daemon launched this session and can stop its process. */
  daemon: { session_id: string; status: string } | null;
  association: TopologyAssociation;
  actions: {
    request_close: ActionAvailability;
    stop_process: ActionAvailability;
    end_record: ActionAvailability;
  };
}

export interface TopologyDisconnect {
  id: string;
  host_id: number;
  host: string;
  username: string;
  version: string;
  connected_at: string;
  ended_at: string;
  reason: 'admin_disconnect' | 'admin_terminate' | 'peer_closed';
  actor: string | null;
  /** The owner's self-reported pid at the time, when it reported one. */
  pid: number | null;
  affected_agent_ids: string[];
  /** Id of the connection that took its place, once one has connected. */
  successor_id: string | null;
}

export interface TopologySnapshot {
  generated_at: string;
  server: TopologyServerNode;
  communicators: TopologyCommunicatorNode[];
  agents: TopologyAgentNode[];
  recent_disconnects: TopologyDisconnect[];
  counts: {
    communicators: number;
    agents: number;
    attributed: number;
    stale: number;
    unattributed: number;
  };
}
