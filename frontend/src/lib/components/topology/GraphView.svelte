<script lang="ts">
  /** The Graph view: the connection tree as a radial map or a list, with the conversation drawer beside it. */
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { StateBlock } from "$lib/components/page";
  import ClientsWorkspace from "$lib/components/portal/ClientsWorkspace.svelte";
  import TopologyGraph from "./TopologyGraph.svelte";
  import TopologyList from "./TopologyList.svelte";
  import type { AgentsView } from "./agents-view.svelte";

  let { agents }: { agents: AgentsView } = $props();
  const topology = $derived(agents.topology.current);
  const stale = $derived(topology.isError && Boolean(topology.data));
  const updated = $derived(topology.data ? new Date(topology.data.generated_at).toLocaleTimeString() : "—");
</script>

{#if topology.isError && !topology.data}
  <StateBlock state="error" message={`The topology could not be loaded. ${topology.error.message}`} onRetry={() => topology.refetch()} />
{:else if topology.isPending}
  <Skeleton class="h-[60vh] w-full" />
{:else}
  <p class="text-caption text-muted-foreground" aria-live="polite">
    {#if stale}<span class="text-warning">Showing the last good snapshot. </span>{/if}Updated {updated}
    {#if topology.data && !topology.data.server.communicator_enabled}
      · The connection (communicator) transport is off on this server, so every session connects directly.
    {/if}
  </p>

  <div class={agents.fullscreen ? "fixed inset-0 z-40 flex flex-col gap-2 bg-background p-4" : "flex min-h-0 flex-col"}>
    {#if agents.fullscreen}
      <div class="flex justify-end"><Button size="sm" variant="outline" onclick={() => (agents.fullscreen = false)}>Exit fullscreen</Button></div>
    {/if}
    <div class="relative min-h-0 flex-1 {agents.chatOpen ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,40%)] lg:gap-3' : ''}">
      <div class="relative min-w-0">
        <div class={agents.fullscreen ? "h-[calc(100dvh-6rem)] min-w-0" : "h-[62vh] min-h-[24rem] min-w-0 lg:h-[calc(100dvh-22rem)]"}>
          {#if agents.layout === "radial"}
            <TopologyGraph bind:this={agents.graph} server={topology.data?.server} model={agents.visibleModel} selectedId={agents.selectedId} query={agents.search} onselect={(id) => agents.select(id)} />
          {:else}
            <div class="h-full overflow-y-auto pr-1">
              <TopologyList model={agents.visibleModel} selectedId={agents.selectedId} query={agents.search} onselect={(id) => agents.select(id)} />
            </div>
          {/if}
        </div>
      </div>
      <aside class={agents.chatOpen ? "absolute inset-0 z-10 flex min-h-0 flex-col rounded-md border bg-card lg:static" : "hidden"} aria-label="Topology conversation">
        <div class="flex items-center justify-between border-b p-2">
          <span class="text-body font-medium">Conversation</span>
          <Button size="sm" variant="ghost" onclick={() => (agents.chatOpen = false)}>Close chat</Button>
        </div>
        {#if agents.chatId || agents.spawnOpen || agents.chatOpen}
          <ClientsWorkspace embedded sessionId={agents.chatId} spawnHost={agents.spawnHost} bind:spawnOpen={agents.spawnOpen} />
        {/if}
      </aside>
    </div>
  </div>
{/if}
