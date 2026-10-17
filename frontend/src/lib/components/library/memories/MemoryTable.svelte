<script lang="ts">
  /** The memory inventory: one dense row per memory; the key opens the inspector. */
  import Brain from "@lucide/svelte/icons/brain";
  import { relativeTime } from "$lib/utils/format";
  import { DataTable } from "$lib/components/page";
  import { Badge } from "$lib/components/ui/badge";
  import * as Table from "$lib/components/ui/table";
  import { displayMemoryKey, formatCharacters } from "$lib/components/memories/atlas-types";
  import type { MemoriesState } from "./memories-state.svelte";

  let { state }: { state: MemoriesState } = $props();
  const error = $derived(state.query.isError ? (state.query.error instanceof Error ? state.query.error.message : "Could not load memories") : null);
</script>

<DataTable
  items={state.tableRows}
  loading={state.query.isLoading}
  {error}
  onRetry={() => void state.query.refetch()}
  key={(row) => row.id}
  filtered={state.hasFilters}
  emptyTitle="No memories yet"
  emptyDescription="Agents and admins create memories to keep durable context across sessions."
  emptyIcon={Brain}
  caption="Memories"
>
  {#snippet head()}
    <Table.Head>Memory</Table.Head>
    <Table.Head>Scope &amp; owner</Table.Head>
    <Table.Head>Length</Table.Head>
    <Table.Head>Engine</Table.Head>
    <Table.Head>Updated</Table.Head>
    <Table.Head>Tags</Table.Head>
  {/snippet}
  {#snippet row(item)}
    <Table.Row>
      <Table.Cell class="min-w-60 max-w-80">
        <button type="button" class="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Inspect ${displayMemoryKey(item)}`} onclick={() => state.selectNode(item)}>
          <span class="block truncate font-mono text-body-sm font-semibold hover:underline">{displayMemoryKey(item)}</span>
          <span class="block truncate text-body-sm text-muted-foreground">{item.summary || item.preview || "No summary"}</span>
        </button>
      </Table.Cell>
      <Table.Cell>
        <Badge variant="outline" class="capitalize">{item.scope}</Badge>
        <p class="mt-0.5 max-w-44 truncate text-caption text-muted-foreground">{item.host || item.project_slug || "Fleet-wide"}</p>
      </Table.Cell>
      <Table.Cell class="whitespace-nowrap tabular-nums">{formatCharacters(item.content_length ?? 0)}</Table.Cell>
      <Table.Cell class="text-muted-foreground">{item.engine ?? "—"}</Table.Cell>
      <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground">{item.updated_at ? relativeTime(item.updated_at) : "—"}</Table.Cell>
      <Table.Cell>
        <div class="flex max-w-56 flex-wrap items-center gap-1">
          {#each (item.tags ?? []).slice(0, 4) as tag (tag)}<Badge variant="outline" class="px-1.5 py-0">{tag}</Badge>{/each}
          {#if (item.tags?.length ?? 0) > 4}<span class="text-caption text-muted-foreground">+{(item.tags?.length ?? 0) - 4}</span>{/if}
        </div>
      </Table.Cell>
    </Table.Row>
  {/snippet}
</DataTable>
