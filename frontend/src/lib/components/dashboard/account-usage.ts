import type { ProviderAccount } from "../../api/accounts";

/** Only supplied readings become meters; zero is a valid reading. */
export function accountQuotaRows(account: Pick<ProviderAccount, "engine" | "usage" | "quota_snapshot">) {
  const { usage, engine } = account;
  if (engine === "grok" || usage.supported === false) return [];
  const emulated = account.quota_snapshot?.short?.source === "emulated" ? account.quota_snapshot.short : null;
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
