/**
 * Memories API — read-only list + delete against /admin/mcp/memories.
 */
import { api } from "./client";
import type { MemoryEntry, MemoriesListResponse } from "./types";

export interface MemoriesListParams {
  q?: string;
  limit?: number;
  /** Filter by host id. Pass null/undefined for "all hosts". */
  host?: number | string | null;
  /** @deprecated Older callers; kept as an alias for `host`. */
  host_id?: number | string | null;
  tags?: string;
}

export const memoriesApi = {
  list(params?: MemoriesListParams): Promise<MemoriesListResponse> {
    const search = new URLSearchParams();
    if (params?.q) search.set("q", params.q);
    if (params?.limit) search.set("limit", String(params.limit));
    const hostValue = params?.host ?? params?.host_id ?? null;
    if (hostValue !== undefined && hostValue !== null && String(hostValue) !== "") {
      search.set("host_id", String(hostValue));
    }
    if (params?.tags) search.set("tags", params.tags);
    const qs = search.toString();
    return api.get<MemoriesListResponse>(`/admin/mcp/memories${qs ? `?${qs}` : ""}`);
  },
  delete(recordId: number | string): Promise<{ deleted: number | string }> {
    return api.delete<{ deleted: number | string }>(`/admin/mcp/memories/${encodeURIComponent(String(recordId))}`);
  },
};

/** Query-key helpers for the memories list (used by `createQuery({ queryKey })`). */
export const memoriesKeys = {
  all: ["memories"] as const,
  list: (host: number | string | null | undefined = null) =>
    ["memories", "list", host === null || host === undefined || host === "" ? "all" : String(host)] as const,
};

export type { MemoryEntry, MemoriesListResponse };
