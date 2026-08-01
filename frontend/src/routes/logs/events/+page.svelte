<script lang="ts">
  import { writable } from "svelte/store";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import Search from "@lucide/svelte/icons/search";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import Activity from "@lucide/svelte/icons/activity";
  import { eventLogsQuery, hostsForLogsQuery, buildHostLabelMap } from "$lib/api/logs";
  import { ApiError } from "$lib/api/client";
  import type { AdminAuditLogRow, HostFqdnSummary } from "$lib/api/types";
  import { relativeTime } from "$lib/utils/format";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import * as Alert from "$lib/components/ui/alert";
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

  const LIMITS = [50, 100, 250, 500] as const;
  const WINDOWS = [
    { value: "all", label: "All time", ms: 0 },
    { value: "5m", label: "Last 5 minutes", ms: 5 * 60_000 },
    { value: "1h", label: "Last hour", ms: 60 * 60_000 },
    { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60_000 },
    { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60_000 },
  ] as const;

  // --- URL-synced filters --------------------------------------------------
  function initHostFilter(): string {
    const v = page.url.searchParams.get("host");
    if (v === "all" || v === "system") return v;
    return v !== null && /^\d+$/.test(v) ? v : "all";
  }

  function initTimeWindow(): (typeof WINDOWS)[number]["value"] {
    const v = page.url.searchParams.get("window");
    return WINDOWS.some((w) => w.value === v) ? (v as (typeof WINDOWS)[number]["value"]) : "all";
  }

  function initLimit(): number {
    const v = Number(page.url.searchParams.get("limit"));
    return (LIMITS as readonly number[]).includes(v) ? v : 100;
  }

  let searchInput = $state(page.url.searchParams.get("q") ?? "");
  let actionPrefix = $state(page.url.searchParams.get("prefix") ?? "");
  let hostFilter = $state<string>(initHostFilter());
  let timeWindow = $state<(typeof WINDOWS)[number]["value"]>(initTimeWindow());
  let limit = $state<number>(initLimit());
  let copiedKey = $state<string | null>(null);

  $effect(() => {
    const url = new URL(page.url);
    const sp = url.searchParams;
    const setOrDelete = (key: string, value: string, fallback: string) => {
      if (value === fallback) sp.delete(key);
      else sp.set(key, value);
    };
    setOrDelete("q", searchInput, "");
    setOrDelete("prefix", actionPrefix, "");
    setOrDelete("host", hostFilter, "all");
    setOrDelete("window", timeWindow, "all");
    setOrDelete("limit", String(limit), "100");
    if (url.search !== page.url.search) {
      void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
    }
  });

  const queryClient = useQueryClient();
  // Seeds from `limit`'s initial (URL-derived) value once, avoiding a
  // hardcoded-then-corrected first fetch; the `$effect` below re-syncs it
  // reactively on every subsequent change.
  // eslint-disable-next-line svelte/no-unused-svelte-ignore
  // svelte-ignore state_referenced_locally
  const eventsOptions = writable(eventLogsQuery(limit));
  $effect(() => {
    eventsOptions.set(eventLogsQuery(limit));
  });
  const query = createQuery<AdminAuditLogRow[], Error>(eventsOptions);
  const result = $derived($query);
  const allRows = $derived<AdminAuditLogRow[]>(result.data ?? []);

  const hostsOptions = writable(hostsForLogsQuery());
  const hostsQuery = createQuery<HostFqdnSummary[], Error>(hostsOptions);
  const hostList = $derived<HostFqdnSummary[]>($hostsQuery.data ?? []);
  const hostLabels = $derived(buildHostLabelMap(hostList));

  function hostLabel(row: AdminAuditLogRow): string {
    if (row.host_id === null || row.host_id === undefined) return "System";
    return hostLabels.get(String(row.host_id)) ?? `Host #${row.host_id}`;
  }

  function detailsToString(details: unknown): string {
    if (details === null || details === undefined) return "";
    if (typeof details === "string") {
      // Some endpoints store JSON-as-string; pretty-print if it parses.
      try {
        return JSON.stringify(JSON.parse(details));
      } catch {
        return details;
      }
    }
    try {
      return JSON.stringify(details);
    } catch {
      return String(details);
    }
  }

  function fullPayload(row: AdminAuditLogRow): string {
    const obj = {
      id: row.id,
      host_id: row.host_id,
      action: row.action,
      details: parseMaybe(row.details),
      created_at: row.created_at ?? null,
    };
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(row.details ?? "");
    }
  }

  function parseMaybe(v: unknown): unknown {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  function truncate(text: string, n: number): string {
    if (text.length <= n) return text;
    return text.slice(0, n - 1) + "…";
  }

  async function copyRow(row: AdminAuditLogRow) {
    const payload = fullPayload(row);
    try {
      await navigator.clipboard.writeText(payload);
      copiedKey = String(row.id);
      setTimeout(() => {
        if (copiedKey === String(row.id)) copiedKey = null;
      }, 1_500);
    } catch {
      // ignore — clipboard might be unavailable
    }
  }

  const filtered = $derived.by(() => {
    const needle = searchInput.trim().toLowerCase();
    const prefix = actionPrefix.trim().toLowerCase();
    const window = WINDOWS.find((w) => w.value === timeWindow);
    const cutoff = window && window.ms > 0 ? Date.now() - window.ms : 0;
    return allRows.filter((row) => {
      if (hostFilter === "system" && row.host_id !== null && row.host_id !== undefined) return false;
      if (hostFilter !== "all" && hostFilter !== "system") {
        if (String(row.host_id ?? "") !== hostFilter) return false;
      }
      if (prefix !== "" && !row.action.toLowerCase().startsWith(prefix)) return false;
      if (cutoff > 0 && row.created_at) {
        const ts = Date.parse(row.created_at);
        if (Number.isFinite(ts) && ts < cutoff) return false;
      }
      if (needle === "") return true;
      const action = row.action.toLowerCase();
      const host = hostLabel(row).toLowerCase();
      const details = detailsToString(row.details).toLowerCase();
      return action.includes(needle) || host.includes(needle) || details.includes(needle);
    });
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["logs", "events"] });
  }

  function resetFilters() {
    searchInput = "";
    actionPrefix = "";
    hostFilter = "all";
    timeWindow = "all";
  }

  function rowKey(row: AdminAuditLogRow): string {
    return String(row.id);
  }

  const columns: LogTableColumn<AdminAuditLogRow>[] = [
    {
      id: "created_at",
      header: "Timestamp",
      class: "w-[160px] shrink-0",
      cell: tsCell,
    },
    {
      id: "host",
      header: "Host",
      class: "w-[200px] shrink-0",
      cell: hostCell,
    },
    {
      id: "action",
      header: "Action",
      class: "w-[200px] shrink-0",
      cell: actionCell,
    },
    {
      id: "details",
      header: "Details",
      class: "min-w-0 flex-1",
      cell: detailsCell,
    },
    {
      id: "copy",
      header: "",
      class: "w-[60px] shrink-0 justify-end",
      headerClass: "justify-end",
      cell: copyCell,
    },
  ];
