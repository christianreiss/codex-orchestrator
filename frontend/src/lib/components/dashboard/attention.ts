/**
 * The Overview's "Needs attention" list, derived from data the page already
 * fetches (hosts, pending approvals, provider accounts, runner, engine
 * switches, upstream release checks). Pure and framework-free so the ordering
 * and wording are unit-tested; every item names where it is fixed.
 */
import type { ProviderAccount } from "../../api/accounts";
import type { RunnerStatus } from "../../api/runner";

export type AttentionTone = "danger" | "warning" | "info";

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  detail?: string;
  /** Base-relative route, with query or hash, where this is fixed. */
  href: string;
  action: string;
}

/** Host findings already boiled down by the page (see hostAttention.ts). */
export interface HostFindings {
  /** Hosts with no, partial, or older-than-fleet credentials. */
  authProblems: string[];
  /** Hosts whose CLI or host agent is not at the target version. */
  versionProblems: string[];
}

export interface AttentionInput {
  hosts?: HostFindings | null;
  /** Hosts waiting for a temporary-access decision; null when the check itself failed. */
  pendingApprovals?: number | null;
  accounts?: ProviderAccount[] | null;
  runner?: RunnerStatus | null;
  /** Display labels of engines switched off fleet-wide. */
  disabledEngines?: string[];
  /** True when every engine is off. */
  allEnginesDisabled?: boolean;
  /** Display labels of engines whose upstream release check has gone stale. */
  staleReleaseChecks?: string[];
  /** Percent of a quota window at which an account counts as near its limit. */
  quotaWarnAt?: number;
}

const ENGINE_LABEL = { codex: "Codex", claude: "Claude", grok: "Grok" } as const;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function names(list: string[], max = 3): string {
  if (list.length <= max) return list.join(", ");
  return `${list.slice(0, max).join(", ")} and ${list.length - max} more`;
}

/** Highest quota reading for an account, or null when the provider reported none. */
export function peakUsage(account: Pick<ProviderAccount, "usage">): number | null {
  const { usage } = account;
  const readings = [usage.short_used_percent, usage.weekly_used_percent, usage.current_window?.used_percent].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return readings.length ? Math.max(...readings) : null;
}

function accountItems(accounts: ProviderAccount[], warnAt: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const account of accounts) {
    if (account.state !== "enabled") continue;
    const who = `${ENGINE_LABEL[account.engine] ?? account.engine} account ${account.label}`;
    if (account.refresh_state === "login_required") {
      items.push({ id: `account-${account.id}-login`, tone: "danger", title: `${who} needs a new login`, detail: "The subscription login expired and cannot be renewed automatically.", href: "/accounts", action: "Renew login" });
    } else if (account.verification_state === "failed") {
      items.push({ id: `account-${account.id}-verify`, tone: "danger", title: `${who} failed verification`, detail: account.verification_reason ?? undefined, href: "/accounts", action: "Review account" });
    }
    if (account.usage.supported === false) continue;
    const peak = peakUsage(account);
    if (peak !== null && peak >= warnAt) {
      items.push({
        id: `account-${account.id}-quota`,
        tone: peak >= 100 ? "danger" : "warning",
        title: peak >= 100 ? `${who} has used its quota` : `${who} is at ${Math.round(peak)}% of its quota`,
        href: "/accounts",
        action: "Open accounts",
      });
    }
  }
  return items;
}

function runnerItems(runner: RunnerStatus): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (!runner.configured) {
    items.push({ id: "runner-unconfigured", tone: "danger", title: "The verification runner is not configured", detail: "New credentials cannot be checked until it is.", href: "/dashboard#runner", action: "See runner" });
  } else if (!runner.ready) {
    items.push({ id: "runner-down", tone: "danger", title: "The verification runner is not ready", detail: runner.detail || undefined, href: "/dashboard#runner", action: "See runner" });
  }
  for (const engine of ["codex", "claude", "grok"] as const) {
    const status = runner.engines?.[engine];
    if (!status) continue;
    if (runner.configured && (status.state ?? "").toLowerCase() === "fail") {
      items.push({ id: `runner-${engine}-fail`, tone: "danger", title: `${ENGINE_LABEL[engine]} verification is failing`, detail: status.last_error ?? undefined, href: "/dashboard#runner", action: "See runner" });
    }
    // Login expiry is persisted telemetry, so it stays true while the runner itself is down.
    const expiry = status.login_expiry;
    if (expiry?.state === "expired") {
      items.push({ id: `runner-${engine}-expired`, tone: "danger", title: `${ENGINE_LABEL[engine]} login expired`, href: "/accounts", action: "Renew login" });
    } else if (expiry?.state === "expiring") {
      const days = expiry.days_remaining;
      items.push({ id: `runner-${engine}-expiring`, tone: "warning", title: `${ENGINE_LABEL[engine]} login expires ${days === null ? "soon" : `in ${plural(days, "day")}`}`, href: "/accounts", action: "Renew login" });
    }
  }
  return items;
}

const ORDER: Record<AttentionTone, number> = { danger: 0, warning: 1, info: 2 };

/** Most urgent first; ties keep the order they were found in. */
export function buildAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (input.allEnginesDisabled) {
    items.push({ id: "engines-all-off", tone: "danger", title: "Every engine is switched off fleet-wide", detail: "Hosts refuse to launch and the server has stopped polling accounts.", href: "/engines", action: "Open engines" });
  } else if (input.disabledEngines?.length) {
    items.push({ id: "engines-off", tone: "warning", title: `${names(input.disabledEngines)} ${input.disabledEngines.length === 1 ? "is" : "are"} switched off fleet-wide`, detail: "Hosts will not run it and the server has stopped polling its accounts.", href: "/engines", action: "Open engines" });
  }

  if (input.pendingApprovals === null) {
    items.push({ id: "approvals-check", tone: "warning", title: "Temporary-access requests could not be checked", detail: "Hosts waiting for approval may not be shown.", href: "/hosts?insecure=1", action: "Open hosts" });
  } else if (input.pendingApprovals) {
    items.push({ id: "approvals", tone: "warning", title: `${plural(input.pendingApprovals, "host")} waiting for temporary access`, detail: "A host asked to connect without its usual checks.", href: "/hosts?insecure=1", action: "Review requests" });
  }

  const hosts = input.hosts;
  if (hosts?.authProblems.length) {
    items.push({ id: "hosts-auth", tone: "danger", title: `${plural(hosts.authProblems.length, "host")} with missing or outdated credentials`, detail: names(hosts.authProblems), href: "/hosts", action: "Open hosts" });
  }
  if (hosts?.versionProblems.length) {
    items.push({ id: "hosts-versions", tone: "warning", title: `${plural(hosts.versionProblems.length, "host")} behind on versions`, detail: names(hosts.versionProblems), href: "/hosts", action: "Open hosts" });
  }

  if (input.accounts) items.push(...accountItems(input.accounts, input.quotaWarnAt ?? 90));
  if (input.runner) items.push(...runnerItems(input.runner));

  if (input.staleReleaseChecks?.length) {
    items.push({ id: "release-checks", tone: "info", title: `Latest-version lookup is stale for ${names(input.staleReleaseChecks)}`, detail: "Hosts are being handed an old target version.", href: "/dashboard#engines", action: "See versions" });
  }

  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => ORDER[a.item.tone] - ORDER[b.item.tone] || a.index - b.index)
    .map(({ item }) => item);
}
