/**
 * Memories API — read-only list + delete against /admin/mcp/memories.
 */
import { api } from "./client";
import type { MemoryEntry, MemoriesListResponse } from "./types";

export const memoriesApi = {
  list(params?: { q?: string; limit?: number; host_id?: number | string; tags?: string }): Promise<MemoriesListResponse> {
    const search = new URLSearchParams();
    if (params?.q) search.set("q", params.q);
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.host_id !== undefined && params?.host_id !== null && params?.host_id !== "") {
      search.set("host_id", String(params.host_id));
    }
    if (params?.tags) search.set("tags", params.tags);
    const qs = search.toString();
    return api.get<MemoriesListResponse>(`/admin/mcp/memories${qs ? `?${qs}` : ""}`);
  },
  delete(recordId: number | string): Promise<{ deleted: number | string }> {
    return api.delete<{ deleted: number | string }>(`/admin/mcp/memories/${encodeURIComponent(String(recordId))}`);
  },
};

export type { MemoryEntry, MemoriesListResponse };
