/**
 * WebSocket event → svelte-query invalidation map.
 *
 * Single source of truth for which query keys get invalidated by which
 * WS event types. Consolidated after Phase 2 feature merges.
 *
 * `api/test/unit/ws/event-invalidation-coverage.test.ts` reads this map and
 * fails when the API publishes an event type that has no entry here;
 * `api/test/unit/routes/ws-invalidation-key-liveness.test.ts` fails when an
 * entry names a query key root nothing under `frontend/src` queries.
 */
import type { QueryClient, QueryKey } from "@tanstack/svelte-query";
import type { Readable } from "svelte/store";
import { toast } from "svelte-sonner";
import type { WsEvent } from "./client";

export type WsInvalidationMap = Record<string, QueryKey[]>;

/** Default invalidation map. */
export const DEFAULT_INVALIDATIONS: WsInvalidationMap = {
  // Logs
  "log.created": [["logs"], ["logs", "api"], ["logs", "events"]],
  "log.updated": [["logs"], ["logs", "events"]],
  "mcp.invoked": [["logs", "mcp"]],

  // Hosts + overview dashboard counters
  "host.updated": [["hosts"], ["overview"], ["agent-messaging"]],
  "host.created": [["hosts"], ["overview"]],
  "host.deleted": [["hosts"], ["overview"], ["agent-messaging"]],
  "host.pruned": [["hosts"], ["overview"], ["agent-messaging"]],

  // Users
  "user.updated": [["users"]],
  "user.created": [["users"]],
  "user.deleted": [["users"]],
  // Bulk delete of every admin user except the actor.
  "admin.user.wipe": [["users"]],

  // Projects (both list and project-scoped detail; per-project keys handled in wireWsToQueryClient)
  "project.changed": [["projects"]],
  "project.updated": [["projects"]],
  "project.created": [["projects"]],
  "project.deleted": [["projects"]],
  "project.note.created": [["projects"]],
  "project.note.updated": [["projects"]],
  "project.note.deleted": [["projects"]],
  "project.todo.created": [["projects"]],
  "project.todo.updated": [["projects"]],
  "project.todo.deleted": [["projects"]],
  "project.file.upserted": [["projects"]],
  "project.file.updated": [["projects"]],
  "project.file.deleted": [["projects"]],
  "project.feedback.created": [["projects"]],
  "project.card.created": [["projects"]],
  "project.card.updated": [["projects"]],
  "project.card.moved": [["projects"]],
  "project.card.claimed": [["projects"]],
  "project.card.released": [["projects"]],
  "project.card.deleted": [["projects"]],
  "project.board.updated": [["projects"]],
  "project_board.module_toggled": [["projects"], ["projects", "board", "state"]],
  "project_board.claim_force_released": [["projects"]],

  // Authoring (the authoring pages query the bare ["agents"]/["skills"]/["memories"] keys)
  "agents.stored": [["agents"]],
  "skill.updated": [["skills"]],
  "skill.stored": [["skills"]],
  "skill.deleted": [["skills"]],
  "memory.changed": [["memories"]],
  "memory.created": [["memories"]],
  "memory.updated": [["memories"]],
  "memory.appended": [["memories"]],
  "memory.deleted": [["memories"]],
  "project.memory.created": [["memories"], ["projects"]],
  "project.memory.updated": [["memories"], ["projects"]],
  "project.memory.deleted": [["memories"], ["projects"]],
  "shared_memory.changed": [["memories"]],
  "shared_memory.created": [["memories"]],
  "shared_memory.updated": [["memories"]],
  "shared_memory.appended": [["memories"]],
  "shared_memory.deleted": [["memories"]],

  // Claude artifacts (subagents / slash-commands / output-styles)
  "claude_artifact.stored": [["subagents"], ["commands"], ["output-styles"]],
  "claude_artifact.updated": [["subagents"], ["commands"], ["output-styles"]],
  "claude_artifact.deleted": [["subagents"], ["commands"], ["output-styles"]],

  // API keys
  "api-key.changed": [
    ["keys", "openai"],
    ["keys", "claude"],
  ],
  "apikey.created": [
    ["keys", "openai"],
    ["keys", "claude"],
  ],
  "apikey.toggled": [
    ["keys", "openai"],
    ["keys", "claude"],
  ],
  "apikey.deleted": [
    ["keys", "openai"],
    ["keys", "claude"],
  ],

  // Fleet secrets. The module card shows a live count, so every mutation
  // refreshes the state key as well as the listing. `secret.revealed` is
  // published with broadcast:false on purpose — a human reading a credential is
  // an audit fact, not a reason to nudge any UI into re-fetching.
  // NB: keep apostrophes and other bare quote characters out of comments in
  // this object. The coverage test scans quote characters at depth 0 to find
  // the keys, so a stray one swallows every entry that follows it.
  "secret.created": [
    ["secrets", "list"],
    ["secrets", "state"],
  ],
  "secret.updated": [
    ["secrets", "list"],
    ["secrets", "state"],
  ],
  "secret.deleted": [
    ["secrets", "list"],
    ["secrets", "state"],
  ],
  "secret.module_toggled": [
    ["secrets", "state"],
    ["secrets", "list"],
  ],

  // Settings (root key triggers hierarchical match on all per-setting keys)
  // Source checks update their state even when the imported catalogue itself
  // is unchanged, so keep the source card live across tabs and worker ticks.
  "settings.changed": [["settings"], ["skills", "source"]],

  // Agent portal controls live under Settings.
  "agent_portal.state": [["agent-portal"]],
  "agent_portal.user.created": [["agent-portal"]],
  "agent_portal.user.updated": [["agent-portal"]],
  "agent_portal.user.enabled": [["agent-portal"]],
  "agent_portal.user.rotated": [["agent-portal"]],
  "agent_portal.user.link_revealed": [["agent-portal"]],
  "agent_portal.user.deleted": [["agent-portal"]],
  // Live agent sessions. This is the ONLY event the sessions view gets: nothing
  // publishes on register, heartbeat or event append, so the list polls and the
  // timeline streams over SSE instead. Force-close is broadcast because it ends
  // an agent every other console is also looking at.
  "agent_portal.session.force_closed": [["agent-sessions"]],

  // Agent Messaging state, address discovery, relays and delivery lifecycle.
  "agent_messaging.state.changed": [["agent-messaging"]],
  "agent_messaging.host.changed": [["agent-messaging"], ["hosts"]],
  "agent_messaging.address.changed": [["agent-messaging"]],
  "agent_messaging.conversation.changed": [["agent-messaging"]],
  "agent_messaging.conference.changed": [["agent-messaging"]],
  "agent_messaging.message.changed": [["agent-messaging"]],
  "agent_messaging.relay.changed": [["agent-messaging"]],
  "agent_messaging.queue.changed": [["agent-messaging"]],

  // Git Director
  "git_director.changed": [["git-director"]],
  "git_director.module_toggled": [["git-director"]],
  "git_director.decision_forced": [["git-director"]],
  "git_director.worktree_evicted": [["git-director"]],

  // Usage / dashboard
  "chatgpt.usage.updated": [["usage", "chatgpt"]],
  // Pushed by the clx wrapper via POST /claude/usage/report, not fetched by
  // the server — see api/src/services/claude-usage.ts.
  "claude.usage.updated": [["usage", "claude"]],
  // Also carries the fleet-window open/close, which restamps or clears every
  // insecure host row -- so the hosts list has to refresh, not just the summary.
  "insecure.approval.changed": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
    ["hosts"],
    ["hosts", "insecure"],
  ],

  // Account
  "passkey.registered": [["passkeys"]],
  "passkey.deleted": [["passkeys"]],

  // Hosts: insecure window state
  "insecure.requested": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
    ["hosts", "insecure"],
  ],
  "insecure.approved": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
    ["hosts"],
    ["hosts", "insecure"],
  ],
  "insecure.denied": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
  ],
  "insecure.domain.allowed": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
    ["hosts"],
    ["hosts", "insecure"],
  ],
  "insecure.domain.revoked": [["hosts"], ["hosts", "insecure"]],
};

