<script lang="ts">
  /**
   * Memories inside the Library: search first, filters in the toolbar, the
   * inventory as a list, and the relationship map behind a List/Map toggle
   * (list by default). The inspector and the edit/append dialogs are shared
   * with the rest of the memory tooling.
   */
  import Network from "@lucide/svelte/icons/network";
  import List from "@lucide/svelte/icons/list";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { Toolbar } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import MemoryAppendDialog from "$lib/components/memories/MemoryAppendDialog.svelte";
  import MemoryEditorDialog from "$lib/components/memories/MemoryEditorDialog.svelte";
  import MemoryInspector from "$lib/components/memories/MemoryInspector.svelte";
  import MemoryFilters from "./MemoryFilters.svelte";
  import MemoryMap from "./MemoryMap.svelte";
  import MemoryPager from "./MemoryPager.svelte";
  import MemoryScopeTags from "./MemoryScopeTags.svelte";
  import MemoryTable from "./MemoryTable.svelte";
  import { MemoriesState } from "./memories-state.svelte";

  const state = new MemoriesState();
  const total = $derived(state.totals.all);
  const count = $derived(`${total.toLocaleString()} ${total === 1 ? "memory" : "memories"}`);
</script>

<div class="space-y-3">
  <Toolbar bind:search={state.searchInput} searchPlaceholder="Search keys, titles, summaries, tags" {count}>
    {#snippet filters()}
      <MemoryFilters {state} />
    {/snippet}
    {#snippet actions()}
      <div class="inline-flex rounded-md border p-0.5" role="group" aria-label="Memory view">
        <Button size="sm" variant={state.showMap ? "ghost" : "secondary"} aria-pressed={!state.showMap} onclick={() => state.setMap(false)}>
          <List class="h-4 w-4" />List
        </Button>
        <Button size="sm" variant={state.showMap ? "secondary" : "ghost"} aria-pressed={state.showMap} onclick={() => state.setMap(true)}>
          <Network class="h-4 w-4" />Map
        </Button>
      </div>
      <Button variant="outline" size="icon" aria-label="Refresh" disabled={state.query.isFetching} onclick={() => void state.query.refetch()}>
        <RefreshCw class={state.query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      </Button>
      {#if state.canCreate}
        <Button onclick={() => (state.createOpen = true)}><Plus class="h-4 w-4" />New memory</Button>
      {/if}
    {/snippet}
  </Toolbar>

  <MemoryScopeTags {state} />

  {#if state.showMap}
    <MemoryMap {state} />
  {:else}
    <MemoryTable {state} />
  {/if}
  <MemoryPager {state} />
</div>

<MemoryInspector
  open={!!state.selectedNode}
  node={state.selectedNode}
  onOpenChange={(next) => { if (!next) state.clearSelection(); }}
  onEdit={(memory) => state.openEdit(memory)}
  onAppend={(memory) => state.openAppend(memory)}
  onDelete={(memory) => state.openDelete(memory)}
/>

<MemoryEditorDialog
  bind:open={state.createOpen}
  mode="create"
  onOpenChange={(next) => (state.createOpen = next)}
  onSaved={(memory) => state.updateUrl((url) => url.searchParams.set("node", memory.node_id))}
/>

<MemoryEditorDialog
  bind:open={state.editOpen}
  mode="edit"
  memory={state.editTarget}
  onOpenChange={(next) => { state.editOpen = next; if (!next) state.editTarget = null; }}
/>

<MemoryAppendDialog
  bind:open={state.appendOpen}
  memory={state.appendTarget}
  onOpenChange={(next) => { state.appendOpen = next; if (!next) state.appendTarget = null; }}
/>

<ConfirmDialog
  bind:open={state.deleteOpen}
  title="Delete memory permanently?"
  description={`${state.deleteTarget?.id ?? "This memory"} will be removed from the ${state.deleteTarget?.scope ?? ""} scope. There is no trash, restore, or rollback.`}
  confirmLabel="Delete permanently"
  destructive
  busy={state.deleting}
  onConfirm={() => state.confirmDelete()}
/>