</script>

{#snippet tsCell(row: AdminAuditLogRow)}
  <span class="truncate text-muted-foreground" title={row.created_at ?? ""}>
    {row.created_at ? relativeTime(row.created_at) : "—"}
  </span>
{/snippet}

{#snippet hostCell(row: AdminAuditLogRow)}
  {@const label = hostLabel(row)}
  {#if row.host_id === null || row.host_id === undefined}
    <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">System</span>
  {:else}
    <span class="truncate font-mono text-[12px]" title={label}>{label}</span>
  {/if}
{/snippet}

{#snippet actionCell(row: AdminAuditLogRow)}
  <code class="truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px]" title={row.action}>
    {row.action}
  </code>
{/snippet}

{#snippet detailsCell(row: AdminAuditLogRow)}
  {@const text = detailsToString(row.details)}
  <span class="truncate font-mono text-[11px] text-muted-foreground" title={text}>
    {text ? truncate(text, 220) : ""}
  </span>
{/snippet}

{#snippet copyCell(row: AdminAuditLogRow)}
  <Button
    variant="ghost"
    size="icon"
    class="h-8 w-8"
    onclick={(e: MouseEvent) => {
      e.stopPropagation();
      void copyRow(row);
    }}
    title="Copy full JSON payload">
    {#if copiedKey === String(row.id)}
      <Check class="h-4 w-4 text-success" />
    {:else}
      <Copy class="h-4 w-4" />
    {/if}
  </Button>
{/snippet}

<div class="space-y-4">
  <LogToolbar>
    <div class="relative min-w-0 flex-1 sm:max-w-md">
      <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Search audit trail"
        type="search"
        placeholder="Free-text search (action, host, details)…"
        bind:value={searchInput}
        class="pl-9" />
    </div>
    <Input
      aria-label="Filter by action prefix"
      type="text"
      placeholder="Action prefix"
      bind:value={actionPrefix}
      class="h-9 w-full sm:w-[160px]" />

    <Select
      type="single"
      value={hostFilter}
      onValueChange={(v: unknown) => {
        if (typeof v === "string") hostFilter = v;
      }}>
      <SelectTrigger class="h-9 w-[180px]" aria-label="Filter by host">
        <SelectValue placeholder="Host" />
      </SelectTrigger>
      <SelectContent class="max-h-[320px]">
        <SelectItem value="all" label="All hosts">All hosts</SelectItem>
        <SelectItem value="system" label="System">System (no host)</SelectItem>
        {#each hostList as host (host.id)}
          <SelectItem
            value={String(host.id)}
            label={host.fqdn || host.hostname || `Host #${host.id}`}>
            {host.fqdn || host.hostname || `Host #${host.id}`}
          </SelectItem>
        {/each}
      </SelectContent>
    </Select>

    <Select
      type="single"
      value={timeWindow}
      onValueChange={(v: unknown) => {
        if (typeof v === "string") {
          const found = WINDOWS.find((w) => w.value === v);
          if (found) timeWindow = found.value;
        }
      }}>
      <SelectTrigger class="h-9 w-[152px]">
        <SelectValue placeholder="Time window" />
      </SelectTrigger>
      <SelectContent>
        {#each WINDOWS as w (w.value)}
          <SelectItem value={w.value} label={w.label}>{w.label}</SelectItem>
        {/each}
      </SelectContent>
    </Select>

    <div class="flex items-center gap-1.5">
      <Select
        type="single"
        value={String(limit)}
        onValueChange={(v: unknown) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) limit = n;
        }}>
        <SelectTrigger class="h-9 w-[92px]" aria-label="Events fetched per request">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {#each LIMITS as size (size)}
            <SelectItem value={String(size)} label={String(size)}>{size}</SelectItem>
          {/each}
        </SelectContent>
      </Select>
      <span class="text-xs text-muted-foreground">most recent</span>
    </div>

    <div class="ml-auto flex items-center gap-2">
      <Button variant="outline" size="sm" onclick={refresh}>
        <RefreshCw class="h-4 w-4" />
        Refresh
      </Button>
    </div>
  </LogToolbar>

  {#if result.isError}
    <Alert.Root variant="destructive">
      <Alert.Title>Could not load audit events</Alert.Title>
      <Alert.Description>
        {result.error instanceof ApiError ? result.error.message : "Unknown error"}
      </Alert.Description>
    </Alert.Root>
  {/if}

  <LogTable
    rows={filtered}
    columns={columns}
    rowHeight={44}
    {rowKey}
    loading={result.isPending}
    isEmpty={allRows.length === 0}
    emptyIcon={Activity}
    emptyMessage="No audit events recorded."
    emptyFilteredMessage="No events match these filters"
    onClearFilters={resetFilters}
    virtualize={false} />

  <p class="text-xs text-muted-foreground">
    Showing
    <span class="font-medium text-foreground">{filtered.length}</span>
    of
    <span class="font-medium text-foreground">{allRows.length}</span>
    fetched events.
  </p>
</div>
