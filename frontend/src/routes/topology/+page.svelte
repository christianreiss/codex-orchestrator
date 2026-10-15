<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SearchIcon from "@lucide/svelte/icons/search";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import ClientsWorkspace from "$lib/components/portal/ClientsWorkspace.svelte";
  import { authStore } from "$lib/stores/auth";
  import NodeDetail from "$lib/components/topology/NodeDetail.svelte";
  import TopologyGraph from "$lib/components/topology/TopologyGraph.svelte";
  import TopologyList from "$lib/components/topology/TopologyList.svelte";
  import { topologyQuery, type Topology } from "$lib/api/topology";
  import { emptyGhostState, graphModel, filterGraph, summarize, trackGhosts, type GhostState } from "$lib/topology/model";

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
  let filters = $state({ engine: "all", status: "all", host: "all", mode: "all" });
  let collapsed = $state(new Set<string>());
  let chatId = $state<string | null>(null);
  let chatOpen = $state(false);
  let spawnHost = $state<number | undefined>();
  let spawnOpen = $state(false);
  let graph = $state<TopologyGraph>();
  let fullscreen = $state(false);
  let loadedPreferences = $state(false);
  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("topology-view-v1") ?? "null");
      if (saved?.view === "list" || saved?.view === "radial") view = saved.view;
      if (saved?.filters) for (const key of ["engine", "status", "host", "mode"] as const) if (typeof saved.filters[key] === "string") filters[key] = saved.filters[key];
    } catch { /* Storage is optional. */ }
    loadedPreferences = true;
  });
  $effect(() => { if (loadedPreferences) { try { localStorage.setItem("topology-view-v1", JSON.stringify({ view, filters })); } catch { /* Storage is optional. */ } } });
  const visibleModel = $derived(filterGraph(model, filters, collapsed));
  function startAgent(host?: number) { spawnHost = host; spawnOpen = true; chatOpen = true; }
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

  <div class={fullscreen ? "fixed inset-0 z-40 flex flex-col bg-background p-4" : "flex min-h-0 flex-col"}>
  <div class="mb-2 flex flex-wrap items-center gap-2 text-xs">
    <select aria-label="Filter engine" bind:value={filters.engine} class="rounded border bg-background p-2"><option value="all">All engines</option><option>codex</option><option>claude</option><option>grok</option></select>
    <select aria-label="Filter status" bind:value={filters.status} class="rounded border bg-background p-2"><option value="all">All statuses</option>{#each [...new Set(model.agents.map(a => a.node.presence))] as status}<option value={status}>{status}</option>{/each}</select>
    <select aria-label="Filter host" bind:value={filters.host} class="rounded border bg-background p-2"><option value="all">All hosts</option>{#each [...new Map([...model.communicators, ...model.agents].map(a => [a.node.host_id, a.node.host])).entries()] as [id, host]}<option value={String(id)}>{host}</option>{/each}</select>
    <select aria-label="Filter runtime" bind:value={filters.mode} class="rounded border bg-background p-2"><option value="all">All runtimes</option><option value="resident">Persistent</option><option value="on_demand">On demand</option><option value="unknown">Unknown</option></select>
    <Button size="sm" variant="ghost" onclick={() => { filters = { engine: "all", status: "all", host: "all", mode: "all" }; collapsed = new Set(); }}>Reset filters</Button>
    <Button size="sm" variant="ghost" disabled={!selectedId} onclick={() => graph?.centerSelection()}>Center selection</Button>
    <Button size="sm" variant="ghost" onclick={() => fullscreen = !fullscreen}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</Button>
    <Button size="sm" disabled={!$authStore.can("agent_messaging.manage")} onclick={() => startAgent()}>Start agent</Button>
  </div>
  <div class="relative min-h-0 flex-1 {chatOpen ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,40%)] lg:gap-3' : ''}">
  <div class="relative min-w-0">
    <div class={fullscreen ? "h-[calc(100dvh-6rem)] min-w-0" : "h-[62vh] min-h-[24rem] min-w-0 lg:h-[calc(100vh-17rem)]"}>
      {#if view === "radial"}
        <TopologyGraph bind:this={graph} server={$topology.data?.server} model={visibleModel} {selectedId} {query} onselect={select} />
      {:else}
        <div class="h-full overflow-y-auto pr-1"><TopologyList model={visibleModel} {selectedId} {query} onselect={select} /></div>
      {/if}
    </div>
    <aside class:hidden={!selectedItem} class="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-0 right-0 z-20 max-h-[55dvh] sm:absolute sm:bottom-3 sm:left-3 sm:right-3 sm:max-h-[55%] overflow-y-auto rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur sm:right-auto sm:w-80 {chatOpen ? 'max-lg:invisible' : ''}" aria-label="Selection details">
      <div class="mb-2 flex justify-end gap-2">
        {#if selectedItem?.node.kind === "communicator"}<Button variant="ghost" size="sm" onclick={() => { const next = new Set(collapsed); if (next.has(selectedItem!.node.id)) next.delete(selectedItem!.node.id); else next.add(selectedItem!.node.id); collapsed = next; }}>{collapsed.has(selectedItem.node.id) ? "Expand" : "Collapse"} agents ({selectedItem.node.agent_ids.length})</Button>{/if}
        <Button variant="ghost" size="sm" aria-label="Close inspector" onclick={() => select(null)}>Close</Button>
      </div>
      <NodeDetail snapshot={$topology.data} item={selectedItem} onselect={select} onchat={(id) => { chatId = id; chatOpen = true; }} onspawn={startAgent} />
    </aside>
  </div>
  <aside class={chatOpen ? "absolute inset-0 z-10 flex min-h-0 flex-col rounded-xl border bg-card lg:static" : "hidden"} aria-label="Topology conversation">
    <div class="flex items-center justify-between border-b p-2"><span class="text-sm font-medium">Conversation</span><Button size="sm" variant="ghost" onclick={() => chatOpen = false}>Close chat</Button></div>
    {#if chatId || spawnOpen || chatOpen}<ClientsWorkspace embedded sessionId={chatId} {spawnHost} bind:spawnOpen />{/if}
  </aside>
  </div></div>
{/if}
