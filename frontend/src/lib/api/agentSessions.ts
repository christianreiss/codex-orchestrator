/**
 * Live agent sessions for the console.
 *
 * This is the console half of a surface the phone portal at `/go` already had.
 * The wire types come from `$lib/portal/types` rather than being restated here:
 * one contract serves both apps, and the presence ladder both render is the
 * tested one in `$lib/portal/presence`.
 *
 * Presence uses15s polling and the selected timeline uses scoped SSE with a
 * polling fallback. Shared WebSocket invalidation refreshes administrative
 * metadata changes and reconnects; transport state never proves client liveness.
 */
import { createMutation, createQuery, useQueryClient, type CreateMutationOptions } from "@tanstack/svelte-query";
import { get, toStore } from "svelte/store";
import { api } from "./client";
import { authStore } from "../stores/auth";
import { createSessionWriter } from "./session-write";
import type { Agent, EventRow, PresenceTimings } from "$lib/portal/types";

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
  generated_at?: string;
  timings: PresenceTimings & { retention_hours: number };
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
    queryFn: ({ signal }) => boundedGet<AgentSessionsResponse>("/admin/agent-sessions", signal),
    // Heartbeats land every 15s, so anything faster reports the same rows back.
    refetchInterval: 15_000,
    retry: 1,
  });
}

/**
 * A session's timeline. Gated server-side on `agent_portal.reveal_transcript`,
 * so a viewer account gets a 403 here while the listing above still loads --
 * which is the intended split, not an error to surface loudly.
 */
export function sessionEventsQuery(sessionId: () => string | null) {
  // svelte-query 5 expects a store for changing options. Getters on a plain
  // object are read once, leaving the first null selection disabled forever.
  return createQuery<SessionEventsResponse>(toStore(() => ({
    queryKey: agentSessionKeys.events(sessionId() ?? ""),
    enabled: Boolean(sessionId()),
    queryFn: ({ queryKey, signal }) =>
      boundedGet<SessionEventsResponse>(
        `/admin/agent-sessions/${encodeURIComponent(String(queryKey[2]))}/events?tail=true&limit=250`,
        signal,
      ),
    // Keep the selected timeline moving when SSE is blocked or reconnecting.
    refetchInterval: 15_000,
    retry: 1,
  })));
}

async function boundedGet<T>(path: string, signal: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
  try {
    const combined = AbortSignal.any([signal, timeout]);
    const result = await api.get<T>(path, { signal: combined });
    combined.throwIfAborted();
    return result;
  } catch (error) {
    if (timeout.aborted && !signal.aborted) throw new Error("The request timed out. Retry to reconnect.");
    throw error;
  }
}

function sessionWriter() {
  return createSessionWriter({ actor: () => {
    const auth = get(authStore);
    return auth.authenticated && auth.user ? String(auth.user.id) : null;
  }, confirmed: (result) => {
    const row = result as Record<string, unknown>;
    return (typeof row.message_id === "string" && Boolean(row.message_id))
      || (typeof row.forced === "boolean" && typeof row.already_ended === "boolean" && typeof row.status === "string");
  } });
}

/**
 * Send an instruction, or answer the agent's open question.
 *
 * The branch mirrors the portal's: with a prompt open, what the operator types
 * IS the answer, because a plain message would leave the agent still blocked on
 * a question it had already been given the reply to.
 */
export function sendMutation(
  opts: MutationOpts<unknown, { id: string; content: string; prompt?: { id: string; version: number } | null }> = {},
) {
  const client = useQueryClient();
  const write = sessionWriter();
  return createMutation<unknown, Error, { id: string; content: string; prompt?: { id: string; version: number } | null }>({
    mutationFn: ({ id, content, prompt }) => {
      const session = encodeURIComponent(id);
      return write(JSON.stringify(["send", id, content, prompt ?? null]), (clientMessageId, signal) => prompt
        ? api.post(`/admin/agent-sessions/${session}/prompts/${encodeURIComponent(prompt.id)}/answer`, {
            client_message_id: clientMessageId,
            answer: content,
            version: prompt.version,
          }, { signal })
        : api.post(`/admin/agent-sessions/${session}/messages`, {
            client_message_id: clientMessageId,
            content,
          }, { signal }));
    },
    ...opts,
    onSettled: (...args) => {
      void client.invalidateQueries({ queryKey: agentSessionKeys.all });
      opts.onSettled?.(...args);
    },
  });
}

/** Ask the agent to wrap up. Queued for it to honour; see force for the rest. */
export function requestCloseMutation(opts: MutationOpts<unknown, { id: string; note?: string }> = {}) {
  const client = useQueryClient();
  const write = sessionWriter();
  return createMutation<unknown, Error, { id: string; note?: string }>({
    mutationFn: ({ id, note }) =>
      write(JSON.stringify(["close", id, note ?? null]), (clientMessageId, signal) => api.post(`/admin/agent-sessions/${encodeURIComponent(id)}/close`, {
        client_message_id: clientMessageId,
        note,
      }, { signal })),
    ...opts,
    onSettled: (...args) => {
      void client.invalidateQueries({ queryKey: agentSessionKeys.all });
      opts.onSettled?.(...args);
    },
  });
}

export function forceCloseMutation(opts: MutationOpts<ForceCloseResult, { id: string; note?: string }> = {}) {
  const client = useQueryClient();
  const write = sessionWriter();
  return createMutation<ForceCloseResult, Error, { id: string; note?: string }>({
    mutationFn: ({ id, note }) =>
      write(JSON.stringify(["force", id, note ?? null]), (clientMessageId, signal) => api.post<ForceCloseResult>(`/admin/agent-sessions/${encodeURIComponent(id)}/close/force`, {
        client_message_id: clientMessageId,
        note,
      }, { signal })),
    ...opts,
    onSettled: (...args) => {
      void client.invalidateQueries({ queryKey: agentSessionKeys.all });
      opts.onSettled?.(...args);
    },
  });
}
