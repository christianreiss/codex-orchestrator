/**
 * Live agent sessions for the console.
 *
 * This is the console half of a surface the phone portal at `/go` already had.
 * The wire types come from `$lib/portal/types` rather than being restated here:
 * one contract serves both apps, and the presence ladder both render is the
 * tested one in `$lib/portal/presence`.
 *
 * Liveness is polling plus SSE, and deliberately does not go through the
 * WebSocket invalidation map. Nothing publishes a WS event when a wrapper
 * registers, heartbeats, or appends an event -- and emitting one per agent per
 * 15 seconds would be traffic nobody reads. `agent_portal.session.force_closed`
 * is the single exception and does have a map entry, because ending an agent is
 * something every other open console should see.
 */
import { createMutation, createQuery, useQueryClient, type CreateMutationOptions } from "@tanstack/svelte-query";
import { api } from "./client";
import type { Agent, EventRow } from "$lib/portal/types";

/** What the Git Director and Agent Messaging know about a session's work. */
export interface SessionWork {
  task: string | null;
  branch: string | null;
  target_branch: string | null;
  declared_paths: string[];
  /**
   * The registered worktree the session's cwd resolved into. Differs from the
   * cwd when the agent is working below the directory it registered.
   */
  worktree_path: string | null;
  address: string | null;
  address_alias: string | null;
}

export interface AgentSessionRow extends Agent {
  host_id: number;
  invocation_kind: string;
  upstream_session_id: string | null;
  active_turn_id: string | null;
  work: SessionWork;
}

export interface AgentSessionsResponse {
  /**
   * Whether the Agent Portal module is on. An empty list means two very
   * different things and this is what tells them apart: with the module off,
   * registration is discarded server-side and no wrapper can ever appear.
   */
  enabled: boolean;
  timings: { heartbeat_fresh_seconds: number; relay_fresh_seconds: number; retention_hours: number };
  sessions: AgentSessionRow[];
}

export interface SessionEventsResponse {
  events: EventRow[];
  next_cursor: number;
}

export interface ForceCloseResult {
  forced: boolean;
  already_ended: boolean;
  status: string;
  ended_at: string | null;
  expires_at: string | null;
}

type MutationOpts<T, V> = Omit<CreateMutationOptions<T, Error, V, unknown>, "mutationFn">;

export const agentSessionKeys = {
  all: ["agent-sessions"] as const,
  list: ["agent-sessions", "list"] as const,
  events: (id: string) => ["agent-sessions", "events", id] as const,
};

export function agentSessionsQuery() {
  return createQuery<AgentSessionsResponse>({
    queryKey: agentSessionKeys.list,
    queryFn: () => api.get<AgentSessionsResponse>("/admin/agent-sessions"),
    // Heartbeats land every 15s, so anything faster reports the same rows back.
    refetchInterval: 15_000,
  });
}

/**
 * A session's timeline. Gated server-side on `agent_portal.reveal_transcript`,
 * so a viewer account gets a 403 here while the listing above still loads --
 * which is the intended split, not an error to surface loudly.
 */
export function sessionEventsQuery(sessionId: () => string | null) {
  return createQuery<SessionEventsResponse>({
    get queryKey() {
      return agentSessionKeys.events(sessionId() ?? "");
    },
    get enabled() {
      return Boolean(sessionId());
    },
    queryFn: () =>
      api.get<SessionEventsResponse>(
        `/admin/agent-sessions/${encodeURIComponent(sessionId() ?? "")}/events?tail=true&limit=250`,
      ),
  });
}

export function forceCloseMutation(opts: MutationOpts<ForceCloseResult, { id: string; note?: string }> = {}) {
  const client = useQueryClient();
  return createMutation<ForceCloseResult, Error, { id: string; note?: string }>({
    mutationFn: ({ id, note }) =>
      api.post<ForceCloseResult>(`/admin/agent-sessions/${encodeURIComponent(id)}/close/force`, {
        client_message_id: crypto.randomUUID(),
        note,
      }),
    ...opts,
    onSettled: (...args) => {
      void client.invalidateQueries({ queryKey: agentSessionKeys.all });
      opts.onSettled?.(...args);
    },
  });
}
