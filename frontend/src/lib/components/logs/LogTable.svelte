<script lang="ts" generics="TData">
  import type { Snippet } from "svelte";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import { cn } from "$lib/utils/cn";
  import type { LogTableColumn } from "./log-table-types";

  type Props = {
    rows: TData[];
    columns: LogTableColumn<TData>[];
    /** Estimated row height in px (virtualizer only). */
    rowHeight?: number;
    /** Max height of the scroll viewport. */
    maxHeight?: string;
    /** Empty-state copy. */
    emptyMessage?: string;
    /** Show skeleton-loading skeletons while loading. */
    loading?: boolean;
    skeletonRows?: number;
    /** When true, renders each row as a button-style click target that expands. */
    expandable?: boolean;
    /** Snippet rendered below an expanded row. Receives the row. */
    expandContent?: Snippet<[TData]>;
    /** Sort state for header arrows. */
    sortBy?: string;
    sortDir?: "asc" | "desc";
    /** Called when a sortable header is clicked. */
    onSort?: (id: string) => void;
    /** Optional stable key per row (default: index). */
    rowKey?: (row: TData, index: number) => string;
    /** Disable virtualization (useful for tiny datasets). */
    virtualize?: boolean;
    class?: string;
  };

  let {
    rows,
    columns,
    rowHeight = 44,
    maxHeight = "60vh",
    emptyMessage = "No rows.",
    loading = false,
    skeletonRows = 8,
    expandable = false,
    expandContent,
    sortBy,
    sortDir,
    onSort,
    rowKey,
    virtualize = true,
    class: className,
  }: Props = $props();

  let scrollEl: HTMLDivElement | null = $state(null);
  let expandedKey: string | null = $state(null);
  // Live virtualizer instance.
  type VirtualizerStore = ReturnType<typeof createVirtualizer<HTMLDivElement, HTMLDivElement>>;
  type VirtualizerValue = Parameters<Parameters<VirtualizerStore["subscribe"]>[0]>[0];
  let virtualizer: VirtualizerStore | null = null;
  let liveVirtualizer = $state<VirtualizerValue | null>(null);
  let unsubVirtualizer: (() => void) | null = null;

  const keyOf = (row: TData, index: number): string =>
    rowKey ? rowKey(row, index) : String(index);

  $effect(() => {
    if (!virtualize || !scrollEl) {
      unsubVirtualizer?.();
      unsubVirtualizer = null;
      virtualizer = null;
      liveVirtualizer = null;
      return;
    }
    const el = scrollEl;
    virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: rows.length,
      getScrollElement: () => el,
      estimateSize: () => rowHeight,
      overscan: 8,
    });
    unsubVirtualizer = virtualizer.subscribe((v) => {
      liveVirtualizer = v;
    });
    return () => {
      unsubVirtualizer?.();
      unsubVirtualizer = null;
      virtualizer = null;
      liveVirtualizer = null;
    };
  });

  // Reactively bump count/estimateSize on the live observer.
  $effect(() => {
    if (!liveVirtualizer) return;
    liveVirtualizer.setOptions({
      count: rows.length,
      estimateSize: () => rowHeight,
    });
  });

  function toggleRow(key: string) {
    if (!expandable) return;
    expandedKey = expandedKey === key ? null : key;
  }
</script>

