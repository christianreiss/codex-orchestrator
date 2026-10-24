<script lang="ts">
  /** Admin changes: the audit trail of what operators and the system altered. */
  import { createQuery } from "@tanstack/svelte-query";
  import Activity from "@lucide/svelte/icons/activity";
  import { DataTable, EventFeed } from "$lib/components/page";
  import * as Table from "$lib/components/ui/table";
  import { filterClass } from "$lib/components/feedback/report-model";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { eventLogsQuery, hostsForLogsQuery, buildHostLabelMap } from "$lib/api/logs";
  import type { AdminAuditLogRow } from "$lib/api/types";
  import { relativeTime } from "$lib/utils/format";
  import type { ActivityFilters } from "./activity-filters.svelte";
  import ActivityFilterBar from "./ActivityFilterBar.svelte";
  import EventRow from "./EventRow.svelte";
  import JsonExpando from "./JsonExpando.svelte";
  import { actionGroups, changePayload, detailsToString, filterChanges, pageCountFor, paginate, truncate } from "./event-model";

  let { feed }: { feed: ActivityFilters } = $props();

  const query = createQuery<AdminAuditLogRow[], Error>(eventLogsQuery(500));
  const hostsQuery = createQuery(hostsForLogsQuery());
  const hosts = $derived($hostsQuery.data ?? []);
  const labels = $derived(buildHostLabelMap(hosts));
  const all = $derived($query.data ?? []);

  const hostLabel = (row: AdminAuditLogRow): string =>
    row.host_id === null || row.host_id === undefined ? "System" : (labels.get(String(row.host_id)) ?? `Host #${row.host_id}`);

  const rows = $derived(
    filterChanges(all, { q: feed.q, host: feed.host, window: feed.window, action: feed.action }, hostLabel),
  );
  // A prefix carried in from an old link stays selectable even if nothing matches it any more.
  const groups = $derived.by(() => {
    const found = actionGroups(all.map((row) => row.action));
    return feed.action && !found.some((g) => g.value === feed.action) ? [{ value: feed.action, count: 0 }, ...found] : found;
  });
  const pageCount = $derived(pageCountFor(rows.length));
  const pageRows = $derived(paginate(rows, feed.page));
  let open = $state<string | null>(null);
  const rowKey = (row: AdminAuditLogRow) => String(row.id);
</script>

<h2 class="sr-only">Change history</h2>
<EventFeed page={Math.min(feed.page, pageCount)} {pageCount} onPage={(next) => (feed.page = next)}>
  {#snippet filters()}
    <ActivityFilterBar {feed} {hosts} includeSystem searchLabel="Search changes" count={`${rows.length} of ${all.length} recent changes`}>
      {#snippet extra()}
        <select class="{filterClass} w-44" aria-label="Filter by action" bind:value={feed.action}>
          <option value="">All actions</option>
          {#each groups as group (group.value)}<option value={group.value}>{group.value} ({group.count})</option>{/each}
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
    emptyIcon={Activity}
    emptyTitle="No changes recorded"
    emptyDescription="Admin and system changes appear here as they happen."
    caption="Admin changes"
  >
    {#snippet head()}
      <Table.Head class="w-8"><span class="sr-only">Details</span></Table.Head>
      <Table.Head>When</Table.Head>
      <Table.Head>Host</Table.Head>
      <Table.Head>Action</Table.Head>
      <Table.Head>Details</Table.Head>
    {/snippet}
    {#snippet row(item: AdminAuditLogRow)}
      <EventRow
        expanded={open === rowKey(item)}
        onToggle={() => (open = open === rowKey(item) ? null : rowKey(item))}
        label={`${item.action} on ${hostLabel(item)}`}
        columns={4}
      >
        {#snippet cells()}
          <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground" title={item.created_at ?? ""}>
            {item.created_at ? relativeTime(item.created_at) : "—"}
          </Table.Cell>
          <Table.Cell class="max-w-56 truncate text-body-sm" title={hostLabel(item)}>{hostLabel(item)}</Table.Cell>
          <Table.Cell><code class="font-mono text-caption">{item.action}</code></Table.Cell>
          <Table.Cell class="max-w-md truncate font-mono text-caption text-muted-foreground">
            {truncate(detailsToString(item.details), 160)}
          </Table.Cell>
        {/snippet}
        {#snippet detail()}
          <div class="space-y-2">
            <JsonExpando value={changePayload(item)} />
            <CopyButton value={JSON.stringify(changePayload(item), null, 2)} label="Copy JSON" variant="outline" size="sm" toastMessage="Payload copied" />
          </div>
        {/snippet}
      </EventRow>
    {/snippet}
  </DataTable>
</EventFeed>
