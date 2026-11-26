/**
 * Pure helpers for the account distribution policy form. Import-free at runtime so `node --test`
 * can load it; the limits mirror the server contract (`POST /admin/accounts/policy/:engine`).
 */
export const SPREAD_POINTS = { eng: 10, normal: 20, locker: 30 } as const;

export interface PolicyDraft {
  mode: "auto" | "manual";
  strategy: "balanced" | "exhaust";
  soft_ceiling: number;
  hard_ceiling: number;
  min_dwell_minutes: number;
}

const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/** Field problems keyed by field name; empty when the draft can be sent. Only the visible fields are judged. */
export function policyIssues(policy: PolicyDraft): Partial<Record<"soft_ceiling" | "hard_ceiling" | "min_dwell_minutes", string>> {
  const issues: Partial<Record<"soft_ceiling" | "hard_ceiling" | "min_dwell_minutes", string>> = {};
  if (policy.mode !== "auto") return issues;
  if (policy.strategy === "exhaust") {
    if (!whole(policy.soft_ceiling) || policy.soft_ceiling < 50 || policy.soft_ceiling > 99) issues.soft_ceiling = "Enter a whole number from 50 to 99.";
    if (!whole(policy.hard_ceiling) || policy.hard_ceiling > 100) issues.hard_ceiling = "Enter a whole number up to 100.";
    else if (!issues.soft_ceiling && policy.hard_ceiling < policy.soft_ceiling) issues.hard_ceiling = "The hard limit cannot be below the soft limit.";
  }
  if (!whole(policy.min_dwell_minutes) || policy.min_dwell_minutes < 0 || policy.min_dwell_minutes > 240) issues.min_dwell_minutes = "Enter a whole number of minutes from 0 to 240.";
  return issues;
}

/** Accounts a scope may be moved to: same engine, enabled and verified, not the one it is on. */
export function switchTargets(
  accounts: ReadonlyArray<{ id: number; engine: string; label: string; email?: string | null; state: string; verification_state: string }>,
  engine: string,
  currentId: number,
): Array<{ value: string; label: string }> {
  return accounts
    .filter((account) => account.engine === engine && account.state === "enabled" && account.verification_state === "verified" && account.id !== currentId)
    .map((account) => ({ value: String(account.id), label: account.email && account.email !== account.label ? `${account.label} (${account.email})` : account.label }));
}