<div class={cn("overflow-hidden rounded-lg border bg-card", className)}>
  <!-- Header -->
  <div class="border-b bg-muted/40 px-2">
    <div class="flex w-full items-center text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {#each columns as col (col.id)}
        {#if col.sortable && onSort}
          <button
            type="button"
            onclick={() => onSort?.(col.id)}
            class={cn(
              "flex h-10 items-center gap-1 px-3 py-2 hover:text-foreground",
              col.class,
              col.headerClass,
            )}>
            <span>{col.header}</span>
            {#if sortBy === col.id}
              {#if sortDir === "asc"}
                <ChevronUp class="h-3.5 w-3.5" />
              {:else}
                <ChevronDown class="h-3.5 w-3.5" />
              {/if}
            {:else}
              <ChevronsUpDown class="h-3.5 w-3.5 opacity-40" />
            {/if}
          </button>
        {:else}
          <div
            class={cn(
              "flex h-10 items-center px-3 py-2",
              col.class,
              col.headerClass,
            )}>
            {col.header}
          </div>
        {/if}
      {/each}
    </div>
  </div>

  <!-- Body -->
  {#if loading}
    <div class="divide-y">
      {#each Array.from({ length: skeletonRows }) as _, i}
        <div class="flex w-full items-center" style="height: {rowHeight}px;">
          {#each columns as col (col.id)}
            <div class={cn("px-3 py-2", col.class)}>
              <div class="h-3 w-3/4 animate-pulse rounded bg-muted"></div>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {:else if rows.length === 0}
    <div class="flex items-center justify-center px-6 py-10 text-sm text-muted-foreground">
      {emptyMessage}
    </div>
  {:else if virtualize}
    <div
      bind:this={scrollEl}
      class="overflow-y-auto"
      style="max-height: {maxHeight};">
      {#if liveVirtualizer}
        <div style="height: {liveVirtualizer.getTotalSize()}px; position: relative; width: 100%;">
          {#each liveVirtualizer.getVirtualItems() as v (v.key)}
            {@const row = rows[v.index]}
            {@const key = keyOf(row, v.index)}
            {@const isExpanded = expandable && expandedKey === key}
            <div
              style="position: absolute; top: 0; left: 0; right: 0; transform: translateY({v.start}px);"
              data-index={v.index}>
              {#if expandable}
                <div
                  role="button"
                  tabindex="0"
                  onclick={() => toggleRow(key)}
                  onkeydown={(e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleRow(key);
                    }
                  }}
                  class={cn(
                    "flex w-full cursor-pointer items-center border-b text-sm transition-colors hover:bg-muted/40",
                    isExpanded && "bg-muted/40",
                  )}
                  style="min-height: {rowHeight}px;">
                  {#each columns as col (col.id)}
                    <div class={cn("flex items-center px-3 py-2", col.class)}>
                      {#if col.cell}
                        {@render col.cell(row)}
                      {/if}
                    </div>
                  {/each}
                </div>
              {:else}
                <div
                  class="flex w-full items-center border-b text-sm transition-colors"
                  style="min-height: {rowHeight}px;">
                  {#each columns as col (col.id)}
                    <div class={cn("flex items-center px-3 py-2", col.class)}>
                      {#if col.cell}
                        {@render col.cell(row)}
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
              {#if isExpanded && expandContent}
                <div class="border-b bg-background px-4 py-3">
                  {@render expandContent(row)}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="overflow-y-auto" style="max-height: {maxHeight};">
      {#each rows as row, i (keyOf(row, i))}
        {@const key = keyOf(row, i)}
        {@const isExpanded = expandable && expandedKey === key}
        {#if expandable}
          <div
            role="button"
            tabindex="0"
            onclick={() => toggleRow(key)}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleRow(key);
              }
            }}
            class={cn(
              "flex w-full cursor-pointer items-center border-b text-sm transition-colors hover:bg-muted/40",
              isExpanded && "bg-muted/40",
            )}
            style="min-height: {rowHeight}px;">
            {#each columns as col (col.id)}
              <div class={cn("flex items-center px-3 py-2", col.class)}>
                {#if col.cell}
                  {@render col.cell(row)}
                {/if}
              </div>
            {/each}
          </div>
          {#if isExpanded && expandContent}
            <div class="border-b bg-background px-4 py-3">
              {@render expandContent(row)}
            </div>
          {/if}
        {:else}
          <div
            class="flex w-full items-center border-b text-sm transition-colors"
            style="min-height: {rowHeight}px;">
            {#each columns as col (col.id)}
              <div class={cn("flex items-center px-3 py-2", col.class)}>
                {#if col.cell}
                  {@render col.cell(row)}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
