<script lang="ts">
  import { writable } from "svelte/store";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import Search from "@lucide/svelte/icons/search";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { mcpLogsQuery } from "$lib/api/logs";
  import type { McpAccessLogRow } from "$lib/api/types";
  import { relativeTime } from "$lib/utils/format";
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
  import StatusBadge from "$lib/components/logs/StatusBadge.svelte";
  import JsonExpando from "$lib/components/logs/JsonExpando.svelte";

  // --- URL-synced filters --------------------------------------------------
  function initStatusFilter(): "all" | "ok" | "fail" {
    const v = page.url.searchParams.get("status");
    return v === "ok" || v === "fail" ? v : "all";
  }

  let searchInput = $state(page.url.searchParams.get("q") ?? "");
  let statusFilter = $state<"all" | "ok" | "fail">(initStatusFilter());

  $effect(() => {
    const url = new URL(page.url);
    const sp = url.searchParams;
    if (searchInput === "") sp.delete("q");
    else sp.set("q", searchInput);
    if (statusFilter === "all") sp.delete("status");
    else sp.set("status", statusFilter);
    if (url.search !== page.url.search) {
      void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
    }
  });

  const queryClient = useQueryClient();
  const mcpOptions = writable(mcpLogsQuery(200));
  const query = createQuery<McpAccessLogRow[], Error>(mcpOptions);
  const result = $derived($query);
  const allRows = $derived<McpAccessLogRow[]>(result.data ?? []);

  function isOk(row: McpAccessLogRow): boolean {
    return Boolean(row.success);
  }

  const rows = $derived.by(() => {
    const needle = searchInput.trim().toLowerCase();
    return allRows.filter((row) => {
      if (statusFilter === "ok" && !isOk(row)) return false;
      if (statusFilter === "fail" && isOk(row)) return false;
      if (needle === "") return true;
      const host = (row.host_fqdn ?? "").toLowerCase();
      const tool = (row.name ?? "").toLowerCase();
      const method = (row.method ?? "").toLowerCase();
      return host.includes(needle) || tool.includes(needle) || method.includes(needle);
    });
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["logs", "mcp"] });
  }

  function rowKey(row: McpAccessLogRow): string {
    return String(row.id);
  }

  const columns: LogTableColumn<McpAccessLogRow>[] = [
    {
      id: "created_at",
      header: "Timestamp",
      class: "w-[160px] shrink-0",
      cell: tsCell,
    },
    {
      id: "host",
      header: "Host",
      class: "min-w-0 flex-1",
      cell: hostCell,
    },
    {
      id: "tool",
      header: "Tool / Method",
      class: "min-w-0 flex-1",
      cell: toolCell,
    },
    {
      id: "status",
      header: "Status",
      class: "w-[160px] shrink-0",
      cell: statusCell,
    },
  ];
</script>

{#snippet tsCell(row: McpAccessLogRow)}
  <span class="truncate text-muted-foreground" title={row.created_at ?? ""}>
    {row.created_at ? relativeTime(row.created_at) : "—"}
  </span>
{/snippet}

{#snippet hostCell(row: McpAccessLogRow)}
  <span class="truncate font-mono text-[12px]">{row.host_fqdn ?? "—"}</span>
{/snippet}

{#snippet toolCell(row: McpAccessLogRow)}
  <div class="flex min-w-0 flex-col">
    <span class="truncate font-mono text-[12px]">{row.name ?? "—"}</span>
    {#if row.method && row.method !== row.name}
      <span class="truncate text-[11px] text-muted-foreground">{row.method}</span>
    {/if}
  </div>
{/snippet}

{#snippet statusCell(row: McpAccessLogRow)}
  <StatusBadge
    ok={isOk(row)}
    code={row.error_code}
    message={row.error_message} />
{/snippet}

{#snippet expanded(row: McpAccessLogRow)}
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
      {#if row.client_ip}
        <span><span class="font-medium text-foreground">Client IP:</span> <code class="font-mono">{row.client_ip}</code></span>
      {/if}
      {#if row.method}
        <span><span class="font-medium text-foreground">Method:</span> <code class="font-mono">{row.method}</code></span>
      {/if}
      {#if !isOk(row) && row.error_message}
        <span class="text-destructive">{row.error_message}</span>
      {/if}
    </div>
    <JsonExpando value={row.params ?? null} />
  </div>
{/snippet}

<div class="space-y-4">
  <LogToolbar>
    <div class="relative min-w-0 flex-1 sm:max-w-md">
      <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Search MCP requests"
        type="search"
        placeholder="Filter by host or tool name…"
        bind:value={searchInput}
        class="pl-9" />
    </div>
    <div class="flex items-center gap-2">
      <label class="text-xs font-medium uppercase tracking-wide text-muted-foreground" for="mcp-status">
        Status
      </label>
      <Select
        type="single"
        value={statusFilter}
        onValueChange={(v: unknown) => {
          if (v === "all" || v === "ok" || v === "fail") statusFilter = v;
        }}>
        <SelectTrigger id="mcp-status" class="h-9 w-[112px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all" label="All">All</SelectItem>
          <SelectItem value="ok" label="OK">OK only</SelectItem>
          <SelectItem value="fail" label="Failed">Failed only</SelectItem>
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
    rowHeight={48}
    {rowKey}
    expandable
    expandContent={expanded}
    loading={result.isPending}
    emptyMessage="No MCP invocations recorded."
    virtualize={false} />

  <p class="text-xs text-muted-foreground">
    Showing
    <span class="font-medium text-foreground">{rows.length}</span>
    of
    <span class="font-medium text-foreground">{allRows.length}</span>
    recent MCP calls. Click a row to inspect parameters.
  </p>
</div>
