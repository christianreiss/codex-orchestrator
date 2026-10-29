/**
 * Client allowlist for Chatty action buttons.
 *
 * The API verifies every action and signs a short-lived proposal for this admin
 * session; this file is the console's own, independent registry. It decides the
 * risk (a payload cannot downgrade a mutation to "safe"), builds navigation paths
 * only from enumerated values, and accepts a request plan only when its shape fits
 * the existing admin endpoint for that action. Anything else renders no button.
 */

export const ENGINES = ["codex", "claude", "grok"] as const;
export type ActionEngine = (typeof ENGINES)[number];
export type ActionRisk = "safe" | "confirm" | "danger";

/** Fixed risk per action; must match api/src/services/chatty/actions.ts. */
export const ACTION_RISK = {
  "hosts.filter": "safe",
  "activity.host": "safe",
  "host.engine.enable": "confirm",
  "host.engine.disable": "danger",
  "host.auto_update": "confirm",
  "host.insecure.close": "confirm",
  "account.verify": "confirm",
  "versions.check": "confirm",
} as const satisfies Record<string, ActionRisk>;
export type ActionId = keyof typeof ACTION_RISK;

const HOST_STATUS = ["online", "offline", "attention"];
const HOST_FLAG = ["vip", "roaming", "secure", "insecure", "unprovisioned"];
const ACTIVITY_WINDOW = ["1h", "24h", "7d"];

export interface ChattyActionElement {
  type: "action";
  action: ActionId;
  risk: ActionRisk;
  label: string;
  params: Record<string, string | number | boolean>;
  proposal: string;
  expires_at: string;
}

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isEngine = (v: unknown): v is ActionEngine => typeof v === "string" && (ENGINES as readonly string[]).includes(v);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A renderable action element, or null for anything unknown, inconsistent or tampered. */
export function chattyAction(value: unknown): ChattyActionElement | null {
  if (!isRecord(value) || value.type !== "action") return null;
  const action = value.action;
  if (typeof action !== "string" || !Object.hasOwn(ACTION_RISK, action)) return null;
  const risk = ACTION_RISK[action as ActionId];
  if (value.risk !== risk) return null;
  if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 120) return null;
  if (typeof value.proposal !== "string" || !/^v1\.[A-Za-z0-9_.-]{1,1600}$/.test(value.proposal)) return null;
  if (typeof value.expires_at !== "string" || Number.isNaN(Date.parse(value.expires_at))) return null;
  if (!isRecord(value.params)) return null;
  return value as unknown as ChattyActionElement;
}

export function isExpired(element: Pick<ChattyActionElement, "expires_at">, now = Date.now()) {
  return Date.parse(element.expires_at) <= now;
}

/** Base-relative destination of a safe navigation action (`paths.base` is added by the caller). */
export function actionPath(element: Pick<ChattyActionElement, "action" | "params">): string | null {
  const p = element.params;
  if (element.action === "hosts.filter") {
    const query = new URLSearchParams();
    if (p.status !== undefined) {
      if (typeof p.status !== "string" || !HOST_STATUS.includes(p.status)) return null;
      query.set("status", p.status);
    }
    if (p.flag !== undefined) {
      if (typeof p.flag !== "string" || !HOST_FLAG.includes(p.flag)) return null;
      query.set("flag", p.flag);
    }
    const search = query.toString();
    return search ? `/hosts?${search}` : null;
  }
  if (element.action === "activity.host") {
    if (!isId(p.host)) return null;
    const query = new URLSearchParams({ host: String(p.host) });
    if (p.window !== undefined) {
      if (typeof p.window !== "string" || !ACTIVITY_WINDOW.includes(p.window)) return null;
      query.set("window", p.window);
    }
    return `/activity?${query}`;
  }
  return null;
}

/** The single existing-endpoint call a confirmed action may make. */
export type ActionRequest =
  | { kind: "host-engines"; hostId: number; engines: ActionEngine[] }
  | { kind: "host-auto-update"; hostId: number; enabled: boolean }
  | { kind: "host-insecure-close"; hostId: number }
  | { kind: "account-verify"; accountId: number }
  | { kind: "versions-check" };

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Maps a server-verified plan to an endpoint request, or null when the plan does
 * not have exactly the shape the action allows (for engines: the list after must
 * be the list before plus, or minus, the named engine and never empty).
 */
export function actionRequest(action: ActionId, plan: unknown): ActionRequest | null {
  if (!isRecord(plan)) return null;
  switch (action) {
    case "host.engine.enable":
    case "host.engine.disable": {
      const { host_id, engine, engines_before: before, engines_after: after } = plan;
      if (!isId(host_id) || !isEngine(engine) || !Array.isArray(before) || !Array.isArray(after)) return null;
      if (!before.every(isEngine) || !after.every(isEngine) || new Set(after).size !== after.length || !after.length) return null;
      const expected = action === "host.engine.enable"
        ? !before.includes(engine) && sameSet(after, [...before, engine])
        : before.includes(engine) && sameSet(after, before.filter((e) => e !== engine));
      return expected ? { kind: "host-engines", hostId: host_id, engines: after as ActionEngine[] } : null;
    }
    case "host.auto_update":
      return isId(plan.host_id) && typeof plan.enabled === "boolean"
        ? { kind: "host-auto-update", hostId: plan.host_id, enabled: plan.enabled }
        : null;
    case "host.insecure.close":
      return isId(plan.host_id) ? { kind: "host-insecure-close", hostId: plan.host_id } : null;
    case "account.verify":
      return isId(plan.account_id) ? { kind: "account-verify", accountId: plan.account_id } : null;
    case "versions.check":
      return Object.keys(plan).length === 0 ? { kind: "versions-check" } : null;
    default:
      return null;
  }
}

/** Stable comparison of two verified plans: a change between dialog and click needs a new confirmation. */
export function samePlan(a: unknown, b: unknown) {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
