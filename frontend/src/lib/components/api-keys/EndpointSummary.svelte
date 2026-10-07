<script lang="ts">
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { apiStateQuery, apiSurfacesQuery, engineStateQuery } from "$lib/api/settings";
  import type { ApiKeyEngine, ApiSurfaceId } from "$lib/api/types";

  let { activeTab, onSelect }: { activeTab: ApiKeyEngine; onSelect: (tab: ApiKeyEngine) => void } = $props();
  const query = apiSurfacesQuery();
  const state = apiStateQuery();
  const engines = engineStateQuery();
  const keyTab: Record<ApiSurfaceId, ApiKeyEngine> = { openai: "openai", anthropic: "claude", grok: "grok" };
  const labels: Record<ApiSurfaceId, string> = { openai: "OpenAI", anthropic: "Anthropic", grok: "Grok" };
  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);
</script>

<section aria-label="API endpoints" class="mb-6">
  {#if $state.data?.disabled}
    <p role="status" class="mb-3 text-sm text-warning">All API traffic is disabled. Open Configuration to restore access.</p>
  {/if}
  {#if $query.isError}
    <p role="alert" class="py-3 text-sm text-destructive">Failed to load endpoints: {$query.error?.message}</p>
  {:else if $query.isPending}
    <div aria-label="Loading endpoints" class="space-y-4 py-3">
      {#each Array(3) as _, i (i)}<Skeleton class="h-6 w-full" />{/each}
    </div>
  {:else}
    {#if $state.isError || $engines.isError}
      <p role="alert" class="mb-2 text-sm text-destructive">Failed to load API status: {$state.error?.message ?? $engines.error?.message}</p>
    {/if}
    <div class="divide-y border-y border-border/60">
      {#each $query.data?.surfaces ?? [] as row (row.surface)}
        {@const url = `${origin}${row.base_path}`}
        {@const backend = $engines.data?.engines?.find((entry) => entry.engine === row.backend)}
        {@const unknown = $state.isError || $engines.isError || !backend || !$state.data}
        {@const off = $state.data?.disabled || row.disabled || backend?.enabled === false}
        {@const status = $state.data?.disabled ? "All traffic off" : row.disabled ? "Disabled" : backend?.enabled === false ? "Backend off" : unknown ? ($state.isPending || $engines.isPending ? "Checking…" : "Status unavailable") : "Enabled"}
        <div class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[8rem_minmax(0,1fr)_auto_auto]" data-endpoint={row.surface}>
          <button
            type="button"
            class="w-fit rounded-sm text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Show ${labels[row.surface]} keys`}
            aria-pressed={activeTab === keyTab[row.surface]}
            onclick={() => onSelect(keyTab[row.surface])}
          >{labels[row.surface]}</button>
          <code class="col-start-1 row-start-2 min-w-0 break-all font-mono text-xs text-muted-foreground sm:col-start-auto sm:row-start-auto">{url}</code>
          <span class="col-start-2 row-start-1 flex items-center gap-1.5 text-xs text-muted-foreground sm:col-start-auto sm:row-start-auto" title={`Backend: ${row.backend}`}>
            <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full {off ? 'bg-warning' : unknown ? 'bg-muted-foreground' : 'bg-success'}"></span>
            {status}
          </span>
          <CopyButton value={url} variant="ghost" size="icon" class="col-start-2 row-start-2 h-8 w-8 sm:col-start-auto sm:row-start-auto" aria-label={`Copy ${row.base_path} URL`} toastMessage={`${row.base_path} URL copied`} />
        </div>
      {/each}
    </div>
  {/if}
</section>
