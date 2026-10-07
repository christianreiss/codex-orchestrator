<script lang="ts">
  import { base } from "$app/paths";
  import { ENGINES, ENGINE_META } from "$lib/constants/engines";
  import { engineInstallCounts, type VersionDistribution } from "$lib/api/overview";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import { Skeleton } from "$lib/components/ui/skeleton";

  let { distribution, totalHosts, loading = false }: {
    distribution?: VersionDistribution | null;
    totalHosts?: number;
    loading?: boolean;
  } = $props();

  const counts = $derived(engineInstallCounts(distribution));
  const rows = $derived(ENGINES.map((engine) => ({
    engine,
    ...ENGINE_META[engine],
    count: counts?.[engine],
  })));
  const noVersion = $derived(distribution?.install_combinations
    ? distribution.install_combinations.filter((item) => item.engines.length === 0).reduce((sum, item) => sum + item.count, 0)
    : counts?.grok == null ? distribution?.install?.neither : undefined);
</script>

<section class="overflow-hidden rounded-lg border bg-card" aria-labelledby="fleet-coverage-title">
  <div class="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-5 py-4">
    <div>
      <h2 id="fleet-coverage-title" class="text-sm font-semibold">Engine coverage</h2>
      <p class="mt-1 text-xs text-muted-foreground">Installed CLI versions reported by your hosts.</p>
    </div>
    <a class="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`${base}/engines`}>
      Configure engines <ArrowUpRight class="h-3.5 w-3.5" />
    </a>
  </div>
  <div class="p-5">
    {#if loading}
      <Skeleton class="h-2 w-full" />
      <Skeleton class="mt-5 h-10 w-full" />
    {:else if !counts || totalHosts == null}
      <p class="text-sm text-muted-foreground">Engine coverage is unavailable until a fleet snapshot loads.</p>
    {:else if totalHosts === 0}
      <p class="text-sm text-muted-foreground">Register a host to start building your fleet. Engine coverage appears after clients report their versions.</p>
    {:else}
      <div class="space-y-5">
        {#each rows as row (row.engine)}
          <div>
            <dl class="mb-2 flex items-baseline justify-between gap-3">
              <dt id={`coverage-${row.engine}`} class="text-sm font-medium">{row.label}</dt>
              <dd class="text-sm tabular-nums">
                {#if row.count != null}
                  <span class="font-semibold">{row.count} / {totalHosts}</span>
                  <span class="ml-2 text-xs text-muted-foreground">{Math.round(row.count / totalHosts * 100)}%</span>
                {:else}
                  <span class="text-muted-foreground">No data</span>
                {/if}
              </dd>
            </dl>
            {#if row.count != null}
              <div class="h-2 overflow-hidden rounded-full bg-muted" role="progressbar"
                aria-labelledby={`coverage-${row.engine}`} aria-valuemin={0}
                aria-valuemax={totalHosts} aria-valuenow={row.count}
                aria-valuetext={`${row.count} of ${totalHosts} hosts (${Math.round(row.count / totalHosts * 100)}%)`}>
                <div class={`h-full ${row.color}`} style:width={`${Math.min(100, row.count / totalHosts * 100)}%`}></div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <div class="mt-5 space-y-2 border-t pt-4 text-xs text-muted-foreground">
        {#if noVersion != null}
          <p>No CLI version reported: <span class="font-medium text-foreground tabular-nums">{noVersion}</span></p>
        {/if}
        <p>Hosts with multiple engines count towards each engine.</p>
      </div>
    {/if}
  </div>
</section>
