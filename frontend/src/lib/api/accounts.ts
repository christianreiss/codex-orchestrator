import { createQuery } from "@tanstack/svelte-query";
import { api } from "./client";
import type { AuthEngine } from "./auth";

export interface ProviderAccount {
  id: number;
  engine: AuthEngine;
  label: string;
  state: "enabled" | "paused" | "removing";
  verification_state: string;
  verification_reason: string | null;
  verification_checked_at: string | null;
  generation: number | null;
  usage: {
    fetched_at: string | null;
    stale: boolean;
    short_used_percent: number | null;
    short_resets_at: string | null;
    weekly_used_percent: number | null;
    weekly_resets_at: string | null;
  };
  sessions: Array<{ id: string; host_id: number; expires_at: string }>;
}

export const accountsKeys = { all: () => ["accounts"] as const };
export const accountsApi = {
  list: () => api.get<{ accounts: ProviderAccount[] }>("/admin/accounts"),
  update: (id: number, changes: { label?: string; state?: "enabled" | "paused" }) => api.patch(`/admin/accounts/${id}`, changes),
  remove: (id: number) => api.delete(`/admin/accounts/${id}`),
  verify: (id: number) => api.post<{ verification_state: string; reason?: string }>(`/admin/accounts/${id}/verify`, {}),
};
export function accountsQuery() {
  return createQuery({ queryKey: accountsKeys.all(), queryFn: accountsApi.list, refetchInterval: 30_000 });
}
