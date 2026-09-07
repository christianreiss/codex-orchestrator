<script lang="ts">
  import { base } from "$app/paths";
  import type { VersionDistribution } from "$lib/api/overview";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import { Skeleton } from "$lib/components/ui/skeleton";

  let { distribution, loading = false }: {
    distribution?: VersionDistribution | null;
    loading?: boolean;
  } = $props();

  const segments = $derived(distribution?.install ? [
    { label: "Both engines", count: distribution.install.both, color: "bg-primary", dot: "bg-primary" },
    { label: "Codex only", count: distribution.install.codex_only, color: "bg-persona-codex", dot: "bg-persona-codex" },
    { label: "Claude only", count: distribution.install.claude_only, color: "bg-persona-claude", dot: "bg-persona-claude" },
    { label: "No version reported", count: distribution.install.neither, color: "bg-muted-foreground/40", dot: "bg-muted-foreground" },
  ] : []);
  const total = $derived(segments.reduce((sum, item) => sum + item.count, 0));
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
    {:else if segments.length === 0}
      <p class="text-sm text-muted-foreground">Engine coverage is unavailable until a fleet snapshot loads.</p>
    {:else if total === 0}
      <p class="text-sm text-muted-foreground">Register a host to start building your fleet. Engine coverage appears after clients report their versions.</p>
    {:else}
      <div class="mb-5 flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {#each segments as segment (segment.label)}
          {#if segment.count > 0}
            <div class={segment.color} style:width={`${segment.count / total * 100}%`}></div>
          {/if}
        {/each}
      </div>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
        {#each segments as segment (segment.label)}
          <div>
            <dt class="flex items-center gap-2 text-xs text-muted-foreground">
              <span class="h-2 w-2 shrink-0 rounded-full {segment.dot}" aria-hidden="true"></span>
              {segment.label}
            </dt>
            <dd class="mt-2 text-xl font-semibold tabular-nums">{segment.count}<span class="ml-2 text-xs font-normal text-muted-foreground">{Math.round(segment.count / total * 100)}%</span></dd>
          </div>
        {/each}
      </dl>
    {/if}
  </div>
</section>
