/**
 * svelte-query builders for the Logs feature.
 *
 * Brief-facing surface uses `limit` / `offset` / `dir`; the backend's
 * `/admin/usage/ingests` actually accepts `per_page` / `page` / `direction`,
 * so we translate transparently.
 */
import type { CreateQueryOptions } from "@tanstack/svelte-query";
import { api } from "./client";
import type {
  AdminAuditLogRow,
  HostFqdnSummary,
  McpAccessLogRow,
  UsageIngestPage,
} from "./types";

export type SortDirection = "asc" | "desc";

export interface UsageIngestsParams {
  limit?: number;
  offset?: number;
  q?: string;
  sort?: string;
  dir?: SortDirection;
  hostId?: number | null;
}

function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === null || raw === undefined) continue;
    const value = String(raw).trim();
    if (value === "") continue;
    search.set(key, value);
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

/** Convert brief-style `limit`/`offset` into backend-style `per_page`/`page`. */
function paginate(limit?: number, offset?: number): { per_page: number; page: number } {
  const perPage = Math.max(1, Math.min(200, limit ?? 50));
  const off = Math.max(0, offset ?? 0);
  const page = Math.floor(off / perPage) + 1;
  return { per_page: perPage, page };
}

/**
 * Query builder for paginated API-traffic ingest rows.
 * Endpoint: `GET /admin/usage/ingests`
 */
export function usageIngestsQuery(
  params: UsageIngestsParams = {},
): CreateQueryOptions<UsageIngestPage, Error> {
  const { limit, offset, q, sort, dir, hostId } = params;
  const { per_page, page } = paginate(limit, offset);
  const direction = dir === "asc" ? "asc" : "desc";
  const qs = buildQuery({
    per_page,
    page,
    q: q && q.trim() !== "" ? q.trim() : undefined,
    sort: sort && sort.trim() !== "" ? sort.trim() : "created_at",
    direction,
    host_id: hostId ?? undefined,
  });
  return {
    queryKey: ["logs", "api", { per_page, page, q: q ?? "", sort: sort ?? "created_at", dir: direction, hostId: hostId ?? null }],
    queryFn: () => api.get<UsageIngestPage>(`/admin/usage/ingests${qs}`),
    placeholderData: (prev) => prev,
  };
}

/**
 * Query builder for recent MCP access logs (returns full page).
 * Endpoint: `GET /admin/mcp/logs?limit=`
 */
export function mcpLogsQuery(limit = 200): CreateQueryOptions<McpAccessLogRow[], Error> {
  const qs = buildQuery({ limit });
  return {
    queryKey: ["logs", "mcp", { limit }],
    queryFn: async () => {
      const data = await api.get<{ logs: McpAccessLogRow[] }>(`/admin/mcp/logs${qs}`);
      return Array.isArray(data?.logs) ? data.logs : [];
    },
  };
}

/**
 * Query builder for the admin audit-trail log feed.
 * Endpoint: `GET /admin/logs?limit=`
 */
export function eventLogsQuery(limit = 200): CreateQueryOptions<AdminAuditLogRow[], Error> {
  const qs = buildQuery({ limit });
  return {
    queryKey: ["logs", "events", { limit }],
    queryFn: async () => {
      const data = await api.get<{ logs: AdminAuditLogRow[] }>(`/admin/logs${qs}`);
      return Array.isArray(data?.logs) ? data.logs : [];
    },
  };
}

/**
 * Query builder for the host → FQDN map used by the events view filter.
 * Endpoint: `GET /admin/hosts`
 *
 * The full hosts payload is heavy; we only need id + fqdn here.
 */
export function hostsForLogsQuery(): CreateQueryOptions<HostFqdnSummary[], Error> {
  return {
    queryKey: ["logs", "hosts-map"],
    queryFn: async () => {
      const data = await api.get<unknown>("/admin/hosts");
      const rows = extractHostsArray(data);
      return rows.map((row) => ({
        id: (row.id as number | string) ?? 0,
        fqdn: (row.fqdn as string | null) ?? (row.hostname as string | null) ?? null,
        hostname: (row.hostname as string | null) ?? null,
        display_name: (row.display_name as string | null) ?? null,
      }));
    },
    staleTime: 60_000,
  };
}

/** Tolerates either a bare array or `{ hosts: [...] }` envelope. */
function extractHostsArray(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.hosts)) return obj.hosts as Array<Record<string, unknown>>;
    if (Array.isArray(obj.items)) return obj.items as Array<Record<string, unknown>>;
  }
  return [];
}

/** Map of host id → display string (FQDN > hostname > "Host #id"). */
export function buildHostLabelMap(rows: HostFqdnSummary[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.id === undefined || row.id === null) continue;
    const id = String(row.id);
    const label = row.fqdn || row.hostname || row.display_name || `Host #${id}`;
    map.set(id, label);
  }
  return map;
}
