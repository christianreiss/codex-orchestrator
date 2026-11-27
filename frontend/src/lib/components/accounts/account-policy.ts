/**
 * Pure helpers for the account distribution policy form. Import-free at runtime so `node --test`
 * can load it; the limits mirror the server contract (`POST /admin/accounts/policy/:engine`).
 */
export const SPREAD_POINTS = { eng: 10, normal: 20, locker: 30 } as const;

export type PolicyStrategyName = "balanced" | "exhaust" | "reset_aware";

/** One line per strategy for the policy form: what it does, in the operator's terms. */
export const STRATEGY_OPTIONS: ReadonlyArray<{ value: PolicyStrategyName; label: string; hint: string; explanation: string }> = [
  {
    value: "balanced",
    label: "Balanced",
    hint: "Raise all accounts together",
    explanation: "Accounts are raised together. A running scope only moves once the account it is on is further ahead of the least-used account than the band allows.",
  },
  {
    value: "exhaust",
    label: "Exhaust",
    hint: "Use one account up to its limit, then the next",
    explanation: "Account 1 is used up to the soft limit, then the next one. Only when every account is past the soft limit does work continue up to the hard limit.",
  },
  {
    value: "reset_aware",
    label: "Expiring first",
    hint: "Use the account closest to its weekly reset first",
    explanation: "The account whose weekly quota resets soonest is used first, up to the soft limit, then the next soonest; a freshly reset account comes last. Quota left over at a reset is lost, so it is spent before quota that keeps for days.",
  },
];

/** The policy in a few words for group headers: "Manual" or "Automatic, Expiring first". */
export function policySummary(policy: { mode: string; strategy: string } | null | undefined): string {
  if (policy?.mode === "manual") return "Manual";
  if (policy?.mode !== "auto") return "";
  return `Automatic, ${STRATEGY_OPTIONS.find((option) => option.value === policy.strategy)?.label ?? "Balanced"}`;
}

/** Strategies that fill accounts to the soft and hard limit; Balanced uses the band instead. */
export const usesCeilings = (strategy: PolicyStrategyName): boolean => strategy !== "balanced";

export interface PolicyDraft {
  mode: "auto" | "manual";
  strategy: PolicyStrategyName;
  soft_ceiling: number;
  hard_ceiling: number;
  min_dwell_minutes: number;
  /** Absent on engines without live switching, and on a server before pause rounds. */
  pause?: "off" | "on";
  pause_after_seconds?: number;
  pause_hold_seconds?: number;
}

type PolicyField = "soft_ceiling" | "hard_ceiling" | "min_dwell_minutes" | "pause_after_seconds" | "pause_hold_seconds";

const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/** Field problems keyed by field name; empty when the draft can be sent. Only the visible fields are judged. */
export function policyIssues(policy: PolicyDraft): Partial<Record<PolicyField, string>> {
  const issues: Partial<Record<PolicyField, string>> = {};
  // Pausing does not depend on the mode: an operator's own switch request is paused for as well.
  if (policy.pause === "on") {
    if (!whole(policy.pause_after_seconds) || policy.pause_after_seconds < 0 || policy.pause_after_seconds > 3600)
      issues.pause_after_seconds = "Enter a whole number of seconds from 0 to 3600.";
    if (!whole(policy.pause_hold_seconds) || policy.pause_hold_seconds < 30 || policy.pause_hold_seconds > 300)
      issues.pause_hold_seconds = "Enter a whole number of seconds from 30 to 300.";
  }
  if (policy.mode !== "auto") return issues;
  if (usesCeilings(policy.strategy)) {
    if (!whole(policy.soft_ceiling) || policy.soft_ceiling < 50 || policy.soft_ceiling > 99) issues.soft_ceiling = "Enter a whole number from 50 to 99.";
    if (!whole(policy.hard_ceiling) || policy.hard_ceiling > 100) issues.hard_ceiling = "Enter a whole number up to 100.";
    else if (!issues.soft_ceiling && policy.hard_ceiling < policy.soft_ceiling) issues.hard_ceiling = "The hard limit cannot be below the soft limit.";
  }
  if (!whole(policy.min_dwell_minutes) || policy.min_dwell_minutes < 0 || policy.min_dwell_minutes > 240) issues.min_dwell_minutes = "Enter a whole number of minutes from 0 to 240.";
  return issues;
}

/**
 * Soft and hard limit from the two thumbs of the limit slider: whole percent from 50 to 100,
 * the soft limit at most 99 (the server's bound), the hard limit never below it.
 */
export function ceilingsFrom([low, high]: readonly [number, number]): { soft_ceiling: number; hard_ceiling: number } {
  const clamp = (value: number) => Math.min(100, Math.max(50, Math.round(Number.isFinite(value) ? value : 50)));
  const [a, b] = [clamp(low), clamp(high)].sort((x, y) => x - y) as [number, number];
  const soft = Math.min(a, 99);
  return { soft_ceiling: soft, hard_ceiling: Math.max(b, soft) };
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

/** Why a session cannot be held for a switch, in the operator's terms. */
const PAUSE_OBSTACLES: Record<string, string> = {
  timed_lease: "runs without a live connection to the server",
  no_hooks: "was started before pausing was available, or its hooks have not run yet",
  detached: "is not connected right now",
};

export interface ScopePauseInput {
  pending: boolean;
  sessions: number;
  pause?: {
    pausable: boolean;
    blocked_by: ReadonlyArray<{ session_id: string; reason: string }>;
    round: { ready_at: string | null; sessions: ReadonlyArray<{ state: string }> } | null;
    last: { outcome: string; paused: number; asked: number; detail: string | null } | null;
    retry_at: string | null;
  } | null;
}

/**
 * What the scopes table says about pausing for one scope, or null when there is nothing to say.
 * `tone` is "active" while sessions are being held, "blocked" when a pending switch cannot be
 * paused for, and "info" otherwise. `retryAt` is shown as a time by the caller.
 */
export function scopePauseStatus(scope: ScopePauseInput): { tone: "active" | "blocked" | "info"; text: string; retryAt: string | null } | null {
  const pause = scope.pause;
  if (!pause) return null;
  if (pause.round) {
    const paused = pause.round.sessions.filter((session) => session.state === "paused").length;
    const total = pause.round.sessions.length;
    return {
      tone: "active",
      text: pause.round.ready_at ? `All ${total} ${total === 1 ? "session is" : "sessions are"} paused. Switching now.` : `Pausing sessions: ${paused} of ${total} paused.`,
      retryAt: null,
    };
  }
  if (!scope.pending) return null;
  if (!pause.pausable) {
    const first = pause.blocked_by[0];
    const count = pause.blocked_by.length;
    const why = first ? (PAUSE_OBSTACLES[first.reason] ?? "cannot be paused") : "cannot be paused";
    return {
      tone: "blocked",
      text: `Cannot pause for this switch: ${count === 1 ? "1 session" : `${count} sessions`} of ${scope.sessions} ${why}. It waits for a gap between turns.`,
      retryAt: null,
    };
  }
  if (pause.last && pause.last.outcome !== "switched") {
    const ended: Record<string, string> = {
      deadline: `ran out of time with ${pause.last.paused} of ${pause.last.asked} sessions paused`,
      running: "was ended by a session that went on working",
      detached: "ended because a session lost its connection",
      failed: `failed${pause.last.detail ? ` (${pause.last.detail})` : ""}`,
      disabled: "was ended because pausing was switched off",
    };
    return { tone: "info", text: `The last pause ${ended[pause.last.outcome] ?? "ended without a switch"}.`, retryAt: pause.retry_at };
  }
  return null;
}
