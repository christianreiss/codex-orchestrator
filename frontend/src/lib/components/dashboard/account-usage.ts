import type { ProviderAccount } from "../../api/accounts";

/** Only supplied readings become meters; zero is a valid reading. */
export function accountQuotaRows(account: Pick<ProviderAccount, "engine" | "usage" | "quota_snapshot">) {
  const { usage, engine } = account;
  if (engine === "grok" || usage.supported === false) return [];
  const emulated = account.quota_snapshot?.short?.source === "emulated" ? account.quota_snapshot.short : null;
  if (engine === "kimi") return (usage.windows ?? []).map(window => ({
    key: window.kind,
    value: window.kind === "five_hour" && emulated ? emulated.used_percent : window.used_percent,
    reset: window.kind === "five_hour" && emulated ? emulated.resets_at : window.resets_at,
    // Window length for the dashboard's elapsed-time marker; calendar months have none fixed.
    seconds: window.kind === "five_hour" ? (emulated?.limit_seconds ?? 18000) : window.kind === "weekly" ? 604800 : undefined as number | undefined,
    label: window.kind === "five_hour" && emulated ? `Emulated ${Math.round((emulated.limit_seconds ?? 18000) / 3600)}-hour window`
      : { five_hour: "5-hour window", weekly: "Weekly window", month_total: "Monthly total", month_code: "Monthly code" }[window.kind],
  }));
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
