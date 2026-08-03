import { createMutation, createQuery, type QueryClient } from "@tanstack/svelte-query";
import { api, type ApiError } from "./client";

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

/** Wizard step ids, in order. Mirrors SETUP_WIZARD_STEPS on the server. */
export const SETUP_STEPS = [
  "infrastructure",
  "owner",
  "engines",
  "auth",
  "defaults",
  "policy",
  "modules",
  "collaboration",
  "host",
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === "string" && (SETUP_STEPS as readonly string[]).includes(value);
}

export interface SetupWizardState {
  completed_at: string | null;
  dismissed_at: string | null;
  last_step: SetupStep | null;
  /** `[]` is a real answer ("no engines yet"); `null` means "not asked". */
  engines: ("codex" | "claude")[] | null;
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
  wizard: SetupWizardState;
}

export interface SetupWizardUpdate {
  last_step?: SetupStep;
  engines?: ("codex" | "claude")[];
  completed?: boolean;
  dismissed?: boolean;
}

export const setupKeys = {
  all: () => ["setup"] as const,
  status: () => ["setup", "status"] as const,
};

export function getSetupStatus(): Promise<SetupStatus> {
  return api.get<SetupStatus>("/admin/setup/status");
}

export function setupStatusQuery(enabled = true) {
  return createQuery<SetupStatus>({
    queryKey: setupKeys.status(),
    queryFn: getSetupStatus,
    enabled,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

/**
 * Records wizard position and completion. Every actual answer the wizard
 * collects is written by the endpoint that owns it; this only moves the
 * bookmark.
 *
 * Nothing invalidates `["setup","status"]` from the WS layer — `settings.changed`
 * is deliberately not published for progress writes — so callers that change
 * real state must invalidate it themselves. `invalidateSetup` below is the
 * one-liner for that.
 */
export function createSetupWizardMutation(qc: QueryClient) {
  return createMutation<SetupWizardState, ApiError, SetupWizardUpdate>({
    mutationFn: (vars) => api.post<SetupWizardState>("/admin/setup/wizard", vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: setupKeys.status() });
    },
  });
}

/** Call after any mutation whose result the setup checklist reflects. */
export function invalidateSetup(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: setupKeys.status() });
}
