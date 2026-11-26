/**
 * Plain-language state of a provider account, derived from the API row.
 *
 * Pure and import-free at runtime (type imports are erased) so `node --test`
 * can load it. Thresholds are stated once here and echoed in the stat strip
 * hints: an account "needs attention" when its login or verification is
 * broken, and is "near quota" when either usage window reaches 80%. Totals
 * judge an engine with several usable accounts as a pool: its high accounts
 * count only when no usable account has headroom (`nearQuotaCounted`).
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
  const values = [usage.short_used_percent, usage.weekly_used_percent, usage.current_window?.used_percent, ...(usage.windows ?? []).map(window => window.used_percent)]
    .filter((value): value is number => typeof value === "number");
  return values.length ? Math.max(...values) : null;
}

export const isNearQuota = (account: ProviderAccount): boolean => !account.quota_policy?.unlimited && (peakUsage(account) ?? 0) >= NEAR_QUOTA_PERCENT;

/** Enabled and verified: the account can take new sessions and live switches. */
export const isUsable = (account: ProviderAccount): boolean =>
  account.pool?.usable ?? (account.state === "enabled" && account.verification_state === "verified");

/** The server's pool score (same rule as live switching), or the highest window when it is absent. */
export function poolScore(account: ProviderAccount): number | null {
  if (account.pool) return account.pool.score;
  return account.quota_policy?.unlimited ? 0 : peakUsage(account);
}

/** A pool score in words: "87%", or "no reading yet" (never shown as 0%). */
export function scoreText(account: ProviderAccount): string {
  const score = poolScore(account);
  return score === null ? "no reading yet" : `${Math.round(score)}%`;
}

/** A usable account below the near-quota level. No reading yet counts as unused, as in the server policy. */
export const hasHeadroom = (account: ProviderAccount): boolean => isUsable(account) && (poolScore(account) ?? 0) < NEAR_QUOTA_PERCENT;

/** One engine's accounts judged together, the way agents are advised (`poolRecommendation`). */
export interface EnginePool {
  engine: ProviderAccount["engine"];
  accounts: ProviderAccount[];
  usable: ProviderAccount[];
  /** More than one usable account: the engine's quota is judged as a pool. */
  pooled: boolean;
  /** Usable accounts with headroom. */
  headroom: ProviderAccount[];
  /** Accounts at or above the near-quota level (the per-row "Near quota"). */
  high: ProviderAccount[];
  /** The usable account with the most headroom, or null. */
  best: ProviderAccount | null;
  /** Near quota as an engine: for a pool only when no usable account has headroom. */
  nearQuota: boolean;
  /** Accounts whose login or verification is broken. */
  attention: ProviderAccount[];
  /** Mean short / weekly window over the usable accounts reporting it, rounded; null when none does. */
  avgShort: number | null;
  avgWeekly: number | null;
  /** Usable accounts with any current reading. */
  reporting: number;
  /** Usable accounts behind each average (its coverage). */
  shortReporting: number;
  weeklyReporting: number;
}

