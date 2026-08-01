import { createQuery } from "@tanstack/svelte-query";
import { api } from "./client";

export interface SetupCheck {
  id: string;
  label: string;
  ok: boolean;
  critical: boolean;
  detail: string;
}

export interface SetupAction {
  id: string;
  complete: boolean;
  label: string;
  href: string;
}

export interface SetupStatus {
  critical_complete: boolean;
  owner_created: boolean;
  setup_complete: boolean;
  checks: SetupCheck[];
  configured_engines: string[];
  canonical_auth: { codex: boolean; claude: boolean };
  hosts: { total: number; synced: number };
  public_base_url: string | null;
  warnings: string[];
  next_actions: SetupAction[];
}

export function getSetupStatus(): Promise<SetupStatus> {
  return api.get<SetupStatus>("/admin/setup/status");
}

export function setupStatusQuery(enabled = true) {
  return createQuery<SetupStatus>({
    queryKey: ["setup", "status"],
    queryFn: getSetupStatus,
    enabled,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
