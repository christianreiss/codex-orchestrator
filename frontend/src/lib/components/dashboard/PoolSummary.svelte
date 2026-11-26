<script lang="ts">
  /**
   * Engines with more than one usable account, judged as a pool: how many accounts can take work,
   * which one has the most headroom and which are high. "Near quota" appears only when no usable
   * account has headroom, the same rule agents are advised by (`poolRecommendation`). Single-account
   * engines are not listed; their quota stays in the table below.
   */
  import { base } from "$app/paths";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { ProviderAccount } from "$lib/api/accounts";
  import { ENGINE_META } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { enginePools, NEAR_QUOTA_PERCENT, scoreText } from "$lib/components/accounts/account-state";
  import { cn } from "$lib/utils/cn";

  let { accounts }: { accounts: ProviderAccount[] | undefined } = $props();
  const fleet = useFleetEngines();
  const pools = $derived(enginePools((accounts ?? []).filter((account) => $fleet.isEnabled(account.engine))).filter((pool) => pool.pooled));
  const named = (list: ProviderAccount[]) => list.map((account) => `${account.label} (${scoreText(account)})`).join(", ");
</script>

{#if pools.length}
  <ul class="mb-3 space-y-1 text-body-sm" aria-label="Account pools">
    {#each pools as pool (pool.engine)}
      <li class="flex items-start gap-2" data-testid="account-pool">
        <span class={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", ENGINE_META[pool.engine].color)} aria-hidden="true"></span>
        <p class="min-w-0 break-words">
          <a class="font-medium text-primary underline-offset-2 hover:underline" href={`${base}/accounts?engine=${pool.engine}`}>{ENGINE_META[pool.engine].label} pool</a>
          <span class="text-muted-foreground">· {pool.usable.length} usable accounts</span>
          {#if pool.nearQuota}
            <span class="inline-flex items-center gap-1 text-warning-muted-foreground">· <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />Near quota: every usable account is at {NEAR_QUOTA_PERCENT}% or more</span>
          {:else if pool.best}
            <span>· Most headroom: {pool.best.label} ({scoreText(pool.best)})</span>
          {/if}
          {#if pool.high.length}
            <span class="text-muted-foreground">· At {NEAR_QUOTA_PERCENT}% or more: {named(pool.high)}</span>
          {/if}
        </p>
      </li>
    {/each}
  </ul>
{/if}