/** One window as the pool scores it: the server's value, else the raw reading. */
function windowValue(account: ProviderAccount, window: "short" | "weekly"): number | null {
  const value = account.pool && window in account.pool ? account.pool[window] : window === "short" ? account.usage.short_used_percent : account.usage.weekly_used_percent;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function average(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? Math.round(present.reduce((sum, value) => sum + value, 0) / present.length) : null;
}

export function enginePools(accounts: readonly ProviderAccount[]): EnginePool[] {
  const engines = [...new Set(accounts.map((account) => account.engine))].sort((a, b) => ENGINE_ORDER.indexOf(a) - ENGINE_ORDER.indexOf(b));
  return engines.map((engine) => {
    const mine = accounts.filter((account) => account.engine === engine);
    const usable = mine.filter(isUsable);
    const headroom = usable.filter(hasHeadroom);
    const high = mine.filter((account) => isNearQuota(account) || (isUsable(account) && !hasHeadroom(account)));
    const pooled = usable.length > 1;
    const best = [...usable].sort((a, b) => (poolScore(a) ?? 0) - (poolScore(b) ?? 0) || a.id - b.id)[0] ?? null;
    return {
      engine, accounts: mine, usable, pooled, headroom, high, best,
      nearQuota: pooled ? headroom.length === 0 : high.length > 0,
      attention: mine.filter(needsAttention),
      avgShort: average(usable.map((account) => windowValue(account, "short"))),
      avgWeekly: average(usable.map((account) => windowValue(account, "weekly"))),
      reporting: usable.filter((account) => poolScore(account) !== null).length,
      shortReporting: usable.filter((account) => windowValue(account, "short") !== null).length,
      weeklyReporting: usable.filter((account) => windowValue(account, "weekly") !== null).length,
    };
  });
}

export type PoolState = { tone: "danger" | "warning" | "success"; label: string };

/** The group header's state: problems first, then the pool rule (never near quota while a usable account has headroom). */
export function poolState(pool: EnginePool): PoolState {
  if (pool.attention.length) return { tone: "danger", label: `${pool.attention.length} ${pool.attention.length === 1 ? "needs" : "need"} attention` };
  if (!pool.usable.length) return { tone: "warning", label: "No usable account" };
  if (pool.nearQuota) return { tone: "warning", label: pool.pooled ? "Pool near quota" : "Near quota" };
  return { tone: "success", label: "OK" };
}

/**
 * The group header's usage line: the least-used account first, then the window averages with
 * their coverage, because an unmeasured account is not zero and one busy account is not the pool.
 */
export function poolUsageText(pool: EnginePool): string {
  if (!pool.usable.length) return "";
  // Grok and Kimi Code report other windows (period, monthly); their rows show them, the pool score does not.
  if (!pool.reporting && pool.usable.some((account) => peakUsage(account) !== null)) return "";
  const parts = [pool.best ? `Least used: ${displayName(pool.best)} (${scoreText(pool.best)})` : "Least used: no reading yet"];
  const of = pool.usable.length;
  const windows = [
    pool.avgShort !== null ? { text: `short ${pool.avgShort}%`, count: pool.shortReporting } : null,
    pool.avgWeekly !== null ? { text: `weekly ${pool.avgWeekly}%`, count: pool.weeklyReporting } : null,
  ].filter((window) => window !== null);
  if (!windows.length) parts.push("no usage reported yet");
  // One coverage note when both averages rest on the same accounts, else one per window.
  else if (windows.every((window) => window.count === windows[0].count)) parts.push(`average ${windows.map((window) => window.text).join(", ")} (${windows[0].count} of ${of} reporting)`);
  else parts.push(`average ${windows.map((window) => `${window.text} (${window.count} of ${of})`).join(", ")}`);
  return parts.join(" · ");
}

/** A table entry: a single-account engine stays one row; an engine with several accounts becomes a group. */
export type AccountEntry =
  | { kind: "account"; account: ProviderAccount }
  | { kind: "group"; pool: EnginePool; rows: ProviderAccount[] };

/**
 * One entry per engine. `problems` (Accounts) leads with what needs attention, then engine order,
 * and sorts group rows the same way (`sortAccounts`); `listed` (Overview) keeps the server order.
 */
export function accountEntries(accounts: readonly ProviderAccount[], order: "problems" | "listed" = "problems"): AccountEntry[] {
  const entries = enginePools(accounts).map((pool): AccountEntry =>
    pool.accounts.length > 1 ? { kind: "group", pool, rows: order === "problems" ? sortAccounts(pool.accounts) : pool.accounts } : { kind: "account", account: pool.accounts[0]! },
  );
  if (order === "listed") {
    const first = (entry: AccountEntry) => accounts.findIndex((account) => account.engine === entryEngine(entry));
    return entries.sort((a, b) => first(a) - first(b));
  }
  return entries.sort((a, b) => entryRank(a) - entryRank(b) || ENGINE_ORDER.indexOf(entryEngine(a)) - ENGINE_ORDER.indexOf(entryEngine(b)));
}

export const entryEngine = (entry: AccountEntry): ProviderAccount["engine"] => (entry.kind === "group" ? entry.pool.engine : entry.account.engine);

/** Problems first, as in `sortAccounts`: attention 0, near quota or paused 1, the rest 2. */
export function entryRank(entry: AccountEntry): number {
  if (entry.kind === "account") return needsAttention(entry.account) ? 0 : entry.account.state === "paused" || isNearQuota(entry.account) ? 1 : 2;
  return entry.pool.attention.length ? 0 : entry.pool.nearQuota || !entry.pool.usable.length ? 1 : 2;
}

export const entryKey = (entry: AccountEntry): string => (entry.kind === "group" ? `engine:${entry.pool.engine}` : `account:${entry.account.id}`);

/** Expanded groups as stored in the `open` URL parameter: a comma-separated engine list. */
export function parseOpen(value: string | null | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((part) => part.trim()).filter(Boolean));
}

