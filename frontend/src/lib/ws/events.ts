/**
 * WebSocket event → svelte-query invalidation map.
 *
 * Single source of truth for which query keys get invalidated by which
 * WS event types. Consolidated after Phase 2 feature merges.
 */
import type { QueryClient, QueryKey } from "@tanstack/svelte-query";
import type { Readable } from "svelte/store";
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

  // Users
  "user.updated": [["users"]],
  "user.created": [["users"]],
  "user.deleted": [["users"]],

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

  // Authoring
  "agents.stored": [["agents"], ["authoring", "agents"]],
  "skill.updated": [["skills"], ["authoring", "skills"]],
  "skill.stored": [["skills"], ["authoring", "skills"]],
  "skill.deleted": [["skills"], ["authoring", "skills"]],
  "memory.changed": [["memories"], ["authoring", "memories"]],
  "memory.created": [["memories"], ["authoring", "memories"]],
  "memory.deleted": [["memories"], ["authoring", "memories"]],

  // API keys
  "api-key.changed": [["api-keys"]],
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
  "usage.refreshed": [["usage"], ["dashboard"]],
  "usage.refresh": [
    ["usage", "chatgpt"],
    ["usage", "claude"],
  ],
  "chatgpt.usage.updated": [["usage", "chatgpt"]],
  "claude.usage.updated": [["usage", "claude"]],
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
    const keys = invalidations[event.type];
    if (keys && keys.length > 0) {
      for (const key of keys) {
        void qc.invalidateQueries({ queryKey: key });
      }
    }
    if (PROJECT_SCOPED_EVENTS.has(event.type)) {
      const slug = extractProjectSlug((event as { payload?: unknown }).payload);
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

/** Merge feature-specific entries into the default map at module load. */
export function extendInvalidations(map: WsInvalidationMap): WsInvalidationMap {
  for (const [evt, keys] of Object.entries(map)) {
    const existing = DEFAULT_INVALIDATIONS[evt] ?? [];
    DEFAULT_INVALIDATIONS[evt] = [...existing, ...keys];
  }
  return DEFAULT_INVALIDATIONS;
}
