<script lang="ts">
  /**
   * The three public API base URLs and whether each one is serving, as a popover
   * off the key list's toolbar. Reference information, not the page's data.
   */
  import Globe from "@lucide/svelte/icons/globe";
  import * as Popover from "$lib/components/ui/popover";
  import { Button } from "$lib/components/ui/button";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { apiStateQuery, apiSurfacesQuery, engineStateQuery } from "$lib/api/settings";
  import type { ApiKeyEngine, ApiSurfaceId } from "$lib/api/types";

  let { onSelect }: { onSelect: (vendor: ApiKeyEngine) => void } = $props();
  const query = apiSurfacesQuery();
  const apiState = apiStateQuery();
  const engines = engineStateQuery();
  const keyVendor: Record<ApiSurfaceId, ApiKeyEngine> = { openai: "openai", anthropic: "claude", grok: "grok" };
  const labels: Record<ApiSurfaceId, string> = { openai: "OpenAI", anthropic: "Anthropic", grok: "Grok" };
  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);
  let open = $state(false);

  /** One status per endpoint; "unknown" never claims the endpoint is enabled. */
  const rows = $derived(
    ($query.data?.surfaces ?? []).map((row) => {
      const backend = $engines.data?.engines?.find((entry) => entry.engine === row.backend);
      const unknown = $apiState.isError || $engines.isError || !backend || !$apiState.data;
      const off = Boolean($apiState.data?.disabled || row.disabled || backend?.enabled === false);
      const status = $apiState.data?.disabled ? "All traffic off" : row.disabled ? "Disabled" : backend?.enabled === false ? "Default engine off" : unknown ? ($apiState.isPending || $engines.isPending ? "Checking…" : "Status unavailable") : "Enabled";
      return { row, url: `${origin}${row.base_path}`, off, unknown, status };
    }),
  );
  const anyOff = $derived(rows.some((entry) => entry.off));
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline" aria-label="API endpoints">
        <Globe class="h-4 w-4" />Endpoints
        {#if anyOff}<span class="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true"></span>{/if}
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content align="end" class="w-[28rem] max-w-[calc(100vw-2rem)] space-y-2" aria-label="API endpoints">
    {#if $apiState.data?.disabled}
      <p role="status" class="text-body-sm text-warning">All API traffic is disabled. Open Configure to restore access.</p>
    {/if}
    {#if $query.isError}
      <p role="alert" class="text-body-sm text-destructive">Failed to load endpoints: {$query.error?.message}</p>
    {:else if $query.isPending}
      <div aria-label="Loading endpoints" class="space-y-2">{#each Array(3) as _, i (i)}<Skeleton class="h-6 w-full" />{/each}</div>
    {:else}
      {#if $apiState.isError || $engines.isError}
        <p role="alert" class="text-body-sm text-destructive">Failed to load API status: {$apiState.error?.message ?? $engines.error?.message}</p>
      {/if}
      <ul class="divide-y">
        {#each rows as { row, url, off, unknown, status } (row.surface)}
          <li class="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 py-2" data-endpoint={row.surface}>
            <button
              type="button"
              class="w-fit rounded-md text-left text-body font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Show ${labels[row.surface]} keys`}
              onclick={() => { onSelect(keyVendor[row.surface]); open = false; }}
            >{labels[row.surface]}</button>
            <span class="flex items-center gap-1.5 text-caption text-muted-foreground" title={`Default engine: ${row.backend}. Assigned keys use their own engine.`}>
              <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full {off ? 'bg-warning' : unknown ? 'bg-muted-foreground' : 'bg-success'}"></span>
              {status}
            </span>
            <code class="min-w-0 break-all font-mono text-caption text-muted-foreground">{url}</code>
            <CopyButton value={url} variant="ghost" size="icon" aria-label={`Copy ${row.base_path} URL`} toastMessage={`${row.base_path} URL copied`} />
          </li>
        {/each}
      </ul>
    {/if}
  </Popover.Content>
</Popover.Root>
