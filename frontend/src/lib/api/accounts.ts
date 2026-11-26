import { createQuery } from "@tanstack/svelte-query";
import { api } from "./client";
import type { AuthEngine } from "./auth";

export interface ProviderAccount {
  quota_snapshot?: {
    emulation: { enabled: boolean; window_hours: 5 | 8; action: string; auto_resume: boolean };
    short: { source: string; used_percent: number; limit_seconds: number | null; resets_at: string | null; status: string } | null;
  } | null;
  quota_policy?: import("$lib/components/settings/QuotaPolicyEditor.svelte").QuotaPolicy;
  id: number;
  engine: AuthEngine;
  label: string;
  /** Provider login e-mail when the server could derive it (Claude profile). */
  email?: string | null;
  /** False when no provider identity was recorded yet, so re-logins cannot be matched to this account. */
  identity_known?: boolean;
  state: "enabled" | "paused" | "removing";
  verification_state: string;
  verification_reason: string | null;
  verification_checked_at: string | null;
  generation: number | null;
  refresh_state?: "idle" | "refreshing" | "pending_verification" | "uncertain" | "login_required";
  plan?: {
    name: string | null;
    source: "chatgpt_usage" | "claude_login" | "grok_settings" | "kimi_userinfo";
    observed_at: string | null;
    stale: boolean;
  };
  usage: {
    plan_name?: string | null;
    windows?: Array<{ kind: "five_hour" | "weekly" | "month_total" | "month_code"; used_percent: number; resets_at: string | null }>;
    supported?: boolean;
    fetched_at: string | null;
    stale: boolean;
    short_used_percent: number | null;
    short_resets_at: string | null;
    short_limit_seconds?: number | null;
    weekly_used_percent: number | null;
    weekly_resets_at: string | null;
    weekly_limit_seconds?: number | null;
    checked_at?: string | null;
    error_code?: string | null;
    current_window?: {
      used_percent: number;
      period: "weekly" | "monthly" | null;
      starts_at: string | null;
      resets_at: string | null;
      shared: boolean | null;
    } | null;
  };
  sessions: Array<{ id: string; host_id: number; expires_at: string; scope_id?: string; binding_generation?: number; account_switch?: AccountSwitchDirective | null }>;
  /**
   * Position in the engine's account pool, scored like live switching: `score` is max(short, weekly)
   * used percent (a passed reset is no reading, unlimited 0, an emulated block 100); `short` and
   * `weekly` are the windows as scored (null without a current reading); `usable` means enabled and
   * verified.
   */
  pool?: { score: number | null; short?: number | null; weekly?: number | null; usable: boolean; emulation_blocked: boolean };
}

/** A pending account switch for one scope (host + user + native credential directory). */
export interface AccountSwitchDirective {
  account_id: number;
  account_label: string;
  binding_generation: number;
  reason: "policy" | "admin" | "host" | "agent";
  requested_at: string;
}

export type PolicyMode = "auto" | "manual";
export type PolicyStrategy = "balanced" | "exhaust";
export type PolicySpread = "eng" | "normal" | "locker";

/** Per-engine account distribution policy (`GET/POST /admin/accounts/policy/:engine`). */
export interface AccountPolicy {
  mode: PolicyMode;
  strategy: PolicyStrategy;
  spread: PolicySpread;
  spread_points: number;
  soft_ceiling: number;
  hard_ceiling: number;
  min_dwell_minutes: number;
}
export type AccountPolicyChanges = Partial<Pick<AccountPolicy, "mode" | "strategy" | "spread" | "soft_ceiling" | "hard_ceiling" | "min_dwell_minutes">>;

/** One live scope: every session of one user on one host shares this binding. */
export interface AccountScope {
  host_id: number;
  host_fqdn: string;
  scope_id: string;
  account_id: number;
  account_label: string;
  binding_generation: number;
  sessions: number;
  bound_at: string | null;
  account_switch: AccountSwitchDirective | null;
}

// policy/scopes sit under the "accounts" root, so every accounts.updated invalidation reaches them too.
export const accountsKeys = {
  all: () => ["accounts"] as const,
  policy: (engine: AuthEngine) => ["accounts", "policy", engine] as const,
  scopes: (engine: AuthEngine) => ["accounts", "scopes", engine] as const,
};
export const accountsApi = {
  list: () => api.get<{ accounts: ProviderAccount[] }>("/admin/accounts"),
  update: (id: number, changes: { label?: string; state?: "enabled" | "paused" }) => api.patch(`/admin/accounts/${id}`, changes),
  remove: (id: number) => api.delete(`/admin/accounts/${id}`),
  policy: (engine: AuthEngine) => api.get<AccountPolicy>(`/admin/accounts/policy/${engine}`),
  setPolicy: (engine: AuthEngine, changes: AccountPolicyChanges) => api.post<AccountPolicy>(`/admin/accounts/policy/${engine}`, changes),
  scopes: (engine: AuthEngine) => api.get<AccountScope[]>(`/admin/accounts/scopes?engine=${encodeURIComponent(engine)}`),
  switchScope: (input: { engine: AuthEngine; host_id: number; scope_id: string; account_id: number }) =>
    api.post<{ binding_generation: number; account_switch: AccountSwitchDirective | null }>("/admin/accounts/scopes/switch", input),
  verify: (id: number) => api.post<{ verification_state: string; reason?: string }>(`/admin/accounts/${id}/verify`, {}),
};
export function accountsQuery() {
  return createQuery({ queryKey: accountsKeys.all(), queryFn: accountsApi.list });
}
