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
  "host.updated": [["hosts"], ["overview"]],
  "host.created": [["hosts"], ["overview"]],
  "host.deleted": [["hosts"], ["overview"]],
  "host.pruned": [["hosts"], ["overview"]],

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

  // Settings (root key triggers hierarchical match on all per-setting keys)
  "settings.changed": [["settings"]],

  // Usage / dashboard
  // NB: the backend only ever publishes `chatgpt.usage.updated` (see
  // api/src/services/chatgpt-usage.ts); there is no live push for Claude
  // usage, so no invalidation entry is mapped for it here.
  "chatgpt.usage.updated": [["usage", "chatgpt"]],
  "insecure.approval.changed": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
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
]);

function projectDetailSubKey(eventType: string): string | null {
  if (eventType.startsWith("project.note")) return "notes";
  if (eventType.startsWith("project.todo")) return "todos";
  if (eventType.startsWith("project.file")) return "files";
  if (eventType.startsWith("project.feedback")) return "feedback";
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
