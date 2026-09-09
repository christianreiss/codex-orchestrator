/**
 * Short-lived record of insecure approval requests that have just been resolved.
 *
 * The pending list is a server query: the moment a request is approved or
 * denied it stops coming back from `/admin/insecure-approvals/pending`, and the
 * row it was rendering vanishes with no indication of *which* way it went. That
 * is fine for a list nobody is watching and wrong for a modal an operator is
 * looking at while they click.
 *
 * So a resolution is remembered here for `GHOST_MS`, outside TanStack Query,
 * because it has to outlive the server row it describes. The dialog merges these
 * over the live rows, greys the resolved ones out with their outcome, and drops
 * them when the entry expires. Two things feed it: the operator's own clicks
 * (marked optimistically, before the mutation resolves) and the WS events that
 * carry a `request_id` — which is what makes a peer's approval, a domain sweep
 * or the fleet window animate here exactly like a local click.
 *
 * This is presentation only. The pending query stays the source of truth; a
 * ghost that was never really resolved simply re-appears on the next refetch.
 */
import { writable, derived, type Readable } from "svelte/store";

export type ResolutionOutcome = "approved" | "denied" | "timeout" | "domain" | "auto";

export interface Resolution {
  outcome: ResolutionOutcome;
  at: number;
}

/** How long a resolved row lingers as a shadow before it is dropped. */
export const GHOST_MS = 1600;

const store = writable<Map<number, Resolution>>(new Map());

const timers = new Map<number, ReturnType<typeof setTimeout>>();

function isId(id: unknown): id is number {
  return typeof id === "number" && Number.isFinite(id);
}

/**
 * Record a resolution. First outcome wins: a local click and the WS echo of
 * that same click both arrive, and the operator should see what they pressed,
 * not whichever message lost the race.
 */
export function markResolved(id: unknown, outcome: ResolutionOutcome): void {
  if (!isId(id)) return;
  let added = false;
  store.update((m) => {
    if (m.has(id)) return m;
    const next = new Map(m);
    next.set(id, { outcome, at: Date.now() });
    added = true;
    return next;
  });
  if (!added) return;
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      store.update((m) => {
        if (!m.has(id)) return m;
        const next = new Map(m);
        next.delete(id);
        return next;
      });
    }, GHOST_MS),
  );
}

export function markResolvedMany(ids: unknown, outcome: ResolutionOutcome): void {
  if (!Array.isArray(ids)) return;
  for (const id of ids) markResolved(id, outcome);
}

/** Undo an optimistic mark whose mutation turned out to fail. */
export function clearResolved(id: unknown): void {
  if (!isId(id)) return;
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
  store.update((m) => {
    if (!m.has(id)) return m;
    const next = new Map(m);
    next.delete(id);
    return next;
  });
}

export const resolutions: Readable<Map<number, Resolution>> = { subscribe: store.subscribe };

/** How many shadows are still on screen — the auto-close waits for zero. */
export const ghostCount: Readable<number> = derived(store, (m) => m.size);

export const OUTCOME_LABELS: Record<ResolutionOutcome, string> = {
  approved: "Approved",
  denied: "Denied",
  timeout: "Timed out",
  domain: "Domain allowed",
  auto: "Auto-allowed",
};
