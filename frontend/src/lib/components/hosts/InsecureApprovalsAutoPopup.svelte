<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { browser } from "$app/environment";
  import type { Readable } from "svelte/store";
  import type { WsEvent } from "$lib/ws/client";
  import { insecureApprovalsQuery, insecureSummaryQuery } from "$lib/api/insecure";
  import { hostsSummary } from "$lib/stores/hosts-summary";
  import { ghostCount, resolutions } from "$lib/stores/insecure-resolutions";
  import InsecureApprovalsDialog, {
    type InsecureDialogMode,
  } from "./InsecureApprovalsDialog.svelte";
  import type { InsecureApprovalRequest } from "$lib/api/types";

  /**
   * Global owner of the InsecureApprovalsDialog state.
   *
   * Auto-opens the modal (in `triage` mode) when a pending request appears
   * — on a WS push, a poll, or already on first load — and in
   * `manage` mode when any component dispatches
   * `codex:open-insecure-approvals` on window. Also
   * plays a short beep and (if the tab is in the background and the user
   * has granted permission) fires a desktop Notification.
   */

  type Props = {
    events: Readable<WsEvent | null>;
  };
  let { events }: Props = $props();

  let open = $state(false);
  let mode = $state<InsecureDialogMode>("triage");
  let hadPendingRequests = $state(false);
  // Compare identities, so replacing one request with another also opens the box.
  let lastSettledIds: Set<number> | null = null;

  const approvals = insecureApprovalsQuery();

  let now = $state(Date.now());

  function isPending(r: InsecureApprovalRequest, at: number): boolean {
    if (r.status !== "pending") return false;
    const exp = r.expires_at ? Date.parse(r.expires_at) : NaN;
    return !Number.isFinite(exp) || exp > at;
  }
  const pending = $derived(($approvals.data?.requests ?? []).filter((r) => isPending(r, now)));
  const pendingCount = $derived(pending.length);
  // A request only becomes actionable once the host is waiting. Resolved rows
  // can still be present in a cached read while the server refetch is in flight.
  const waiting = $derived(pending.filter((r) => r.live !== false && !$resolutions.has(r.id)));

  // This component is mounted in the root layout, which makes it the only place
  // that can keep the TopBar honest about a fleet-wide auto-allow from every
  // route -- the hosts page, the store's other writer, is usually not mounted.
  const summary = insecureSummaryQuery();
  $effect(() => {
    const fleet = $summary.data?.fleet_window;
    hostsSummary.setFleetWindowUntil(fleet?.open ? (fleet.until ?? null) : null);
  });

  // Short cooldown so a backlog replay or burst of requests doesn't spam audio.
  let lastSoundAt = 0;
  const SOUND_COOLDOWN_MS = 2_000;

  function playBeep(): void {
    if (!browser) return;
    const now = Date.now();
    if (now - lastSoundAt < SOUND_COOLDOWN_MS) return;
    lastSoundAt = now;
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      const t0 = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.24);
      osc.onended = () => {
        try {
          void ctx.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* Audio is best-effort: pre-gesture autoplay rejection, no AudioContext, etc. */
    }
  }

  function maybeNotify(fqdn: string | undefined): void {
    if (!browser) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (!document.hidden) return;
    try {
      const n = new Notification("Insecure access requested", {
        body: fqdn ? `Pending approval for ${fqdn}` : "A host is requesting insecure access.",
        tag: "insecure-request",
      });
      n.onclick = () => {
        try {
          window.focus();
        } catch {
          /* ignore */
        }
        n.close();
      };
    } catch {
      /* ignore */
    }
  }

  // WS invalidation and polling both drive the same identity comparison.
  // Ignore failed/in-flight reads: only a settled queue can open or close it.
  $effect(() => {
    if (!$approvals.isSuccess || $approvals.isFetching) return;
    const prev = lastSettledIds;
    const incoming = waiting.filter((r) => !prev?.has(r.id));
    lastSettledIds = new Set(waiting.map((r) => r.id));
    if (incoming.length === 0) return;
    if (prev !== null) {
      playBeep();
      maybeNotify(incoming[incoming.length - 1]?.fqdn);
    }
    untrack(() => {
      if (!open) mode = "triage";
      hadPendingRequests = true;
      open = true;
    });
  });

  // A manually opened management panel with no requests stays available.
  // Once a queue has been shown, close after it drains in either dialog mode.
  $effect(() => {
    if (open && pendingCount > 0) hadPendingRequests = true;
  });
  $effect(() => {
    if (!open || (mode === "manage" && !hadPendingRequests)) return;
    if (!$approvals.isSuccess || $approvals.isFetching) return;
    // Let the final approval/denial feedback finish before closing.
    if (pendingCount === 0 && $ghostCount === 0) {
      open = false;
      hadPendingRequests = false;
    }
  });

  function onDialogOpenChange(value: boolean): void {
    open = value;
    if (!value) hadPendingRequests = false;
  }

  let unsubEvents: (() => void) | null = null;
  let manualOpenListener: ((e: Event) => void) | null = null;

  onMount(() => {
    if (!browser) return;
    const clock = setInterval(() => (now = Date.now()), 1000);

    // The live `insecure.requested` push only needs to *wake the query*: the
    // global WS→query wiring already invalidates ["insecure-approvals"], but we
    // also nudge an explicit refetch so the identity comparison runs with
    // the smallest possible latency. The actual open/beep/notify is owned by
    // that effect, so the WS-on and WS-off paths behave identically.
    unsubEvents = events.subscribe((evt) => {
      if (!evt || evt.type !== "insecure.requested") return;
      void $approvals.refetch?.();
    });

    manualOpenListener = () => {
      mode = "manage";
      open = true;
      hadPendingRequests = false;
    };
    window.addEventListener("codex:open-insecure-approvals", manualOpenListener);
    return () => clearInterval(clock);
  });

  onDestroy(() => {
    unsubEvents?.();
    if (browser && manualOpenListener) {
      window.removeEventListener("codex:open-insecure-approvals", manualOpenListener);
    }
  });
</script>

<InsecureApprovalsDialog bind:open bind:mode onOpenChange={onDialogOpenChange} {events} />
