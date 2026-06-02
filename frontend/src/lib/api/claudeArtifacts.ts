/**
 * Shared builder for Claude collection artifact APIs (subagents, commands,
 * output-styles). Each collection module wires a `kind` into this factory.
 *
 * Endpoints (kind is one of subagents | commands | output-styles):
 *   GET    /admin/claude/:kind          → { kind, artifacts: ArtifactView[] }
 *   GET    /admin/claude/:kind/:slug     → ArtifactView
 *   POST   /admin/claude/:kind/store     → ArtifactStoreResult
 *   DELETE /admin/claude/:kind/:slug     → ArtifactDeleteResult
 */
import { api } from "./client";
import type {
  ArtifactView,
  ArtifactListResponse,
  ArtifactStorePayload,
  ArtifactStoreResult,
  ArtifactDeleteResult,
} from "./types";

export interface ClaudeArtifactApi {
  list(): Promise<ArtifactListResponse>;
  get(slug: string): Promise<ArtifactView>;
  store(payload: ArtifactStorePayload): Promise<ArtifactStoreResult>;
  delete(slug: string): Promise<ArtifactDeleteResult>;
}

export function createClaudeArtifactApi(kind: string): ClaudeArtifactApi {
  const base = `/admin/claude/${kind}`;
  return {
    list: () => api.get<ArtifactListResponse>(base),
    get: (slug) => api.get<ArtifactView>(`${base}/${encodeURIComponent(slug)}`),
    store: (payload) => api.post<ArtifactStoreResult>(`${base}/store`, payload),
    delete: (slug) => api.delete<ArtifactDeleteResult>(`${base}/${encodeURIComponent(slug)}`),
  };
}

/** Query-key helper factory mirroring memoriesKeys. */
export function createArtifactKeys(kind: string) {
  return {
    all: [kind] as const,
    list: () => [kind, "list"] as const,
    detail: (slug: string) => [kind, "detail", slug] as const,
  };
}