/** WS event types whose payload contains a `slug` we use to scope invalidation. */
const PROJECT_SCOPED_EVENTS = new Set<string>([
  "project.changed",
  "project.updated",
  "project.created",
  "project.deleted",
  "project.note.created",
  "project.note.updated",
  "project.note.deleted",
  "project.todo.created",
  "project.todo.updated",
  "project.todo.deleted",
  "project.file.upserted",
  "project.file.updated",
  "project.file.deleted",
  "project.feedback.created",
  "project.card.created",
  "project.card.updated",
  "project.card.moved",
  "project.card.claimed",
  "project.card.released",
  "project.card.deleted",
  "project.board.updated",
]);

function projectDetailSubKey(eventType: string): string | null {
  if (eventType.startsWith("project.note")) return "notes";
  if (eventType.startsWith("project.todo")) return "todos";
  if (eventType.startsWith("project.file")) return "files";
  if (eventType.startsWith("project.feedback")) return "feedback";
  if (eventType.startsWith("project.card") || eventType.startsWith("project.board")) return "board";
  return null;
}

function extractProjectSlug(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const slug = p.slug ?? p.project ?? (p.project_slug as unknown);
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

interface ToastPayload {
  message: string;
  title: string | null;
  level: "info" | "success" | "warn" | "error";
  timeoutMs: number | null;
}

function extractToastPayload(payload: unknown): ToastPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.message !== "string" || p.message.length === 0) return null;
  const level = p.level === "success" || p.level === "warn" || p.level === "error" ? p.level : "info";
  const title = typeof p.title === "string" && p.title.length > 0 ? p.title : null;
  const timeoutMs = typeof p.timeout_ms === "number" ? p.timeout_ms : null;
  return { message: p.message, title, level, timeoutMs };
}

