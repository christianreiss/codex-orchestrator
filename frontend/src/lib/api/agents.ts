/**
 * Agents API — typed builders for /admin/agents/* endpoints.
 *
 * Backs the AGENTS.md editor with version history + serve mode.
 */
import { api } from "./client";
import type { AgentsDocument, AgentsVersion, AgentsStoreResult } from "./types";

export const agentsApi = {
  get(): Promise<AgentsDocument> {
    return api.get<AgentsDocument>("/admin/agents");
  },
  getVersion(id: number): Promise<AgentsVersion> {
    return api.get<AgentsVersion>(`/admin/agents/versions/${id}`);
  },
  store(payload: { content: string; sha256?: string | null }): Promise<AgentsStoreResult> {
    return api.post<AgentsStoreResult>("/admin/agents/store", payload);
  },
  serve(payload: { mode: "latest" | "locked"; version_id?: number | null }): Promise<AgentsDocument> {
    return api.post<AgentsDocument>("/admin/agents/serve", payload);
  },
  revert(payload: { version_id: number }): Promise<AgentsDocument> {
    return api.post<AgentsDocument>("/admin/agents/revert", payload);
  },
  retention(payload: { backup_limit: number }): Promise<AgentsDocument> {
    return api.post<AgentsDocument>("/admin/agents/retention", payload);
  },
  deleteVersion(id: number): Promise<{ deleted_id?: number } & Record<string, unknown>> {
    return api.delete(`/admin/agents/versions/${id}`);
  },
};

export type { AgentsDocument, AgentsVersion, AgentsStoreResult };
