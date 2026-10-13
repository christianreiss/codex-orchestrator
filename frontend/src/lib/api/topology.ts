/**
 * The live connection tree: server → communicators → agent sessions.
 *
 * Mirrors `GET /admin/topology` (see `docs/interface-api.md`). Parentage is the
 * server's claim, made only from traffic it saw; nothing here infers it.
 *
 * Stopping an agent reuses the existing session contracts (`requestCloseMutation`,
 * `forceCloseMutation` in `agentSessions.ts`, and the daemon stop below), so
 * their durable-work semantics and idempotency are not restated. The one control
 * that is new is closing a communicator's socket.
 */
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
import { get } from "svelte/store";
import { api } from "./client";
import { authStore } from "../stores/auth";
import { createSessionWriter } from "./session-write";

export type CommunicatorHealth = "live" | "stale" | "closing";
export type AssociationState = "attributed" | "stale" | "unattributed";

export interface ResidentRuntimeReport {
  sequence: number;
  owner_instance_id: string;
  runtime_protocol: 1;
  mode: "on_demand" | "resident";
  managed: boolean;
  resident_enabled: boolean;
  execution_enabled: boolean;
  binary_sha256: string;
  draining: boolean;
  local_requests: number;
  legacy_clients: number;
  execution: {
    running: boolean;
    fenced: boolean;
    verified: boolean;
    workload: { accepted: number; peer_claims: number; children: number; receipts: number; writes: number; requests: number; legacy_clients: number };
  } | null;
  received_at: string;
  age_s: number;
  stale: boolean;
}

export interface TopologyServer {
  id: "server";
  label: string;
  started_at: string;
  uptime_s: number;
  communicator_enabled: boolean;
  portal_enabled: boolean;
  scope: "api_process";
}

export interface TopologyCommunicator {
  kind: "communicator";
  id: string;
  /** `user@host`, plus a runtime tag when several connections would read alike. */
  label: string;
  host_id: number;
  host: string;
  username: string;
  version: string;
  connected_at: string;
  last_frame_at: string;
  last_heartbeat_at: string | null;
  health: CommunicatorHealth;
  idle_s: number;
  leases_reported: number;
  requests: number;
  synced_at: string | null;
  sync_scopes: number;
  sync_errors: number;
  remote_address: string | null;
  daemon_attached: boolean;
  agent_ids: string[];
  /** The owner process's own account of itself; null if it never gave one. */
  process: { pid: number; started_at: string | null; instance_id: string | null; runtime_id: string | null } | null;
  /** True only when the owner said it can be stopped remotely. */
  can_terminate: boolean;
  /** Optional for compatibility with API versions before owner reports. */
  resident?: ResidentRuntimeReport | null;
}

export interface ActionAvailability {
  allowed: boolean;
  reason: string | null;
}

export interface TopologyAssociation {
  state: AssociationState;
  basis: "session_traffic" | "none";
  parent_id: string;
  last_seen_at: string | null;
  age_s: number | null;
  also_seen_on: string[];
}

export interface TopologyAgent {
  kind: "agent";
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
  label: string;
  host_id: number;
  host: string;
  username: string;
  version: string;
  connected_at: string;
  ended_at: string;
  reason: "admin_disconnect" | "admin_terminate" | "peer_closed";
  actor: string | null;
  pid: number | null;
  affected_agent_ids: string[];
  /** Set only on proof: the same process dialled again, or a replacement in the same runtime. */
  successor_id: string | null;
  successor_basis: "same_process" | "same_runtime" | null;
  /** Same host and user, no identity linking them. Unverified. */
  candidate_ids: string[];
}

export interface Topology {
  generated_at: string;
  server: TopologyServer;
  communicators: TopologyCommunicator[];
  agents: TopologyAgent[];
  recent_disconnects: TopologyDisconnect[];
  counts: { communicators: number; agents: number; attributed: number; stale: number; unattributed: number };
}

export interface DisconnectResult {
  outcome: "closed" | "requested";
  connection_id: string;
  host_id: number;
  username: string;
  version: string;
  reconnect_expected: true;
  affected: { agent_ids: string[]; leases_reported: number };
  replayed: boolean;
}

