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
export type Presence = "listening" | "working" | "idle" | "offline" | "ended";

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
  /**
   * When the turn the agent is currently executing was accepted. Null unless
   * presence is "working" — the server withholds it once the turn outlives its
   * ceiling, so this never reports an age the label does not stand behind.
   */
  active_turn_started_at: string | null;
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
  | "message_canceled"
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

/**
 * What `Timeline` needs from whatever is driving it.
 *
 * The portal hands it the whole `Portal` state object, which satisfies this
 * structurally. The admin console drives the same component from entirely
 * different plumbing -- svelte-query against `/admin/agent-sessions` rather than
 * the portal's own poller and SSE loop -- so naming the six members the
 * component actually reads is what lets one timeline serve both surfaces
 * without either app having to import the other's state machine.
 */
export interface TimelineSource {
  /** Events for the selected session, oldest first. */
  timeline: EventRow[];
  /** Host-ticked wall clock, so relative ages re-render without their own timer. */
  now: number;
  /** Whether the scroller is currently pinned to the bottom. */
  atBottom: boolean;
  /** Events that arrived while the reader was scrolled away. */
  missed: number;
  setAtBottom(value: boolean): void;
  /** Hands the host a scroll-to-bottom callback to invoke when events land. */
  setScroller(fn: (smooth: boolean) => void): void;
}

export type Phase = "loading" | "ready" | "disabled" | "login" | "error";
