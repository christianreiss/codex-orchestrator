<script lang="ts">
  import { onDestroy } from "svelte";
  import { writable } from "svelte/store";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import Search from "@lucide/svelte/icons/search";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { usageIngestsQuery, type SortDirection } from "$lib/api/logs";
  import type { UsageIngestPage, UsageIngestRow } from "$lib/api/types";
  import { formatTokens, relativeTime } from "$lib/utils/format";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
  } from "$lib/components/ui/select";
  import LogTable from "$lib/components/logs/LogTable.svelte";
  import type { LogTableColumn } from "$lib/components/logs/log-table-types";
  import LogToolbar from "$lib/components/logs/LogToolbar.svelte";

  const PAGE_SIZES = [10, 25, 50, 100, 250] as const;

  let searchInput = $state("");
  let q = $state("");
  let limit = $state<number>(50);
  let offset = $state<number>(0);
  let sort = $state<string>("created_at");
  let dir = $state<SortDirection>("desc");

  // Debounce search input → committed q (300ms).
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  function onSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    searchInput = value;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      q = value;
      offset = 0;
    }, 300);
  }
  onDestroy(() => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
  });

  const queryClient = useQueryClient();

  // svelte-query 5.90's Svelte adapter accepts a Readable<options>; we keep a
  // writable in sync with rune state via $effect so the observer updates
  // smoothly without recreating itself on every param change.
  const optionsStore = writable(usageIngestsQuery({}));
  $effect(() => {
    optionsStore.set(usageIngestsQuery({ limit, offset, q, sort, dir }));
  });

  const query = createQuery<UsageIngestPage, Error>(optionsStore);
  const result = $derived($query);
  const rows = $derived<UsageIngestRow[]>(result.data?.items ?? []);
  const total = $derived(result.data?.total ?? 0);
  const page = $derived(result.data?.page ?? 1);
  const pages = $derived(result.data?.pages ?? 1);

  function toggleSort(id: string) {
    if (sort === id) {
      dir = dir === "asc" ? "desc" : "asc";
    } else {
      sort = id;
      dir = "desc";
    }
    offset = 0;
  }

  function setLimit(value: string) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    limit = n;
    offset = 0;
  }

  function prevPage() {
    offset = Math.max(0, offset - limit);
  }
  function nextPage() {
    if (page < pages) offset = offset + limit;
  }
  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["logs", "api"] });
  }

  const columns: LogTableColumn<UsageIngestRow>[] = [
    {
      id: "created_at",
      header: "Timestamp",
      sortable: true,
      class: "w-[160px] shrink-0",
      cell: tsCell,
    },
    {
      id: "host",
      header: "FQDN",
      sortable: true,
      class: "min-w-0 flex-1",
      cell: hostCell,
    },
    {
      id: "client_ip",
      header: "Client IP",
      sortable: true,
      class: "w-[140px] shrink-0",
      cell: ipCell,
    },
    {
      id: "input",
      header: "Input",
      sortable: true,
      class: "w-[80px] shrink-0 justify-end",
      headerClass: "justify-end",
      cell: inputCell,
    },
    {
      id: "output",
      header: "Output",
      sortable: true,
      class: "w-[80px] shrink-0 justify-end",
      headerClass: "justify-end",
      cell: outputCell,
    },
    {
      id: "cached",
      header: "Cached",
      sortable: true,
      class: "w-[80px] shrink-0 justify-end",
      headerClass: "justify-end",
      cell: cachedCell,
    },
    {
      id: "reasoning",
      header: "Reasoning",
      sortable: true,
      class: "w-[90px] shrink-0 justify-end",
      headerClass: "justify-end",
      cell: reasoningCell,
    },
  ];

  function rowKey(row: UsageIngestRow): string {
    return String(row.id);
  }
</script>

{#snippet tsCell(row: UsageIngestRow)}
  <span
    class="truncate text-muted-foreground"
    title={row.created_at ?? ""}>
    {row.created_at ? relativeTime(row.created_at) : "—"}
  </span>
{/snippet}

{#snippet hostCell(row: UsageIngestRow)}
  <span class="truncate font-mono text-[12px]">{row.fqdn ?? "—"}</span>
{/snippet}

{#snippet ipCell(row: UsageIngestRow)}
  <span class="truncate font-mono text-[12px] text-muted-foreground">
    {row.client_ip ?? "—"}
  </span>
{/snippet}

{#snippet inputCell(row: UsageIngestRow)}
  <span class="font-mono tabular-nums">{formatTokens((row.input ?? 0) as number)}</span>
{/snippet}

{#snippet outputCell(row: UsageIngestRow)}
  <span class="font-mono tabular-nums">{formatTokens((row.output ?? 0) as number)}</span>
{/snippet}

{#snippet cachedCell(row: UsageIngestRow)}
  <span class="font-mono tabular-nums">{formatTokens((row.cached ?? 0) as number)}</span>
{/snippet}

{#snippet reasoningCell(row: UsageIngestRow)}
  <span class="font-mono tabular-nums">{formatTokens((row.reasoning ?? 0) as number)}</span>
{/snippet}

<div class="space-y-4">
  <LogToolbar>
    <div class="relative min-w-0 flex-1 sm:max-w-md">
      <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        placeholder="Search FQDN, client IP, or ID…"
        value={searchInput}
        oninput={onSearchInput}
        class="pl-9" />
    </div>
    <div class="flex items-center gap-2">
      <label class="text-xs font-medium uppercase tracking-wide text-muted-foreground" for="page-size">
        Page size
      </label>
      <Select
        type="single"
        value={String(limit)}
        onValueChange={(v: unknown) => setLimit(String(v))}>
        <SelectTrigger id="page-size" class="h-9 w-[88px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {#each PAGE_SIZES as size (size)}
            <SelectItem value={String(size)} label={String(size)}>{size}</SelectItem>
          {/each}
        </SelectContent>
      </Select>
    </div>
    <div class="ml-auto flex items-center gap-2">
      <Button variant="outline" size="sm" onclick={refresh}>
        <RefreshCw class="h-4 w-4" />
        Refresh
      </Button>
    </div>
  </LogToolbar>

  <LogTable
    rows={rows}
    columns={columns}
    rowHeight={44}
    sortBy={sort}
    sortDir={dir}
    onSort={toggleSort}
    {rowKey}
    loading={result.isPending}
    emptyMessage="No API traffic yet."
    virtualize={false} />

  <div class="flex flex-col items-center justify-between gap-3 text-xs text-muted-foreground sm:flex-row">
    <div>
      Showing
      <span class="font-medium text-foreground">{rows.length}</span>
      of
      <span class="font-medium text-foreground">{total.toLocaleString()}</span>
      rows
      {#if pages > 1}
        · page <span class="font-medium text-foreground">{page}</span> / {pages}
      {/if}
      {#if result.isFetching && !result.isPending}
        · refreshing…
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" disabled={offset <= 0} onclick={prevPage}>Previous</Button>
      <Button variant="outline" size="sm" disabled={page >= pages} onclick={nextPage}>Next</Button>
    </div>
  </div>
</div>