export interface TerminateResult {
  /**
   * What the server observed — never a process exit, which it cannot see.
   * `acknowledged_closed`: the addressed owner process said it will stop, and its
   * connection then closed. `acknowledged`: it said so but is still connected.
   */
  outcome: "acknowledged_closed" | "acknowledged" | "refused" | "unacknowledged";
  connection_id: string;
  host_id: number;
  username: string;
  version: string;
  /** The owner's own account of itself; the server cannot observe a pid. */
  process: { pid: number | null; started_at: string | null };
  acknowledged: boolean;
  connection_closed: boolean;
  affected: { agent_ids: string[]; leases_reported: number };
  replayed: boolean;
}

export const topologyKeys = {
  all: ["topology"] as const,
};

export function topologyQuery() {
  return createQuery<Topology>({
    queryKey: topologyKeys.all,
    queryFn: ({ signal }) => api.get<Topology>("/admin/topology", { signal }),
    // WebSocket events invalidate this on every connect, disconnect, heartbeat
    // and session change; the poll is the net under a dropped socket.
    refetchInterval: 10_000,
    // Keep the last tree on screen while a refetch is in flight or has failed.
    placeholderData: (previous) => previous,
    retry: 1,
  });
}

function writer(timeoutMs?: number) {
  return createSessionWriter({
    timeoutMs,
    actor: () => {
      const auth = get(authStore);
      return auth.authenticated && auth.user ? String(auth.user.id) : null;
    },
    confirmed: (result) => {
      const row = result as Record<string, unknown>;
      return typeof row.outcome === "string" || typeof row.status === "string" || typeof row.id === "string";
    },
  });
}

/** Closes one communicator socket. The communicator redials by itself. */
export function disconnectCommunicatorMutation() {
  const client = useQueryClient();
  const write = writer();
  return createMutation<DisconnectResult, Error, { target: TopologyCommunicator; note?: string }>({
    mutationFn: ({ target, note }) =>
      write(JSON.stringify(["disconnect", target.id, note ?? null]), (clientMessageId, signal) =>
        api.post<DisconnectResult>(
          `/admin/communicators/${encodeURIComponent(target.id)}/disconnect`,
          {
            client_message_id: clientMessageId,
            expect: { host_id: target.host_id, username: target.username },
            note: note || undefined,
          },
          { signal },
        ),
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: topologyKeys.all });
      void client.invalidateQueries({ queryKey: ["communicators"] });
    },
  });
}

/**
 * Asks the communicator owner process to stop. The server waits for the owner's
 * acknowledgement and then for its connection to close (up to ~13 s), so the
 * write is given longer than the 10 s default before it counts as uncertain.
 */
export function terminateCommunicatorMutation() {
  const client = useQueryClient();
  const write = writer(25_000);
  return createMutation<TerminateResult, Error, { target: TopologyCommunicator; note?: string }>({
    mutationFn: ({ target, note }) =>
      write(JSON.stringify(["terminate", target.id, note ?? null]), (clientMessageId, signal) =>
        api.post<TerminateResult>(
          `/admin/communicators/${encodeURIComponent(target.id)}/terminate`,
          { client_message_id: clientMessageId, expect: { host_id: target.host_id, username: target.username }, note: note || undefined },
          { signal },
        ),
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: topologyKeys.all });
      void client.invalidateQueries({ queryKey: ["communicators"] });
    },
  });
}

export interface StopDaemonResult {
  id: string;
  status: string;
}

/** Stops the process the host daemon launched for a session. */
export function stopDaemonSessionMutation() {
  const client = useQueryClient();
  const write = writer();
  return createMutation<StopDaemonResult, Error, { daemonSessionId: string }>({
    mutationFn: ({ daemonSessionId }) =>
      write(JSON.stringify(["stop", daemonSessionId]), (_clientMessageId, signal) =>
        api.post<StopDaemonResult>(`/admin/daemon-sessions/${encodeURIComponent(daemonSessionId)}/stop`, {}, { signal }),
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: topologyKeys.all });
      void client.invalidateQueries({ queryKey: ["agent-sessions"] });
      void client.invalidateQueries({ queryKey: ["daemon-sessions"] });
      void client.invalidateQueries({ queryKey: ["host-daemons"] });
    },
  });
}
