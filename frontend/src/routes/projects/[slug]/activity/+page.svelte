<script lang="ts">
  import type { Snapshot } from "./$types";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";
  import History from "@lucide/svelte/icons/history";
  import { DataTable, EventFeed } from "$lib/components/page";
  import { Badge } from "$lib/components/ui/badge";
  import * as Table from "$lib/components/ui/table";
  import EventRow from "$lib/components/logs/EventRow.svelte";
  import JsonExpando from "$lib/components/logs/JsonExpando.svelte";
  import { pageCountFor, paginate } from "$lib/components/logs/event-model";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import { fetchChanges, projectKeys } from "$lib/api/projects";
  import type { ProjectChange } from "$lib/api/types";

  const PAGE_SIZE = 25;
  const slug = $derived(page.params.slug ?? "");

  const changesQuery = createQuery(
    reactiveOptions(() => ({ queryKey: projectKeys.changes(slug), queryFn: () => fetchChanges(slug, 0), enabled: slug.length > 0 })),
  );

  // Newest first, across everything the server returned in this fetch.
  const all = $derived([...($changesQuery.data?.changes ?? [])].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)));
  let pageNo = $state(1);
  $effect(() => { void slug; pageNo = 1; });
  const pageCount = $derived(pageCountFor(all.length, PAGE_SIZE));
  const rows = $derived(paginate(all, pageNo, PAGE_SIZE));
  let open = $state<number | null>(null);

  const actionLabel = (change: ProjectChange): string =>
    change.eventType && change.action ? `${change.eventType}.${change.action}` : (change.action ?? "event");
  export const snapshot: Snapshot<{ pageNo: typeof pageNo }> = {
    capture: () => ({ pageNo }),
    restore: (value) => { pageNo = value.pageNo; },
  };
</script>

<EventFeed page={Math.min(pageNo, pageCount)} {pageCount} onPage={(next) => (pageNo = next)}>
  <DataTable
    items={rows}
    loading={$changesQuery.isLoading}
    error={$changesQuery.isError ? ($changesQuery.error instanceof ApiError ? $changesQuery.error.message : "Could not load activity") : null}
    onRetry={() => void $changesQuery.refetch()}
    key={(change) => change.seq}
    emptyIcon={History}
    emptyTitle="No activity yet"
    emptyDescription="Changes to this project's notes, board, files and reports are recorded here."
    caption="Project activity"
  >
    {#snippet head()}
      <Table.Head class="w-8"><span class="sr-only">Details</span></Table.Head>
      <Table.Head>Event</Table.Head>
      <Table.Head>Action</Table.Head>
      <Table.Head class="text-right">When</Table.Head>
    {/snippet}
    {#snippet row(change: ProjectChange)}
      <EventRow
        expanded={open === change.seq}
        onToggle={() => (open = open === change.seq ? null : change.seq)}
        label={`#${change.seq} ${actionLabel(change)}`}
        columns={3}
      >
        {#snippet cells()}
          <Table.Cell><Badge variant="outline" class="font-mono">#{change.seq}</Badge></Table.Cell>
          <Table.Cell><code class="font-mono text-body-sm">{actionLabel(change)}</code></Table.Cell>
          <Table.Cell class="whitespace-nowrap text-right text-body-sm text-muted-foreground"><Timestamp value={change.createdAt} /></Table.Cell>
        {/snippet}
        {#snippet detail()}
          <div class="space-y-2">
            {#if change.entityType || change.entityId != null || change.sourceHostId != null}
              <div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-caption text-muted-foreground">
                {#if change.entityType}
                  <span><span class="font-medium text-foreground">Entity:</span> <code class="font-mono">{change.entityType}{change.entityId != null ? ` #${change.entityId}` : ""}</code></span>
                {/if}
                {#if change.sourceHostId != null}
                  <span><span class="font-medium text-foreground">Source host:</span> <code class="font-mono">{change.sourceHostId}</code></span>
                {/if}
              </div>
            {/if}
            <JsonExpando value={change.payloadJson ?? null} />
          </div>
        {/snippet}
      </EventRow>
    {/snippet}
  </DataTable>
</EventFeed>