/** Push a server-initiated `toast` WS event to the sonner Toaster. */
function showServerToast(payload: unknown): void {
  const parsed = extractToastPayload(payload);
  if (!parsed) return;
  // `title` (if present) is a short heading shown as the toast's primary
  // line, with the longer `message` as the description underneath; when no
  // title was sent, `message` alone is the primary line.
  const primary = parsed.title ?? parsed.message;
  const options = {
    description: parsed.title ? parsed.message : undefined,
    duration: parsed.timeoutMs ?? undefined,
  };
  if (parsed.level === "success") toast.success(primary, options);
  else if (parsed.level === "warn") toast.warning(primary, options);
  else if (parsed.level === "error") toast.error(primary, options);
  else toast.info(primary, options);
}

/**
 * Subscribe the supplied WebSocket event stream to the query client.
 * Returns an unsubscribe function.
 */
export function wireWsToQueryClient(
  qc: QueryClient,
  events: Readable<WsEvent | null>,
  invalidations: WsInvalidationMap = DEFAULT_INVALIDATIONS,
): () => void {
  return events.subscribe((event) => {
    if (!event || !event.type) return;
    if (event.type === "toast") {
      showServerToast(event.payload);
      return;
    }
    const keys = invalidations[event.type];
    if (keys && keys.length > 0) {
      for (const key of keys) {
        void qc.invalidateQueries({ queryKey: key });
      }
    }
    if (PROJECT_SCOPED_EVENTS.has(event.type)) {
      const slug = extractProjectSlug(event.payload);
      if (slug) {
        const subKey = projectDetailSubKey(event.type);
        if (subKey) {
          void qc.invalidateQueries({ queryKey: ["project", slug, subKey] });
          void qc.invalidateQueries({ queryKey: ["project", slug, "changes"] });
        } else {
          void qc.invalidateQueries({ queryKey: ["project", slug] });
        }
      }
      void qc.invalidateQueries({ queryKey: ["projects"] });
    }
  });
}
