<script lang="ts">
  /** The relationship map: scope and ownership always shown, optional layers explicit. */
  import Brain from "@lucide/svelte/icons/brain";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Tags from "@lucide/svelte/icons/tags";
  import { StateBlock } from "$lib/components/page";
  import MemoryGraph from "$lib/components/memories/MemoryGraph.svelte";
  import { Button } from "$lib/components/ui/button";
  import type { MemoriesState } from "./memories-state.svelte";

  let { state }: { state: MemoriesState } = $props();
  const error = $derived(state.query.isError ? (state.query.error instanceof Error ? state.query.error.message : "The map could not be loaded") : null);
</script>

<section class="overflow-hidden rounded-md border" aria-label="Relationship map">
  <div class="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
    <p class="text-body-sm text-muted-foreground">Scope and ownership are always shown; optional layers stay explicit.</p>
    <div class="flex items-center gap-1.5" role="group" aria-label="Map layers">
      <Button size="sm" variant={state.layers.includes("tags") ? "secondary" : "outline"} aria-pressed={state.layers.includes("tags")} onclick={() => state.toggleLayer("tags")}>
        <Tags class="h-4 w-4" />Tags
      </Button>
      <Button size="sm" variant={state.layers.includes("provenance") ? "secondary" : "outline"} aria-pressed={state.layers.includes("provenance")} onclick={() => state.toggleLayer("provenance")}>
        <GitBranch class="h-4 w-4" />Provenance
      </Button>
    </div>
  </div>

  {#if state.query.isLoading}
    <div class="p-4"><StateBlock state="loading" rows={6} /></div>
  {:else if error}
    <div class="p-4"><StateBlock state="error" message={error} onRetry={() => void state.query.refetch()} /></div>
  {:else if state.memoryNodes.length === 0}
    <StateBlock
      state="empty"
      icon={Brain}
      message={state.hasFilters ? "No memories match" : "No memories yet"}
      description={state.hasFilters ? "Adjust the filters to reveal another part of the map." : "Create the first memory to start mapping durable context."}
    />
  {:else}
    <MemoryGraph
      nodes={state.mapNodes}
      edges={state.mapEdges}
      selectedNodeId={state.selectedNodeId}
      showTags={state.layers.includes("tags")}
      showProvenance={state.layers.includes("provenance")}
      onSelect={(node) => state.selectNode(node)}
    />
  {/if}
</section>
