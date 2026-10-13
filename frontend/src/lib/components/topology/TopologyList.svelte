<script lang="ts">
  import EngineAvatar from "$lib/components/portal/EngineAvatar.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { isEngine } from "$lib/constants/engines";
  import { ageLabel, communicatorLabel, matchesQuery, type GraphModel } from "$lib/topology/model";
  import type { Presence } from "$lib/portal/types";

  type Props = { model: GraphModel; selectedId: string | null; query?: string; onselect: (id: string | null) => void };
  let { model, selectedId, query = "", onselect }: Props = $props();

  const agentsByParent = $derived.by(() => {
    const map = new Map<string, typeof model.agents>();
    for (const item of model.agents) {
      const list = map.get(item.node.association.parent_id) ?? [];
      list.push(item);
      map.set(item.node.association.parent_id, list);
    }
    return map;
  });
  const direct = $derived(agentsByParent.get("server") ?? []);
  const known = $derived(new Set(model.communicators.map((c) => c.node.id)));
  // An agent whose communicator has left the list is direct as far as this view goes.
  const orphans = $derived(model.agents.filter((a) => a.node.association.parent_id !== "server" && !known.has(a.node.association.parent_id)));
  const visible = (node: Parameters<typeof matchesQuery>[0]) => matchesQuery(node, query);
</script>

{#snippet agentRow(item: (typeof model.agents)[number])}
  {#if visible(item.node)}
    <li>
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        class:bg-accent={selectedId === item.node.id}
        aria-pressed={selectedId === item.node.id}
        onclick={() => onselect(selectedId === item.node.id ? null : item.node.id)}
      >
        {#if isEngine(item.node.engine)}<EngineAvatar engine={item.node.engine} presence={item.node.presence as Presence} size="xs" />{/if}
        <span class="min-w-0 flex-1 truncate font-medium">{item.node.name}</span>
        {#if item.ghost}<Badge variant="secondary">ended</Badge>
        {:else if item.node.association.state === "stale"}<Badge variant="warning">quiet {ageLabel(item.node.association.age_s)}</Badge>
        {:else}<span class="text-xs text-muted-foreground">{item.node.presence}</span>{/if}
      </button>
    </li>
  {/if}
{/snippet}

<div class="space-y-4">
  {#each model.communicators as item (item.node.id)}
    {@const children = agentsByParent.get(item.node.id) ?? []}
    {#if visible(item.node) || children.some((child) => visible(child.node))}
      <section class="rounded-lg border bg-card" aria-label="Communicator {communicatorLabel(item.node)}">
        <button
          type="button"
          class="flex w-full flex-wrap items-center gap-2 rounded-t-lg px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          class:bg-accent={selectedId === item.node.id}
          aria-pressed={selectedId === item.node.id}
          onclick={() => onselect(selectedId === item.node.id ? null : item.node.id)}
        >
          <span class="font-semibold">{communicatorLabel(item.node)}</span>
          {#if item.ghost}<Badge variant="secondary">disconnected</Badge>
          {:else}<Badge variant={item.node.health === "live" ? "success" : item.node.health === "closing" ? "destructive" : "warning"}>{item.node.health}</Badge>{/if}
          <span class="text-xs text-muted-foreground">cxx {item.node.version} · {children.length} agent{children.length === 1 ? "" : "s"}</span>
        </button>
        {#if children.length > 0}<ul class="border-t p-1">{#each children as child (child.node.id)}{@render agentRow(child)}{/each}</ul>{/if}
      </section>
    {/if}
  {/each}

  {#if direct.length + orphans.length > 0}
    <section class="rounded-lg border border-dashed bg-card" aria-label="Agents with no communicator">
      <h3 class="px-3 py-2 text-sm font-semibold">Direct <span class="font-normal text-muted-foreground">· no communicator carried their requests</span></h3>
      <ul class="border-t p-1">{#each [...direct, ...orphans] as child (child.node.id)}{@render agentRow(child)}{/each}</ul>
    </section>
  {/if}

  {#if model.communicators.length === 0 && model.agents.length === 0}
    <p class="rounded-lg border bg-card p-4 text-sm text-muted-foreground">Nothing is connected to this server right now.</p>
  {/if}
</div>
