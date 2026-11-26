import type { ProviderAccount } from "../../api/accounts";

/** Only supplied readings become meters; zero is a valid reading. */
export function accountQuotaRows(account: Pick<ProviderAccount, "engine" | "usage" | "quota_snapshot">) {
  const { usage, engine } = account;
  if (engine === "grok" || usage.supported === false) return [];
  const emulated = account.quota_snapshot?.short?.source === "emulated" ? account.quota_snapshot.short : null;
  if (engine === "kimi") {
    const native = usage.windows ?? [];
    const windows = emulated
      ? [{ kind: "five_hour" as const, used_percent: emulated.used_percent, resets_at: emulated.resets_at }, ...native.filter(window => window.kind !== "five_hour")]
      : native;
    return windows.map(window => ({
      key: window.kind,
      value: window.used_percent,
      reset: window.resets_at,
      seconds: window.kind === "five_hour" ? (emulated?.limit_seconds ?? 18000) : window.kind === "weekly" ? 604800 : undefined,
      label: window.kind === "five_hour" && emulated ? `Emulated ${Math.round((emulated.limit_seconds ?? 18000) / 3600)}-hour window`
        : { five_hour: "5-hour window", weekly: "Weekly window", month_total: "Monthly total", month_code: "Monthly code" }[window.kind],
    }));
  }
  const windows = [
    { key: "short", value: emulated?.used_percent ?? usage.short_used_percent, reset: emulated?.resets_at ?? usage.short_resets_at, seconds: emulated?.limit_seconds ?? usage.short_limit_seconds, fallback: engine === "claude" ? "5-hour window" : "Short window" },
    { key: "weekly", value: usage.weekly_used_percent, reset: usage.weekly_resets_at, seconds: usage.weekly_limit_seconds, fallback: "Weekly window" },
  ];
  return windows
    .filter((window): window is typeof window & { value: number } => typeof window.value === "number" && Number.isFinite(window.value))
    .map((window) => {
      const seconds = window.seconds;
      const label = seconds === 18000 ? "5-hour window"
        : typeof seconds === "number" && seconds >= 604800 ? "Weekly window"
        : typeof seconds === "number" && seconds > 0 && seconds % 86400 === 0 ? `${seconds / 86400}-day window`
        : typeof seconds === "number" && seconds > 0 && seconds % 3600 === 0 ? `${seconds / 3600}-hour window`
        : window.fallback;
      return { ...window, value: Math.round(window.value * 10) / 10, label: emulated && window.key === "short" ? `Emulated ${label.toLowerCase()}` : label };
    });
}

/** One window of an engine pool, drawn like an account's own meter. */
export interface PoolQuotaRow {
  key: string;
  label: string;
  /** Mean of the accounts reporting this window, rounded to one decimal. */
  value: number;
  /** Mean of their elapsed period (0-100), so the average reads against time like one account; null without a period. */
  elapsed: number | null;
  /** The next reset in the pool: when capacity comes back first. */
  reset: string | null;
  /** Accounts behind the mean, and the accounts asked. */
  reporting: number;
  of: number;
}

/**
 * The pool's windows for a collapsed engine group: the mean of each window over the given (usable)
 * accounts. A reading whose reset has passed is no longer current and is left out, as in the
 * server's pool score; an unmeasured account is never counted as zero.
 */
export function poolQuotaRows(
  accounts: readonly Pick<ProviderAccount, "engine" | "usage" | "quota_snapshot">[],
  /** `periodElapsedPercent`, passed in so this module stays import-free for `node --test`. */
  elapsedOf: (reset: string | null | undefined, period: { startsAt?: string | null; limitSeconds?: number | null }, now: number) => number | null,
  now = Date.now(),
): PoolQuotaRow[] {
  const windows = new Map<string, { label: string; values: number[]; elapsed: number[]; resets: number[] }>();
  for (const account of accounts) {
    if (account.usage.supported === false) continue;
    // Grok reports one current period (its rows draw it through GrokUsage, with these labels).
    const grok = account.engine === "grok" ? account.usage.current_window : null;
    const rows = account.engine === "grok"
      ? grok ? [{ key: "current", label: grok.period === "weekly" ? "Weekly usage" : grok.period === "monthly" ? "Monthly usage" : "Current period", value: grok.used_percent, reset: grok.resets_at, seconds: undefined as number | undefined, starts: grok.starts_at }] : []
      : accountQuotaRows(account).map((row) => ({ ...row, starts: null as string | null }));
    for (const row of rows) {
      if (typeof row.value !== "number" || !Number.isFinite(row.value)) continue;
      const end = row.reset ? new Date(row.reset).getTime() : NaN;
      if (Number.isFinite(end) && end <= now) continue;
      const slot = windows.get(row.key) ?? { label: row.label, values: [], elapsed: [], resets: [] };
      slot.values.push(row.value);
      const elapsed = elapsedOf(row.reset, { startsAt: row.starts, limitSeconds: row.seconds }, now);
      if (elapsed !== null) slot.elapsed.push(elapsed);
      if (Number.isFinite(end)) slot.resets.push(end);
      windows.set(row.key, slot);
    }
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return [...windows.entries()].map(([key, slot]) => ({
    key,
    label: slot.label,
    value: Math.round(mean(slot.values) * 10) / 10,
    elapsed: slot.elapsed.length ? mean(slot.elapsed) : null,
    reset: slot.resets.length ? new Date(Math.min(...slot.resets)).toISOString() : null,
    reporting: slot.values.length,
    of: accounts.length,
  }));
}
