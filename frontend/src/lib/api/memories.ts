/**
 * Unified Memory Atlas API.
 *
 * Graph responses deliberately omit full bodies and metadata. The inspector
 * fetches those fields only after a memory node is selected.
 */
import { api, apiFetch } from "./client";

export type MemoryScope = "host" | "project" | "shared";
export type MemoryEngine = "codex" | "claude" | string;

export interface MemoryCapabilities {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  append: boolean;
}

export interface MemoryRecord {
  node_id: string;
  /** Immutable memory key (host/project) or slug (shared). */
  id: string;
  record_id: number;
  scope: MemoryScope;
  title: string | null;
  summary: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  tags: string[];
  content_length: number;
  host_id: number | null;
  host: string | null;
  project_id: number | null;
  project_slug: string | null;
  source_host_id: number | null;
  source_host?: string | null;
  engine: MemoryEngine | null;
  revision: number | null;
  created_at: string | null;
  updated_at: string | null;
  etag: string;
  capabilities: MemoryCapabilities;
}

export type MemoryGraphNodeKind = "memory" | "scope" | "host" | "project" | "tag" | "engine";

/** Body-free node returned by GET /admin/memories/graph. */
export interface MemoryGraphNode {
  /** Relationship-node id. Memory nodes also expose canonical `node_id`. */
  id: string;
  node_id?: string;
  /** Immutable human key/slug on memory nodes. */
  memory_id?: string;
  key?: string;
  kind: MemoryGraphNodeKind;
  label: string;
  record_id?: number;
  scope?: MemoryScope;
  title?: string | null;
  summary?: string | null;
  preview?: string | null;
  tags?: string[];
  content_length?: number;
  host_id?: number | null;
  host?: string | null;
  project_id?: number | null;
  project_slug?: string | null;
  source_host_id?: number | null;
  source_host?: string | null;
  engine?: MemoryEngine | null;
  revision?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  capabilities?: MemoryCapabilities;
}

export type MemoryGraphEdgeType =
  | "in_scope"
  | "owned_by"
  | "in_project"
  | "tagged_with"
  | "written_by"
  | "from_engine";

export interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  type: MemoryGraphEdgeType;
}

export interface CountFacet {
  value: string;
  count: number;
}

export interface HostFacet {
  id: number;
  label: string;
  count: number;
}

export interface ProjectFacet {
  slug: string;
  label: string;
  count: number;
}

export interface MemoryFacets {
  scopes: CountFacet[];
  hosts: HostFacet[];
  projects: ProjectFacet[];
  tags: CountFacet[];
  engines: CountFacet[];
}

export interface MemoryTotals {
  all: number;
  host: number;
  project: number;
  shared: number;
}

export interface MemoryGraphResponse {
  status: "ok" | string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  facets: MemoryFacets;
  facets_truncated: {
    hosts: boolean;
    projects: boolean;
    tags: boolean;
  };
  totals: MemoryTotals;
  count: number;
  next_cursor?: string | null;
  truncated: boolean;
}

