/**
 * Hosts summary store — broadcasts the number of currently-active insecure
 * host windows so the global TopBar can render an "active windows" badge
 * without having to mount the /hosts data layer.
 *
 * The hosts list page (`routes/hosts/+page.svelte`) is the only writer; it
 * updates the count whenever its query data changes. `TopBar.svelte` is the
 * only reader outside that page.
 */
import { writable } from "svelte/store";

export interface HostsSummaryState {
  /** Hosts whose insecure window is currently open (insecure_enabled_until > now). */
  activeInsecureWindows: number;
}

const initial: HostsSummaryState = {
  activeInsecureWindows: 0,
};

function createHostsSummaryStore() {
  const { subscribe, update } = writable<HostsSummaryState>(initial);
  return {
    subscribe,
    setActiveInsecureWindows(n: number): void {
      update((s) => ({ ...s, activeInsecureWindows: Math.max(0, n | 0) }));
    },
  };
}

export const hostsSummary = createHostsSummaryStore();
