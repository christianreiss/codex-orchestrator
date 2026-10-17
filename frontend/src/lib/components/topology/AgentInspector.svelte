<script lang="ts">
  /**
   * The one detail inspector for an agent or a connection, shared by the Live
   * and Graph views. A docked side panel (a bottom card on phones) that does
   * not block the page: the graph stays clickable, so selecting another node
   * simply retargets it. The conversation
   * drawer is one click away ("Chat").
   */
  import X from "@lucide/svelte/icons/x";
  import { Button } from "$lib/components/ui/button";
  import NodeDetail from "./NodeDetail.svelte";
  import type { AgentsView } from "./agents-view.svelte";

  let { agents }: { agents: AgentsView } = $props();
  const item = $derived(agents.selectedItem);
  const node = $derived(item?.node ?? null);
</script>

<aside
  class:hidden={!item}
  class="z-20 flex flex-col gap-3 overflow-y-auto rounded-md border bg-card p-3 shadow-pop max-lg:fixed max-lg:inset-x-0 max-lg:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-lg:max-h-[55dvh] lg:sticky lg:top-4 lg:max-h-[calc(100dvh-6rem)] lg:w-96 lg:shrink-0"
  aria-label="Selection details"
>
  <div class="flex items-center justify-end gap-1">
    {#if node?.kind === "communicator"}
      <Button variant="ghost" size="sm" onclick={() => agents.toggleCollapsed(node.id)}>
        {agents.collapsed.has(node.id) ? "Expand" : "Collapse"} agents ({node.agent_ids.length})
      </Button>
    {/if}
    <Button variant="ghost" size="sm" aria-label="Close inspector" onclick={() => agents.select(null)}><X class="h-4 w-4" /> Close</Button>
  </div>
  <NodeDetail
    snapshot={agents.topology.current.data}
    {item}
    onselect={(id) => agents.select(id)}
    onchat={(id) => agents.openChat(id)}
    onspawn={(host) => agents.startAgent(host)}
  />
</aside>
