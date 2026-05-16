/**
 * Hosts summary store — broadcasts derived counts (currently the number of
 * currently-active insecure host windows) so the global TopBar can render an
 * "active windows" badge without having to mount the /hosts data layer.
 *
 * The hosts list page updates this whenever its query data changes; the
 * insecure-summary dialog also keeps it in sync. The store value is the
 * single source of truth used elsewhere in the app.
 */
import { writable } from "svelte/store";

export interface HostsSummaryState {
  /** Hosts whose insecure window is currently open (insecure_enabled_until > now). */
  activeInsecureWindows: number;
  /** Active insecure-domain allow entries (countable for the same badge). */
  activeInsecureDomains: number;
  /** Pending /admin/insecure-approvals/pending requests. */
  pendingApprovals: number;
}

const initial: HostsSummaryState = {
  activeInsecureWindows: 0,
  activeInsecureDomains: 0,
  pendingApprovals: 0,
};

function createHostsSummaryStore() {
  const { subscribe, update, set } = writable<HostsSummaryState>(initial);
  return {
    subscribe,
    setActiveInsecureWindows(n: number): void {
      update((s) => ({ ...s, activeInsecureWindows: Math.max(0, n | 0) }));
    },
    setActiveInsecureDomains(n: number): void {
      update((s) => ({ ...s, activeInsecureDomains: Math.max(0, n | 0) }));
    },
    setPendingApprovals(n: number): void {
      update((s) => ({ ...s, pendingApprovals: Math.max(0, n | 0) }));
    },
    set,
    reset(): void {
      set(initial);
    },
  };
}

export const hostsSummary = createHostsSummaryStore();
