<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SearchIcon from "@lucide/svelte/icons/search";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import NodeDetail from "$lib/components/topology/NodeDetail.svelte";
  import TopologyGraph from "$lib/components/topology/TopologyGraph.svelte";
  import TopologyList from "$lib/components/topology/TopologyList.svelte";
  import { topologyQuery, type Topology } from "$lib/api/topology";
  import { emptyGhostState, graphModel, summarize, trackGhosts, type GhostState } from "$lib/topology/model";

  const topology = topologyQuery();

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  // Nodes that just left stay on the canvas, faded, for a few seconds.
  let ghostState = $state<GhostState>(emptyGhostState());
  let latest: Topology | undefined;
  $effect(() => {
    const data = $topology.data;
    if (!data) return;
    latest = data;
    ghostState = trackGhosts(untrack(() => ghostState), data, Date.now());
  });
  // Ghosts also age out on the clock, not only when the next snapshot lands.
  $effect(() => {
    void now;
    const current = untrack(() => ghostState);
    if (current.ghosts.size === 0 || !latest) return;
    const next = trackGhosts(current, latest, Date.now());
    if (next.ghosts.size !== current.ghosts.size) ghostState = next;
  });

  const model = $derived(graphModel($topology.data, ghostState, now));
  const summary = $derived(summarize($topology.data));

  let view = $state<"radial" | "list">("radial");
  let query = $state("");
  let selectedId = $state<string | null>(page.url.searchParams.get("node"));
  function select(id: string | null) {
    selectedId = id;
    const url = new URL(page.url);
    if (id) url.searchParams.set("node", id);
    else url.searchParams.delete("node");
    try {
      replaceState(url, {});
    } catch {
      /* The router is not ready during the first paint; selection still works. */
    }
  }
  const selectedItem = $derived(
    selectedId ? ([...model.communicators, ...model.agents].find((item) => item.node.id === selectedId) ?? null) : null,
  );
  // A selection that no longer exists (and has no ghost) is dropped.
  $effect(() => {
    if (selectedId && $topology.data && !selectedItem) select(null);
  });

  const stale = $derived($topology.isError && Boolean($topology.data));
  const updated = $derived($topology.data ? new Date($topology.data.generated_at).toLocaleTimeString() : "—");
</script>

<svelte:head><title>Topology · Codex Orchestrator</title></svelte:head>

<PageHeader
  title="Live topology"
  subtitle="The server, the communicators connected to it, and the agent sessions each one demonstrably carries."
>
  {#snippet actions()}
    <div class="relative w-full sm:w-56">
      <SearchIcon class="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input bind:value={query} type="search" placeholder="Find a node…" aria-label="Find a node" class="pl-8" />
    </div>
    <div class="inline-flex h-9 items-center rounded-md bg-muted p-1" role="group" aria-label="View">
      {#each [["radial", "Radial"], ["list", "List"]] as const as [value, label] (value)}
        <button
          type="button"
          class="h-7 rounded px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
          aria-pressed={view === value}
          onclick={() => (view = value)}
        >{label}</button>
      {/each}
    </div>
    <Button variant="outline" size="sm" onclick={() => $topology.refetch()} disabled={$topology.isFetching} aria-label="Refresh topology">
      <RefreshCwIcon class="h-4 w-4 {$topology.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}" /> Refresh
    </Button>
  {/snippet}
</PageHeader>

{#if $topology.isError && !$topology.data}
  <div role="alert" class="rounded-lg border border-destructive/30 bg-destructive-muted p-4 text-sm text-destructive-muted-foreground">
    <p class="font-medium">The topology could not be loaded.</p>
    <p class="mt-1">{$topology.error.message}</p>
    <Button class="mt-3" variant="outline" size="sm" onclick={() => $topology.refetch()}>Try again</Button>
  </div>
{:else if $topology.isPending}
  <Skeleton class="h-[60vh] w-full rounded-lg" />
{:else}
  <div class="mb-3 flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
    <Badge variant="outline">{summary.communicators} communicator{summary.communicators === 1 ? "" : "s"}</Badge>
    <Badge variant="outline">{summary.agents} agent{summary.agents === 1 ? "" : "s"}</Badge>
    <Badge variant="success">{summary.attributed} via a communicator</Badge>
    {#if summary.stale > 0}<Badge variant="warning">{summary.stale} link quiet</Badge>{/if}
    <Badge variant="secondary">{summary.unattributed} direct</Badge>
    <span class="ml-auto text-xs text-muted-foreground">
      {#if stale}<span class="text-warning">Showing the last good snapshot. </span>{/if}Updated {updated}
    </span>
  </div>

  {#if $topology.data && !$topology.data.server.communicator_enabled}
    <p class="mb-3 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
      The communicator transport is switched off on this server, so every session connects directly.
    </p>
  {/if}

  <div class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
    <div class="h-[62vh] min-h-[24rem] min-w-0 lg:h-[calc(100vh-17rem)]">
      {#if view === "radial"}
        <TopologyGraph server={$topology.data?.server} {model} {selectedId} {query} onselect={select} />
      {:else}
        <div class="h-full overflow-y-auto pr-1"><TopologyList {model} {selectedId} {query} onselect={select} /></div>
      {/if}
    </div>
    <aside class="min-h-0 min-w-0 rounded-lg border bg-card p-4 lg:h-[calc(100vh-17rem)]" aria-label="Selection details">
      <NodeDetail snapshot={$topology.data} item={selectedItem} onselect={select} />
    </aside>
  </div>
{/if}
