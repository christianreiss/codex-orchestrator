<script lang="ts">
  /** Host, project and engine selects for the Toolbar. Flat toolbar content, no card. */
  import FilterX from "@lucide/svelte/icons/filter-x";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import { ALL, type MemoriesState } from "./memories-state.svelte";

  let { state }: { state: MemoriesState } = $props();
  const facets = $derived(state.facets);
</script>

<Select.Root type="single" value={state.hostFilter} onValueChange={(value) => state.setFilter("host", value || ALL)}>
  <Select.Trigger class="w-36" aria-label="Filter by host">
    <Select.Value placeholder="All hosts">
      {state.hostFilter === ALL ? "All hosts" : facets.hosts.find((item) => String(item.id) === state.hostFilter)?.label ?? `Host #${state.hostFilter}`}
    </Select.Value>
  </Select.Trigger>
  <Select.Content>
    <Select.Item value={ALL} label="All hosts">All hosts</Select.Item>
    {#each facets.hosts as host (host.id)}<Select.Item value={String(host.id)} label={host.label}>{host.label} ({host.count})</Select.Item>{/each}
  </Select.Content>
</Select.Root>

<Select.Root type="single" value={state.projectFilter} onValueChange={(value) => state.setFilter("project", value || ALL)}>
  <Select.Trigger class="w-36" aria-label="Filter by project">
    <Select.Value placeholder="All projects">
      {state.projectFilter === ALL ? "All projects" : facets.projects.find((item) => item.slug === state.projectFilter)?.label ?? state.projectFilter}
    </Select.Value>
  </Select.Trigger>
  <Select.Content>
    <Select.Item value={ALL} label="All projects">All projects</Select.Item>
    {#each facets.projects as project (project.slug)}<Select.Item value={project.slug} label={project.label}>{project.label} ({project.count})</Select.Item>{/each}
  </Select.Content>
</Select.Root>

<Select.Root type="single" value={state.engineFilter} onValueChange={(value) => state.setFilter("engine", value || ALL)}>
  <Select.Trigger class="w-32" aria-label="Filter by engine">
    <Select.Value placeholder="All engines">{state.engineFilter === ALL ? "All engines" : state.engineFilter}</Select.Value>
  </Select.Trigger>
  <Select.Content>
    <Select.Item value={ALL} label="All engines">All engines</Select.Item>
    {#each facets.engines as engine (engine.value)}<Select.Item value={engine.value} label={engine.value}>{engine.value} ({engine.count})</Select.Item>{/each}
  </Select.Content>
</Select.Root>

{#if state.hasFilters}
  <Button size="sm" variant="ghost" onclick={() => state.clearFilters()}><FilterX class="h-4 w-4" />Reset</Button>
{/if}
