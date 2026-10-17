<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Brain from "@lucide/svelte/icons/brain";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import FilterX from "@lucide/svelte/icons/filter-x";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import List from "@lucide/svelte/icons/list";
  import Network from "@lucide/svelte/icons/network";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";
  import Tags from "@lucide/svelte/icons/tags";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { ApiError } from "$lib/api/client";
  import {
    memoriesApi,
    memoriesKeys,
    type MemoryGraphNode,
    type MemoryRecord,
    type MemoryScope,
  } from "$lib/api/memories";
  import { authStore } from "$lib/stores/auth";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import MemoryAppendDialog from "$lib/components/memories/MemoryAppendDialog.svelte";
  import MemoryEditorDialog from "$lib/components/memories/MemoryEditorDialog.svelte";
  import MemoryGraph from "$lib/components/memories/MemoryGraph.svelte";
  import MemoryInspector from "$lib/components/memories/MemoryInspector.svelte";
  import { displayMemoryKey, formatCharacters } from "$lib/components/memories/atlas-types";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import * as Select from "$lib/components/ui/select";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Table from "$lib/components/ui/table";
  import { cn } from "$lib/utils/cn";
  import { relativeTime } from "$lib/utils/format";

  type ViewMode = "graph" | "list";
  type LayerId = "tags" | "provenance";

  const ALL_SCOPES: MemoryScope[] = ["shared", "project", "host"];
  const ALL = "all";
  const PAGE_SIZE = 25;
  const GRAPH_LIMIT = 500;
  const GRAPH_RENDER_LIMIT = 150;
  const qc = useQueryClient();

  function validScope(value: string): value is MemoryScope {
    return value === "host" || value === "project" || value === "shared";
  }

  function csv(value: string | null): string[] {
    return [...new Set((value ?? "").split(",").map((part) => part.trim()).filter(Boolean))];
  }

  const scopes = $derived.by<MemoryScope[]>(() => {
    const requested = csv(page.url.searchParams.get("scopes")).filter(validScope);
    return requested.length ? requested : ALL_SCOPES;
  });
  const selectedTags = $derived(csv(page.url.searchParams.get("tags")));
  const hostFilter = $derived(page.url.searchParams.get("host") ?? ALL);
  const projectFilter = $derived(page.url.searchParams.get("project") ?? ALL);
  const engineFilter = $derived(page.url.searchParams.get("engine") ?? ALL);
  const viewMode = $derived<ViewMode>(page.url.searchParams.get("view") === "list" ? "list" : "graph");
  const layers = $derived(csv(page.url.searchParams.get("layers")) as LayerId[]);
  const selectedNodeId = $derived(page.url.searchParams.get("node"));

  const urlSearch = $derived(page.url.searchParams.get("q") ?? "");
  let searchInput = $state(untrack(() => urlSearch));
  // eslint-disable-next-line svelte/no-unused-svelte-ignore
  // svelte-ignore state_referenced_locally
  let searchDebounced = $state(searchInput.trim());
  let lastUrlSearch = $state(untrack(() => urlSearch));
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let cursor = $state<string | null>(null);
  let cursorHistory = $state<Array<string | null>>([]);
  let tablePage = $state(0);
  let previousFilterSignature = $state("");
  let createOpen = $state(false);
  let editOpen = $state(false);
  let editTarget = $state<MemoryRecord | null>(null);
  let appendOpen = $state(false);
  let appendTarget = $state<MemoryRecord | null>(null);
  let deleteTarget = $state<MemoryRecord | null>(null);
  let deleteConflict = $state<string | null>(null);

  function updateUrl(change: (url: URL) => void): void {
    const url = new URL(page.url);
    change(url);
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  $effect(() => {
    const next = urlSearch;
    if (next === lastUrlSearch) return;
    lastUrlSearch = next;
    searchInput = next;
    searchDebounced = next.trim();
  });

  $effect(() => {
    const value = searchInput;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchDebounced = value.trim();
      updateUrl((url) => {
        if (searchDebounced) url.searchParams.set("q", searchDebounced);
        else url.searchParams.delete("q");
      });
    }, 250);
  });

  onDestroy(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  function setScopes(next: MemoryScope[]): void {
    updateUrl((url) => {
      if (next.length === ALL_SCOPES.length) url.searchParams.delete("scopes");
      else url.searchParams.set("scopes", next.join(","));
    });
  }

  function toggleScope(scope: MemoryScope): void {
    const next = scopes.includes(scope) ? scopes.filter((item) => item !== scope) : [...scopes, scope];
    if (!next.length) return;
    setScopes(ALL_SCOPES.filter((item) => next.includes(item)));
  }

  function setFilter(name: "host" | "project" | "engine", value: string): void {
    updateUrl((url) => {
      if (value === ALL) url.searchParams.delete(name);
      else url.searchParams.set(name, value);
    });
  }

  function toggleTag(tag: string): void {
    const next = selectedTags.includes(tag)
      ? selectedTags.filter((value) => value !== tag)
      : [...selectedTags, tag];
    updateUrl((url) => {
      if (next.length) url.searchParams.set("tags", next.join(","));
      else url.searchParams.delete("tags");
    });
  }

  function setView(view: ViewMode): void {
    updateUrl((url) => {
      if (view === "graph") url.searchParams.delete("view");
      else url.searchParams.set("view", view);
    });
  }

  function toggleLayer(layer: LayerId): void {
    const next = layers.includes(layer) ? layers.filter((value) => value !== layer) : [...layers, layer];
    updateUrl((url) => {
      if (next.length) url.searchParams.set("layers", next.join(","));
      else url.searchParams.delete("layers");
    });
  }

  function clearFilters(): void {
    searchInput = "";
    updateUrl((url) => {
      for (const key of ["q", "scopes", "tags", "host", "project", "engine"]) url.searchParams.delete(key);
    });
  }

  function selectNode(node: MemoryGraphNode): void {
    if (node.kind !== "memory") return;
    updateUrl((url) => url.searchParams.set("node", node.node_id ?? node.id));
  }

  function clearSelection(): void {
    updateUrl((url) => url.searchParams.delete("node"));
  }

  const filterSignature = $derived([
    ...scopes,
    searchDebounced,
    ...selectedTags,
    hostFilter,
    projectFilter,
    engineFilter,
  ].join("|"));

  $effect(() => {
    const signature = filterSignature;
    if (previousFilterSignature && signature !== previousFilterSignature) {
      cursor = null;
      cursorHistory = [];
      tablePage = 0;
    }
    previousFilterSignature = signature;
  });

  const graphParams = $derived({
    scopes,
    q: searchDebounced || undefined,
    tags: selectedTags.length ? selectedTags : undefined,
    host_id: hostFilter === ALL ? null : hostFilter,
    project_slug: projectFilter === ALL ? null : projectFilter,
    engine: engineFilter === ALL ? null : engineFilter,
    limit: GRAPH_LIMIT,
    cursor,
  });

  const graphQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: memoriesKeys.graph(graphParams),
      queryFn: () => memoriesApi.graph(graphParams),
    })),
  );

  const graphNodes = $derived($graphQuery.data?.nodes ?? []);
  const graphEdges = $derived($graphQuery.data?.edges ?? []);
  const memoryNodes = $derived(graphNodes.filter((node) => node.kind === "memory"));
  const mapMemoryIds = $derived(new Set(memoryNodes.slice(0, GRAPH_RENDER_LIMIT).map((node) => node.id)));
  const mapEdges = $derived(graphEdges.filter((edge) => mapMemoryIds.has(edge.source)));
  const mapRelationIds = $derived(new Set(mapEdges.flatMap((edge) => [edge.source, edge.target])));
  const mapNodes = $derived(
    graphNodes.filter((node) =>
      node.kind === "memory" ? mapMemoryIds.has(node.id) : mapRelationIds.has(node.id),
    ),
  );
  const facets = $derived($graphQuery.data?.facets ?? {
    scopes: [],
    hosts: [],
    projects: [],
    tags: [],
    engines: [],
  });
  const facetsTruncated = $derived($graphQuery.data?.facets_truncated ?? {
    hosts: false,
    projects: false,
    tags: false,
  });
  const truncatedFacetNames = $derived([
    facetsTruncated.hosts ? "host" : "",
    facetsTruncated.projects ? "project" : "",
    facetsTruncated.tags ? "tag" : "",
  ].filter(Boolean).join(", "));
  const totals = $derived($graphQuery.data?.totals ?? { all: 0, shared: 0, project: 0, host: 0 });
  const tablePageCount = $derived(Math.max(1, Math.ceil(memoryNodes.length / PAGE_SIZE)));
  const tableRows = $derived(memoryNodes.slice(tablePage * PAGE_SIZE, (tablePage + 1) * PAGE_SIZE));

  $effect(() => {
    if (tablePage >= tablePageCount) tablePage = Math.max(0, tablePageCount - 1);
  });

  function selectedNodeFallback(id: string): MemoryGraphNode | null {
    const match = /^memory:(host|project|shared):(\d+)$/.exec(id);
    if (!match || !validScope(match[1])) return null;
    return {
      id,
      node_id: id,
      kind: "memory",
      label: id,
      record_id: Number(match[2]),
      scope: match[1],
    };
  }

  const selectedNode = $derived.by<MemoryGraphNode | null>(() => {
    if (!selectedNodeId) return null;
    return graphNodes.find((node) => node.id === selectedNodeId || node.node_id === selectedNodeId)
      ?? selectedNodeFallback(selectedNodeId);
  });

  // `memory.write` is the fleet-wide grant. The per-record `capabilities` the
  // API attaches to each node stay in the disjunction because a record can
  // widen what its own owner may do with it; they never narrow the grant.
  const canCreate = $derived(
    $authStore.authenticated
      && ($authStore.can("memory.write") || memoryNodes.some((node) => node.capabilities?.create)),
  );

  function nextServerPage(): void {
    const next = $graphQuery.data?.next_cursor;
    if (!next) return;
    cursorHistory = [...cursorHistory, cursor];
    cursor = next;
    tablePage = 0;
  }

  function previousServerPage(): void {
    if (!cursorHistory.length) return;
    cursor = cursorHistory[cursorHistory.length - 1] ?? null;
    cursorHistory = cursorHistory.slice(0, -1);
    tablePage = 0;
  }

  function openEdit(memory: MemoryRecord): void {
    editTarget = memory;
    editOpen = true;
  }

  function openAppend(memory: MemoryRecord): void {
    appendTarget = memory;
    appendOpen = true;
  }

  function openDelete(memory: MemoryRecord): void {
    deleteConflict = null;
    deleteTarget = memory;
  }

  const deleteMutation = createMutation({
    mutationFn: (memory: MemoryRecord) => memoriesApi.delete(memory.scope, memory.record_id, memory.etag),
    onSuccess: () => {
      toast.success("Memory permanently deleted");
      deleteTarget = null;
      deleteConflict = null;
      clearSelection();
      void qc.invalidateQueries({ queryKey: memoriesKeys.all });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && (error.status === 409 || error.code === "memory_conflict")) {
        deleteConflict = "This memory changed after you opened it. Reload the inspector before deleting.";
        if (deleteTarget) {
          void qc.invalidateQueries({ queryKey: memoriesKeys.detail(deleteTarget.scope, deleteTarget.record_id) });
        }
        return;
      }
      toast.error(error instanceof Error ? error.message : "Could not delete memory");
    },
  });

  const hasFilters = $derived(
    !!searchDebounced
      || scopes.length !== ALL_SCOPES.length
      || selectedTags.length > 0
      || hostFilter !== ALL
      || projectFilter !== ALL
      || engineFilter !== ALL,
  );

  // Unified paging status line: whether the server has more pages beyond the
  // currently loaded window, and whether the graph canvas is truncating what
  // it draws from that window (list view never truncates — it paginates).
  const serverHasMore = $derived(Boolean($graphQuery.data?.next_cursor) || cursorHistory.length > 0);
  const graphIsCapped = $derived(memoryNodes.length > GRAPH_RENDER_LIMIT);
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
  <p class="text-sm text-muted-foreground">
    <span class="font-medium text-foreground">{totals.all.toLocaleString()}</span>
    {totals.all === 1 ? "memory" : "memories"} across fleet, project, and host scope
  </p>
  <div class="flex items-center gap-2">
    <Button variant="outline" size="sm" onclick={() => void $graphQuery.refetch()} disabled={$graphQuery.isFetching}>
      <RefreshCw class={$graphQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Refresh
    </Button>
    {#if canCreate}
      <Button size="sm" onclick={() => (createOpen = true)}><Plus class="h-4 w-4" />Create memory</Button>
    {/if}
  </div>
</div>

<section class="mb-4 space-y-4 rounded-md border border-border/70 bg-card p-4" aria-label="Memory filters">
  <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
    <div class="relative min-w-0 flex-1">
      <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input bind:value={searchInput} class="pl-9" aria-label="Search all memories" placeholder="Search keys, titles, summaries, tags…" />
    </div>
    <div class="flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 p-1" aria-label="View mode">
      <Button size="sm" variant={viewMode === "graph" ? "secondary" : "ghost"} onclick={() => setView("graph")} aria-pressed={viewMode === "graph"}>
        <Network class="h-4 w-4" /> Graph
      </Button>
      <Button size="sm" variant={viewMode === "list" ? "secondary" : "ghost"} onclick={() => setView("list")} aria-pressed={viewMode === "list"}>
        <List class="h-4 w-4" /> List
      </Button>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <span class="mr-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Scope</span>
    {#each ALL_SCOPES as scope (scope)}
      <Button size="sm" variant={scopes.includes(scope) ? "secondary" : "outline"} class="capitalize" onclick={() => toggleScope(scope)} aria-pressed={scopes.includes(scope)}>
        {scope}
        <span class="ml-1 text-[10px] opacity-65">{totals[scope]}</span>
      </Button>
    {/each}

    <Select.Root type="single" value={hostFilter} onValueChange={(value) => setFilter("host", value || ALL)}>
      <Select.Trigger class="w-[190px]" aria-label="Filter by host"><Select.Value placeholder="All hosts">{hostFilter === ALL ? "All hosts" : facets.hosts.find((item) => String(item.id) === hostFilter)?.label ?? `Host #${hostFilter}`}</Select.Value></Select.Trigger>
      <Select.Content>
        <Select.Item value={ALL} label="All hosts">All hosts</Select.Item>
        {#each facets.hosts as host (host.id)}<Select.Item value={String(host.id)} label={host.label}>{host.label} ({host.count})</Select.Item>{/each}
      </Select.Content>
    </Select.Root>

    <Select.Root type="single" value={projectFilter} onValueChange={(value) => setFilter("project", value || ALL)}>
      <Select.Trigger class="w-[190px]" aria-label="Filter by project"><Select.Value placeholder="All projects">{projectFilter === ALL ? "All projects" : facets.projects.find((item) => item.slug === projectFilter)?.label ?? projectFilter}</Select.Value></Select.Trigger>
      <Select.Content>
        <Select.Item value={ALL} label="All projects">All projects</Select.Item>
        {#each facets.projects as project (project.slug)}<Select.Item value={project.slug} label={project.label}>{project.label} ({project.count})</Select.Item>{/each}
      </Select.Content>
    </Select.Root>

    <Select.Root type="single" value={engineFilter} onValueChange={(value) => setFilter("engine", value || ALL)}>
      <Select.Trigger class="w-[150px]" aria-label="Filter by engine"><Select.Value placeholder="All engines">{engineFilter === ALL ? "All engines" : engineFilter}</Select.Value></Select.Trigger>
      <Select.Content>
        <Select.Item value={ALL} label="All engines">All engines</Select.Item>
        {#each facets.engines as engine (engine.value)}<Select.Item value={engine.value} label={engine.value}>{engine.value} ({engine.count})</Select.Item>{/each}
      </Select.Content>
    </Select.Root>

    {#if hasFilters}
      <Button size="sm" variant="ghost" onclick={clearFilters}><FilterX class="h-4 w-4" />Reset</Button>
    {/if}
  </div>

  {#if facets.tags.length || selectedTags.length}
    <div class="flex items-start gap-2 border-t border-border/60 pt-3">
      <Tags class="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      <div class="flex flex-wrap gap-1.5">
        {#each facets.tags.slice(0, 18) as tag (tag.value)}
          <button
            type="button"
            class={cn(
              "rounded-full border px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selectedTags.includes(tag.value)
                ? "border-primary/35 bg-primary/10 text-primary"
                : "border-border/75 bg-background text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={selectedTags.includes(tag.value)}
            onclick={() => toggleTag(tag.value)}
          >
            {tag.value} <span class="opacity-60">{tag.count}</span>
          </button>
        {/each}
        {#each selectedTags.filter((selected) => !facets.tags.some((tag) => tag.value === selected)) as tag (tag)}
          <button type="button" class="rounded-full border border-primary/35 bg-primary/10 px-2 py-1 text-[11px] text-primary" aria-pressed="true" onclick={() => toggleTag(tag)}>{tag} ×</button>
        {/each}
      </div>
    </div>
  {/if}

  {#if truncatedFacetNames}
    <p class="border-t border-border/60 pt-3 text-xs text-muted-foreground">
      Capped filter choices ({truncatedFacetNames}) show the top 200 values; the current graph/list page remains complete.
    </p>
  {/if}
</section>

{#if viewMode === "graph"}
  <section class="overflow-hidden rounded-md border border-border/70 bg-card">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
      <div>
        <h3 class="text-sm font-semibold">Relationship map</h3>
        <p class="text-xs text-muted-foreground">Scope and ownership are always shown; optional layers stay explicit.</p>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant={layers.includes("tags") ? "secondary" : "outline"} onclick={() => toggleLayer("tags")} aria-pressed={layers.includes("tags")}>
          <Tags class="h-3.5 w-3.5" />Tags
        </Button>
        <Button size="sm" variant={layers.includes("provenance") ? "secondary" : "outline"} onclick={() => toggleLayer("provenance")} aria-pressed={layers.includes("provenance")}>
          <GitBranch class="h-3.5 w-3.5" />Provenance
        </Button>
      </div>
    </div>

    {#if $graphQuery.isLoading}
      <div class="grid min-h-[520px] place-items-center bg-muted/20"><div class="space-y-3 text-center"><Skeleton class="mx-auto h-16 w-64" /><p class="text-sm text-muted-foreground">Mapping memory relationships…</p></div></div>
    {:else if $graphQuery.isError}
      <div class="grid min-h-[420px] place-items-center p-6 text-center">
        <div><p class="font-semibold text-destructive">The atlas could not be loaded</p><p class="mt-1 text-sm text-muted-foreground">{$graphQuery.error instanceof Error ? $graphQuery.error.message : "Unknown error"}</p><Button class="mt-4" variant="outline" onclick={() => $graphQuery.refetch()}>Try again</Button></div>
      </div>
    {:else if memoryNodes.length === 0}
      <div class="grid min-h-[420px] place-items-center p-8 text-center">
        <div class="max-w-sm"><div class="mx-auto grid h-14 w-14 place-items-center rounded-md bg-muted"><Brain class="h-6 w-6 text-muted-foreground" /></div><h3 class="mt-4 font-semibold">{hasFilters ? "No memories match" : "The atlas is empty"}</h3><p class="mt-1 text-sm text-muted-foreground">{hasFilters ? "Adjust filters to reveal another part of the topology." : "Create the first memory to start mapping durable context."}</p>{#if hasFilters}<Button class="mt-4" variant="outline" onclick={clearFilters}>Clear filters</Button>{:else if canCreate}<Button class="mt-4" onclick={() => (createOpen = true)}><Plus class="h-4 w-4" />Create memory</Button>{/if}</div>
      </div>
    {:else}
      <MemoryGraph
        nodes={mapNodes}
        edges={mapEdges}
        {selectedNodeId}
        showTags={layers.includes("tags")}
        showProvenance={layers.includes("provenance")}
        onSelect={selectNode}
      />
    {/if}
  </section>
{:else}
  <section class="overflow-hidden rounded-md border border-border/70 bg-card">
    <div class="border-b border-border/70 px-4 py-3"><h3 class="text-sm font-semibold">Memory inventory</h3><p class="text-xs text-muted-foreground">Keyboard-friendly dense view of the same filtered graph page.</p></div>
    <div class="overflow-x-auto">
      <Table.Root>
        <Table.Header><Table.Row><Table.Head>Memory</Table.Head><Table.Head>Scope & owner</Table.Head><Table.Head>Length</Table.Head><Table.Head>Engine</Table.Head><Table.Head>Updated</Table.Head><Table.Head>Tags</Table.Head><Table.Head class="text-right">Action</Table.Head></Table.Row></Table.Header>
        <Table.Body>
          {#if $graphQuery.isLoading}
            <Table.Row><Table.Cell colspan={7} class="py-10 text-center text-sm text-muted-foreground">Loading memories…</Table.Cell></Table.Row>
          {:else if $graphQuery.isError}
            <Table.Row><Table.Cell colspan={7} class="py-10 text-center text-sm text-destructive">{$graphQuery.error instanceof Error ? $graphQuery.error.message : "Could not load memories"}</Table.Cell></Table.Row>
          {:else if tableRows.length === 0}
            <Table.Row><Table.Cell colspan={7} class="py-10 text-center text-sm text-muted-foreground">No memories match these filters.</Table.Cell></Table.Row>
          {:else}
            {#each tableRows as row (row.id)}
              <Table.Row class="hover:bg-muted/35">
                <Table.Cell class="min-w-[240px]"><button type="button" class="max-w-[320px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onclick={() => selectNode(row)}><span class="block truncate font-mono text-xs font-semibold">{displayMemoryKey(row)}</span><span class="mt-0.5 block line-clamp-1 text-xs text-muted-foreground">{row.summary || row.preview || "No summary"}</span></button></Table.Cell>
                <Table.Cell><Badge variant="outline" class="capitalize">{row.scope}</Badge><p class="mt-1 max-w-[180px] truncate text-xs text-muted-foreground">{row.host || row.project_slug || "Fleet-wide"}</p></Table.Cell>
                <Table.Cell class="text-sm tabular-nums">{formatCharacters(row.content_length ?? 0)}</Table.Cell>
                <Table.Cell class="text-sm text-muted-foreground">{row.engine ?? "—"}</Table.Cell>
                <Table.Cell class="whitespace-nowrap text-xs text-muted-foreground">{row.updated_at ? relativeTime(row.updated_at) : "—"}</Table.Cell>
                <Table.Cell><div class="flex max-w-[220px] flex-wrap gap-1">{#each (row.tags ?? []).slice(0, 4) as tag (tag)}<Badge variant="outline" class="px-1.5 py-0 text-[10px]">{tag}</Badge>{/each}{#if (row.tags?.length ?? 0) > 4}<span class="text-[10px] text-muted-foreground">+{(row.tags?.length ?? 0) - 4}</span>{/if}</div></Table.Cell>
                <Table.Cell class="text-right"><Button size="sm" variant="ghost" onclick={() => selectNode(row)}>Inspect</Button></Table.Cell>
              </Table.Row>
            {/each}
          {/if}
        </Table.Body>
      </Table.Root>
    </div>
  </section>
{/if}

{#if !$graphQuery.isLoading && !$graphQuery.isError && memoryNodes.length > 0 && (serverHasMore || (viewMode === "graph" && graphIsCapped) || (viewMode === "list" && memoryNodes.length > PAGE_SIZE))}
  <div class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/25 px-4 py-2.5 text-xs text-muted-foreground">
    <p>
      {#if viewMode === "list"}
        {tablePage * PAGE_SIZE + 1}–{Math.min((tablePage + 1) * PAGE_SIZE, memoryNodes.length)} of {memoryNodes.length} loaded
      {:else if graphIsCapped}
        Map shows the newest {GRAPH_RENDER_LIMIT} of {memoryNodes.length} loaded — switch to list for the rest
      {:else}
        {memoryNodes.length} loaded
      {/if}
      {#if serverHasMore}
        · server page {cursorHistory.length + 1}{$graphQuery.data?.count ? ` of ${$graphQuery.data.count} matching` : ""}
      {/if}
    </p>
    <div class="flex items-center gap-1">
      {#if viewMode === "list" && memoryNodes.length > PAGE_SIZE}
        <Button size="sm" variant="outline" onclick={() => (tablePage = Math.max(0, tablePage - 1))} disabled={tablePage === 0} aria-label="Previous table page"><ChevronLeft class="h-4 w-4" /></Button>
        <Button size="sm" variant="outline" onclick={() => (tablePage = Math.min(tablePageCount - 1, tablePage + 1))} disabled={tablePage >= tablePageCount - 1} aria-label="Next table page"><ChevronRight class="h-4 w-4" /></Button>
      {/if}
      {#if serverHasMore}
        <Button size="sm" variant="outline" onclick={previousServerPage} disabled={!cursorHistory.length}><ChevronLeft class="h-4 w-4" />Previous 500</Button>
        <Button size="sm" variant="outline" onclick={nextServerPage} disabled={!$graphQuery.data?.next_cursor}>Next 500<ChevronRight class="h-4 w-4" /></Button>
      {/if}
    </div>
  </div>
{/if}

<MemoryInspector
  open={!!selectedNode}
  node={selectedNode}
  onOpenChange={(next) => { if (!next) clearSelection(); }}
  onEdit={openEdit}
  onAppend={openAppend}
  onDelete={openDelete}
/>

<MemoryEditorDialog
  bind:open={createOpen}
  mode="create"
  onOpenChange={(next) => (createOpen = next)}
  onSaved={(memory) => updateUrl((url) => url.searchParams.set("node", memory.node_id))}
/>

<MemoryEditorDialog
  bind:open={editOpen}
  mode="edit"
  memory={editTarget}
  onOpenChange={(next) => { editOpen = next; if (!next) editTarget = null; }}
/>

<MemoryAppendDialog
  bind:open={appendOpen}
  memory={appendTarget}
  onOpenChange={(next) => { appendOpen = next; if (!next) appendTarget = null; }}
/>

<Dialog.Root open={!!deleteTarget} onOpenChange={(next) => { if (!next) { deleteTarget = null; deleteConflict = null; } }}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Delete memory permanently?</Dialog.Title>
      <Dialog.Description>
        <span class="font-mono">{deleteTarget?.id}</span> will be removed from the {deleteTarget?.scope} scope. There is no trash, restore, or rollback.
      </Dialog.Description>
    </Dialog.Header>
    {#if deleteConflict}<p class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{deleteConflict}</p>{/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={() => { deleteTarget = null; deleteConflict = null; }} disabled={$deleteMutation.isPending}>Cancel</Button>
      <Button variant="destructive" onclick={() => deleteTarget && $deleteMutation.mutate(deleteTarget)} disabled={$deleteMutation.isPending || !!deleteConflict}>
        <Trash2 class="h-4 w-4" />{$deleteMutation.isPending ? "Deleting…" : "Delete permanently"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
