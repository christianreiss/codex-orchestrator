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
};

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
    if (!keys || keys.length === 0) return;
    for (const key of keys) {
      void qc.invalidateQueries({ queryKey: key });
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
