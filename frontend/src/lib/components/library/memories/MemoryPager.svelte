<script lang="ts">
  /** Where you are in the loaded window, and the controls to move through it. */
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { Button } from "$lib/components/ui/button";
  import { GRAPH_LIMIT, GRAPH_RENDER_LIMIT, PAGE_SIZE, type MemoriesState } from "./memories-state.svelte";

  let { state }: { state: MemoriesState } = $props();
  const loaded = $derived(state.memoryNodes.length);
  const tablePaged = $derived(!state.showMap && loaded > PAGE_SIZE);
  const visible = $derived(
    !state.query.isLoading && !state.query.isError && loaded > 0 && (state.serverHasMore || tablePaged || (state.showMap && state.graphIsCapped)),
  );
</script>

{#if visible}
  <div class="flex flex-wrap items-center justify-between gap-3 text-body-sm text-muted-foreground">
    <p>
      {#if !state.showMap}
        {state.tablePage * PAGE_SIZE + 1}–{Math.min((state.tablePage + 1) * PAGE_SIZE, loaded)} of {loaded} loaded
      {:else if state.graphIsCapped}
        Map shows the newest {GRAPH_RENDER_LIMIT} of {loaded} loaded. Switch to the list for the rest.
      {:else}
        {loaded} loaded
      {/if}
      {#if state.serverHasMore}
        · server page {state.cursorHistory.length + 1}{state.query.data?.count ? ` of ${state.query.data.count} matching` : ""}
      {/if}
    </p>
    <div class="flex items-center gap-1">
      {#if tablePaged}
        <Button size="sm" variant="outline" aria-label="Previous table page" disabled={state.tablePage === 0} onclick={() => (state.tablePage = Math.max(0, state.tablePage - 1))}>
          <ChevronLeft class="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" aria-label="Next table page" disabled={state.tablePage >= state.tablePageCount - 1} onclick={() => (state.tablePage = Math.min(state.tablePageCount - 1, state.tablePage + 1))}>
          <ChevronRight class="h-4 w-4" />
        </Button>
      {/if}
      {#if state.serverHasMore}
        <Button size="sm" variant="outline" disabled={!state.cursorHistory.length} onclick={() => state.previousServerPage()}><ChevronLeft class="h-4 w-4" />Previous {GRAPH_LIMIT}</Button>
        <Button size="sm" variant="outline" disabled={!state.query.data?.next_cursor} onclick={() => state.nextServerPage()}>Next {GRAPH_LIMIT}<ChevronRight class="h-4 w-4" /></Button>
      {/if}
    </div>
  </div>
{/if}
