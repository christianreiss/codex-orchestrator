<script lang="ts">
  import type { ProviderAccount } from "$lib/api/accounts";
  import UsageMeter from "./UsageMeter.svelte";
  import { Badge } from "$lib/components/ui/badge";

  let { usage, label }: { usage: ProviderAccount["usage"]; label: string } = $props();
  const window = $derived(usage.current_window);
  const periodLabel = $derived(window?.period === "weekly" ? "Weekly usage" : window?.period === "monthly" ? "Monthly usage" : "Current period");
  function date(value: string | null | undefined) {
    return value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
  }
</script>

<div class="space-y-3" role="group" aria-label={`${label} Grok usage`}>
  {#if window}
    {#if usage.stale}<Badge variant="warning">Last known reading</Badge>{/if}
    <UsageMeter usedPercent={window.used_percent} label={periodLabel} valueLabel={`${window.used_percent}% used`} />
    <p class="text-xs text-muted-foreground">
      {#if date(window.resets_at)}Resets <time datetime={window.resets_at ?? undefined}>{date(window.resets_at)}</time>{:else}Reset time unavailable{/if}
    </p>
    {#if window.shared}<p class="text-xs text-muted-foreground">Shared across Grok products</p>{/if}
    {#if usage.error_code}<p class="text-xs text-muted-foreground">Update unavailable; showing the last reading.</p>{/if}
  {:else}
    <p class="text-sm text-muted-foreground">{usage.checked_at ? "Usage unavailable" : "Waiting for usage data"}</p>
  {/if}
  {#if usage.fetched_at}
    <p class="text-xs text-muted-foreground">Updated <time datetime={usage.fetched_at}>{date(usage.fetched_at)}</time></p>
  {/if}
</div>