export interface MemoryGraphParams {
  scopes?: MemoryScope[];
  q?: string;
  tags?: string[];
  host_id?: number | string | null;
  project_slug?: string | null;
  engine?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface MemoryDetailResponse {
  status: "ok" | string;
  memory: MemoryRecord;
}

export interface MemoryMutationResponse {
  status: "created" | "updated" | "unchanged" | "appended" | string;
  memory: MemoryRecord;
}

export interface MemoryDeleteResponse {
  status: "deleted" | string;
  node_id: string;
  scope: MemoryScope;
  record_id: number;
}

export interface MemoryCreatePayload {
  id: string;
  content: string;
  host_id?: number;
  project_slug?: string;
  title?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[];
  engine?: string | null;
}

export interface MemoryUpdatePayload {
  expected_etag: string;
  content?: string;
  metadata?: Record<string, unknown> | null;
  tags?: string[];
  summary?: string | null;
  title?: string | null;
  engine?: string | null;
}

export interface MemoryActivity {
  id: number | string;
  source: string;
  action: string;
  actor_type: string | null;
  admin_id: number | null;
  source_host_id: number | null;
  source_engine: string | null;
  old_etag: string | null;
  new_etag: string | null;
  content_length: number | null;
  delta_length: number | null;
  tag_count: number | null;
  created_at: string | null;
  details: Record<string, unknown> | null;
}

export interface MemoryRetention {
  kind: "operational" | string;
  immutable: boolean;
  body_history: boolean;
  note: string;
}

export interface MemoryAuditResponse {
  status: "ok" | string;
  node_id: string;
  activities: MemoryActivity[];
  next_cursor?: string | null;
  truncated: boolean;
  retention: MemoryRetention;
}

function graphSearch(params: MemoryGraphParams): string {
  const search = new URLSearchParams();
  if (params.scopes?.length) search.set("scopes", params.scopes.join(","));
  if (params.q?.trim()) search.set("q", params.q.trim());
  if (params.tags?.length) search.set("tags", params.tags.join(","));
  if (params.host_id !== undefined && params.host_id !== null && String(params.host_id) !== "") {
    search.set("host_id", String(params.host_id));
  }
  if (params.project_slug) search.set("project_slug", params.project_slug);
  if (params.engine) search.set("engine", params.engine);
  if (params.limit) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  return search.toString();
}

function recordPath(scope: MemoryScope, recordId?: number | string): string {
  const root = `/admin/memories/${encodeURIComponent(scope)}`;
  return recordId === undefined ? root : `${root}/${encodeURIComponent(String(recordId))}`;
}

export const memoriesApi = {
  graph(params: MemoryGraphParams = {}): Promise<MemoryGraphResponse> {
    const search = graphSearch(params);
    return api.get<MemoryGraphResponse>(`/admin/memories/graph${search ? `?${search}` : ""}`);
  },

  detail(scope: MemoryScope, recordId: number | string): Promise<MemoryDetailResponse> {
    return api.get<MemoryDetailResponse>(recordPath(scope, recordId));
  },

  create(scope: MemoryScope, payload: MemoryCreatePayload): Promise<MemoryMutationResponse> {
    return api.post<MemoryMutationResponse>(recordPath(scope), payload);
  },

  update(
    scope: MemoryScope,
    recordId: number | string,
    payload: MemoryUpdatePayload,
  ): Promise<MemoryMutationResponse> {
    return api.patch<MemoryMutationResponse>(recordPath(scope, recordId), payload);
  },

  delete(
    scope: MemoryScope,
    recordId: number | string,
    expectedEtag: string,
  ): Promise<MemoryDeleteResponse> {
    // DELETE carries an optimistic-concurrency body. Use apiFetch directly so
    // the generic `api.delete(path, init)` call signature remains compatible.
    return apiFetch<MemoryDeleteResponse>(recordPath(scope, recordId), {
      method: "DELETE",
      body: { expected_etag: expectedEtag },
    });
  },

  append(recordId: number | string, content: string): Promise<MemoryMutationResponse> {
    return api.post<MemoryMutationResponse>(
      `/admin/memories/shared/${encodeURIComponent(String(recordId))}/append`,
      { content },
    );
  },

  audit(nodeId: string, limit = 50, cursor?: string | null): Promise<MemoryAuditResponse> {
    const search = new URLSearchParams({ node_id: nodeId, limit: String(limit) });
    if (cursor) search.set("cursor", cursor);
    return api.get<MemoryAuditResponse>(`/admin/memories/audit?${search.toString()}`);
  },
};

/** Query-key helpers; the `memories` root is shared with WebSocket invalidation. */
export const memoriesKeys = {
  all: ["memories"] as const,
  graph: (params: MemoryGraphParams) => ["memories", "graph", params] as const,
  detail: (scope: MemoryScope, recordId: number | string) =>
    ["memories", "detail", scope, String(recordId)] as const,
  audit: (nodeId: string, cursor?: string | null) =>
    ["memories", "audit", nodeId, cursor ?? "first"] as const,
};
