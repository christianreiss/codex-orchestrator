/**
 * The Overview's "Needs you" list: at most one row per kind of thing waiting
 * on the operator, each with a count and a link to the page that owns it.
 * Every count comes from a query that page already reads and is computed
 * with that page's own rule, so the two never disagree.
 *
 * Version drift and stale credentials are deliberately left out: they are
 * maintenance, not something waiting on a person.
 *
 * Pure and import-free at runtime so `node --test` can load it.
 */

export type NeedsYouId = "approvals" | "agents" | "access" | "runner" | "accounts" | "feedback";

/**
 * One signal as the page can read it. `hidden`: this operator may not read
 * it, or the feature is off, so it is neither counted nor reported missing.
 */
export type Source<T> =
  | { status: "hidden" }
  | { status: "pending" }
  | { status: "error" }
  | { status: "ok"; value: T };

export interface NeedsYouInput {
  /** Hosts waiting for a temporary access approval. */
  approvals: Source<number>;
  /** Agents in the Chats list waiting on the operator's answer. */
  agents: Source<number>;
  /** Open per-host temporary access windows, and the fleet-wide window's deadline. */
  access: Source<{ windows: number; fleetUntil: string | null }>;
  /** Switched-on engines whose login verification is failing. */
  runner: Source<number>;
  /**
   * Accounts of switched-on engines: needing attention, near quota, and either. Near quota is
   * pool-aware (`nearQuotaCounted`): an engine with several usable accounts counts only when none
   * of them has headroom.
   */
  accounts: Source<{ attention: number; nearQuota: number; either: number }>;
  /** Open feedback reports nobody has claimed. */
  feedback: Source<number>;
}

export type NeedsYouTone = "danger" | "warning" | "info";

export interface NeedsYouRow {
  id: NeedsYouId;
  count: number;
  /** The row's sentence, also the link's accessible name. */
  text: string;
  /** Secondary detail, e.g. the split behind a combined count. */
  detail?: string;
  /** Route inside the console, without the base path. */
  href: string;
  tone: NeedsYouTone;
}

export interface NeedsYouState {
  rows: NeedsYouRow[];
  /** Signals that could not be read: named, never shown as zero. */
  failed: { id: NeedsYouId; label: string }[];
  /** Some signal has not answered yet. */
  pending: boolean;
  /** Every readable signal answered and none needs the operator. */
  calm: boolean;
}

export const NEEDS_YOU_LIMIT = 6;

/** Rows appear in this order: what expires or blocks someone first. */
const ORDER: readonly NeedsYouId[] = ["approvals", "agents", "access", "runner", "accounts", "feedback"];

const SOURCE_LABEL: Record<NeedsYouId, string> = {
  approvals: "access requests",
  agents: "waiting agents",
  access: "temporary access",
  runner: "verification runner",
  accounts: "accounts",
  feedback: "feedback",
};

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function row(id: NeedsYouId, input: NeedsYouInput): NeedsYouRow | null {
  switch (id) {
    case "approvals": {
      const source = input.approvals;
      if (source.status !== "ok" || source.value <= 0) return null;
      const n = source.value;
      return { id, count: n, tone: "warning", href: "/hosts?insecure=1", text: `${n} ${plural(n, "host is", "hosts are")} waiting for temporary access approval` };
    }
    case "agents": {
      const source = input.agents;
      if (source.status !== "ok" || source.value <= 0) return null;
      const n = source.value;
      return { id, count: n, tone: "warning", href: "/agents", text: `${n} ${plural(n, "agent is", "agents are")} waiting for your answer` };
    }
    case "access": {
      const source = input.access;
      if (source.status !== "ok") return null;
      const { windows, fleetUntil } = source.value;
      if (fleetUntil) {
        return {
          id, count: windows + 1, tone: "danger", href: "/hosts?insecure=1",
          text: windows > 0
            ? `Fleet-wide temporary access is open, plus ${windows} host ${plural(windows, "window", "windows")}`
            : "Fleet-wide temporary access is open",
        };
      }
      if (windows <= 0) return null;
      return { id, count: windows, tone: "warning", href: "/hosts?insecure=1", text: `${windows} temporary access ${plural(windows, "window is", "windows are")} open` };
    }
    case "runner": {
      const source = input.runner;
      if (source.status !== "ok" || source.value <= 0) return null;
      const n = source.value;
      return { id, count: n, tone: "danger", href: "/dashboard?tab=runner", text: `${n} ${plural(n, "engine fails", "engines fail")} login verification` };
    }
    case "accounts": {
      const source = input.accounts;
      if (source.status !== "ok" || source.value.either <= 0) return null;
      const { attention, nearQuota, either } = source.value;
      const parts = [attention > 0 && `${attention} ${plural(attention, "needs", "need")} attention`, nearQuota > 0 && `${nearQuota} near quota`].filter(Boolean);
      return {
        id, count: either, tone: attention > 0 ? "danger" : "warning", href: "/accounts",
        text: `${either} ${plural(either, "account needs", "accounts need")} attention or ${plural(either, "is", "are")} near quota`,
        detail: parts.join(" · "),
      };
    }
    case "feedback": {
      const source = input.feedback;
      if (source.status !== "ok" || source.value <= 0) return null;
      const n = source.value;
      return { id, count: n, tone: "info", href: "/reports", text: `${n} unclaimed feedback ${plural(n, "report", "reports")}` };
    }
  }
}

export function needsYou(input: NeedsYouInput): NeedsYouState {
  const rows = ORDER.map((id) => row(id, input)).filter((entry): entry is NeedsYouRow => entry !== null).slice(0, NEEDS_YOU_LIMIT);
  const failed = ORDER.filter((id) => input[id].status === "error").map((id) => ({ id, label: SOURCE_LABEL[id] }));
  const pending = ORDER.some((id) => input[id].status === "pending");
  return { rows, failed, pending, calm: rows.length === 0 && failed.length === 0 && !pending };
}
