<script lang="ts" generics="T">
  /**
   * The one list table. Owns the loading, error, empty and no-match states so
   * a page only declares its columns and its row. Wraps `ui/table`; use
   * `SortableHead` from `data-table/` inside `head` for sortable columns.
   */
  import type { Component, Snippet } from "svelte";
  import * as Table from "$lib/components/ui/table";
  import { Button } from "$lib/components/ui/button";
  import StateBlock from "./StateBlock.svelte";

  type Props = {
    items: T[] | undefined;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    /** Column headers: `<Table.Head>…</Table.Head>` cells. */
    head: Snippet;
    /** One row: `<Table.Row>…</Table.Row>`. */
    row: Snippet<[T, number]>;
    key?: (item: T) => string | number;
    /** Shown when the list is empty. */
    emptyTitle?: string;
    emptyDescription?: string;
    emptyIcon?: Component;
    emptyAction?: Snippet;
    /** True when a filter is active and removed every row. */
    filtered?: boolean;
    onClearFilters?: () => void;
    caption?: string;
  };
  let { items, loading = false, error = null, onRetry, head, row, key, emptyTitle = "Nothing here yet", emptyDescription, emptyIcon, emptyAction, filtered = false, onClearFilters, caption }: Props = $props();
</script>

{#if error}
  <StateBlock state="error" message={items?.length ? `Refresh failed. Showing previously loaded data. ${error}` : error} {onRetry} />
{/if}
{#if loading && !items?.length}
  <StateBlock state="loading" />
{:else if !error && (!items || items.length === 0)}
  <StateBlock
    state="empty"
    message={filtered ? "No matches" : emptyTitle}
    description={filtered ? "Try a different search or clear the filters." : emptyDescription}
    icon={emptyIcon}
    action={filtered ? clearFilters : emptyAction}
  />
{:else if items?.length}
  {#if loading}<p role="status" class="text-body-sm text-muted-foreground">Refreshing… Previously loaded data remains visible.</p>{/if}
  <div class="min-w-0 max-w-full rounded-md border" aria-busy={loading}>
    <Table.Root regionLabel={caption ?? emptyTitle}>
      {#if caption}<Table.Caption class="sr-only">{caption}</Table.Caption>{/if}
      <Table.Header><Table.Row>{@render head()}</Table.Row></Table.Header>
      <Table.Body>
        {#each items as item, index (key ? key(item) : index)}
          {@render row(item, index)}
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}

{#snippet clearFilters()}{#if onClearFilters}<Button variant="outline" onclick={onClearFilters}>Clear filters</Button>{/if}{/snippet}
