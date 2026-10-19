<script lang="ts">
  import type { ProviderAccount } from "$lib/api/accounts";
  import UsageMeter from "./UsageMeter.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { resetsIn } from "$lib/utils/format";

  let { usage, label, showStatus = true, showUpdated = true, inline = false }: {
    usage: ProviderAccount["usage"]; label: string; showStatus?: boolean; showUpdated?: boolean;
    /** One-line meter and tight spacing, for table cells. */
    inline?: boolean;
  } = $props();
  const window = $derived(usage.current_window);
  const periodLabel = $derived(window?.period === "weekly" ? "Weekly usage" : window?.period === "monthly" ? "Monthly usage" : "Current period");
  function date(value: string | null | undefined) {
    return value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
  }
</script>

<div class={inline ? "space-y-1" : "space-y-3"} role="group" aria-label={`${label} Grok usage`}>
  {#if window}
    {@const when = resetsIn(window.resets_at)}
    {#if showStatus && usage.stale}<Badge variant="warning">Last known reading</Badge>{/if}
    <UsageMeter {inline} usedPercent={window.used_percent} label={periodLabel} valueLabel={`${window.used_percent}% used`} />
    <p class="text-body-sm text-muted-foreground">
      {#if when === "passed"}Reset passed{:else if when}Resets <time datetime={window.resets_at ?? undefined} title={window.resets_at ?? undefined}>{when}</time>{:else}Reset time unavailable{/if}
    </p>
    {#if usage.error_code}<p class="text-body-sm text-muted-foreground">Update unavailable; showing the last reading.</p>{/if}
  {:else}
    <p class="rounded-md border bg-muted/30 p-3 text-body-sm text-muted-foreground">{usage.checked_at ? "Usage unavailable" : "Waiting for usage data"}</p>
  {/if}
  {#if showUpdated && usage.fetched_at}
    <p class="text-body-sm text-muted-foreground">Updated <time datetime={usage.fetched_at}>{date(usage.fetched_at)}</time></p>
  {/if}
</div>
