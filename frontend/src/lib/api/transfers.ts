import {
  createMutation,
  createQuery,
  useQueryClient,
  type CreateMutationOptions,
} from "@tanstack/svelte-query";
import { api } from "./client";
import { downloadFile } from "$lib/utils/download";

/** `uploading` while a chunked put is open, `live` once sealed, then retired. */
export type TransferStatus = "uploading" | "live" | "expired" | "deleted";

export interface TransferLimits {
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  max_file_bytes: number;
  quota_bytes: number;
}

export interface TransferState extends TransferLimits {
  enabled: boolean;
  updated_at: string | null;
  used_bytes: number;
  live_count: number;
}

export interface TransferRow {
  id: string;
  name: string;
  description: string | null;
  mime_type: string | null;
  size_bytes: number;
  content_sha256: string | null;
  status: TransferStatus;
  source_host_id: number | null;
  /** Asserted by the uploading agent, not verified by the fleet. */
  uploaded_by: string | null;
  uploaded_from: string | null;
  requested_ttl_seconds: number | null;
  /** True when the fleet shortened what the agent asked for. */
  ttl_clamped: boolean;
  download_count: number;
  expires_at: string;
  sealed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransferEventRow {
  id: string;
  action: "uploaded" | "appended" | "sealed" | "downloaded" | "deleted" | "expired";
  actor_kind: "agent" | "admin" | "system";
  actor_label: string | null;
  source_host_id: number | null;
  detail: string | null;
  created_at: string;
}

type MutationOpts<T, V> = Omit<CreateMutationOptions<T, Error, V, unknown>, "mutationFn">;

export const transferKeys = {
  all: ["transfers"] as const,
  state: ["transfers", "state"] as const,
  list: ["transfers", "list"] as const,
  events: (id: string) => ["transfers", "events", id] as const,
};

export function transferStateQuery() {
  return createQuery<TransferState>({
    queryKey: transferKeys.state,
    queryFn: () => api.get<TransferState>("/admin/transfers/state"),
  });
}

export function transferListQuery() {
  return createQuery<{ transfers: TransferRow[] }>({
    queryKey: transferKeys.list,
    queryFn: () => api.get<{ transfers: TransferRow[] }>("/admin/transfers"),
    // Every row carries a deadline that the server sweeps past. Without a
    // refetch a page left open shows files that expired minutes ago as live.
    refetchInterval: 30_000,
  });
}

export function transferEventsQuery(id: () => string | null) {
  return createQuery<{ events: TransferEventRow[] }>({
    get queryKey() {
      return transferKeys.events(id() ?? "");
    },
    get enabled() {
      return id() !== null;
    },
    queryFn: () => api.get<{ events: TransferEventRow[] }>(`/admin/transfers/${id()}/events`),
  });
}

function invalidateAll() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: transferKeys.all });
}

export function transferStateMutation(opts: MutationOpts<TransferState, boolean> = {}) {
  const invalidate = invalidateAll();
  return createMutation<TransferState, Error, boolean>({
    mutationFn: (enabled) => api.post<TransferState>("/admin/transfers/state", { enabled }),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

export function transferLimitsMutation(opts: MutationOpts<TransferState, Partial<TransferLimits>> = {}) {
  const invalidate = invalidateAll();
  return createMutation<TransferState, Error, Partial<TransferLimits>>({
    mutationFn: (limits) => api.post<TransferState>("/admin/transfers/limits", limits),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

export function transferDeleteMutation(opts: MutationOpts<TransferRow, string> = {}) {
  const invalidate = invalidateAll();
  return createMutation<TransferRow, Error, string>({
    mutationFn: (id) => api.delete<TransferRow>(`/admin/transfers/${id}`),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

/**
 * Fetch the bytes and hand them to the browser. Invalidates afterwards because
 * the server counts the fetch, so the row's download count is now stale.
 */
export function transferDownloadMutation(opts: MutationOpts<void, TransferRow> = {}) {
  const invalidate = invalidateAll();
  return createMutation<void, Error, TransferRow>({
    mutationFn: (row) => downloadFile(`/admin/transfers/${row.id}/content`, row.name),
    ...opts,
    onSettled: (...args) => {
      invalidate();
      opts.onSettled?.(...args);
    },
  });
}

/** Seconds as a compact duration, for the TTL settings inputs. */
export function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export function transferStatusLabel(status: TransferStatus): string {
  switch (status) {
    case "uploading":
      return "Uploading";
    case "live":
      return "Live";
    case "expired":
      return "Expired";
    case "deleted":
      return "Deleted";
    default:
      return status;
  }
}

/**
 * What the audit trail says happened, in words an operator reads rather than
 * the enum the table stores.
 */
export function transferActionLabel(row: TransferEventRow): string {
  const who =
    row.actor_kind === "system"
      ? "the sweeper"
      : row.actor_kind === "admin"
        ? `admin ${row.actor_label ?? "?"}`
        : (row.actor_label ?? "an agent");
  switch (row.action) {
    case "uploaded":
      return `Uploaded by ${who}`;
    case "appended":
      return `Chunk appended by ${who}`;
    case "sealed":
      return `Sealed by ${who}`;
    case "downloaded":
      return `Downloaded by ${who}`;
    case "deleted":
      return `Deleted by ${who}`;
    case "expired":
      return "Expired and swept";
    default:
      return row.action;
  }
}
