<script lang="ts">
  /** Tool calls: every MCP request agents made, newest first. */
  import { createQuery } from "@tanstack/svelte-query";
  import Workflow from "@lucide/svelte/icons/workflow";
  import { DataTable, EventFeed } from "$lib/components/page";
  import * as Table from "$lib/components/ui/table";
  import { filterClass } from "$lib/components/feedback/report-model";
  import { mcpLogsQuery, hostsForLogsQuery } from "$lib/api/logs";
  import type { McpAccessLogRow } from "$lib/api/types";
  import { relativeTime } from "$lib/utils/format";
  import type { ActivityFilters } from "./activity-filters.svelte";
  import ActivityFilterBar from "./ActivityFilterBar.svelte";
  import EventRow from "./EventRow.svelte";
  import JsonExpando from "./JsonExpando.svelte";
  import StatusBadge from "./StatusBadge.svelte";
  import { actionGroups, filterToolCalls, pageCountFor, paginate, parseStatus, toolSucceeded } from "./event-model";

  let { feed }: { feed: ActivityFilters } = $props();

  const query = createQuery<McpAccessLogRow[], Error>(mcpLogsQuery(200));
  const hostsQuery = createQuery(hostsForLogsQuery());
  const hosts = $derived($hostsQuery.data ?? []);
  const all = $derived($query.data ?? []);

  // MCP rows carry the host name, not its id, so the chosen id is resolved to a name.
  const hostFqdn = $derived.by(() => {
    if (feed.host === "all" || feed.host === "system") return null;
    const host = hosts.find((h) => String(h.id) === feed.host);
    return host?.fqdn || host?.hostname || `\u0000unknown-host-${feed.host}`;
  });

  const rows = $derived(
    filterToolCalls(all, { q: feed.q, hostFqdn, window: feed.window, action: feed.action, status: feed.status }),
  );
  const groups = $derived.by(() => {
    const found = actionGroups(all.map((row) => row.name ?? ""), /[._:/]/);
    return feed.action && !found.some((g) => g.value === feed.action) ? [{ value: feed.action, count: 0 }, ...found] : found;
  });
  const pageCount = $derived(pageCountFor(rows.length));
  const pageRows = $derived(paginate(rows, feed.page));
  let open = $state<string | null>(null);
  const rowKey = (row: McpAccessLogRow) => String(row.id);
</script>

<EventFeed page={Math.min(feed.page, pageCount)} {pageCount} onPage={(next) => (feed.page = next)}>
  {#snippet filters()}
    <ActivityFilterBar {feed} {hosts} searchLabel="Search tool calls" count={`${rows.length} of ${all.length} recent calls`}>
      {#snippet extra()}
        <select class="{filterClass} w-44" aria-label="Filter by tool" bind:value={feed.action}>
          <option value="">All tools</option>
          {#each groups as group (group.value)}<option value={group.value}>{group.value} ({group.count})</option>{/each}
        </select>
        <select class="{filterClass} w-36" aria-label="Filter by result" value={feed.status} onchange={(e) => (feed.status = parseStatus(e.currentTarget.value))}>
          <option value="all">Any result</option>
          <option value="ok">Succeeded</option>
          <option value="fail">Failed only</option>
        </select>
      {/snippet}
    </ActivityFilterBar>
  {/snippet}

  <DataTable
    items={pageRows}
    loading={$query.isPending}
    error={$query.isError ? $query.error.message : null}
    onRetry={() => void $query.refetch()}
    key={rowKey}
    filtered={feed.active}
    emptyIcon={Workflow}
    emptyTitle="No tool calls recorded"
    emptyDescription="Requests agents make through the orchestrator's tools (MCP) appear here."
    caption="Tool calls"
  >
    {#snippet head()}
      <Table.Head class="w-8"><span class="sr-only">Details</span></Table.Head>
      <Table.Head>When</Table.Head>
      <Table.Head>Host</Table.Head>
      <Table.Head>Tool</Table.Head>
      <Table.Head>Result</Table.Head>
    {/snippet}
    {#snippet row(item: McpAccessLogRow)}
      <EventRow
        expanded={open === rowKey(item)}
        onToggle={() => (open = open === rowKey(item) ? null : rowKey(item))}
        label={`${item.name ?? item.method ?? "call"} from ${item.host_fqdn ?? "unknown host"}`}
        columns={4}
      >
        {#snippet cells()}
          <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground" title={item.created_at ?? ""}>
            {item.created_at ? relativeTime(item.created_at) : "—"}
          </Table.Cell>
          <Table.Cell class="max-w-56 truncate text-body-sm">{item.host_fqdn ?? "—"}</Table.Cell>
          <Table.Cell>
            <code class="font-mono text-caption">{item.name ?? "—"}</code>
            {#if item.method && item.method !== item.name}<span class="ml-2 text-caption text-muted-foreground">{item.method}</span>{/if}
          </Table.Cell>
          <Table.Cell><StatusBadge ok={toolSucceeded(item)} code={item.error_code} message={item.error_message} /></Table.Cell>
        {/snippet}
        {#snippet detail()}
          <div class="space-y-2">
            <div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-caption text-muted-foreground">
              {#if item.client_ip}<span><span class="font-medium text-foreground">Client IP:</span> <code class="font-mono">{item.client_ip}</code></span>{/if}
              {#if item.method}<span><span class="font-medium text-foreground">Method:</span> <code class="font-mono">{item.method}</code></span>{/if}
              {#if !toolSucceeded(item) && item.error_message}<span class="text-destructive">{item.error_message}</span>{/if}
            </div>
            <JsonExpando value={item.params ?? null} />
          </div>
        {/snippet}
      </EventRow>
    {/snippet}
  </DataTable>
</EventFeed>
