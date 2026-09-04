/**
 * Hosts summary store — broadcasts the number of currently-active insecure
 * host windows so the global TopBar can render an "active windows" badge
 * without having to mount the /hosts data layer.
 *
 * The hosts list page (`routes/hosts/+page.svelte`) is the only writer of
 * `activeInsecureWindows`; it updates the count whenever its query data
 * changes, so the count is only live while that page is mounted.
 *
 * `fleetWindowUntil` has a different writer for that exact reason:
 * `InsecureApprovalsAutoPopup.svelte` is mounted in the root layout and already
 * polls, so the fleet window reaches the TopBar from every route. A fleet-wide
 * auto-allow is the one piece of this state an operator should not have to be
 * on the hosts page to notice. `TopBar.svelte` is the only reader of either.
 */
import { writable } from "svelte/store";

export interface HostsSummaryState {
  /** Hosts whose insecure window is currently open (insecure_enabled_until > now). */
  activeInsecureWindows: number;
  /** Deadline of the fleet-wide insecure window, or null when it is closed. */
  fleetWindowUntil: string | null;
}

const initial: HostsSummaryState = {
  activeInsecureWindows: 0,
  fleetWindowUntil: null,
};

function createHostsSummaryStore() {
  const { subscribe, update } = writable<HostsSummaryState>(initial);
  return {
    subscribe,
    setActiveInsecureWindows(n: number): void {
      update((s) => ({ ...s, activeInsecureWindows: Math.max(0, n | 0) }));
    },
    setFleetWindowUntil(until: string | null): void {
      update((s) => ({ ...s, fleetWindowUntil: until }));
    },
  };
}

export const hostsSummary = createHostsSummaryStore();
