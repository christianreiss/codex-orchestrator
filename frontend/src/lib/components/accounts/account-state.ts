/**
 * Plain-language state of a provider account, derived from the API row.
 *
 * Pure and import-free at runtime (type imports are erased) so `node --test`
 * can load it. Thresholds are stated once here and echoed in the stat strip
 * hints: an account "needs attention" when its login or verification is
 * broken, and is "near quota" when either usage window reaches 80%.
 */
import type { ProviderAccount } from "../../api/accounts";

export const NEAR_QUOTA_PERCENT = 80;

export type AccountTone = "ok" | "warning" | "danger" | "muted";

export interface AccountStatus {
  tone: AccountTone;
  /** The problem (or "Active") in plain words, shown first. */
  label: string;
  /** Secondary text: the reason or the next step. */
  detail?: string;
}

/** Highest usage percent across the windows an account reports, or null. */
export function peakUsage(account: ProviderAccount): number | null {
  const { usage } = account;
  const values = [usage.short_used_percent, usage.weekly_used_percent, usage.current_window?.used_percent]
    .filter((value): value is number => typeof value === "number");
  return values.length ? Math.max(...values) : null;
}

export const isNearQuota = (account: ProviderAccount): boolean => !account.quota_policy?.unlimited && (peakUsage(account) ?? 0) >= NEAR_QUOTA_PERCENT;

export const loginNeedsRenewal = (account: ProviderAccount): boolean => account.refresh_state === "login_required";

export function needsAttention(account: ProviderAccount): boolean {
  return account.verification_state === "failed" || loginNeedsRenewal(account);
}

export function accountStatus(account: ProviderAccount, engineOn: boolean, loginCommand: string): AccountStatus {
  if (account.state === "removing") return { tone: "muted", label: "Removing", detail: "Waiting for active sessions to finish." };
  if (loginNeedsRenewal(account)) {
    return { tone: "danger", label: "Login needs renewal", detail: `Run ${loginCommand} login, then replace the full login credentials.` };
  }
  if (account.verification_state === "failed") {
    return { tone: "danger", label: "Verification failed", detail: account.verification_reason ?? undefined };
  }
  if (account.state === "paused") return { tone: "warning", label: "Paused", detail: "Not used for new sessions." };
  if (!engineOn) return { tone: "warning", label: "Engine off", detail: "Disabled fleet-wide; the account is kept but not used." };
  if (isNearQuota(account)) return { tone: "warning", label: "Near quota", detail: account.verification_reason ?? undefined };
  if (account.refresh_state && account.refresh_state !== "idle") {
    return { tone: "ok", label: "Active", detail: `Credential refresh: ${account.refresh_state.replaceAll("_", " ")}` };
  }
  if (account.verification_state !== "verified") {
    return { tone: "warning", label: "Not verified yet", detail: account.verification_reason ?? undefined };
  }
  return { tone: "ok", label: "Active" };
}

const ENGINE_ORDER = ["codex", "claude", "grok"];

/** Problems first, then by engine, then by name: the list leads with what needs attention. */
export function sortAccounts(accounts: ProviderAccount[]): ProviderAccount[] {
  const rank = (account: ProviderAccount) => (needsAttention(account) ? 0 : account.state === "paused" || isNearQuota(account) ? 1 : 2);
  return [...accounts].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      ENGINE_ORDER.indexOf(a.engine) - ENGINE_ORDER.indexOf(b.engine) ||
      a.label.localeCompare(b.label) ||
      a.id - b.id,
  );
}

export function matchesSearch(account: ProviderAccount, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return `${account.label} #${account.id} ${account.engine} ${account.plan?.name ?? ""}`.toLowerCase().includes(needle);
}

/** Distinct real host ids using the account (host 0 is the server-side runner). */
export function sessionHosts(account: ProviderAccount): number[] {
  return [...new Set(account.sessions.map((session) => session.host_id))].filter((id) => id !== 0);
}
