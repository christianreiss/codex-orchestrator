<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { browser } from "$app/environment";
  import type { Readable } from "svelte/store";
  import type { WsEvent } from "$lib/ws/client";
  import { insecureApprovalsQuery } from "$lib/api/insecure";
  import InsecureApprovalsDialog from "./InsecureApprovalsDialog.svelte";

  /**
   * Global owner of the InsecureApprovalsDialog state.
   *
   * Auto-opens the modal when a new `insecure.requested` WS event arrives,
   * when there are already pending requests on first load, or when any
   * component dispatches `codex:open-insecure-approvals` on window. Also
   * plays a short beep and (if the tab is in the background and the user
   * has granted permission) fires a desktop Notification.
   */

  type Props = {
    events: Readable<WsEvent | null>;
  };
  let { events }: Props = $props();

  let open = $state(false);
  let openedByPush = $state(false);
  let initialAutoOpened = false;

  const approvals = insecureApprovalsQuery();
  const pendingCount = $derived($approvals.data?.requests?.length ?? 0);

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

  // Auto-open once per session if pending exist when we land in the app.
  $effect(() => {
    if (initialAutoOpened) return;
    if ($approvals.isLoading) return;
    initialAutoOpened = true;
    if (pendingCount > 0) {
      open = true;
      openedByPush = true;
    }
  });

  // Auto-close the modal when there's nothing pending left AND it was
  // opened by a push (so we don't close it under a user who opened it
  // manually via the /hosts button to view Active Windows / Allowed Domains).
  $effect(() => {
    if (!open) return;
    if (!openedByPush) return;
    if ($approvals.isLoading) return;
    if (pendingCount === 0) {
      open = false;
      openedByPush = false;
    }
  });

  function onDialogOpenChange(value: boolean): void {
    open = value;
    if (!value) openedByPush = false;
  }

  let unsubEvents: (() => void) | null = null;
  let manualOpenListener: ((e: Event) => void) | null = null;

  onMount(() => {
    if (!browser) return;

    unsubEvents = events.subscribe((evt) => {
      if (!evt || evt.type !== "insecure.requested") return;
      const payload = (evt as { payload?: { fqdn?: string } }).payload ?? {};
      playBeep();
      maybeNotify(payload.fqdn);
      open = true;
      openedByPush = true;
    });

    manualOpenListener = () => {
      open = true;
      openedByPush = false;
    };
    window.addEventListener("codex:open-insecure-approvals", manualOpenListener);
  });

  onDestroy(() => {
    unsubEvents?.();
    if (browser && manualOpenListener) {
      window.removeEventListener("codex:open-insecure-approvals", manualOpenListener);
    }
  });
</script>

<InsecureApprovalsDialog bind:open onOpenChange={onDialogOpenChange} />