export function toggleOpen(value: string | null | undefined, engine: string): string {
  const open = parseOpen(value);
  if (open.has(engine)) open.delete(engine);
  else open.add(engine);
  return [...open].sort((a, b) => ENGINE_ORDER.indexOf(a) - ENGINE_ORDER.indexOf(b)).join(",");
}

/** The server's untouched default label ("Claude", "Claude account", "Claude 1"), which reads like the provider. */
export const isDefaultLabel = (label: string): boolean => /^(Claude|ChatGPT|Grok|Kimi Code)( account| \d+)?$/.test(label.trim());

/**
 * The name shown for an account. A default label would read like the provider itself, so it
 * shows the login e-mail when known, else "Claude account #1". Rename and search keep the stored label.
 */
export function displayName(account: Pick<ProviderAccount, "id" | "label" | "email">): string {
  if (!isDefaultLabel(account.label)) return account.label;
  return account.email || `${account.label.trim().replace(/( account| \d+)$/, "")} account #${account.id}`;
}

/**
 * Accounts counted in "near quota" totals. A high account of an engine whose pool still has
 * headroom is not counted: work continues on the other accounts. Single-account engines keep
 * the per-account rule.
 */
export function nearQuotaCounted(accounts: readonly ProviderAccount[]): ProviderAccount[] {
  return enginePools(accounts).flatMap((pool) => (pool.nearQuota ? pool.high : []));
}

/** Ids of accounts whose engine pool has headroom elsewhere, for the per-row status detail. */
export function poolCoveredIds(accounts: readonly ProviderAccount[]): Set<number> {
  return new Set(enginePools(accounts).flatMap((pool) => (pool.pooled && !pool.nearQuota ? pool.high.map((account) => account.id) : [])));
}

export const loginNeedsRenewal = (account: ProviderAccount): boolean => account.refresh_state === "login_required";

export function needsAttention(account: ProviderAccount): boolean {
  return account.verification_state === "failed" || loginNeedsRenewal(account);
}

/** `poolCovered`: the account is high, but another usable account of its engine has headroom. */
export function accountStatus(account: ProviderAccount, engineOn: boolean, loginCommand: string, poolCovered = false): AccountStatus {
  if (account.state === "removing") return { tone: "muted", label: "Removing", detail: "Waiting for active sessions to finish." };
  if (loginNeedsRenewal(account)) {
    return { tone: "danger", label: "Login needs renewal", detail: `Run ${loginCommand} login, then replace the full login credentials.` };
  }
  if (account.verification_state === "failed") {
    return { tone: "danger", label: "Verification failed", detail: account.verification_reason ?? undefined };
  }
  if (account.state === "paused") return { tone: "warning", label: "Paused", detail: "Not used for new sessions." };
  if (!engineOn) return { tone: "warning", label: "Engine off", detail: "Disabled fleet-wide; the account is kept but not used." };
  if (isNearQuota(account)) return { tone: "warning", label: "Near quota", detail: poolCovered ? "Other accounts have headroom" : account.verification_reason ?? undefined };
  if (account.refresh_state && account.refresh_state !== "idle") {
    return { tone: "ok", label: "Active", detail: `Credential refresh: ${account.refresh_state.replaceAll("_", " ")}` };
  }
  if (account.verification_state !== "verified") {
    return { tone: "warning", label: "Not verified yet", detail: account.verification_reason ?? undefined };
  }
  return { tone: "ok", label: "Active" };
}

const ENGINE_ORDER = ["codex", "claude", "grok", "kimi"];

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
