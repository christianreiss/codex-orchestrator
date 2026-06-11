/**
 * svelte-query builders for the Logs feature.
 */
import type { CreateQueryOptions } from "@tanstack/svelte-query";
import { api } from "./client";
import type {
  AdminAuditLogRow,
  HostFqdnSummary,
  McpAccessLogRow,
} from "./types";

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
