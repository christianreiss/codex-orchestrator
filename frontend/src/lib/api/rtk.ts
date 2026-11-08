export type RtkEngine = "codex" | "claude" | "grok";
export const RTK_ENGINES: RtkEngine[] = ["codex", "claude", "grok"];
export interface RtkObservation {
  engine: RtkEngine; ready: boolean; wrapper_version: string; native_version: string;
  rtk_version: string; policy_revision: string; observed_at: string; error_code?: string;
}
export interface RtkPolicy {
  enabled: boolean; source: "fleet" | "host"; override: boolean | null; fleet: boolean;
  adapter_mode?: "instructions" | "hook";
  policy_revision: string | null; assigned?: boolean; observation?: RtkObservation | null;
}
export interface RtkPolicies { engines: Record<RtkEngine, RtkPolicy> }
/** Readiness is evidence for this policy revision, never proof of active sessions. */
export function rtkReadiness(policy: RtkPolicy, now = Date.now()): string {
  if (policy.assigned === false) return "Engine not assigned";
  const report = policy.observation;
  if (!report) return "Not reported";
  if (!Number.isFinite(Date.parse(report.observed_at)) || now - Date.parse(report.observed_at) > 24 * 60 * 60 * 1000) return "Report older than 24 hours; readiness unknown";
  if (report.policy_revision !== policy.policy_revision) return "Previous policy reported; awaiting sync";
  return report.ready ? (policy.adapter_mode === "instructions" ? "Guidance prepared at last report" : "Adapter prepared at last report") : "Adapter unavailable at last report";
}
