<script lang="ts">
  /**
   * The fleet-wide insecure window — "let every insecure host through until
   * this evening", with a deadline and an off.
   *
   * The presets are hours rather than the 0–480-minute slider the per-host
   * popover uses: this switch is scoped to a working day, and "until end of
   * day" has to be able to exceed eight hours.
   */
  import { Button } from "$lib/components/ui/button";
  import { toast } from "svelte-sonner";
  import { authStore } from "$lib/stores/auth";
  import type { InsecureFleetWindow } from "$lib/api/types";
  import InsecureCountdown from "./InsecureCountdown.svelte";
  import ShieldOff from "@lucide/svelte/icons/shield-off";
  import Clock from "@lucide/svelte/icons/clock";

  type Props = {
    window: InsecureFleetWindow | undefined;
    /** Insecure hosts currently holding an open window — what a close will shut. */
    openHostCount: number;
    /** Active domain auto-allows — a close pulls these back to now as well. */
    openDomainCount: number;
    onOpen: (durationMinutes: number) => Promise<unknown>;
    onClose: () => Promise<unknown>;
  };
  let { window: fleetWindow, openHostCount, openDomainCount, onOpen, onClose }: Props = $props();

  const canMutate = $derived($authStore.can("hosts.activate_insecure"));
  const isOpen = $derived(fleetWindow?.open === true && !!fleetWindow?.until);

  let busy = $state(false);

  /** Minutes from now until 23:59 local, floored at the server's 5-minute minimum. */
  function minutesUntilEndOfDay(): number {
    const now = new Date();
    const end = new Date(now);
    end.setHours(23, 59, 0, 0);
    return Math.max(5, Math.min(1440, Math.round((end.getTime() - now.getTime()) / 60_000)));
  }

  const PRESETS: Array<{ label: string; minutes: () => number }> = [
    { label: "1h", minutes: () => 60 },
    { label: "4h", minutes: () => 240 },
    { label: "8h", minutes: () => 480 },
    { label: "Until end of day", minutes: minutesUntilEndOfDay },
  ];

  const deadlineLabel = $derived.by(() => {
    if (!fleetWindow?.until) return null;
    const at = new Date(fleetWindow.until);
    if (Number.isNaN(at.getTime())) return null;
    return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  });

  async function run(label: string, work: Promise<unknown>): Promise<void> {
    busy = true;
    try {
      await work;
      toast.success(label);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="space-y-3 rounded-md border px-3 py-3 {isOpen
    ? 'border-warning/40 bg-warning-muted'
    : 'bg-muted/30'}"
>
  <header class="flex items-start justify-between gap-3">
    <div class="min-w-0 space-y-0.5">
      <h3 class="flex items-center gap-1.5 text-sm font-semibold">
        <Clock class="h-3.5 w-3.5" />
        Fleet window
      </h3>
      {#if isOpen}
        <p class="text-[11px] text-warning-muted-foreground">
          Every insecure host is auto-allowed. Closes
          {#if deadlineLabel}at {deadlineLabel}{/if}.
        </p>
      {:else}
        <p class="text-[11px] text-muted-foreground">
          Auto-allow every insecure host for a stretch — a working day, rather than
          approving each request as it arrives.
        </p>
      {/if}
    </div>
    {#if isOpen}
      <InsecureCountdown until={fleetWindow?.until} />
    {/if}
  </header>

  {#if isOpen}
    <p class="text-[11px] text-warning-muted-foreground">
      While this is open, insecure hosts also skip reverse-DNS enforcement, may
      rebind their IP, and are eligible for Agent Messaging.
    </p>
    <div class="flex flex-wrap items-center gap-1">
      {#each PRESETS as preset (preset.label)}
        <Button
          size="sm"
          variant="outline"
          disabled={!canMutate || busy}
          onclick={() =>
            run("Fleet window reset", onOpen(preset.minutes()))}
        >
          {preset.label}
        </Button>
      {/each}
      <Button
        size="sm"
        variant="ghost"
        disabled={!canMutate || busy}
        onclick={() => run("Fleet window closed", onClose())}
      >
        <ShieldOff class="h-3.5 w-3.5" /> Close now
      </Button>
    </div>
    <p class="text-[11px] text-muted-foreground">
      Closing disables
      {openHostCount}
      {openHostCount === 1 ? "open host window" : "open host windows"}{#if openDomainCount > 0}
        and expires {openDomainCount}
        {openDomainCount === 1 ? "domain allow" : "domain allows"}{/if}. Re-setting
      a duration replaces the deadline rather than adding to it.
    </p>
  {:else}
    <div class="flex flex-wrap items-center gap-1">
      {#each PRESETS as preset (preset.label)}
        <Button
          size="sm"
          variant="outline"
          disabled={!canMutate || busy}
          onclick={() => run("Fleet window opened", onOpen(preset.minutes()))}
        >
          {preset.label}
        </Button>
      {/each}
    </div>
  {/if}

  {#if !canMutate}
    <p class="text-[11px] text-muted-foreground">
      You do not have the <code>hosts.activate_insecure</code> capability.
    </p>
  {/if}
</section>
