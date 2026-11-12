<script lang="ts">
  import type { ProviderAccount } from "$lib/api/accounts";
  import { accountQuotaRows } from "./account-usage";
  import UsageMeter from "./UsageMeter.svelte";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import { resetsIn } from "$lib/utils/format";
  let { usage, label, quotaSnapshot, inline = false, showUpdated = true }: {
    usage: ProviderAccount["usage"]; label: string; quotaSnapshot?: ProviderAccount["quota_snapshot"]; inline?: boolean; showUpdated?: boolean;
  } = $props();
  const rows = $derived(accountQuotaRows({ engine: "kimi", usage, quota_snapshot: quotaSnapshot }));
</script>
<div class="space-y-2" role="group" aria-label={`${label} Kimi Code usage`}>
  {#each rows as window (window.key)}
    {@const when = resetsIn(window.reset)}
    <UsageMeter {inline} usedPercent={window.value} label={window.label} valueLabel={`${window.value}% used`} />
    <p class="text-body-sm text-muted-foreground">{#if when === "passed"}Reset passed{:else if when}Resets <time datetime={window.reset ?? undefined}>{when}</time>{:else}Reset time unavailable{/if}</p>
  {:else}
    <p class="text-body-sm text-muted-foreground">{usage.checked_at ? "Usage unavailable" : "Waiting for usage data"}</p>
  {/each}
  {#if usage.stale && usage.windows?.length}<p class="text-body-sm text-muted-foreground">Last known reading</p>{/if}
  {#if usage.error_code && usage.windows?.length}<p class="text-body-sm text-muted-foreground">Update unavailable; showing the last reading.</p>{/if}
  {#if showUpdated && usage.fetched_at}<p class="text-body-sm text-muted-foreground">Updated <Timestamp value={usage.fetched_at} /></p>{/if}
</div>
