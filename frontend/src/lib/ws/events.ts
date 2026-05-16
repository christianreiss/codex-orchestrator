/**
 * WebSocket event → svelte-query invalidation map.
 *
 * Single source of truth for which query keys get invalidated by which
 * WS event types. Feature agents in Phase 2 append to this map as they
 * add features; views never wire their own listeners.
 */
import type { QueryClient, QueryKey } from "@tanstack/svelte-query";
import type { Readable } from "svelte/store";
import type { WsEvent } from "./client";

export type WsInvalidationMap = Record<string, QueryKey[]>;

/** Default invalidation map. Feature agents extend this in-place or via merge. */
export const DEFAULT_INVALIDATIONS: WsInvalidationMap = {
  "log.created": [["logs"]],
  "log.updated": [["logs"]],
  "host.updated": [["hosts"], ["overview"]],
  "host.created": [["hosts"], ["overview"]],
  "host.deleted": [["hosts"], ["overview"]],
  // logs feature ↓
  "log.created": [["logs"], ["logs", "api"], ["logs", "events"]],
  "log.updated": [["logs"], ["logs", "events"]],
  "mcp.invoked": [["logs", "mcp"]],
  // ↑ logs feature
  "host.updated": [["hosts"]],
  "host.created": [["hosts"]],
  "host.deleted": [["hosts"]],
  "user.updated": [["users"]],
  "user.created": [["users"]],
  "user.deleted": [["users"]],
  "project.changed": [["projects"]],
  "project.updated": [["projects"]],
  "project.created": [["projects"]],
  "project.deleted": [["projects"]],
  "agents.stored": [["agents"]],
  "skill.updated": [["skills"]],
  "memory.changed": [["memories"]],
  // projects feature ↓
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
  // projects feature ↑
  "agents.stored": [["authoring", "agents"]],
  "skill.updated": [["authoring", "skills"]],
  "memory.changed": [["authoring", "memories"]],
  "api-key.changed": [["api-keys"]],
  "settings.changed": [["settings"]],
  "usage.refreshed": [["usage"], ["dashboard"]],
  // account feature ↓
  "passkey.registered": [["passkeys"]],
  "passkey.deleted": [["passkeys"]],
  // api-keys feature ↓
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
  // authoring feature ↓
  "skill.stored": [["skills"]],
  "skill.deleted": [["skills"]],
  "memory.created": [["memories"]],
  "memory.deleted": [["memories"]],
  // dashboard feature ↓
  "usage.refresh": [["usage", "chatgpt"], ["usage", "claude"]],
  "chatgpt.usage.updated": [["usage", "chatgpt"]],
  "claude.usage.updated": [["usage", "claude"]],
  "insecure.approval.changed": [["overview", "insecure-approvals"]],
  // hosts feature ↓
  "insecure.requested": [["insecure-approvals"], ["hosts", "insecure"]],
  "insecure.approved": [["insecure-approvals"], ["hosts"], ["hosts", "insecure"]],
  "insecure.denied": [["insecure-approvals"]],
  "insecure.domain.allowed": [["hosts", "insecure"]],
  "insecure.domain.revoked": [["hosts", "insecure"]],
  // hosts feature ↑
  // integrations feature ↓
  "joplin.synced": [["integrations", "joplin"]],
};

// projects feature ↓
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

/** Map a scoped project event to the detail sub-key it should invalidate. */
function projectDetailSubKey(eventType: string): string | null {
  if (eventType.startsWith("project.note")) return "notes";
  if (eventType.startsWith("project.todo")) return "todos";
  if (eventType.startsWith("project.file")) return "files";
  if (eventType.startsWith("project.feedback")) return "feedback";
  return null;
}

/** Extract a `slug` (or `project`) string from a WS event payload, if present. */
function extractProjectSlug(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const slug = p.slug ?? p.project ?? (p.project_slug as unknown);
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}
// projects feature ↑
// settings feature ↓
// The base map already invalidates the root ['settings'] key on
// `settings.changed`. svelte-query's invalidateQueries does a
// hierarchical prefix match, so per-setting query keys like
// ['settings', 'api-state'], ['settings', 'reverse-dns'], etc.
// are refreshed automatically — no additional entries required.

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
    // projects feature ↓
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
      // also always refresh the list
      void qc.invalidateQueries({ queryKey: ["projects"] });
    }
    // projects feature ↑
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
