/**
 * Wire types for the agent portal (`/go/api/*`).
 *
 * Shared with the portal app under frontend/portal via the $lib alias so the
 * pure helpers here can be unit-tested by the existing `npm test`, which only
 * globs src/**\/*.test.ts.
 */

export type Engine = "codex" | "claude";

/**
 * Server-derived liveness. `Agent.status` cannot answer this: the API writes it
 * once at registration and the wrapper heartbeats with an empty status forever,
 * so it reads "active" for the life of the process whether or not the agent is
 * reachable.
 */
export type Presence = "listening" | "idle" | "offline" | "ended";

/** Lifecycle of an operator close note, read off its queue row server-side. */
export type CloseState = "pending" | "acknowledged" | "undeliverable";

export interface PortalUser {
  id: number;
  display_name: string;
}

export interface PendingPrompt {
  id: string;
  question: string;
  options: string[];
  version: number;
  created_at: string;
}

export interface Agent {
  id: string;
  engine: Engine;
  host: string;
  username: string;
  cwd: string;
  /** Compatibility only — never branch on this for liveness. Use `presence`. */
  status: string;
  presence: Presence;
  relay_ready: boolean;
  started_at: string;
  heartbeat_at: string;
  last_event_at: string | null;
  ended_at: string | null;
  expires_at: string | null;
  read_only: boolean;
  attention: { since: string; summary: string | null } | null;
  close_requested_at: string | null;
  close: { requested_at: string; state: CloseState } | null;
  pending_prompt: PendingPrompt | null;
}

export type EventType =
  | "started"
  | "resumed"
  | "user_message"
  | "assistant_message"
  | "progress"
  | "waiting_input"
  | "terminal_block"
  | "message_accepted"
  | "attention"
  | "close_requested"
  | "failed"
  | "completed";

export interface EventRow {
  cursor: number;
  session_id: string;
  type: EventType | string;
  source: "engine" | "terminal" | "bridge" | "portal" | string;
  payload: Record<string, unknown>;
  created_at: string;
}

export type Phase = "loading" | "ready" | "disabled" | "login" | "error";
